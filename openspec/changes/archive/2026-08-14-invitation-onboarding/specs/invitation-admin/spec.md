# Spec: invitation-admin

## Purpose

New capability introduced by change `invitation-onboarding`. Adds the admin-side creation of single-use magic-link invitations: `POST /api/v1/invitations`, guarded by the project's `requireAuth → requireRole → validateZod` chain, with per-jurisdiction RBAC, strict expiry, and hash-only token storage. The raw token is returned exactly once inside `magic_link`; the database stores only its SHA-256 digest. Out of scope: QR generation, rate limiting, listing/pagination, revocation UI.

## Requirements

### Requirement: R1 — Create Invitation Endpoint

The system MUST expose `POST /api/v1/invitations` behind `requireAuth` → `requireRole(['superadmin','condo_admin','building_admin'])` → `validateZod` (HTTP 401 → 403 → 400, fail-closed, matching the unit-routes pattern). Body: `{ "unit_id": uuid }` with optional `"expires_in_hours"`. On success the system MUST return HTTP 201 with `{ "magic_link": string }` where `magic_link` is a URL whose final path segment is the raw token (64 lowercase hex chars); the raw token MUST appear exactly once in the response.

#### Scenario: S1 — Superadmin creates invitation

- GIVEN an authenticated superadmin and an active unit
- WHEN POST /api/v1/invitations sends `{ "unit_id": "u1" }`
- THEN HTTP 201 `{ "magic_link": "/api/v1/invitations/<token>" }` with `<token>` a 64-char lowercase hex string
- AND the token appears exactly once in the response body

#### Scenario: S2 — Condo admin within its condominium

- GIVEN a condo_admin whose `condominium_id = c1` and an active unit under a building of `c1`
- WHEN POST /api/v1/invitations sends `{ "unit_id": "u1" }`
- THEN HTTP 201 with a valid `magic_link`

#### Scenario: S3 — Building admin within its building

- GIVEN a building_admin whose `building_id = b1` and an active unit of `b1`
- WHEN POST sends `{ "unit_id": "u1" }`
- THEN HTTP 201 with a valid `magic_link`

#### Scenario: S4 — Resident denied

- GIVEN a valid session with role `resident`
- WHEN POST /api/v1/invitations runs
- THEN HTTP 403 `{ "error": "Prohibido" }` and the controller never runs

#### Scenario: S5 — No session denied first

- GIVEN no `auth_token` cookie
- WHEN POST /api/v1/invitations runs
- THEN HTTP 401 `{ "error": "No autorizado" }` from `requireAuth`, before any role check

#### Scenario: S6 — Invalid body rejected

- GIVEN a valid admin session
- WHEN sending `{ "unit_id": "not-a-uuid" }` or `{ "unit_id": "u1", "expires_in_hours": -1 }`
- THEN HTTP 400 `{ "error": "Solicitud inválida", "details": [...] }` and no invitation is created

### Requirement: R2 — Jurisdiction Scoping (multi-tenant isolation)

The system MUST restrict issuance to the admin's jurisdiction: superadmin → any active unit; condo_admin → units whose `buildings.condominium_id` equals the admin's `condominium_id`; building_admin → units whose `building_id` equals the admin's `building_id`. A unit outside the jurisdiction, nonexistent, or soft-deleted MUST each return HTTP 404 with the SAME body — indistinguishable (anti-enumeration). 403 is reserved for the role gate (`requireRole`); jurisdiction denial is never 403.

#### Scenario: S7 — Cross-jurisdiction unit is 404

- GIVEN a condo_admin of `c1` and an active unit whose condominium is `c2` (≠ `c1`)
- WHEN POST /api/v1/invitations targets that unit
- THEN HTTP 404 `{ "error": "Unidad no encontrada" }`, byte-identical to the nonexistent-unit response

#### Scenario: S8 — Soft-deleted unit is 404

- GIVEN an active invitation source unit with `deleted_at` set, inside the admin's jurisdiction
- WHEN POST targets it
- THEN HTTP 404 with the same generic body (soft-deleted rows count as absent for issuance)

### Requirement: R3 — Token Generation and Hash-Only Storage

Invitation tokens MUST be generated as `crypto.randomBytes(32).toString('hex')` (256-bit entropy, 64 lowercase hex chars). The system MUST persist ONLY the SHA-256 digest as `invitations.token_hash` (UNIQUE) and MUST NOT store, log, or echo the raw token anywhere but the 201 `magic_link`.

#### Scenario: S9 — Only the hash reaches the database

- GIVEN a successful creation
- WHEN the new `invitations` row is inspected
- THEN `token_hash` equals `sha256(rawToken)` where `rawToken` is the final segment of `magic_link`
- AND no stored column contains the raw token

### Requirement: R4 — Expiry

`expires_in_hours` MUST be an optional integer between 1 and 720 (bounds exposure to ≤ 30 days); when omitted the system MUST default to 72. The system MUST store `expires_at = created_at + expires_in_hours` (ISO text) and treat any invitation with `expires_at <= now` as expired. "expired" is DERIVED — it MUST NOT be persisted as a status value.

#### Scenario: S10 — Default and custom expiry

- GIVEN an admin creating an invitation without `expires_in_hours`
- WHEN POST runs
- THEN `expires_at` equals `created_at + 72h`
- AND with `{ "expires_in_hours": 1 }` the stored `expires_at` is 1 hour after `created_at`