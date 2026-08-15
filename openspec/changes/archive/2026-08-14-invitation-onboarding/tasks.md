# Tasks: Enterprise Resident Onboarding via Magic Links & QR

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 850–1000 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 (stacked-to-main) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Migration 007 + spec | PR 1 | `npx vitest run migration-007` | DB-only (knex up/down) | Migration file + spec only |
| 2 | Domain + repos + services | PR 2 | `npx vitest run invitation.repositories` | DB seed + raw inserts | New files + auth.controller refactor |
| 3 | Controllers + routes + public specs | PR 3 | `npx vitest run invitation-admin invitation-public` | Full HTTP (appRequest) | Routes + app.ts + 3 specs |

## Phase 1: Migration 007

- [x] 1.1 **RED** Write `server/test/migration-007.spec.ts`: tables exist, UNIQUE/status CHECK/composite PK reject, users CHECK relaxed (resident w/o FKs OK), seed survives, down() restores 004 CHECK, re-up clean
- [x] 1.2 **GREEN** Create `server/db/migrations/007_invitations_resident_units.ts`: up rebuilds users (INSERT…SELECT → drop → rename → addIndex ×4), creates resident_units then invitations; down drops both → rebuilds 004 CHECK
- [x] 1.3 Verify: `npx vitest run migration-007` green; full suite green

## Phase 2: Errors + Schemas + Repos + Services

- [x] 2.1 **RED** Write `server/test/invitation.repositories.spec.ts`: linkIfAbsent idempotence, markUsed guard, findUnitInJurisdiction per-role
- [x] 2.2 **GREEN** Add `GoneError { statusCode = 410 }` to `server/src/errors/http-errors.ts`
- [x] 2.3 **GREEN** Create `server/src/schemas/invitation.schemas.ts`: InvitationCreateSchema + AcceptSchema
- [x] 2.4 **GREEN** Create `server/src/repositories/invitation.repository.ts`: findActiveByTokenHash, findUnitChain, findUnitInJurisdiction, insert, markUsed (all with `trx?`)
- [x] 2.5 **GREEN** Create `server/src/repositories/resident-units.repository.ts`: linkIfAbsent (onConflict ignore)
- [x] 2.6 **GREEN** Modify `server/src/repositories/user.repository.ts`: add insert, findAnyByEmail (incl. soft-deleted), trailing `trx?`
- [x] 2.7 **GREEN** Create `server/src/services/session.service.ts`: setSessionCookie (signToken + cookie opts)
- [x] 2.8 **GREEN** Refactor `server/src/controllers/auth.controller.ts`: delegate to session.service
- [x] 2.9 **GREEN** Create `server/src/services/invitation.service.ts`: generateToken, hashToken, create (D3 join), resolve, accept (single trx, D2/D7/D8)
- [x] 2.10 Verify: `npx vitest run invitation.repositories` green

## Phase 3: Controllers + Routes + Integration Specs

- [x] 3.1 **RED** Write `server/test/invitation-admin.spec.ts`: RBAC matrix, jurisdiction 201/404, soft-deleted 404, invalid body 400, hash-only, expiry S10
- [x] 3.2 **GREEN** Create `server/src/controllers/invitation.controller.ts`: create/resolve/accept (no try/catch)
- [x] 3.3 **GREEN** Create `server/src/routes/invitation.routes.ts`: POST guarded, GET/POST :token public
- [x] 3.4 **GREEN** Mount `app.use('/api/v1/invitations', invitationRouter)` in `server/src/app.ts`
- [x] 3.5 Verify: `npx vitest run invitation-admin` green
- [x] 3.6 **RED** Write `server/test/invitation-public.resolve.spec.ts`: S1 names only, S2/S3 404, S4/S5/S6 410
- [x] 3.7 **RED** Write `server/test/invitation-public.accept.spec.ts`: S7 201+cookie, S8/S8b link, S9 400, S10/S11 409, S12 409, S13 410, S14 404, S15 rollback, S16 cookie
- [x] 3.8 **GREEN** Ensure service handles all public spec scenarios
- [x] 3.9 **GREEN** Update `server/test/helpers/db.ts` wipe order: invitations → resident_units → units → buildings → condominiums → users
  - Done early in PR 2 (required by the domain-core specs): actual order is invitations → resident_units → users → units → buildings → condominiums (users references the hierarchy FKs, so it must go before them).
- [x] 3.10 Verify: `npx vitest run invitation-public.resolve invitation-public.accept` green

## Phase 4: Final Validation

- [x] 4.1 Full suite: `npx vitest run` all green
- [x] 4.2 Typecheck: `npx tsc --noEmit` zero errors
