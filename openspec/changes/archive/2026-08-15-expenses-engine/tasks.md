# Tasks: Expenses Engine

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~750–850 (across 3 PRs) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Foundation) → PR 2 (Emission + Panel) → PR 3 (Payments + Machine) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Foundation: migration 008, shared jurisdiction, repos, wipe | PR 1 | `npx vitest run --grep "migration-008\|expense.repositories\|payment.repositories\|wipe"` | `npx vitest run` full suite | migration rollback (008 down) |
| 2 | Emission + Panel: schemas, service, controller, routes | PR 2 | `npx vitest run --grep "expense.admin\|expense.panel"` | `npx vitest run` full suite | remove mounts/routes |
| 3 | Payments + Machine: report, review, routes, mounts | PR 3 | `npx vitest run --grep "expense.payments"` | `npx vitest run` full suite | remove mounts/routes |

## Phase 1: PR-1 Foundation

### 1.1 Migration 008 (RED)
- [x] 1.1.1 Create `server/test/migration-008.spec.ts` — RED: test DDL, CHECKs, partial-unique, FK orphans, down(), wipe never fires FK (delta scenarios: partial-unique rejects active dup, soft-deleted dup allowed, amount/status CHECK enforced, orphan expense/payment rejected, latest-payment recency-tie, one-step rollback drops 008 tables, clean full rollback)
- [x] 1.1.2 Create `server/db/migrations/008_expenses_payments.ts` — expenses + payments tables with CHECKs, partial unique raw SQL index `idx_expenses_unique_unit_period_active`, indexes `idx_expenses_unit_id`, `idx_payments_expense_id`, `idx_payments_resident_id`; down() drops payments then expenses

### 1.2 Shared Jurisdiction Helper (GREEN)
- [x] 1.2.1 Create `server/src/repositories/unit-jurisdiction.ts` — extract `AdminRow`, `UnitChain`, `chainQuery`, `findUnitInJurisdiction` from `invitation.repository.ts` (D2)
- [x] 1.2.2 Modify `server/src/repositories/invitation.repository.ts` — re-export from `unit-jurisdiction.ts`, remove duplicated definitions; behavior unchanged (existing invitation tests must stay green)

### 1.3 Repositories (RED → GREEN)
- [x] 1.3.1 Create `server/test/expense.repositories.spec.ts` — RED: test `insert`, `findActiveByUnitPeriod`, `findActiveById`, `listByUnitIds`, `updateStatusGuarded`
- [x] 1.3.2 Create `server/src/repositories/expense.repository.ts` — GREEN: implement all five methods
- [x] 1.3.3 Create `server/test/payment.repositories.spec.ts` — RED: test `insert`, `findWithCondominium`, `updateStatusGuarded`, `latestByExpenseId`, `latestByExpenseIds`
- [x] 1.3.4 Create `server/src/repositories/payment.repository.ts` — GREEN: implement all five methods

### 1.4 listUnitIdsByUser (RED → GREEN)
- [x] 1.4.1 Add RED test to `server/test/expense.repositories.spec.ts` or new `resident-units.repositories.spec.ts` — `listUnitIdsByUser(userId)` returns unit ids or empty array
- [x] 1.4.2 Modify `server/src/repositories/resident-units.repository.ts` — ADD `listUnitIdsByUser(userId)` method

### 1.5 Wipe Order (RED → GREEN)
- [x] 1.5.1 Update `server/test/migration-008.spec.ts` — RED: test wipe never fires FK with expenses/payments rows
- [x] 1.5.2 Modify `server/test/helpers/db.ts` — update `FK_ORDER_TABLES` to `['payments', 'expenses', 'invitations', 'resident_units', 'users', 'units', 'buildings', 'condominiums']`

## Phase 2: PR-2 Emission + Panel

### 2.1 Schemas (RED → GREEN)
- [x] 2.1.1 Create `server/test/expense.schemas.spec.ts` — RED: test create schema (amount_cents int ≥1, period YYYY-MM valid months 01–12, concept 1..300, unit_id uuid)
- [x] 2.1.2 Create `server/src/schemas/expense.schemas.ts` — GREEN: `ExpenseCreateSchema`, `ExpenseReportSchema` (proof_url http(s)), `ExpenseReviewSchema` (decision enum)

