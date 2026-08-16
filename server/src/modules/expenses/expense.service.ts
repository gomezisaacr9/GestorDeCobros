import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import connection from '../../../db/connection';
import { ConflictError, NotFoundError } from '../../errors/http-errors';
import { expenseRepository } from './expense.repository';
import { paymentRepository, type PaymentRow } from '../payments/payment.repository';
import { residentUnitService } from '../hierarchy/resident-unit.service';
import { findUnitInJurisdiction, type AdminRow } from '../hierarchy/unit-jurisdiction';
import { getUserById } from '../auth/auth.service';
import {
  toPublicExpense,
  toPublicPanelItem,
  type ExpenseCreateInput,
  type ExpensePublic,
  type PanelItemPublic,
} from './expense.schemas';

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
    const admin = await getUserById(actor.id);
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
    const unitIds = await residentUnitService.getUserUnitIds(userId);
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
};