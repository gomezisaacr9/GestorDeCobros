# Spec: invitation-public

## Purpose

New capability introduced by change `invitation-onboarding`. Adds the public (unauthenticated) side of magic-link onboarding: `GET /api/v1/invitations/:token` (names-only resolution) and `POST /api/v1/invitations/:token/accept` (register or link + auto session cookie). The token itself is the sole authorization. Out of scope: email delivery, landing page UI, rate limiting.

## Requirements

### Requirement: R1 — Resolve Invitation (GET)

`GET /api/v1/invitations/:token` MUST NOT require a session. For an active, unexpired invitation the system MUST return HTTP 200 with ONLY readable names: `{ "condominium": string, "building": string, "unit": string }`. The response MUST NOT expose internal ids, timestamps, `deleted_at`, `created_by`, or status.

#### Scenario: S1 — Active token resolves names only

- GIVEN an active invitation for unit `u1` (condominium "Torre Norte", building "A", unit "101")
- WHEN GET /api/v1/invitations/<rawToken> runs
- THEN HTTP 200 `{ "condominium": "Torre Norte", "building": "A", "unit": "101" }`
- AND the body contains no id, timestamp, `deleted_at`, `created_by`, or status key

### Requirement: R2 — Unknown Token (anti-enumeration)

For a token whose hash matches no row, GET MUST return HTTP 404 with a generic body. The response MUST NOT reveal whether the token's format, length, or target unit is valid.

#### Scenario: S2 — Guessed token is 404

- GIVEN a random 64-hex string that was never issued
- WHEN GET /api/v1/invitations/<random> runs
- THEN HTTP 404 `{ "error": "Invitación no encontrada" }`
- AND the body leaks no ids or existence hints

#### Scenario: S3 — Malformed token is 404

- GIVEN a token with wrong length or characters (e.g. "abc")
- WHEN GET runs
- THEN HTTP 404 with the same generic body — no 400, nothing to validate

### Requirement: R3 — Dead Link (410)

GET MUST return HTTP 410 Gone for any invitation that once existed but is unusable: expired, used, or whose unit chain (unit → building → condominium) contains a soft-deleted or missing row. All 410 responses MUST share ONE generic body. Reconciliation note: GET collapses expired AND used into 410 because a read performs no consumption — there is no state conflict to report; accept (R6) differentiates.

#### Scenario: S4 — Expired token is 410

- GIVEN an invitation with `status = 'active'` and `expires_at` in the past
- WHEN GET runs
- THEN HTTP 410 `{ "error": "Invitación expirada o ya utilizada" }`

#### Scenario: S5 — Used token is 410

- GIVEN an invitation with `status = 'used'` (not expired)
- WHEN GET runs
- THEN HTTP 410 with the same generic body as the expired case

#### Scenario: S6 — Soft-deleted unit is 410

- GIVEN an active invitation whose unit has `deleted_at` set
- WHEN GET runs
- THEN HTTP 410 with the same generic body — the link once existed but the unit is gone

### Requirement: R4 — Accept Invitation (transactional)

`POST /api/v1/invitations/:token/accept` MUST NOT require a session. Body `{ "email": valid email, "password": 8–128 chars, "name"?: trimmed ≤ 255 }` MUST pass Zod (reusing auth validation conventions); invalid bodies → HTTP 400 before any mutation. The flow MUST run in a single transaction: resolve token → load unit chain → find/create user → insert `resident_units` → mark `used` → issue session cookie. HTTP 201 when a user is created, 200 when an existing resident is linked; both MUST return `{ "id", "email", "role": "resident" }` and `Set-Cookie: auth_token` with the login mechanics (HttpOnly, Secure outside development, SameSite=Strict, path `/`, maxAge 8h).

#### Scenario: S7 — Register new user (201 + cookie)

