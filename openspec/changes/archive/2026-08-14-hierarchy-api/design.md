# Design: hierarchy-api

## Technical Approach

Per-entity flat files (routes → middlewares → controllers → services → repositories → schemas) mirroring the verified auth pattern, mounted under `/api/v1/...` in `app.ts`. Strict TDD: vitest 4 with explicit imports, per-suite temp SQLite databases, `createApp().listen(0) + fetch` (smoke-auth pattern). Covers hierarchy-api spec reqs 1–5 plus deltas: server-scaffold (vitest + `test` script) and tenant-data-model (migration 006).

## Architecture Decisions

| # | Question | Options | Choice |
|---|---|---|---|
| D1 | vitest globals vs imports | `"vitest/globals"` in tsconfig `types` + config `globals:true` vs explicit imports | **Explicit imports** — zero tsconfig/config coupling, strict-mode safe, matches codebase explicit-import style. tsconfig untouched. |
| D2 | Test DB isolation | dev.sqlite3+truncate / `:memory:` / temp file per suite | **Temp file per test-file process**: knexfile honors `SQLITE_PATH` env; `test/setup.ts` sets `tmpdir/gp-test-<pid>.sqlite3`; vitest `pool:'forks'` ⇒ isolated process+DB per spec; `migrateToLatest()` in beforeAll, `wipe()` in beforeEach. Never touches `server/dev.sqlite3` (holds seed superadmin; migration-006 rollback would destroy it). |
| D3 | HTTP harness | supertest vs fetch | **`createApp().listen(0)+fetch`** — proven in smoke-auth.ts, zero new deps, owns server lifecycle. |
| D4 | requireRole signature | variadic rest vs array | **`(allowed: readonly string[]) => RequestHandler`**; `new Set(allowed)`; `req.user?.role`; 403 `{error:'Prohibido'}`; missing `req.user` ⇒ 403 (fail closed). |
| D5 | Middleware order | validate-before-authz vs authz-before-validate | **`requireAuth → requireRole → validateZod → controller`** — 401→403→400 fail-closed; matches existing rotate route (auth first). |
| D6 | Error typing | strings / union returns / classes | **`errors/http-errors.ts`: `NotFoundError`, `ConflictError`** thrown by services, caught in controllers → 404/409 JSON. Three flows share 404/409; keeps controllers thin. Messages in Spanish (codebase convention); `Prohibido` per spec. |
| D7 | UUID generation | repo vs service | **Service** (via `crypto.randomUUID()`, node builtin — no new import); repos stay dumb CRUD like `user.repository`. |
| D8 | Duplicate enforcement | partial unique index vs service pre-check | **Service pre-check** (`parent scope + name/number + deleted_at IS NULL` ⇒ 409). Proposal deferred DB indexes; race risk Low (SQLite single-writer); future hardening. |
| D9 | List ordering | created_at ASC vs name/number ASC | **name/number ASC** — deterministic strings, no timestamp-granularity tiebreakers, human alpha order. `orderBy('name','asc')`. |
| D10 | Nested 404 vs [] | one query vs two | **Two repo methods**: `findActiveById` (create gate: soft-deleted parent ⇒ 404) and `existsById` (any row, ignoring soft-delete: nested-list 404 gate). Lists always `WHERE deleted_at IS NULL` ⇒ soft-deleted parent ⇒ 200 `[]`. |
| D11 | Migration 006 | `alterTable().notNullable()` vs recreate | **Recreate**: SQLite `ADD COLUMN` + NOT NULL requires a non-NULL default (schema rule — fails even on empty tables), yet no default is allowed (spec: insert without `number` MUST fail). `units` has zero rows (no write path existed) ⇒ drop+recreate safe. `down()` restores 003 shape. |
| D12 | Partial unique index (number per building) | include vs omit | **Omit** — 409 handled at service (D8); proposal explicitly deferred; keeps 006 minimal. |

## Data Flow

```
POST /api/v1/buildings
  requireAuth → requireRole(['superadmin','condo_admin']) → validateZod → buildingController.create
    → buildingService.create(name, condominium_id)
        findActiveById(condominium_id)  ∄/soft-deleted ⇒ NotFoundError → 404
        name dup in condominium         ⇒ ConflictError  → 409
        id = randomUUID(); repo.insert  → 201 {id,name,created_at,updated_at} + Location
```

`GET /api/v1/condominiums/:id/buildings`: `existsById(id)` ∄ ⇒ 404; else `listByCondominium` (`deleted_at IS NULL`, name ASC) ⇒ 200 `[]` even when parent soft-deleted.

## File Changes

