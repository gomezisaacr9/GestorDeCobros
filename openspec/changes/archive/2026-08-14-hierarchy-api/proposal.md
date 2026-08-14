# Proposal: Physical Hierarchy API

## Intent

Build and expose a secure REST API to create and manage the physical hierarchy of the multi-tenant SaaS (Condominiums → Buildings → Units), enforcing strict role-based access control (RBAC). This unlocks the core data-entry flows for admins; resident-unit linking is deferred to a later mini-cycle to keep this change atomic.

## Scope

### In Scope

- **Condominiums** (`/api/v1/condominiums`): create + list. Role: `superadmin` only.
- **Buildings** (`/api/v1/buildings`): create + list within a condominium. Roles: `superadmin`, `condo_admin`.
- **Units** (`/api/v1/units`): create + list within a building. Roles: `superadmin`, `condo_admin`, `building_admin`.
- New middleware `requireRole([...])` reusing the existing `requireAuth` guard.
- Strict Zod validation on all bodies before controllers (pattern: `validateZod`).
- Migration `006_units_add_number` — adds missing `units.number` column (lost in cycle 1, like `users.name`).
- **TDD strict**: install vitest as the test runner; every new component starts with its automated test (RED → GREEN → REFACTOR).
- Follow existing auth patterns: routes → middlewares → controllers → services → repositories → schemas, mounted under `/api/v1/...` in `app.ts`.

### Out of Scope

- Linking `resident` users to units (deferred mini-cycle).
- Update/delete endpoints for the hierarchy (create + list only).
- Pagination, filtering beyond `condominium_id`/`building_id` scoping.
- client-web / client-mobile consumers.

## Capabilities

### New Capabilities

- `hierarchy-api`: condominiums/buildings/units create + list with RBAC (`requireRole`), Zod validation, soft-delete-aware queries, duplicate detection.

### Modified Capabilities

- `server-scaffold`: adds vitest dev dependency and `test` script (TDD runner).
- `tenant-data-model`: migration 006 adds `units.number`.

## Approach

Per-entity flat files (28 new files, ~20-40 lines each) mirroring the verified auth pattern: `condominium.routes.ts`, `condominium.controller.ts`, `condominium.service.ts`, `condominium.repository.ts`, `condominium.schemas.ts` (same for building/unit), plus `middlewares/requireRole.ts`. Lists are soft-delete-aware (`WHERE deleted_at IS NULL`). Both nested routes (`/condominiums/:id/buildings`, `/buildings/:id/units`) and flat filtered routes (`/buildings?condominium_id=`, `/units?building_id=`) are supported. Duplicate names/numbers within the same parent scope return `409 Conflict`. Responses include `id`, `name`/`number`, `created_at`, `updated_at` (never `deleted_at`, `password_hash`, or internal columns).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `server/src/middlewares/requireRole.ts` | New | RBAC guard on `req.user.role` |
| `server/src/routes/{condominium,building,unit}.routes.ts` | New | Router + validateZod + requireAuth + requireRole → controller |
| `server/src/controllers/{condominium,building,unit}.controller.ts` | New | Thin HTTP logic, 201/200/400/401/403/404/409 |
| `server/src/services/{condominium,building,unit}.service.ts` | New | Business logic: existence checks, duplicates |
| `server/src/repositories/{condominium,building,unit}.repository.ts` | New | Knex queries, soft-delete-aware |
| `server/src/schemas/{condominium,building,unit}.schemas.ts` | New | Zod create schemas |
| `server/db/migrations/006_units_add_number.ts` | New | `units.number` nullable→handled at app level |
| `server/src/app.ts` | Modify | Mount 3 routers |
| `server/test/` | New | vitest specs (RED first) |
| `package.json` | Modify | +vitest, `test` script |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `units.number` missing — schema gap | Known (fixed) | Migration 006 before API work |
| No test runner installed | Known (fixed) | vitest installed as first task |
| Role string comparison drift | Med | `requireRole` Set-based check; single source of roles |
| Parent soft-deleted | Med | Child lists of soft-deleted parents return empty (documented behavior) |
| Duplicate race (two concurrent creates) | Low | Service-level check pre-insert; DB partial unique indexes considered but deferred (SQLite) |

## Rollback Plan

No destructive changes to existing data. Migration 006 is additive (`down()` drops the column). API code is additive; revert = revert code. Sessions unaffected (no auth changes).

## Dependencies

- npm: `vitest` (dev).
- Existing: express, zod, knex, better-sqlite3, jsonwebtoken, bcrypt, cookie-parser, dotenv.

## Success Criteria

- [ ] `superadmin` can create and list condominiums; `condo_admin`/`building_admin`/`resident` get 403
- [ ] `superadmin` + `condo_admin` can create/list buildings scoped to a condominium; others 403
- [ ] `superadmin` + `condo_admin` + `building_admin` can create/list units scoped to a building; others 403
- [ ] Zod rejects invalid bodies with 400; unknown parents produce 404; duplicates produce 409
- [ ] Lists exclude soft-deleted rows; responses include timestamps and never leak `deleted_at`
- [ ] `npx vitest run` passes for all hierarchy specs (TDD red/green evidence in tasks)
- [ ] Migration 006 adds `units.number`; rollback clean