### 2.2 Expense Service (RED → GREEN)
- [x] 2.2.1 Create `server/test/expense.admin.spec.ts` — RED: S1 (superadmin 1234050 cents roundtrip), S2 (scoped admin jurisdiction), S3 (resident 403), S4 (no session 401), S5 (invalid body 400), S6 (cross-jurisdiction byte-identical 404), S7 (soft-deleted unit 404), S8 (active duplicate 409), S9 (soft-deleted dup 201)
- [x] 2.2.2 Create `server/test/expense.panel.spec.ts` — RED: S10 (own expenses with unit_number + payment_status, no proof_url), S11 (zero units → 200 []), S12 (neighbor isolation), S13 (guard matrix 401/403)
- [x] 2.2.3 Create `server/src/services/expense.service.ts` — GREEN: implement `create`, `listMine` (listUnitIdsByUser → listByUnitIds → latestByExpenseIds merge)

### 2.3 Controller + Routes (RED → GREEN)
- [x] 2.3.1 Create `server/test/expense.admin.routes.spec.ts` — RED: HTTP-level tests for POST /api/v1/expenses (S1–S9 via appRequest) (delivered inside `expense.admin.spec.ts` per design Testing Strategy table — it drives the real app and exercises the app.ts mount)
- [x] 2.3.2 Create `server/src/controllers/expense.controller.ts` — GREEN: thin adapter (no try/catch — errorHandler)
- [x] 2.3.3 Create `server/src/routes/expense.routes.ts` — GREEN: `POST /` guarded (requireAuth → requireRole admin → validateZod ExpenseCreateSchema), `GET /mine` guarded (requireAuth → requireRole resident)
- [x] 2.3.4 Modify `server/src/app.ts` — mount `expenseRouter` at `/api/v1/expenses`

## Phase 3: PR-3 Payments + Machine — APPLIED 2026-08-15 (2 work-unit commits, see sdd/expenses-engine/apply-progress)

### 3.1 Payment Service (RED → GREEN)
- [x] 3.1.1 Create `server/test/expense.payments.spec.ts` — RED: S14–S21 (report scenarios, S21 concurrent via Promise.all)
- [x] 3.1.1 (review part) + 3.2.1: `server/test/expense.review.spec.ts` — S22–S31 (review + machine; S27 double-review race via Promise.all; S30 reopen cycle; S31 no-mutation edges). Both specs are HTTP-level per design Testing Strategy table (same pattern as PR-2's admin spec — review scenario list here)
- [x] 3.1.2 Modify `server/src/services/expense.service.ts` — GREEN: `reportPayment` (findActiveById + existsLink → 404; one tx: guarded flip pending|rejected→under_review with 0→409 + payment insert, ANY failure rolls back) and `review` (findWithCondominium → 404 + jurisdiction; D4 3-step single tx: guarded payment flip → latest check → guarded expense flip, 0 rows → 409; rolls back on any failure)

### 3.2 Payment Controller + Routes (RED → GREEN)
- [x] 3.2.1 Create `server/test/expense.payments.routes.spec.ts` (HTTP-level S14–S31 delivered INSIDE `expense.payments.spec.ts` + `expense.review.spec.ts` per design Testing Strategy table — drives real app, exercises app.ts mount)
- [x] 3.2.2 Create `server/src/controllers/payment.controller.ts` — thin adapters report (201) + review (200), no try/catch
- [x] 3.2.3 Create `server/src/routes/payment.routes.ts` — `POST /expenses/:id/payments` (requireAuth → requireRole resident → validateZod ExpenseReportSchema), `POST /payments/:paymentId/review` (requireAuth → requireRole superadmin/condo_admin → validateZod ExpenseReviewSchema)
- [x] 3.2.4 Modify `server/src/app.ts` — mount `paymentRouter` at `/api/v1` (after expenseRouter; both spec URLs resolve: `/api/v1/expenses/:id/payments` + `/api/v1/payments/:paymentId/review`)

### 3.3 Final Verification
- [x] 3.3.1 Run `npx vitest run` — full suite **257/257 (32 files)** green; `npx tsc --noEmit` clean
- [x] 3.3.2 Verify `npx knex migrate:rollback` through 008 is clean, re-migrate is clean — verified on temp DB: 8 migrations roll back without FK error, re-migrate recreates `payments`/`expenses`

## Implementation Order

PR-1: 1.1.1→1.1.2→1.2.1→1.2.2→1.3.1→1.3.2→1.3.3→1.3.4→1.4.1→1.4.2→1.5.1→1.5.2 (DONE)
PR-2: 2.1.1→2.1.2→2.2.1→2.2.2→2.2.3→2.3.1→2.3.2→2.3.3→2.3.4 (DONE)
PR-3: 3.1.1→3.1.2→3.2.1→3.2.2→3.2.3→3.2.4→3.3.1→3.3.2 (DONE — 257/257 green)
