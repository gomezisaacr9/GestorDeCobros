# Spec: expenses

## Purpose

New capability introduced by change `expenses-engine` (no prior spec). Adds the common-fee lifecycle: admin emission (`POST /api/v1/expenses`), resident panel (`GET /api/v1/expenses/mine`), resident proof reporting (`POST /api/v1/expenses/:id/payments`), and a guarded review endpoint (`POST /api/v1/payments/:paymentId/review`) driving a materialized `PENDING → UNDER_REVIEW → APPROVED/REJECTED` machine with `REJECTED → UNDER_REVIEW` retries. All amounts are integer cents; APPROVED is terminal and administrative (no transfer verification). Out of scope: edit/reversal, overdue/reminders, partial payments, pagination, proof metadata beyond the URL, notifications.

## Requirements

### Requirement: R1 — Admin Expense Emission

The system MUST expose `POST /api/v1/expenses` behind `requireAuth` → `requireRole(['superadmin','condo_admin','building_admin'])` → `validateZod` (401 → 403 → 400, fail-closed). Body: `unit_id` uuid; `amount_cents` integer ≥ 1; `concept` string 1..300; `period` matching `YYYY-MM` with valid month. Jurisdiction MUST be DB-resolved (`findUnitInJurisdiction` pattern, never JWT): superadmin → any active unit; condo_admin → units whose `buildings.condominium_id` equals the admin's; building_admin → units of its own building. A cross-jurisdiction, nonexistent, or soft-deleted unit MUST return HTTP 404 `{ "error": "Unidad no encontrada" }` — byte-identical (never 403). An ACTIVE duplicate `(unit_id, period)` MUST return HTTP 409; a soft-deleted expense MUST NOT block re-emission. Success MUST return HTTP 201 `{ id, unit_id, amount_cents, concept, period, status: "pending", created_at, updated_at }` echoing the exact integer cents.

#### Scenario: S1 — Superadmin emits with full cents roundtrip

- GIVEN an authenticated superadmin and an active unit
- WHEN POST /api/v1/expenses sends `{ "unit_id": "u1", "amount_cents": 1234050, "concept": "Expensas julio", "period": "2026-07" }`
- THEN HTTP 201 with `status: "pending"` and `amount_cents: 1234050` (no float drift)

#### Scenario: S2 — Scoped admins inside their jurisdiction

- GIVEN a condo_admin of `c1` or a building_admin of `b1`, and an active unit inside that scope
- WHEN the emission is posted
- THEN HTTP 201

#### Scenario: S3 — Resident denied

- GIVEN a valid `resident` session
- WHEN POST /api/v1/expenses runs
- THEN HTTP 403 `{ "error": "Prohibido" }` and the controller never runs

#### Scenario: S4 — No session denied first

- GIVEN no `auth_token` cookie
- WHEN POST /api/v1/expenses runs
- THEN HTTP 401 from `requireAuth`, before any role check

#### Scenario: S5 — Invalid body rejected

- GIVEN a valid admin session
- WHEN `unit_id` is not a uuid, `amount_cents` is 0/negative/float (e.g. `12.34`), `concept` is empty or > 300 chars, or `period` is `"2026-13"` or `"2026-1"`
- THEN HTTP 400 `{ "error": "Solicitud inválida", "details": [...] }` and no expense is created

#### Scenario: S6 — Cross-jurisdiction unit is byte-identical 404

- GIVEN a condo_admin of `c1` and an active unit under `c2` (≠ `c1`)
- WHEN POST targets that unit
- THEN HTTP 404 `{ "error": "Unidad no encontrada" }`, identical to the nonexistent-unit body

#### Scenario: S7 — Soft-deleted unit is 404

- GIVEN a unit with `deleted_at` set, inside the admin's jurisdiction
- WHEN POST targets it
- THEN HTTP 404 with the same generic body

#### Scenario: S8 — Active duplicate is 409

- GIVEN an active expense `(unit_id: "u1", period: "2026-07")`
- WHEN the same pair is emitted again
- THEN HTTP 409 and no second row exists

#### Scenario: S9 — Soft-deleted duplicate does not block

- GIVEN an expense `(u1, 2026-07)` with `deleted_at` set
- WHEN the same pair is emitted again
- THEN HTTP 201 (partial-unique index ignores deleted rows)

### Requirement: R2 — Resident Panel

