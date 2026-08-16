import type { Knex } from 'knex';
import connection from '../../../db/connection';

/**
 * Payment repository (design D1/D4/D5). Each payment records one resident
 * report; `status` supports exactly one `under_review → approved|rejected`
 * flip (guarded update), and "latest payment" is ALWAYS resolved
 * deterministically via `created_at DESC, id DESC` on non-deleted rows —
 * never by a correlated subquery (D5), so the review latest-check (D4) and
 * the panel merge (D5) share one interpretation.
 */

export interface PaymentRow {
  id: string;
  expense_id: string;
  resident_id: string;
  proof_url: string;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Review source of truth (design D4 step lookups): the payment joined through
 * expenses → units → buildings → condominiums. `condominium_id` is the
 * jurisdiction anchor for condo_admin review; a missing/soft-deleted payment
 * yields undefined → upstream 404 «Pago no encontrado».
 */
export interface PaymentWithCondominium extends PaymentRow {
  condominium_id: string;
}

const PAYMENT_COLUMNS = [
  'id',
  'expense_id',
  'resident_id',
  'proof_url',
  'status',
  'created_at',
  'updated_at',
  'deleted_at',
];

export const paymentRepository = {
  /**
   * Persists a resident report; `status` defaults to 'under_review' (the
   * machine always starts a payment under review).
   */
  async insert(
    data: { id: string; expense_id: string; resident_id: string; proof_url: string },
    trx: Knex = connection,
  ): Promise<void> {
    await trx('payments').insert({ ...data, status: 'under_review' });
  },

  /** Chain join for review: source of both the 404 and the jurisdiction. */
  async findWithCondominium(
    id: string,
    trx: Knex = connection,
  ): Promise<PaymentWithCondominium | undefined> {
    const row = await trx('payments')
      .join('expenses', 'expenses.id', 'payments.expense_id')
      .join('units', 'units.id', 'expenses.unit_id')
      .join('buildings', 'buildings.id', 'units.building_id')
      .join('condominiums', 'condominiums.id', 'buildings.condominium_id')
      .select([
        ...PAYMENT_COLUMNS.map((col) => `payments.${col}`),
        'condominiums.id as condominium_id',
      ])
      .where('payments.id', id)
      .whereNull('payments.deleted_at')
      .first();
    return row === undefined ? undefined : ((row as unknown) as PaymentWithCondominium);
  },

  /**
   * The single allowed payment flip (R5): `under_review AND deleted_at IS
   * NULL` → `decision`. Returns affected rows — 0 means already decided or
   * soft-deleted (409 upstream, step (a) of design D4).
   */
  async updateStatusGuarded(
    id: string,
    decision: string,
    trx: Knex = connection,
  ): Promise<number> {
    return trx('payments')
      .where({ id, status: 'under_review' })
      .whereNull('deleted_at')
      .update({ status: decision, updated_at: trx.fn.now() });
  },

  /** Latest non-deleted payment of an expense (design D4 step b). */
  async latestByExpenseId(
    expenseId: string,
    trx: Knex = connection,
  ): Promise<PaymentRow | undefined> {
    return trx('payments')
      .select(PAYMENT_COLUMNS)
      .where({ expense_id: expenseId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
  },

  /**
   * Every non-deleted payment of the given expenses, newest first
   * (design D5): grouping in the service merge keeps the FIRST occurrence
   * per expense = its latest payment. An empty list yields [].
   */
  async latestByExpenseIds(expenseIds: string[]): Promise<PaymentRow[]> {
    return connection('payments')
      .select(PAYMENT_COLUMNS)
      .whereIn('expense_id', expenseIds)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
  },
};