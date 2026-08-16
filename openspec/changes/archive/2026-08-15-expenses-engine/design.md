# Design: Expenses Engine

## Technical Approach

Add a materialized common-fee lifecycle on the existing layered stack (routes → middlewares → controllers → services → repositories). Three REST surfaces (`POST /api/v1/expenses`, `GET /api/v1/expenses/mine`, `POST /api/v1/expenses/:id/payments`, `POST /api/v1/payments/:paymentId/review`) drive a guarded `PENDING → UNDER_REVIEW → APPROVED/REJECTED` machine with unbounded `REJECTED → UNDER_REVIEW` retries. Amounts are integer cents end-to-end. `expenses.status` is materialized and transitions ONLY inside single knex transactions via guarded `UPDATE ... WHERE status = ...` (the `markUsed` pattern): 0 affected rows ⇒ 409. Jurisdiction stays DB-resolved (`findUnitInJurisdiction` pattern, byte-identical 404 per family). The partial unique index is the duplicate invariant; repos map `SQLITE_CONSTRAINT_UNIQUE` → 409 as the race backstop (spec S8/S9, delta "Migration 008 — Expenses").

## Architecture Decisions

| # | Decision | Choice | Alternatives | Rationale |
|---|---|---|---|---|
| D1 | Migration 008 | `expenses`+`payments` DDL with CHECKs + raw-SQL partial unique index; `down()` drops payments → expenses | app-layer dup check only | race-safe DB invariant; spec locked raw partial index (knex has no partial builder) |
| D2 | Jurisdiction predicate | NEW shared `server/src/repositories/unit-jurisdiction.ts`; invitation.repository re-exports from it | duplicate query inside expense.repository | security-critical predicate: one source of truth; existing invitation greens guard the mechanical refactor |
| D3 | Duplicate emission | service pre-check `findActiveByUnitPeriod` + catch `SQLITE_CONSTRAINT_UNIQUE` → 409 on insert | DB-only; pre-check-only | pre-check gives the clean 409 + S9 path; catch covers the S8 race (invitation accept pattern) |
| D4 | Review = 3-step single tx | (a) guarded payment flip → (b) latest-payment check → (c) guarded expense flip | reverse order; two txs | guards read stored columns, never derived (R5); any failure rolls back (R3/R4); pool `min:1 max:1` serializes S27 |
| D5 | Panel `payment_status` | second query `latestByExpenseIds` (`created_at DESC, id DESC`), first-per-expense merged in service | correlated subquery | simpler knex, deterministic tie-break (delta scenario), testable; `proof_url` never selected (R2) |
| D6 | IN-list limit | no chunking; documented bound | chunked IN (500s) | better-sqlite3 bundles SQLite ≥ 3.32 ⇒ `SQLITE_MAX_VARIABLE_NUMBER` = 32766; a resident's unit count is bounded far below by `listUnitIdsByUser` |
| D7 | Routes/controllers | two routers (`expense.routes`, `payment.routes`) + one controller each | single router | mirrors the API surface (`/api/v1/expenses` and `/api/v1/payments`); per-router guard sets differ |
| D8 | HTTP 410 | NOT used — 404/409 families only | GoneError for soft-deleted | 410 exists for single-use invitations; soft-deleted rows are anti-enum 404s, invalid transitions are 409s |

## File Changes

| File | Action | Description |
|---|---|---|
| `server/db/migrations/008_expenses_payments.ts` | Create | expenses + payments DDL, partial index, FK-order down() |
| `server/src/repositories/unit-jurisdiction.ts` | Create | shared `chainQuery` / `AdminRow` / `findUnitInJurisdiction` |
| `server/src/repositories/invitation.repository.ts` | Modify | re-export from unit-jurisdiction (behavior unchanged) |
| `server/src/repositories/resident-units.repository.ts` | Modify | ADD `listUnitIdsByUser(userId)` |
| `server/src/repositories/expense.repository.ts` | Create | insert, findActiveByUnitPeriod, findActiveById, listByUnitIds, updateStatusGuarded |
| `server/src/repositories/payment.repository.ts` | Create | insert, findWithCondominium, updateStatusGuarded, latestByExpenseId(s) |
| `server/src/services/expense.service.ts` | Create | create / listMine / reportPayment / review |
| `server/src/schemas/expense.schemas.ts` | Create | create / report / review Zod schemas (amount int ≥ 1; period `YYYY-MM` with month 01..12; proof_url http(s) only) |
| `server/src/controllers/expense.controller.ts` · `payment.controller.ts` | Create | thin adapters (no try/catch — errorHandler) |
| `server/src/routes/expense.routes.ts` · `payment.routes.ts` | Create | guarded routers |
| `server/src/app.ts` | Modify | mount both routers |
| `server/test/helpers/db.ts` | Modify | wipe order: payments → expenses → invitations → resident_units → users → units → buildings → condominiums |
| 4 spec files | Create | see Testing Strategy |

## Data Model (Migration 008)