- GIVEN an active invitation and an email with no existing user
- WHEN POST accept sends `{ "email": "r@x.com", "password": "secret123", "name": "R" }`
- THEN HTTP 201 `{ "id": <uuid>, "email": "r@x.com", "role": "resident" }` with `Set-Cookie` carrying HttpOnly + SameSite=Strict
- AND a `users` row (bcrypt hash), a `resident_units` row, and `invitations.status = 'used'` persist

#### Scenario: S8 — Link existing resident (200)

- GIVEN an active invitation and an existing ACTIVE user with the same email and role `resident`
- WHEN POST accept runs
- THEN HTTP 200 with that user's `{ id, email, role }`, the unit is linked in `resident_units`, and the token is consumed

#### Scenario: S8b — Already-linked resident is idempotent

- GIVEN an active invitation and an existing resident already linked to the target unit
- WHEN POST accept runs
- THEN HTTP 200, no duplicate-membership error (composite PK never trips), and the token is consumed

#### Scenario: S9 — Invalid body rejected without consumption

- GIVEN an active invitation
- WHEN POST accept sends `{ "email": "nope", "password": "short" }`
- THEN HTTP 400 `{ "error": "Solicitud inválida", "details": [...] }`
- AND the invitation remains `status = 'active'`

### Requirement: R5 — Email Conflict Policy

When the submitted email already exists, the system MUST branch on the holder: ACTIVE role `resident` → link (200); any other role (`superadmin`/`condo_admin`/`building_admin`) → HTTP 409, token NOT consumed; a soft-deleted holder → HTTP 409 (the row is physically present per soft-delete semantics, so recreation would violate UNIQUE), token NOT consumed.

#### Scenario: S10 — Non-resident email conflicts (409, no consume)

- GIVEN an active invitation and an existing active `condo_admin` user holding the submitted email
- WHEN POST accept runs
- THEN HTTP 409 `{ "error": "No se puede vincular el email" }`
- AND the invitation stays `active` — retrying with a different email succeeds

#### Scenario: S11 — Soft-deleted holder conflicts (409)

- GIVEN an active invitation and a soft-deleted user holding the submitted email
- WHEN POST accept runs
- THEN HTTP 409 and the token is NOT consumed

### Requirement: R6 — Consumption Semantics

At accept, an unknown token MUST return 404 (generic, anti-enumeration); an expired token MUST return 410; a used token MUST return 409 (state conflict AT consumption — reconciled per the proposal's own 409 definition and success criteria, which the preliminary table's "410 for used" on accept contradicted). Only a fully successful accept MAY mark the token `used`; ANY failure — validation, conflict, expiry, or database error — MUST roll back the transaction and leave the token `active`.

#### Scenario: S12 — Used token at accept is 409

- GIVEN an invitation with `status = 'used'`
- WHEN POST accept runs
- THEN HTTP 409 `{ "error": "Invitación ya utilizada" }`

#### Scenario: S13 — Expired token at accept is 410

- GIVEN an invitation past `expires_at`
- WHEN POST accept runs
- THEN HTTP 410 `{ "error": "Invitación expirada o ya utilizada" }`

#### Scenario: S14 — Unknown token at accept is 404

- GIVEN a random 64-hex token never issued
- WHEN POST accept runs
- THEN HTTP 404 `{ "error": "Invitación no encontrada" }` — no existence leak

#### Scenario: S15 — Failure never consumes the token

- GIVEN an active invitation and a database error mid-transaction (e.g. FK violation)
- WHEN POST accept runs
- THEN the request fails with 5xx, no user/link row persists, and the token remains `active`

### Requirement: R7 — Auto-Login Session

On both 201 and 200, the system MUST issue the session via `signToken({ sub: user.id, role: 'resident' })` (reusing auth.service) through the standard login cookie mechanics; the resident MUST NOT log in separately.

#### Scenario: S16 — Issued cookie is a working session

- GIVEN a successful accept (register or link)
- WHEN the client calls `GET /api/v1/auth/me` with the returned `auth_token` cookie
- THEN HTTP 200 with the resident's `{ id, email, role, name }`