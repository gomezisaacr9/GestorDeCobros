# Design: Enterprise Resident Onboarding via Magic Links & QR

## Technical Approach

Same layered pattern as the existing stack (routes→middlewares→controllers→services→repositories→db, per `openspec/config.yaml`). One router at `/api/v1/invitations` with mixed guards: the admin `POST /` mounts `requireAuth → requireRole → validateZod` (fail-closed 401→403→400, `unit.routes.ts:13-20`); `GET /:token` and `POST /:token/accept` stay public (no `router.use(requireAuth)`). Migration 007 rebuilds `users` copy-preserving rows (SQLite cannot ALTER a CHECK), adds `invitations` + `resident_units`, and touches zero existing auth code — cookie issuance is extracted into a shared `session.service` consumed by both `auth.controller.login` and accept. Raw token generated in the service (256-bit entropy), persisted as SHA-256 digest only, consumed inside one knex transaction. Specs: `invitation-admin` R1–R4, `invitation-public` R1–R7, `tenant-data-model` (all scenarios).

## Architecture Decisions

| # | Decision | Options considered | Choice & rationale |
|---|---|---|---|
| D1 | users rebuild | (a) rename-then-recreate → index-name collisions (SQLite index names are schema-global); (b) create `users_new_007` **without** named indexes → `INSERT…SELECT` (11 columns enumerated) → `dropTable` → `renameTable` → `addIndex` ×4 | **(b)**. No collisions ever; rows preserved byte-exact incl. superadmin seed (no reseed); `down()` mirrors it restoring the **verbatim 004 CHECK string** (`004_users.ts:39-44`) after dropping `invitations`/`resident_units` first |
| D2 | accept atomicity | naive multi-statement flow vs one `knex.transaction` | One **service-owned** transaction; every repo method gains optional trailing `trx: Knex.Transaction = connection`; `markUsed` guarded `WHERE id=? AND status='active'` → 0 rows ⇒ `ConflictError('Invitación ya utilizada')`; any throw ⇒ rollback, token stays active (R6 S15) |
| D3 | admin jurisdiction | enrich `requireAuth` with DB lookup (perf hit on every guarded route) vs service-side lookup | **Service-side**: `create` loads admin via `userRepository.findById(actor.id)` (missing ⇒ `NotFoundError('Unidad no encontrada')`, fail closed), then ONE joined query `units⋈buildings⋈condominiums` with role-conditioned predicates (condo: `condominiums.id=admin.condominium_id`; building: `buildings.id=admin.building_id`; superadmin: none) + `whereNull deleted_at` ×3. Single fetch, no N+1; unknown/cross/soft-deleted unit → byte-identical 404 |
| D4 | auto-login cookie | import `setSessionCookie` from `auth.controller` (controllers→controllers import breaks layering) vs duplicate 10-line opts vs shared module | New `session.service.setSessionCookie(res, sub)` = `signToken({sub, role})` + auth.controller's exact opts (`httpOnly`, `secure: env.NODE_ENV !== 'development'`, `sameSite:'strict'`, `path:'/'`, `maxAge 8h`); `auth.controller.login` refactored to use it. No drift |
| D5 | `req.user` in public flows | — | **Never used.** `resolve`/`accept` read only `:token` + body; the session subject is the user row resolved inside the transaction, not a JWT (`requireAuth` injects `{id, role}` only — unchanged) |
| D6 | 410 Gone | extend `http-errors.ts` vs inline `res.status(410)` | New `GoneError extends Error { readonly statusCode = 410 }`; `errorHandler` (`errorHandler.ts:16-24`) already maps `err.statusCode` — zero new middleware |
| D7 | expiry storage | ISO `toISOString()` (mixed formats break string comparison against knex sqlite `YYYY-MM-DD HH:MM:SS` timestamps) | Store via `knex.raw("datetime('now', ?)", ['+N hours'])`; compare `expires_at <= connection.fn.now()` — same format ⇒ correct lexicographic order. Single-use consumed at `invitations` insert. |
| D8 | dead unit chain | separate lookups | One `findUnitChain(unitId, trx?)` join used by resolve AND accept; dead/missing chain → 410 (GET R3 S6 and accept share the reconciled `'Invitación expirada o ya utilizada'` body) |

## File Structure

