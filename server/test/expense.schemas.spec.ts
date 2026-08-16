import { describe, expect, it } from 'vitest';
import {
  ExpenseCreateSchema,
  ExpenseReportSchema,
  ExpenseReviewSchema,
  toPublicExpense,
  toPublicPanelItem,
} from '../src/schemas/expense.schemas';

/**
 * Expense schemas (PR-2, design "File Changes" → expense.schemas.ts; tasks
 * 2.1). Pins the API-layer contracts: `ExpenseCreateSchema` (amount_cents
 * int ≥ 1, period `YYYY-MM` with valid month 01..12, concept 1..300, unit_id
 * uuid), `ExpenseReportSchema` (proof_url http(s) ONLY), `ExpenseReviewSchema`
 * (decision enum), and the PUBLIC response mappers (`toPublicExpense` /
 * `toPublicPanelItem`) that NEVER expose `proof_url` or `deleted_at`
 * (spec R2 — "The panel MUST NOT expose proof_url — not even the caller's").
 */

const UNIT_ID = '123e4567-e89b-12d3-a456-426614174000';

const VALID_CREATE = {
  unit_id: UNIT_ID,
  amount_cents: 1234050,
  concept: 'Expensas julio',
  period: '2026-07',
};

describe('ExpenseCreateSchema', () => {
  it('accepts a valid emission body echoing the exact integer cents (S1 roundtrip)', () => {
    const parsed = ExpenseCreateSchema.parse(VALID_CREATE);
    expect(parsed.amount_cents).toBe(1234050);
    expect(parsed.unit_id).toBe(UNIT_ID);
    expect(parsed.concept).toBe('Expensas julio');
    expect(parsed.period).toBe('2026-07');
  });

  it('rejects amount_cents that are zero, negative, or fractional (S5)', () => {
    for (const amount of [0, -50, 12.34]) {
      const result = ExpenseCreateSchema.safeParse({ ...VALID_CREATE, amount_cents: amount });
      expect(result.success).toBe(false);
    }
  });

  it('rejects period values outside YYYY-MM with month 01..12 (S5)', () => {
    for (const period of ['2026-13', '2026-1', '2026-00', '26-07', '2026/07']) {
      const result = ExpenseCreateSchema.safeParse({ ...VALID_CREATE, period });
      expect(result.success).toBe(false);
    }
  });

  it('rejects empty or >300-char concepts (S5)', () => {
    expect(ExpenseCreateSchema.safeParse({ ...VALID_CREATE, concept: '' }).success).toBe(false);
    expect(ExpenseCreateSchema.safeParse({ ...VALID_CREATE, concept: 'x'.repeat(301) }).success).toBe(false);
  });

  it('accepts a concept of exactly 300 chars', () => {
    expect(ExpenseCreateSchema.safeParse({ ...VALID_CREATE, concept: 'x'.repeat(300) }).success).toBe(true);
  });

  it('rejects a non-uuid unit_id (S5)', () => {
    expect(ExpenseCreateSchema.safeParse({ ...VALID_CREATE, unit_id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('ExpenseReportSchema (proof_url http(s) only — S20 contract)', () => {
  it('accepts https and http URLs', () => {
    expect(
      ExpenseReportSchema.safeParse({ proof_url: 'https://img.example.com/receipt.jpg' }).success,
    ).toBe(true);
    expect(ExpenseReportSchema.safeParse({ proof_url: 'http://img.example.com/receipt.jpg' }).success).toBe(
      true,
    );
  });

  it('rejects ftp, javascript:, and non-URL strings (S20)', () => {
    for (const proof_url of ['ftp://files/x', 'javascript:alert(1)', 'not-a-url']) {
      expect(ExpenseReportSchema.safeParse({ proof_url }).success).toBe(false);
    }
  });
});

describe('ExpenseReviewSchema (decision enum)', () => {
  it('accepts only approved | rejected', () => {
    expect(ExpenseReviewSchema.safeParse({ decision: 'approved' }).success).toBe(true);
    expect(ExpenseReviewSchema.safeParse({ decision: 'rejected' }).success).toBe(true);
    expect(ExpenseReviewSchema.safeParse({ decision: 'other' }).success).toBe(false);
  });
});

describe('toPublic mappers — never expose proof_url or deleted_at (R2)', () => {
  it('toPublicExpense strips deleted_at and any stray sensitive key, echoes cents', () => {
    const row = {
      id: 'e1',
      unit_id: UNIT_ID,
      amount_cents: 1234050,
      concept: 'Expensas julio',
      period: '2026-07',
      status: 'pending',
      created_at: '2026-07-01 12:00:00',
      updated_at: '2026-07-01 12:00:00',
      deleted_at: '2026-07-02 12:00:00',
      proof_url: 'https://should-never-leak.example/x',
    };
    const pub = toPublicExpense(row);
    expect(pub).toEqual({
      id: 'e1',
      unit_id: UNIT_ID,
      amount_cents: 1234050,
      concept: 'Expensas julio',
      period: '2026-07',
      status: 'pending',
      created_at: '2026-07-01 12:00:00',
      updated_at: '2026-07-01 12:00:00',
    });
    expect(pub).not.toHaveProperty('deleted_at');
    expect(pub).not.toHaveProperty('proof_url');
  });

  it('toPublicPanelItem keeps unit_number and payment_status, never leaked keys', () => {
    const row = {
      id: 'e1',
      unit_id: UNIT_ID,
      unit_number: '101',
      amount_cents: 1234050,
      concept: 'Expensas julio',
      period: '2026-07',
      status: 'rejected',
      created_at: '2026-07-01 12:00:00',
      updated_at: '2026-07-01 12:00:00',
      deleted_at: '2026-07-02 12:00:00',
      proof_url: 'https://should-never-leak.example/x',
    };
    const item = toPublicPanelItem(row, 'rejected');
    expect(item).toEqual({
      id: 'e1',
      unit_id: UNIT_ID,
      unit_number: '101',
      amount_cents: 1234050,
      concept: 'Expensas julio',
      period: '2026-07',
      status: 'rejected',
      payment_status: 'rejected',
      created_at: '2026-07-01 12:00:00',
      updated_at: '2026-07-01 12:00:00',
    });
    expect(item).not.toHaveProperty('deleted_at');
    expect(item).not.toHaveProperty('proof_url');
  });

  it('toPublicPanelItem carries payment_status null when no payment exists (S10)', () => {
    const item = toPublicPanelItem(
      {
        id: 'e2',
        unit_id: UNIT_ID,
        unit_number: '101',
        amount_cents: 9900,
        concept: 'Expensas agosto',
        period: '2026-08',
        status: 'pending',
        created_at: '2026-08-01 12:00:00',
        updated_at: '2026-08-01 12:00:00',
      },
      null,
    );
    expect(item.payment_status).toBeNull();
  });
});