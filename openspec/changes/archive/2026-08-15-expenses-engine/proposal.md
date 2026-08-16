# Proposal: Expenses Engine (common-fee billing & payment review)

## Intent

Emit monthly common-fee debts per unit and let residents prove payment through a strict review machine. Zero expense/payment tables exist today — fees are handled off-platform. Admins need jurisdiction-scoped billing; residents a private debt view + proof path; super/condo admins a guarded, money-correct, race-safe APPROVED/REJECTED flow with no cross-resident leaks.

## Scope

### In Scope
- Migration 008: `expenses` + `payments` (integer cents, CHECKs, soft-delete, partial-unique unit+period)
- `POST /api/v1/expenses`: admin emission (superadmin/condo_admin/building_admin; jurisdiction 404 anti-enum; 409 duplicate)
- `GET /api/v1/expenses/mine`: resident panel via `resident_units` (new `listUnitIdsByUser`); 200 [ ] for 0 units
- `POST /api/v1/expenses/:id/payments`: resident proof, http(s) URL, one tx: payment insert + expense → under_review
- `POST /api/v1/payments/:paymentId/review`: guarded approve/reject (superadmin/condo_admin only)
- `tenant-data-model` delta: expenses/payments table requirements

### Out of Scope (non-goals)
- Edit/reversal of emitted amounts (future correction flow); image hosting; real-transfer verification — APPROVED is administrative
- Overdue/reminders, partial payments, pagination, rate limiting, notifications

## Capabilities

### New Capabilities
- `expenses`: lifecycle — emission, resident panel, payment reporting, guarded review machine

### Modified Capabilities
- `tenant-data-model`: ADDED expenses/payments table requirements (columns, CHECKs, partial-unique, soft-delete, indexes, rollback)

## Approach

Reuse patterns: `requireAuth→requireRole→validateZod`; jurisdiction via `findUnitInJurisdiction` (DB-resolved, never JWT); guarded `UPDATE…WHERE status=` → 0 rows ⇒ 409 (like `markUsed`). expense.status is **materialized**, updated in the same tx as the payment row. Latest payment: `ORDER BY created_at DESC, id DESC LIMIT 1`. Resident retries unbounded after rejection.

State machine:
- Report: expense pending|rejected → under_review; payment inserted under_review
- Approve/reject: expense under_review → approved|rejected iff payment under_review ∧ latest; 0 rows ⇒ 409
- 409: report while under_review/approved; review non-latest or already-reviewed payment

Decisions:
| Decision | Choice | Rationale / tradeoff |
|---|---|---|
| status storage | materialized | cheap panel read; all writes single-tx |
| (unit_id, period) | partial unique (deleted_at IS NULL) | no double billing; corrections → new period/future admin flow |
| amount/period edit | NO in MVP | emit wrong → re-issue; deletion non-goal |
| routes | /mine, /payments/:id/review | explicit semantics; no dual-id mismatch |

Panel emits `unit_number` (units join); never neighbor data or others' proof_url.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `server/db/migrations/008_expenses_payments.ts` | New | up/down, FK order |
| `server/src/repositories/resident-units.repository.ts` | Modified | + `listUnitIdsByUser` |
| `server/src/repositories/{expense,payment}.repository.ts` | New | inserts, scoped lookups, guarded review update |
| `server/src/services/expense.service.ts` | New | emission + panel + report + review |
| `server/src/schemas/expense.schemas.ts` | New | amount int ≥1; period regex; proof_url http(s) |
| `server/src/routes/{expense,payment}.routes.ts`, `app.ts` | New | mounts /api/v1/expenses, /api/v1/payments |
| `server/test/helpers/db.ts` + `server/test/*.spec.ts` | New | wipe order; migration/schema/repo/service/route specs |

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Cross-resident exposure | High | SQL filter via resident_units; specs: 200 [ ], byte-identical 404, no neighbor proof_url |
| Money float errors | Med | integer cents end-to-end (schema + CHECK); 1234050 fixture |
| Transition races | Med | guarded updates + single tx ⇒ one 409 |
| Fraudulent/decoy URL | Med | accepted: APPROVED is administrative; http(s) validation only |
| Jurisdiction on review | Med | condo_admin scoped via unit chain (404 fail-closed) |

## Rollback

Per-PR revertible: PR-1 → `knex migrate:rollback` (008 down drops payments → expenses; additive); PR-2/3 → remove mounts/routes. No data loss elsewhere.

## Dependencies

resident_units (007), hierarchy chain + findUnitInJurisdiction, RBAC middlewares, Zod URL validation, vitest temp-DB pattern.

## Success Criteria

- [ ] RBAC matrix + full state machine green incl. races (double review, stale approve, reopen path → exact 409s)
- [ ] Isolation: resident sees own units only; 0 units → 200 [ ]; others' proof_url never returned
- [ ] Duplicate (unit_id, period) → 409 + DB-enforced; 1234050 exact cents through API
- [ ] migrate latest/rollback clean; suite green; RED-first TDD per component

## PR Split (stacked-to-main)

1. Foundation: migration 008 + listUnitIdsByUser + expense/payment repos + wipe() + specs
2. Emission + panel: schemas, POST /expenses, GET /expenses/mine, RBAC + isolation specs
3. Payments + machine: report endpoint, guarded review, mounts, race specs