The system MUST expose `GET /api/v1/expenses/mine` behind `requireAuth` → `requireRole(['resident'])`. It MUST return only expenses whose `unit_id` is in `resident_units` for the caller (unit ids from a single SQL filter via `listUnitIdsByUser`), excluding soft-deleted expenses — a resident MUST never see another resident's rows. Zero units MUST yield HTTP 200 `[]`. Each item MUST be exactly `{ id, unit_id, unit_number, amount_cents, concept, period, status, payment_status, created_at, updated_at }`: `unit_number` from the units join; `payment_status` = the latest non-deleted payment's status (`under_review`|`approved`|`rejected`), `null` when no payment exists (latest = `ORDER BY created_at DESC, id DESC LIMIT 1`). The panel MUST NOT expose `proof_url` — not even the caller's — and MUST NOT leak neighbor debts.

#### Scenario: S10 — Resident sees own expenses with unit_number and payment_status

- GIVEN a resident linked to `u1`; on `u1` an expense rejected after a payment report, an expense with no payments, and a soft-deleted expense
- WHEN GET /api/v1/expenses/mine runs
- THEN HTTP 200 with exactly the two active items, `unit_number` resolved, `payment_status: "rejected"` and `null` respectively, no `proof_url` key anywhere

#### Scenario: S11 — Zero units yields empty array

- GIVEN a resident with no `resident_units` rows
- WHEN GET /api/v1/expenses/mine runs
- THEN HTTP 200 `[]`

#### Scenario: S12 — Neighbor isolation

- GIVEN residents A (`u1`) and B (`u2`) and an expense on `u2`
- WHEN A calls GET /api/v1/expenses/mine
- THEN HTTP 200 with no row whose `unit_id` is `u2` — B's debt never appears, even by id

#### Scenario: S13 — Guard matrix

- GIVEN no cookie, then a valid `condo_admin` session
- WHEN GET /api/v1/expenses/mine runs in each case
- THEN HTTP 401 (no session) and HTTP 403 (non-resident)

### Requirement: R3 — Resident Payment Report

`POST /api/v1/expenses/:id/payments` MUST run behind `requireAuth` → `requireRole(['resident'])` → `validateZod`. Body `{ "proof_url": string }` accepting ONLY `http`/`https` URLs (other schemes → 400). Membership: the expense MUST belong to a unit linked to the caller; nonexistent, not-owned, or soft-deleted expense → HTTP 404 `{ "error": "Gasto no encontrado" }`, byte-identical. On valid input the system MUST run ONE transaction: guarded expense transition (`status IN ('pending','rejected')` → `'under_review'`; 0 affected rows → HTTP 409) plus a new payment row with `status: 'under_review'`; ANY failure rolls back. Reporting while `under_review` or on `approved` MUST return HTTP 409. Success MUST return HTTP 201 `{ id, expense_id, proof_url, status: "under_review", created_at }`.

#### Scenario: S14 — Happy report flips the expense in one tx

- GIVEN a resident owner of the expense's unit, expense `status: "pending"`
- WHEN POST /api/v1/expenses/e1/payments sends `{ "proof_url": "https://img.example.com/receipt.jpg" }`
- THEN HTTP 201 with the new payment id and `status: "under_review"` AND the expense row now has `status: "under_review"`

#### Scenario: S15 — Rejected expense retries with a NEW payment

- GIVEN an expense `status: "rejected"` (previous payment rejected)
- WHEN the resident reports again
- THEN HTTP 201 with a DIFFERENT payment id and the expense returns to `under_review` (retries unbounded)

#### Scenario: S16 — Report while under_review is 409

- GIVEN an expense `status: "under_review"`
- WHEN the resident reports
- THEN HTTP 409 and no second payment row exists

#### Scenario: S17 — Report on approved is 409

- GIVEN an expense `status: "approved"` (terminal)
- WHEN the resident reports
- THEN HTTP 409

#### Scenario: S18 — Neighbor's expense is a byte-identical 404

- GIVEN a resident owning only `u1` and an expense on `u2`
- WHEN POST /api/v1/expenses/<that-id>/payments runs
- THEN HTTP 404 `{ "error": "Gasto no encontrado" }`, identical to the nonexistent-id body, and the expense status never changes

#### Scenario: S19 — Nonexistent expense is 404

- GIVEN no expense with `id = e999`
- WHEN the report runs
- THEN HTTP 404 with the same generic body

#### Scenario: S20 — Non-http(s) proof rejected

- GIVEN a valid resident session
- WHEN `proof_url` is `"ftp://files/x"`, `"javascript:alert(1)"`, or `"not-a-url"`
- THEN HTTP 400 and no payment row is created

#### Scenario: S21 — Concurrent reports on a rejected expense

- GIVEN an expense `status: "rejected"` and two simultaneous report requests
- WHEN both execute
- THEN exactly one HTTP 201 and the other HTTP 409 (guarded transition wins)

### Requirement: R4 — Guarded Review

