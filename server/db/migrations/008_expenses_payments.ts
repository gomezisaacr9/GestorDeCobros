import type { Knex } from 'knex';

/**
 * Migration 008 — `expenses` and `payments` (common-fee lifecycle, design D1).
 *
 * `expenses` materializes the monthly debt per unit: integer cents end-to-end
 * (`amount_cents` CHECK > 0), `period` shaped `YYYY-MM` (a GLOB CHECK — the
 * month-range 01..12 semantics live in the API Zod schema), and a `status`
 * CHECK driving the PENDING → UNDER_REVIEW → APPROVED/REJECTED machine.
 * Duplicate emission `(unit_id, period)` is enforced by a DATABASE-level
 * PARTIAL unique index via raw SQL (knex has no partial-index builder) that
 * only covers active rows (`WHERE deleted_at IS NULL`) — race-safe, and a
 * soft-deleted expense never blocks re-emission (spec S9).
 *
 * `payments` records each resident report: `status` CHECK
 * under_review|approved|rejected (one flip per row), FKs → expenses and users.
 *
 * `down()` drops `payments` first, then `expenses` (FK order) — one-step
 * rollback leaves the 007 shape untouched.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('expenses', (table) => {
    table.uuid('id').primary();
    table.uuid('unit_id').notNullable().references('id').inTable('units');
    table.integer('amount_cents').notNullable();
    table.text('concept').notNullable();
    table.text('period').notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.check('amount_cents > 0');
    table.check(`period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`);
    table.check(`status IN ('pending','under_review','approved','rejected')`);
    table.index(['unit_id'], 'idx_expenses_unit_id');
  });

  // Partial unique index — the duplicate invariant (design D3 backstop).
  await knex.raw(
    `CREATE UNIQUE INDEX idx_expenses_unique_unit_period_active
     ON expenses (unit_id, period) WHERE deleted_at IS NULL`,
  );

  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary();
    table.uuid('expense_id').notNullable().references('id').inTable('expenses');
    table.uuid('resident_id').notNullable().references('id').inTable('users');
    table.text('proof_url').notNullable();
    table.text('status').notNullable().defaultTo('under_review');
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.check(`status IN ('under_review','approved','rejected')`);
    table.index(['expense_id'], 'idx_payments_expense_id');
    table.index(['resident_id'], 'idx_payments_resident_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payments');
  await knex.schema.dropTableIfExists('expenses');
}