```ts
// up() — expenses
table.uuid('id').primary();
table.uuid('unit_id').notNullable().references('id').inTable('units');
table.integer('amount_cents').notNullable();        // CHECK (amount_cents > 0)
table.text('concept').notNullable();
table.text('period').notNullable();                  // CHECK period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
table.text('status').notNullable().defaultTo('pending');
//   CHECK status IN ('pending','under_review','approved','rejected')
table.timestamps(true, true);
table.timestamp('deleted_at').nullable();
table.index(['unit_id'], 'idx_expenses_unit_id');
await knex.raw(`CREATE UNIQUE INDEX idx_expenses_unique_unit_period_active
  ON expenses (unit_id, period) WHERE deleted_at IS NULL`);

// up() — payments: id PK; expense_id FK→expenses; resident_id FK→users;
// proof_url text NN; status text NN CHECK IN ('under_review','approved','rejected')
// DEFAULT 'under_review'; timestamps; deleted_at nullable;
// indexes idx_payments_expense_id, idx_payments_resident_id
// down(): dropTableIfExists('payments') then dropTableIfExists('expenses') (FK order)
```

## Key Components

```ts
// expense.repository
insert(data): Promise<void>                                   // status defaults 'pending'
findActiveByUnitPeriod(unitId, period)                        // pre-check dup
findActiveById(id): Promise<ExpenseRow | undefined>
listByUnitIds(ids): Promise<PanelRow[]>                       // ⋈ units → unit_number; deleted excluded
updateStatusGuarded(id, from: string[], to: string, trx): Promise<number>

// payment.repository
insert({ id, expense_id, resident_id, proof_url }): Promise<void>  // status 'under_review'
findWithCondominium(id)                 // ⋈ expenses→units→buildings→condominiums; source of 404 + jurisdiction
updateStatusGuarded(id, decision, trx): Promise<number>
latestByExpenseId(expenseId, trx?)      // ORDER BY created_at DESC, id DESC LIMIT 1 (deleted excluded)
latestByExpenseIds(ids): Promise<PaymentRow[]>   // ordered; first-per-expense wins in service merge

// resident-units (ADDED)
listUnitIdsByUser(userId): Promise<string[]>
```

## Transactions & Data Flow

- **Emission** (`create`): admin row (`userRepository.findById`, 404) → `findUnitInJurisdiction(unit_id)` (unknown/cross/soft-deleted ⇒ 404 `Unidad no encontrada`) → pre-check dup ⇒ 409 → insert (catch unique ⇒ 409) → 201 with exact cents.
- **Report** (`reportPayment`): `findActiveById` + `existsLink` membership ⇒ 404 `Gasto no encontrado` → one tx: guarded flip `pending|rejected → under_review` (0 rows ⇒ 409 — covers under_review/approved) + insert payment `under_review` → commit → 201.
- **Review** (`review`): `findWithCondominium` ⇒ 404 `Pago no encontrado`; condo_admin chain mismatch ⇒ same 404 → one tx: (a) guarded payment flip (`status='under_review' AND deleted_at IS NULL`, 0 rows ⇒ 409) → (b) `latestByExpenseId` must be this payment (stale ⇒ 409, S26) → (c) guarded expense flip (`status='under_review'`, 0 rows ⇒ 409) → commit → 200 `{ id, decision, expense_id, expense_status, updated_at }`.
- **Panel** (`listMine`): `listUnitIdsByUser` → `[]` ⇒ 200 `[]` (no expenses query) → `listByUnitIds` ⋈ units → merge `payment_status` from `latestByExpenseIds` (`null` when none) → 200. `proof_url` never selected.

**Races (S21/S27)**: knex pool `min:1 max:1` serializes one better-sqlite3 connection — concurrent txs queue; guarded `WHERE status = …` updates make exactly one flip, the loser sees 0 affected rows ⇒ 409.

## Error Handling

Byte-identical 404 per family (anti-enum): `Unidad no encontrada` (emission), `Gasto no encontrado` (report), `Pago no encontrado` (review, incl. cross-jurisdiction). 409: duplicate `(unit_id, period)`, reports while `under_review`/`approved`, review of decided/non-latest payment. Reuse `NotFoundError`/`ConflictError` + existing `errorHandler` (`err.statusCode`). **410 N/A** (D8).

## Testing Strategy

Baseline verified pre-change: **23 files / 177 tests green**. Strict TDD — RED first per component (vitest 4; temp DB per file via pool `forks`; `setup.ts` unchanged).

| Spec file | Scenarios | Coverage |
|---|---|---|
| `migration-008.spec.ts` | delta all | DDL, CHECKs, partial unique (active dup ✓ / soft-deleted allows), FK orphans, down() drops both, clean re-run, wipe never fires FK |
| `expense.admin.spec.ts` | S1–S9 | emission, RBAC matrix (401/403), 404 anti-enum, active dup 409 / soft-deleted dup 201, 1234050 cents roundtrip |
| `expense.panel.spec.ts` | S10–S13 | isolation, zero units `[]`, no `proof_url` key, guard matrix |
| `expense.payments.spec.ts` | S14–S31 | report + review + machine; S21/S27 via `Promise.all` concurrent requests (exact-one-winner); S30 reopen cycle; S31 no-mutation |

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Routing stays inside the existing Express app factory (same pattern as `invitation.routes`). All five rows are non-applicable; no RED tests required.

## Migration / Rollout

Additive. PR-1: migration 008 + unit-jurisdiction refactor + repos + wipe order; PR-2: emission + panel; PR-3: payments + review + mounts. Rollback per PR: `knex migrate:rollback` (008 down drops payments → expenses) or remove mounts/routes. No data loss elsewhere.

## Open Questions

- None blocking.