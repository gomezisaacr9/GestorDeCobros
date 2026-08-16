import type { Knex } from 'knex';
import connection from '../../db/connection';

/**
 * Expense repository (design D1, "Key Components"). `deleted_at` is
 * repository-internal: every read filters it (active rows only), every
 * transition guards on it. The duplicate invariant is the DB partial unique
 * index (`idx_expenses_unique_unit_period_active`, active rows only) — the
 * service layer (PR-2, design D3) pre-checks with `findActiveByUnitPeriod`
 * for the clean 409 and maps `SQLITE_CONSTRAINT_UNIQUE` as the race
 * backstop; THIS repo exposes the raw DB contract.
 */

export interface ExpenseRow {
  id: string;
  unit_id: string;
  amount_cents: number;
  concept: string;
  period: string;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Resident panel row: expenses ⋈ units for `unit_number`. `payment_status`
 * is merged by the service from `latestByExpenseIds` (design D5) — never
 * selected here.
 */
export interface PanelRow {
  id: string;
  unit_id: string;
  unit_number: string;
  amount_cents: number;
  concept: string;
  period: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const EXPENSE_COLUMNS = [
  'id',
  'unit_id',
  'amount_cents',
  'concept',
  'period',
  'status',
  'created_at',
  'updated_at',
  'deleted_at',
];

const PANEL_COLUMNS = [
  'expenses.id',
  'expenses.unit_id',
  'units.number as unit_number',
  'expenses.amount_cents',
  'expenses.concept',
  'expenses.period',
  'expenses.status',
  'expenses.created_at',
  'expenses.updated_at',
];

export const expenseRepository = {
  /** Persists an expense; `status` defaults to 'pending' (machine start). */
  async insert(
    data: { id: string; unit_id: string; amount_cents: number; concept: string; period: string },
    trx: Knex = connection,
  ): Promise<void> {
    await trx('expenses').insert({ ...data, status: 'pending' });
  },

  /** Pre-check duplicate lookup: the active row for (unit_id, period), if any. */
  async findActiveByUnitPeriod(
    unitId: string,
    period: string,
    trx: Knex = connection,
  ): Promise<ExpenseRow | undefined> {
    return trx('expenses')
      .select(EXPENSE_COLUMNS)
      .where({ unit_id: unitId, period })
      .whereNull('deleted_at')
      .first();
  },

  /** Active expense by id — soft-deleted rows count as absent. */
  async findActiveById(id: string, trx: Knex = connection): Promise<ExpenseRow | undefined> {
    return trx('expenses')
      .select(EXPENSE_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
  },

  /**
   * Resident panel source (design D5): active expenses of the given units,
   * joined to `units.number`, newest first (created_at DESC, id DESC — the
   * same tie-break as the latest-payment lookup, so panel ordering is
   * deterministic). An empty list yields [] (knex `whereIn` short-circuits).
   */
  async listByUnitIds(unitIds: string[]): Promise<PanelRow[]> {
    return connection('expenses')
      .join('units', 'units.id', 'expenses.unit_id')
      .select(PANEL_COLUMNS)
      .whereIn('expenses.unit_id', unitIds)
      .whereNull('expenses.deleted_at')
      .orderBy('expenses.created_at', 'desc')
      .orderBy('expenses.id', 'desc');
  },

  /**
   * Guarded transition (the `markUsed` pattern): flips `status` only when the
   * current value is in `from`, on a non-soft-deleted row. Returns the number
   * of affected rows — 0 means the machine rejected the transition (409
   * upstream). Reads/updates stored columns, never derived ones (R5).
   */
  async updateStatusGuarded(
    id: string,
    from: string[],
    to: string,
    trx: Knex = connection,
  ): Promise<number> {
    return trx('expenses')
      .where({ id })
      .whereIn('status', from)
      .whereNull('deleted_at')
      .update({ status: to, updated_at: trx.fn.now() });
  },
};