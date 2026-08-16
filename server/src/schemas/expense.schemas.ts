import { z } from 'zod';

/**
 * Expense schemas (design "File Changes" → expense.schemas.ts; tasks 2.1).
 * API-layer contracts only: DB CHECKs guard shape, zod guards semantics
 * (tenant-data-model delta "Migration 008 — Expenses": "month-range validity
 * 01..12 is enforced by the Zod schema at the API layer").
 *
 * Also hosts the PUBLIC response mappers (spec R1/R2): `toPublicExpense` and
 * `toPublicPanelItem` are the ONLY way internal rows become API bodies, so
 * `proof_url` and `deleted_at` can never leak — picking explicit keys is the
 * guard, tested in expense.schemas.spec.ts.
 */

export const ExpenseCreateSchema = z.object({
  unit_id: z.string().uuid(),
  amount_cents: z.number().int().min(1),
  concept: z.string().trim().min(1).max(300),
  // YYYY-MM with month 01..12 — rejects "2026-13", "2026-1", "2026-00"
  // (S5). DB GLOB only guards shape; this regex guards semantics.
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'periodo debe ser YYYY-MM'),
});

export const ExpenseReportSchema = z.object({
  // Spec R3 / S20: ONLY http(s) URLs — ftp:, javascript:, or bare strings
  // must fail (z.string().url() alone accepts ftp/javascript, so the scheme
  // is refined here).
  proof_url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), 'debe ser una URL http(s)'),
});

export const ExpenseReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

export type ExpenseCreateInput = z.infer<typeof ExpenseCreateSchema>;
export type ExpenseReportInput = z.infer<typeof ExpenseReportSchema>;
export type ExpenseReviewInput = z.infer<typeof ExpenseReviewSchema>;

/** Internal row shape accepted by `toPublicExpense` (superset of ExpenseRow). */
export interface ExpenseRowLike {
  id: string;
  unit_id: string;
  amount_cents: number;
  concept: string;
  period: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ExpensePublic {
  id: string;
  unit_id: string;
  amount_cents: number;
  concept: string;
  period: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Emission response (R1): explicit key pick — `deleted_at` never leaves, an
 * exact integer-cents echo (S1). An input with extra keys (e.g. `proof_url`)
 * is silently stripped; the test pins this.
 */
export function toPublicExpense(row: ExpenseRowLike): ExpensePublic {
  return {
    id: row.id,
    unit_id: row.unit_id,
    amount_cents: row.amount_cents,
    concept: row.concept,
    period: row.period,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface PanelRowLike extends ExpenseRowLike {
  unit_number: string;
}

export interface PanelItemPublic extends ExpensePublic {
  unit_number: string;
  payment_status: string | null;
}

/**
 * Panel row (R2): adds `unit_number` (units join) and `payment_status`
 * (latest non-deleted payment, merged by the service — `null` when none).
 * Same explicit-key guard: a `proof_url` or `deleted_at` on the input never
 * reaches the response.
 */
export function toPublicPanelItem(row: PanelRowLike, paymentStatus: string | null): PanelItemPublic {
  return {
    ...toPublicExpense(row),
    unit_number: row.unit_number,
    payment_status: paymentStatus,
  };
}

/** Payment row shape accepted by `toPublicPayment` (superset of PaymentRow). */
export interface PaymentRowLike {
  id: string;
  expense_id: string;
  proof_url: string;
  status: string;
  created_at: string;
}

export interface PaymentPublic {
  id: string;
  expense_id: string;
  proof_url: string;
  status: string;
  created_at: string;
}

/**
 * Report response (R3): EXACTLY `{ id, expense_id, proof_url, status,
 * created_at }` — `resident_id`, `updated_at`, and `deleted_at` never leave.
 * Test S14 pins the full key set.
 */
export function toPublicPayment(row: PaymentRowLike): PaymentPublic {
  return {
    id: row.id,
    expense_id: row.expense_id,
    proof_url: row.proof_url,
    status: row.status,
    created_at: row.created_at,
  };
}