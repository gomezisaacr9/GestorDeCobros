import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import connection from '../../db/connection';
import { ConflictError, NotFoundError } from '../errors/http-errors';
import { expenseRepository } from '../repositories/expense.repository';
import { paymentRepository, type PaymentRow } from '../repositories/payment.repository';
import { residentUnitsRepository } from '../repositories/resident-units.repository';
import { findUnitInJurisdiction, type AdminRow } from '../repositories/unit-jurisdiction';
import { userRepository } from '../repositories/user.repository';
import {
  toPublicExpense,
  toPublicPanelItem,
  toPublicPayment,
  toPublicReview,
  type ExpenseCreateInput,
  type ExpensePublic,
  type PaymentPublic,
  type PanelItemPublic,
  type ReviewPublic,
} from '../schemas/expense.schemas';

/**
 * Expense service (design D3/D5; specs R1/R2). Emission follows the
 * invitation-accept duplicate pattern: pre-check `findActiveByUnitPeriod`
 * gives the clean 409 (S8), and the `SQLITE_CONSTRAINT_UNIQUE` catch on
 * insert is the race backstop (S8 concurrent — the partial unique index is
 * the DB invariant, D1). Jurisdiction is DB-resolved via the SHARED
 * `findUnitInJurisdiction` (D2) — unknown/cross/soft-deleted unit ⇒
 * byte-identical 404 «Unidad no encontrada» (S6/S7).
 *
 * The panel (D5): unit ids come from a single SQL filter
 * (`listUnitIdsByUser`); an empty list short-circuits to 200 [] WITHOUT
 * touching the expenses table (S11). `payment_status` is merged from
 * `latestByExpenseIds` (newest first; first-per-expense wins) — the repo
 * NEVER selects `proof_url`, so it cannot leak (R2).
 */

export interface CreateActor {
  id: string;
  role: string;
}

