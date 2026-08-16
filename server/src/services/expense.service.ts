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
  type ExpenseCreateInput,
  type ExpensePublic,
  type PaymentPublic,
  type PanelItemPublic,
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
};