```
server/db/migrations/007_invitations_resident_units.ts     Create  (up: rebuild users reduced CHECK → resident_units → invitations; down: drop both → rebuild 004 CHECK)
server/src/errors/http-errors.ts                            Modify  (GoneError, statusCode 410)
server/src/schemas/invitation.schemas.ts                    Create  (InvitationCreateSchema, AcceptSchema)
server/src/repositories/invitation.repository.ts            Create  (findActiveByTokenHash, findUnitChain, findUnitInJurisdiction, insert, markUsed)
server/src/repositories/resident-units.repository.ts        Create  (linkIfAbsent — onConflict(['user_id','unit_id']).ignore(), idx0 = PK … for idempotence S8b)
server/src/repositories/user.repository.ts                  Modify  (insert, findAnyByEmail incl. soft-deleted; trailing trx param)
server/src/services/invitation.service.ts                   Create  (create, resolve, accept; token gen + sha256 helpers)
server/src/services/session.service.ts                      Create  (setSessionCookie — D4)
server/src/controllers/auth.controller.ts                   Modify  (login uses session.service; remove local setSessionCookie)
server/src/controllers/invitation.controller.ts             Create  (create/resolve/accept — no try/catch, Express 5 → errorHandler)
server/src/routes/invitation.routes.ts                      Create  (mixed guards — admin POST guarded, public GET/POST :token)
server/src/app.ts                                           Modify  (app.use('/api/v1/invitations', invitationRouter))
server/test/helpers/db.ts                                   Modify  (wipe order: invitations → resident_units → units → buildings → condominiums → users)
server/test/migration-007.spec.ts                           Create
server/test/invitation-admin.spec.ts                        Create
server/test/invitation-public.resolve.spec.ts               Create
server/test/invitation-public.accept.spec.ts                Create
server/test/invitation.repositories.spec.ts                 Create
```

## Key Components

```ts
// services/invitation.service.ts
generateToken(): string            // randomBytes(32).toString('hex')
hashToken(raw: string): string     // createHash('sha256') hex — ONLY value persisted
create(actor: {id,role}, input: {unit_id, expires_in_hours?: 1..720=72}): Promise<{magic_link: string}>
resolve(raw: string): Promise<{condominium: string; building: string; unit: string}>
accept(raw: string, input: {email,password,name?}): Promise<{user: PublicUser; created: boolean}>

// repositories/invitation.repository.ts (all ops accept trx?)
findActiveByTokenHash(hash: string, trx?): Promise<InvitationRow | undefined>   // whereNull deleted_at
findUnitChain(unitId: string, trx?): Promise<UnitChain | undefined>              // units⋈buildings⋈condominiums, active ×3
findUnitInJurisdiction(unitId: string, admin: AdminRow): Promise<UnitChain | undefined>
insert(data: {id,token_hash,unit_id,created_by,expires_at}, trx?): Promise<void>
markUsed(id: string, trx?): Promise<number>                                      // WHERE id AND status='active'
```

## Transaction / Sequence

**accept** (R6 — any failure rolls back; token stays active):

```
POST /:token/accept {email,password,name?}
  ├─ validateZod → 400 (no consumption)
  └─ invitationService.accept(raw):
     trx = await connection.transaction()
     hash = sha256(raw)
     inv = findActiveByTokenHash(hash, trx)      → !inv ⇒ 404 'Invitación no encontrada'
     inv.status==='used'                         → 409 'Invitación ya utilizada'
     inv.expires_at <= fn.now()                  → 410 'Invitación expirada o ya utilizada'
     chain = findUnitChain(inv.unit_id, trx)     → null ⇒ 410 (dead link)
     holder = findAnyByEmail(email, trx)         → deleted_at set ⇒ 409 'No se puede vincular el email' (R5 S11)
                                                  → role!=='resident' ⇒ 409 (R5 S10)
                                                  → resident ⇒ user=holder, created=false
                                                  → none ⇒ insert user (bcrypt 12, role:'resident', name) 
                                                     [UNIQUE(email) race ⇒ 409 'No se puede vincular el email']
     linkIfAbsent(user.id, inv.unit_id, trx)     (idempotent S8b)
     n = markUsed(inv.id, trx)                   → n===0 ⇒ 409 'Invitación ya utilizada' (concurrent consume)
     trx.commit()  → controller: status 201/200 + {id,email,role:'resident',name} + setSessionCookie(res, user.id)
     catch ⇒ trx.rollback(); rethrow
```

**create (admin)**: load admin row → single jurisdiction join (D3) → generate raw + hash → insert `{token_hash, unit_id, created_by, expires_at: datetime('now','+N hours')}` → 201 `{magic_link: '/api/v1/invitations/<raw>'}`. Raw appears exactly once; never logged.

**resolve (public)**: hash → lookup → 404/410 (used OR expired OR dead chain) → 200 names only.

## Data Model Changes

