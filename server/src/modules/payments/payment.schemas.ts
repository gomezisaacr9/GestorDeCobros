import { z } from 'zod';

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

export type ExpenseReportInput = z.infer<typeof ExpenseReportSchema>;
export type ExpenseReviewInput = z.infer<typeof ExpenseReviewSchema>;

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

export interface ReviewPublic {
  id: string;
  decision: string;
  expense_id: string;
  expense_status: string;
  updated_at: string;
}

/**
 * Review response (R4): EXACTLY `{ id, decision, expense_id, expense_status,
 * updated_at }` — nothing else (status is the decision applied to both rows).
 */
export function toPublicReview(
  id: string,
  decision: string,
  expenseId: string,
  expenseStatus: string,
  updatedAt: string,
): ReviewPublic {
  return { id, decision, expense_id: expenseId, expense_status: expenseStatus, updated_at: updatedAt };
}