`POST /api/v1/payments/:paymentId/review` MUST run behind `requireAuth` → `requireRole(['superadmin','condo_admin'])` → `validateZod`. Body `{ "decision": "approved" | "rejected" }`. Jurisdiction: superadmin → any payment; condo_admin → ONLY payments whose expense's condominium equals the admin's; otherwise HTTP 404 `{ "error": "Pago no encontrado" }` — byte-identical to a nonexistent payment (fail-closed, never 403). The review MUST execute in ONE transaction: (a) guarded payment flip `SET status = decision WHERE id = :id AND status = 'under_review' AND deleted_at IS NULL` — 0 rows ⇒ HTTP 409; (b) latest-payment check (`created_at DESC, id DESC`) — a newer payment ⇒ HTTP 409; (c) guarded expense flip `SET status = decision WHERE id = :expenseId AND status = 'under_review'`. ANY failure rolls back and leaves both rows unchanged. Success MUST return HTTP 200 `{ id, decision, expense_id, expense_status, updated_at }`.

#### Scenario: S22 — Superadmin approves (terminal)

- GIVEN an expense `under_review` with one `under_review` payment
- WHEN POST /api/v1/payments/p1/review sends `{ "decision": "approved" }`
- THEN HTTP 200 with `expense_status: "approved"` AND the payment row is `approved`; later reports/reviews on it are 409

#### Scenario: S23 — Condo admin rejects inside its scope

- GIVEN a condo_admin of `c1` and an expense under `c1` with an `under_review` payment
- WHEN review sends `{ "decision": "rejected" }`
- THEN HTTP 200 with `expense_status: "rejected"`; the resident may now report again (S15)

#### Scenario: S24 — Cross-jurisdiction review is byte-identical 404

- GIVEN a condo_admin of `c1` and an `under_review` payment whose expense is under `c2`
- WHEN review runs
- THEN HTTP 404 `{ "error": "Pago no encontrado" }`, identical to the nonexistent-payment body; nothing changes

#### Scenario: S25 — Re-reviewing a decided payment is 409

- GIVEN a payment `status: "rejected"`
- WHEN review runs again
- THEN HTTP 409 (0-row guarded update) and the expense status does not change

#### Scenario: S26 — Reviewing a non-latest payment is 409

- GIVEN an expense with payment `p1` rejected and payment `p2` `under_review`
- WHEN review targets `p1`
- THEN HTTP 409 and `p2`/the expense stay `under_review`

#### Scenario: S27 — Double-review race, exactly one winner

- GIVEN one `under_review` payment and two concurrent reviews, one `approved` and one `rejected`
- WHEN both execute
- THEN exactly one HTTP 200 and the other HTTP 409, and the final `expense_status` equals the winner's decision

#### Scenario: S28 — Resident and building_admin denied

- GIVEN a valid session with role `resident` or `building_admin`
- WHEN review runs
- THEN HTTP 403 `{ "error": "Prohibido" }` and the controller never runs

#### Scenario: S29 — Nonexistent payment is 404

- GIVEN no payment with `id = p999`
- WHEN review runs
- THEN HTTP 404 with the generic body

### Requirement: R5 — Payment Review State Machine

The system MUST materialize the machine state on BOTH `expenses.status` and `payments.status` (same transaction; guards read stored columns — never derived reads). Only these transitions MAY occur:

| From (`expenses.status`) | Event | To | Valid? | Notes |
|---|---|---|---|---|
| pending | report | under_review | YES | + payment `under_review` |
| rejected | report | under_review | YES | NEW payment; unbounded retries |
| under_review | report | — | NO → 409 | |
| approved | report | — | NO → 409 | terminal |
| under_review | review(approved) | approved | YES | iff payment `under_review` ∧ latest |
| under_review | review(rejected) | rejected | YES | same guard |
| approved \| rejected | review | — | NO → 409 | |

Any other transition — including re-review of a payment whose status is `approved`/`rejected` — MUST return HTTP 409 and MUST NOT mutate either row. `payments.status` supports exactly one `under_review → approved|rejected` flip per payment.

#### Scenario: S30 — Reopen cycle walks the full machine

- GIVEN an emitted expense
- WHEN report → reject → report → approve execute in sequence
- THEN statuses walk `pending → under_review → rejected → under_review → approved`, payments end `p1: rejected, p2: approved`, and the expense is terminal

#### Scenario: S31 — Every invalid edge is 409 without mutation

- GIVEN an expense `under_review` whose single payment is `under_review`
- WHEN a second report, then a re-review of the same payment after a first review, then a review of a non-latest payment each attempt
- THEN each returns HTTP 409 and both `expenses.status` and `payments.status` are unchanged after every attempt