- `users` (rebuilt): same 11 columns/unique/FKs; CHECK reduced to `superadmin`/`condo_admin`/`building_admin` branches (unchanged) + `role='resident'` alone — resident FKs unrestricted (`tenant-data-model`).
- `invitations`: `id` UUID PK, `token_hash` TEXT NOT NULL UNIQUE, `unit_id` FK→units, `created_by` FK→users, `expires_at` TEXT NOT NULL, `status` CHECK IN ('active','used'), timestamps, nullable `deleted_at`. `expired` never stored (D7).
- `resident_units`: composite PK (`user_id`,`unit_id`), FKs, `created_at`; no `id`, no `deleted_at`.
- Creation order in 007: rebuild `users` first (no inbound FKs yet) → `resident_units` → `invitations`.

## Error Handling

| Code | Source | Body `error` |
|---|---|---|
| 404 | unknown token (GET+accept), deleted invitation, malformed token (hashed, no format check — R2 S3) | `Invitación no encontrada` |
| 404 | unit unknown / cross-jurisdiction / soft-deleted (create) | `Unidad no encontrada` (byte-identical) |
| 410 | expired, dead unit chain (GET+accept) | `Invitación expirada o ya utilizada` |
| 409 | used at accept, non-resident/soft-deleted holder, create race | `Invitación ya utilizada` / `No se puede vincular el email` |
| 400 | Zod bodies | `Solicitud inválida` + `details` |

Controllers never build error bodies; errors bubble to `errorHandler` (existing pattern).

## Testing Strategy

Safety-net baseline first: `npx vitest run` green on the existing 19 spec files, then RED per piece (strict TDD, temp DB per fork via `setup.ts`, `migrateToLatest`/`wipe`/`appRequest`/`signToken` helpers).

| Spec | Coverage (spec scenarios → tests) |
|---|---|
| `migration-007.spec.ts` | tables exist; UNIQUE token_hash + status CHECK reject; composite PK reject; users CHECK relaxed (resident w/o FKs OK; legacy resident + superadmin w/ FK reject); seed survives rebuild (1 superadmin, id/email/hash intact); `migrate.down()` → tables gone + 004 CHECK restored + rows survive; re-up clean |
| `invitation-admin.spec.ts` | RBAC matrix (super/condo/building→201; resident→403; none→401) with **real seeded user rows** for admins (D3 lookup needs them; CHECK-compliant seeds); S2/S3 jurisdiction 201; S7 cross-jurisdiction 404 byte-identical; S8 soft-deleted unit 404; S6 invalid bodies 400; S9 hash-only storage assertion; S10 default/custom expiry |
| `invitation-public.resolve.spec.ts` | S1 200 names only (no ids/timestamps/deleted_at/created_by/status keys); S2 random token 404; S3 malformed 404; S4 expired 410; S5 used 410; S6 dead unit 410 |
| `invitation-public.accept.spec.ts` | S7 201+cookie (users row bcrypt, resident_units row, status used); S8 200 link; S8b idempotent; S9 400 no consume; S10/S11 409 no consume + retry succeeds; S12 used 409; S13 expired 410; S14 unknown 404; S15 rollback (Promise.all double-accept on one token: exactly one 2xx, 1 user row, 1 resident_units, status used, no partial state); S16 cookie works vs `/auth/me` |
| `invitation.repositories.spec.ts` | `linkIfAbsent` idempotence; `markUsed` guard (0-row when already used); `findUnitInJurisdiction` per-role predicates |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary (pure HTTP API + knex migration).

## Migration / Rollout

Migration 007 is the rollout itself: up copies rows, then future writes take the new shape; no feature flag (repo has none). Rollback: `knex migrate:rollback` → down() drops both tables + restores 004 CHECK; unmount router; delete routes/controllers/services/schemas. No data migration beyond the rebuild.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| users rebuild data loss | High | INSERT…SELECT enumerated columns + migration spec asserting seed/id/hash survival; down() spec-restored CHECK |
| Raw token in logs/URLs | High | Generated in service, hashed before persist, never logged; `magic_link` appears once in 201; TTL 72h + single-use bound exposure |
| Index-name collisions on rebuild | Med | D1 two-step (indexes added post-rename) |
| Concurrent accept | Med | `markUsed` guarded update + UNIQUE catch (D2); invariant asserted in S15 RED test |
| Cross-format expiry comparison | Med | D7 single sqlite datetime format |
| No FK enforcement (no PRAGMA in knexfile) | Low | App-level chain checks always run (D8); S15 uses constraint/unique errors, not FKs |

## Open Questions

- None blocking. Confirm: deleted `invitations` rows resolve 404 (treated as never existed; no spec scenario — documented D1+design choice). Accept on expired-yet-`used` returns 410 (expired checked before used).