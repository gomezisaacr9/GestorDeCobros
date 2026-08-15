# Proposal: Enterprise Resident Onboarding via Magic Links & QR

## Intent

Residents cannot self-onboard today: admins must create accounts manually, and `users` carries singular FK columns (1:1 unit, CHECK-enforced) that block multi-property residents and magic-link flows. This change adds admin-generated single-use magic links (QR rendered client-side) so residents self-register or link an existing account to their unit.

## Problem & User Goals

- Admin: invite per unit without manual account creation; jurisdiction-scoped issuance.
- Resident: arrive via link/QR, register or link an existing account, land in a session (zero friction).
- Platform: multi-property via M:N `resident_units`; the token IS the authorization for public flows.

## Scope

### In Scope

- Migration 007: `invitations` (token_hash UNIQUE, unit_id, created_by, expires_at, status active/used, derived expired) + `resident_units` (user_id, unit_id, PK composite, created_at); relax `users` CHECK.
- Admin API: create invitation (RBAC-scoped), returns the magic link with raw token exactly once.
- Public API: resolve invitation (no session); accept (register or link + auto session cookie).
- Tests per strict TDD (vitest, temp DB per suite).

### Out of Scope (non-goals)

- QR generation (client-side only), rate limiting (see Risks), invitation listing & pagination, email delivery, frontend landing page, resident_units admin maintenance/removal UI, token revocation UI.

## Capabilities

### New Capabilities

- `invitation-admin`: admin creation API — RBAC matrix, jurisdiction scoping, single-use link issuance.
- `invitation-public`: public resolution (names only), self-registration/linking, auto session cookie.

### Modified Capabilities

- `tenant-data-model`: `users` CHECK resident branch removed; new `invitations` + `resident_units` tables.

## Approach

- **users FKs stay nullable** (admin roles still use `condominium_id`/`building_id`; dropping would break the archived RBAC spec and legacy rows). Only the resident CHECK branch is dropped. SQLite cannot ALTER a CHECK, so migration 007 rebuilds `users` copy-preserving rows (superadmin seed intact).
- **Token**: `crypto.randomBytes(32).toString('hex')` (64 chars); DB stores only SHA-256 `token_hash`, UNIQUE, lookup by hash.
- **Single-use**: `accept` runs in one transaction — resolve token → find/create user → insert `resident_units` → mark `used`; any failure rolls back, token stays active.
- **Email exists**: role resident → link unit + consume; other roles → 409 Conflict (cannot link).
- **Isolation**: admin queries validate jurisdiction ids; public resolver returns only `{condominium, building, unit}` names — no internal ids, no `deleted_at`, no session.

## HTTP Contract (preliminary)

| Endpoint | Auth | Success | Errors |
|---|---|---|---|
| `POST /api/v1/invitations` `{unit_id, expires_in_hours?}` | requireAuth + requireRole | 201 `{magic_link}` (raw token once) | 400/401/403/404 |
| `GET /api/v1/invitations/:token` | none | 200 names only | 404 unknown, 410 expired/used |
| `POST /api/v1/invitations/:token/accept` `{email, password, name}` | none | 201 new / 200 linked + Set-Cookie | 400/404/409/410 |

**410 Gone** (RFC 9110): the link once existed but is unusable — expired OR consumed; 404 means never existed (anti-enumeration); 409 is a state conflict at consumption (already used, or existing email holds another role).

## RBAC Matrix (create invitation)

| Role | Scope |
|---|---|
| superadmin | any unit |
| condo_admin | units of its condominium |
| building_admin | units of its buildings |
| resident | denied (403) |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Token brute force | Low | 256-bit entropy; 72h TTL; single-use; hash-only storage |
| Token in URL/logs | Med | Never log full URLs; TTL + single-use bound exposure; regeneration on demand |
| `users` rebuild data loss | Med | INSERT…SELECT copy in migration, migration specs, `down()` restores CHECK |

## Rollback Plan

`knex migrate:rollback` to 006: `down()` drops `resident_units`/`invitations`, restores the original `users` CHECK (rebuild). Unmount the router, delete routes/controllers/services/schemas. Accept never mutates existing auth endpoints or cookie mechanics (reused only).

## Dependencies

- Migration 006 (`units.number`); jwt-auth cookie mechanics (reused for auto-session); hierarchy soft-delete query patterns.

## Success Criteria

- [ ] Full TDD suite green: migration up/down, admin RBAC (incl. cross-jurisdiction 404), register 201 + cookie, link 200 + cookie, expired 410, used 409, unknown 404.
- [ ] DB contains only SHA-256 token hashes — raw token appears only in the 201 response.
- [ ] Failed `accept` (e.g. duplicate-email conflict pre-link) never consumes the token.
- [ ] building_admin cannot invite units outside its buildings (403/404).