export const expenseService = {
  /** Emission (R1): admin row → shared jurisdiction → pre-check → guarded insert. */
  async create(actor: CreateActor, input: ExpenseCreateInput): Promise<ExpensePublic> {
    const admin = await userRepository.findById(actor.id);
    if (!admin) {
      // invitation.create pattern (D3): the actor lookup owns the 404; the
      // per-family byte-identical body is «Unidad no encontrada».
      throw new NotFoundError('Unidad no encontrada');
    }
    const chain = await findUnitInJurisdiction(input.unit_id, admin as AdminRow);
    if (!chain) {
      throw new NotFoundError('Unidad no encontrada'); // unknown / cross-jurisdiction / soft-deleted (S6/S7)
    }

    const existing = await expenseRepository.findActiveByUnitPeriod(input.unit_id, input.period);
    if (existing) {
      throw new ConflictError('Ya existe una expensa activa para esta unidad y período'); // S8
    }

    const id = randomUUID();
    try {
      await expenseRepository.insert({ id, ...input });
    } catch (err) {
      // Race backstop (D3): the partial unique index fired — a concurrent
      // emission won. Same 409 as the pre-check (S8).
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Ya existe una expensa activa para esta unidad y período');
      }
      throw err;
    }

    const row = await expenseRepository.findActiveById(id);
    if (!row) {
      throw new NotFoundError('Unidad no encontrada'); // unreachable after a successful insert
    }
    return toPublicExpense(row);
  },

  /**
   * Resident panel (R2): listUnitIdsByUser → [] ⇒ 200 [] with NO expenses
   * query (S11); otherwise listByUnitIds (⋈ units → unit_number, active
   * only) + latestByExpenseIds merge (D5). Returns ONLY the R2 shape —
   * no proof_url, no deleted_at (toPublic guards).
   */
  async listMine(userId: string): Promise<PanelItemPublic[]> {
    const unitIds = await residentUnitsRepository.listUnitIdsByUser(userId);
    if (unitIds.length === 0) {
      return []; // S11 — zero units, no expenses query
    }
    const rows = await expenseRepository.listByUnitIds(unitIds);
    if (rows.length === 0) {
      return [];
    }

    const payments = await paymentRepository.latestByExpenseIds(rows.map((r) => r.id));
    // D5 merge: repo returns newest-first; first occurrence per expense is
    // its latest payment — `null` when there is none.
    const latestStatusByExpense = new Map<string, string>();
    for (const payment of payments) {
      if (!latestStatusByExpense.has(payment.expense_id)) {
        latestStatusByExpense.set(payment.expense_id, payment.status);
      }
    }

    return rows.map((row) =>
      toPublicPanelItem(row, latestStatusByExpense.get(row.id) ?? null),
    );
  },

  /**
   * Resident payment report (R3/S14–S21, design Report flow). Membership:
   * active expense + `existsLink` — unknown / not-owned / soft-deleted ⇒
   * byte-identical 404 «Gasto no encontrado» (S18/S19). ONE transaction:
   * guarded expense flip `pending|rejected → under_review` (0 rows ⇒ 409 —
   * covers under_review/approved, S16/S17, and the S21 race loser) then the
   * payment insert (`status 'under_review'`); ANY failure rolls back.
   */
  async reportPayment(
    residentId: string,
    expenseId: string,
    proofUrl: string,
  ): Promise<PaymentPublic> {
    const expense = await expenseRepository.findActiveById(expenseId);
    if (!expense) {
      throw new NotFoundError('Gasto no encontrado'); // S19 (never existed or soft-deleted)
    }
    const owns = await residentUnitsRepository.existsLink(residentId, expense.unit_id);
    if (!owns) {
      throw new NotFoundError('Gasto no encontrado'); // S18 neighbor — byte-identical to S19
    }

    const id = randomUUID();
    let created: PaymentRow | undefined;
    await connection.transaction(async (trx: Knex) => {
      const affected = await expenseRepository.updateStatusGuarded(
        expenseId,
        ['pending', 'rejected'],
        'under_review',
        trx,
      );
      if (affected === 0) {
        // S16 (under_review) / S17 (approved) / S21 loser — the machine
        // rejected the transition; NOTHING was written, rollback is a no-op.
        throw new ConflictError('El gasto no admite un nuevo reporte en su estado actual');
      }
      await paymentRepository.insert(
        { id, expense_id: expenseId, resident_id: residentId, proof_url: proofUrl },
        trx,
      );
      // Read back the EXACT inserted row (by id) inside the tx so the 201
      // carries its real created_at — no "latest" ambiguity under timestamp
      // ties (design D5 tie-break only governs derived lookups).
      created = await paymentRepository.findWithCondominium(id, trx);
    });

    if (!created) {
      // Unreachable after a successful tx, kept for type narrowing.
      throw new NotFoundError('Gasto no encontrado');
    }
    return toPublicPayment(created);
  },

  /**
   * Guarded review (R4/S22–S29, design D4 — 3-step single tx). Step 0:
   * `findWithCondominium` is the source of the 404 AND the jurisdiction
   * anchor — condo_admin may only review payments in their OWN condominium,
   * otherwise byte-identical 404 «Pago no encontrado» (S24, never 403);
   * superadmin → any. Then ONE transaction, EXACTLY this order (D4):
   *   (a) guarded payment flip `under_review → decision` (0 rows ⇒ 409 —
   *       S25 re-review, S27 race loser);
   *   (b) latest-payment check — the reviewed payment MUST be the latest
   *       (`created_at DESC, id DESC`); a newer payment ⇒ 409 (S26);
   *   (c) guarded expense flip `under_review → decision` (0 rows ⇒ 409).
   * ANY failure rolls back and leaves both rows unchanged (R4/R5, S31).
   * The knex pool `min:1 max:1` serializes one better-sqlite3 connection so
   * exactly one of two concurrent reviews flips first (S27).
   */
  async review(paymentId: string, actor: CreateActor, decision: string): Promise<ReviewPublic> {
    const payment = await paymentRepository.findWithCondominium(paymentId);
    if (!payment) {
      throw new NotFoundError('Pago no encontrado'); // S29 (nonexistent or soft-deleted payment)
    }

    if (actor.role !== 'superadmin') {
      // S24: condo_admin outside their condominium ⇒ the SAME 404 body as a
      // nonexistent payment (fail-closed, never 403 — spec R4).
      const admin = await userRepository.findById(actor.id);
      if (!admin || admin.condominium_id !== payment.condominium_id) {
        throw new NotFoundError('Pago no encontrado');
      }
    }

    const expenseId = payment.expense_id;
    let updatedAt = '';
    await connection.transaction(async (trx: Knex) => {
      // (a) guarded payment flip — exactly one `under_review → decision`.
      const payFlipped = await paymentRepository.updateStatusGuarded(paymentId, decision, trx);
      if (payFlipped === 0) {
        throw new ConflictError('El pago ya fue decidido o no admite revisión'); // S25 / S27 loser
      }
      // (b) latest-payment check: the target MUST still be the expense's
      // latest payment (a newer report would be out of order, S26).
      const latest = await paymentRepository.latestByExpenseId(expenseId, trx);
      if (!latest || latest.id !== paymentId) {
        throw new ConflictError('Solo puede revisarse el último pago del gasto'); // S26
      }
      // (c) guarded expense flip — mirrors the payment decision (R5).
      const expFlipped = await expenseRepository.updateStatusGuarded(
        expenseId,
        ['under_review'],
        decision,
        trx,
      );
      if (expFlipped === 0) {
        throw new ConflictError('El gasto no admite revisión en su estado actual'); // S31 edge
      }
      const updated = await paymentRepository.findWithCondominium(paymentId, trx);
      updatedAt = updated?.updated_at ?? '';
    });

    return toPublicReview(paymentId, decision, expenseId, decision, updatedAt);
  },
};