| File | Action | Role |
|---|---|---|
| `server/src/middlewares/requireRole.ts` | Create | D4 guard |
| `server/src/errors/http-errors.ts` | Create | D6 |
| `server/src/schemas/{condominium,building,unit}.schemas.ts` | Create | Zod create schemas + `z.infer` types |
| `server/src/repositories/{condominium,building,unit}.repository.ts` | Create | insert / findActiveById / existsById / scoped ordered list |
| `server/src/services/{condominium,building,unit}.service.ts` | Create | parent gate, duplicate check, uuid (D7) |
| `server/src/controllers/{condominium,building,unit}.controller.ts` | Create | thin; toPublic mapper; try/catch → 404/409 |
| `server/src/routes/{condominium,building,unit}.routes.ts` | Create | chains per routing table |
| `server/db/migrations/006_units_add_number.ts` | Create | D11 |
| `server/src/app.ts` | Modify | mount 3 routers |
| `server/db/knexfile.ts` | Modify | `filename: process.env.SQLITE_PATH ?? path.resolve(__dirname,'../dev.sqlite3')` |
| `package.json` | Modify | +`vitest` devDep (^4), `test` = `vitest run`, `test:watch` = `vitest` |
| `vitest.config.ts` | Create | node env, `pool:'forks'`, setupFiles, `include: ['server/test/**/*.spec.ts']` |
| `server/test/setup.ts`, `helpers/db.ts`, `helpers/http.ts` | Create | SQLITE_PATH setup; migrateToLatest/wipe; listen(0)+cookie helpers |
| `server/test/{requireRole, condominium/building/unit.{schemas,services,repositories,routes}, migration-006}.spec.ts` (14) | Create | RED-first specs |

Mounted routes:

| Mount (app.ts) | Route | Guard chain |
|---|---|---|
| `/api/v1/condominiums` | GET `/`, POST `/` | `requireAuth, requireRole(['superadmin'])` (+validateZod on POST) |
| | GET `/:id/buildings` | `requireAuth, requireRole(['superadmin','condo_admin'])` → `buildingController.listByCondominium` |
| `/api/v1/buildings` | GET `/`, POST `/` | `requireAuth, requireRole(['superadmin','condo_admin'])` (+validateZod) |
| | GET `/:id/units` | `requireAuth, requireRole(['superadmin','condo_admin','building_admin'])` → `unitController.listByBuilding` |
| `/api/v1/units` | GET `/`, POST `/` | `requireAuth, requireRole(['superadmin','condo_admin','building_admin'])` (+validateZod) |

Nested routes are explicit lines in the parent router delegating to the child controller — **never** `router.use('/:id/buildings', buildingRouter)` (would leak the child's POST and `/:id/units` under the parent prefix).

## Interfaces / Contracts

```ts
export function requireRole(allowed: readonly string[]): RequestHandler; // else 403 { error: 'Prohibido' }

// schemas (validateZod replaces req.body with parsed value)
CondominiumCreateSchema = z.object({ name: z.string().trim().min(1).max(255) });
BuildingCreateSchema   = z.object({ name: z.string().trim().min(1).max(255), condominium_id: z.string().uuid() });
UnitCreateSchema       = z.object({ number: z.string().trim().min(1).max(50), building_id: z.string().uuid() });

// persisted row (internal); controllers map to public { id, name|number, created_at, updated_at }
interface HierarchyRow { id: string; created_at: string; updated_at: string; deleted_at: string | null; }
```

Responses: create 201 `{id, name|number, created_at, updated_at}` + `Location: /api/v1/<resource>/<id>`; list 200 array of same shape, never `deleted_at`; 400 `{error:'Solicitud inválida', details}` (existing validateZod).

## Migration 006

`up`: `dropTableIfExists('units')` → recreate (uuid PK, `building_id` uuid NOT NULL FK→buildings, `number` string NOT NULL, timestamps, nullable `deleted_at`, `idx_units_building_id`). No default. `down`: drop + recreate original 003 shape.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | requireRole (allowed/denied/no-user); schemas (valid, empty, whitespace-only, over-max, bad uuid, trim); services (parent gate, duplicate); errors | direct calls, no HTTP |
| Integration | RBAC matrix per resource (superadmin/condo_admin/building_admin/resident → 200/403; no cookie → 401); create 201+Location+shape; 400 details; 404 parent; 409 dup; nested 404 vs `[]` | `createApp().listen(0)+fetch`; cookies minted via `signToken` (hierarchy never queries users ⇒ no seed users needed) |
| Repo | insert returns row with timestamps; list excludes soft-deleted, scoping filters, name/number ASC; `existsById` ignores soft-delete | temp DB + migrateToLatest + wipe between tests |
| Migration 006 | `columnInfo('units').number` notNull; insert without `number` fails; rollback; `migrate:latest` re-runs clean | knex `migrate.latest/rollback` on the suite's temp DB |

**RED→GREEN order**: vitest harness (trivial smoke spec) → requireRole → migration 006 → per resource bottom-up (schemas → repositories → services → routes+controllers HTTP integration) → mount in `app.ts` → suite green. The first task of every component writes its failing spec (RED); component code lands in a later task (GREEN).

## Threat Matrix

| Boundary | Applicability | Design response | RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — Express route handlers, no file-execution boundary | — | — |
| Git repository selection | N/A — no VCS invocation | — | — |
| Commit state | N/A — no git calls | — | — |
| Push state | N/A — no git calls | — | — |
| PR commands | N/A — no PR automation | — | — |

This design's routing is in-process middleware composition, not shell/subprocess/process integration. The routing requirement is middleware order (D5): integration tests assert 401 before 403 before 400 and that role checks precede validation.

## Migration / Rollout

Migration 006 recreates a guaranteed-empty table — additive in effect, no data loss; `down()` restores the 003 shape and full rollback empties the DB. API code additive; revert = revert code. Auth/sessions untouched.

## Open Questions

None. (Flat-list filter with a malformed `condominium_id`/`building_id` is spec-silent: pass-through, matching zero rows → `[]`.)