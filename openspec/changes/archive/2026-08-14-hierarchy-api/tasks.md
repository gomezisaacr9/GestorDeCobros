# Tasks: Physical Hierarchy API

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 700–1000 (28 new files + 3 modified; ~600 prod + ~400 test) |
| 400-line budget risk | High (single PR exceeds budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Foundation: vitest + errors + requireRole + migration 006 | PR 1 | `npx vitest run server/test/requireRole.spec.ts server/test/migration-006.spec.ts` | `createApp().listen(0)+fetch` with signToken cookies | vitest.config.ts, setup.ts, helpers/*, http-errors.ts, requireRole.ts, 006 migration — revert removes test infra + middleware |
| 2 | Data layer: schemas + repositories for all 3 entities | PR 2 | `npx vitest run server/test/condominium.schemas.spec.ts server/test/condominium.repositories.spec.ts` | temp DB per suite via setup.ts wipe | schemas/*, repositories/* — revert removes data access, no routes affected |
| 3 | Business + HTTP: services + controllers + routes + app mount | PR 3 | `npx vitest run` (full suite) | `createApp().listen(0)+fetch` full RBAC matrix | services/*, controllers/*, routes/*, app.ts edits — revert removes API surface |

## Phase 1: Foundation

- [x] 1.1 **RED** Write `server/test/smoke.spec.ts`: trivial import test (`describe('vitest runner')`) — expects FAIL until runner configured.
- [x] 1.2 **GREEN** Add `vitest` ^4 devDep to `package.json`, add `"test": "vitest run"` and `"test:watch": "vitest"` scripts. Create `vitest.config.ts`: `env:'node'`, `pool:'forks'`, `setupFiles:['server/test/setup.ts']`, `include:['server/test/**/*.spec.ts']`.
- [x] 1.3 **GREEN** Create `server/test/setup.ts`: set `process.env.SQLITE_PATH` to `tmpdir/gp-test-<pid>.sqlite3`, set `process.env.JWT_SECRET` to test secret. Create `server/test/helpers/db.ts`: `migrateToLatest(knex)` + `wipe(knex)` (DELETE from units, buildings, condominiums, users in FK order). Create `server/test/helpers/http.ts`: `signToken(payload)` + `appRequest(app, method, path, opts?)` using `createApp().listen(0)+fetch`. Verify: `npx vitest run server/test/smoke.spec.ts` passes.
- [x] 1.4 **RED** Write `server/test/requireRole.spec.ts`: (1) allowed role calls next, (2) disallowed role → 403 `{error:'Prohibido'}`, (3) missing `req.user` → 403. Expects FAIL.
- [x] 1.5 **GREEN** Create `server/src/errors/http-errors.ts`: `NotFoundError(message?)`, `ConflictError(message?)` extending `Error` with `statusCode` 404/409. Create `server/src/middlewares/requireRole.ts`: `requireRole(allowed: readonly string[])` → `RequestHandler`; `new Set(allowed)`; `req.user?.role`; 403 `{error:'Prohibido'}`; missing user → fail closed. Verify: `npx vitest run server/test/requireRole.spec.ts` passes.
- [x] 1.6 **RED** Write `server/test/migration-006.spec.ts`: (1) after migrate:latest `columnInfo('units').number` is notNull, (2) insert without number fails, (3) down restores 003 shape, (4) re-run migrate:latest clean. Expects FAIL.
- [x] 1.7 **GREEN** Create `server/db/migrations/006_units_add_number.ts`: up = dropTableIfExists('units') → recreate (uuid PK, building_id uuid NOT NULL FK, number string NOT NULL, timestamps, deleted_at nullable, idx); down = drop + recreate 003 shape. Modify `server/db/knexfile.ts`: `filename: process.env.SQLITE_PATH ?? path.resolve(__dirname,'../dev.sqlite3')`. Verify: `npx vitest run server/test/migration-006.spec.ts` passes.

## Phase 2: Data Layer

- [x] 2.1 **RED** Write `server/test/condominium.schemas.spec.ts`: valid `{name:'A'}` passes; empty name → 400; name > 255 → 400; whitespace-only trims. Expects FAIL.
- [x] 2.2 **GREEN** Create `server/src/schemas/condominium.schemas.ts`: `CondominiumCreateSchema = z.object({name:z.string().trim().min(1).max(255)})`, export inferred type.
- [x] 2.3 **RED** Write `server/test/building.schemas.spec.ts`: valid `{name:'B', condominium_id:uuid}` passes; bad uuid → 400; missing condominium_id → 400. Expects FAIL.
- [x] 2.4 **GREEN** Create `server/src/schemas/building.schemas.ts`: `BuildingCreateSchema = z.object({name:z.string().trim().min(1).max(255), condominium_id:z.string().uuid()})`.
- [x] 2.5 **RED** Write `server/test/unit.schemas.spec.ts`: valid `{number:'101', building_id:uuid}` passes; empty number → 400; number > 50 → 400. Expects FAIL.
- [x] 2.6 **GREEN** Create `server/src/schemas/unit.schemas.ts`: `UnitCreateSchema = z.object({number:z.string().trim().min(1).max(50), building_id:z.string().uuid()})`.
- [x] 2.7 **RED** Write `server/test/condominium.repositories.spec.ts`: insert returns row with timestamps; listByAll excludes soft-deleted, ordered by name ASC; findActiveById returns null for soft-deleted. Expects FAIL.
- [x] 2.8 **GREEN** Create `server/src/repositories/condominium.repository.ts`: `insert(data)` → row; `listByAll()` → name ASC, deleted_at IS NULL; `findActiveById(id)` → row|null; `existsById(id)` → boolean.
- [x] 2.9 **RED** Write `server/test/building.repositories.spec.ts`: insert; listByCondominium scoped + ordered; findActiveById; existsById. Expects FAIL.
- [x] 2.10 **GREEN** Create `server/src/repositories/building.repository.ts`: `insert(data)`; `listByCondominium(condominium_id)`; `findActiveById(id)`; `existsById(id)`.
- [x] 2.11 **RED** Write `server/test/unit.repositories.spec.ts`: insert; listByBuilding scoped + ordered by number ASC; findActiveById; existsById. Expects FAIL.
- [x] 2.12 **GREEN** Create `server/src/repositories/unit.repository.ts`: `insert(data)`; `listByBuilding(building_id)`; `findActiveById(id)`; `existsById(id)`.

## Phase 3: Business Logic

- [x] 3.1 **RED** Write `server/test/condominium.services.spec.ts`: create → 201 shape; duplicate name → ConflictError; list → ordered array. Expects FAIL.
- [x] 3.2 **GREEN** Create `server/src/services/condominium.service.ts`: `create(name)` checks dup via repository, throws `ConflictError` on 409, uuid via `crypto.randomUUID()`, returns public shape; `list()` delegates to repository.
- [x] 3.3 **RED** Write `server/test/building.services.spec.ts`: create with valid parent → 201; soft-deleted parent → NotFoundError; duplicate name in condominium → ConflictError. Expects FAIL.
- [x] 3.4 **GREEN** Create `server/src/services/building.service.ts`: `create(name, condominium_id)` gate via `findActiveById` (NotFoundError), dup check within condominium (ConflictError), uuid, returns shape; `listByCondominium(cid)` delegates.
- [x] 3.5 **RED** Write `server/test/unit.services.spec.ts`: create with valid parent → 201; missing parent → NotFoundError; duplicate number in building → ConflictError. Expects FAIL.
- [x] 3.6 **GREEN** Create `server/src/services/unit.service.ts`: `create(number, building_id)` gate (NotFoundError), dup check within building (ConflictError), uuid, returns shape; `listByBuilding(bid)` delegates.

## Phase 4: HTTP Integration

- [x] 4.1 **RED** Write `server/test/condominium.routes.spec.ts`: full RBAC matrix (superadmin→201/200, resident→403, no cookie→401); create 201 + Location header + shape; invalid body→400; duplicate→409; list excludes soft-deleted. Expects FAIL.
- [x] 4.2 **GREEN** Create `server/src/controllers/condominium.controller.ts`: try/catch → 201/200; catches NotFoundError/ConflictError → 404/409; `toPublic(row)` maps to `{id,name,created_at,updated_at}`. Create `server/src/routes/condominium.routes.ts`: `router.use(requireAuth)`, POST `/` with `requireRole(['superadmin'])` + `validateZod(CondominiumCreateSchema)` → `controller.create`; GET `/` with `requireRole(['superadmin'])` → `controller.list`; GET `/:id/buildings` with `requireRole(['superadmin','condo_admin'])` → `buildingController.listByCondominium`.
- [x] 4.3 **RED** Write `server/test/building.routes.spec.ts`: RBAC (superadmin+condo_admin→201/200, building_admin→403 on create, resident→403); create 201+shape; unknown condominium_id→404; duplicate name in condo→409; list scoped. Expects FAIL.
- [x] 4.4 **GREEN** Create `server/src/controllers/building.controller.ts`: create/listByCondominium, same error pattern. Create `server/src/routes/building.routes.ts`: POST `/` with `requireRole(['superadmin','condo_admin'])` + `validateZod(BuildingCreateSchema)`; GET `/` with same roles; GET `/:id/units` with `requireRole(['superadmin','condo_admin','building_admin'])` → `unitController.listByBuilding`.
- [x] 4.5 **RED** Write `server/test/unit.routes.spec.ts`: RBAC (superadmin+condo_admin+building_admin→201/200, resident→403); create 201+shape; missing building→404; dup number→409; nested 404 vs `[]` soft-deleted. Expects FAIL.
- [x] 4.6 **GREEN** Create `server/src/controllers/unit.controller.ts`: create/listByBuilding, same error pattern. Create `server/src/routes/unit.routes.ts`: POST `/` with `requireRole(['superadmin','condo_admin','building_admin'])` + `validateZod(UnitCreateSchema)`; GET `/` with same roles.
- [x] 4.7 **GREEN** Modify `server/src/app.ts`: import and mount `condominiumRouter` at `/api/v1/condominiums`, `buildingRouter` at `/api/v1/buildings`, `unitRouter` at `/api/v1/units` (after authRouter, before `return app`).
- [x] 4.8 Run full suite: `npx vitest run` — all 14 hierarchy specs + smoke pass. `npm run typecheck` — zero errors.

## Phase 5: Final Verification

- [x] 5.1 Run `npm test` (full `vitest run`) — 0 failures, all hierarchy specs green.
- [x] 5.2 Run `npm run typecheck` — zero type errors.
- [x] 5.3 Smoke end-to-end: `npm run dev` + manual curl (`POST /api/v1/condominiums` with superadmin cookie → 201; `POST /api/v1/buildings` → 201; `POST /api/v1/units` → 201; `GET /api/v1/condominiums` → 200 with array).

### Smoke e2e 5.3 — manual curl (documented, real `createApp` harness executed during apply)

```bash
# 1. Login as superadmin (dev seed) to capture the session cookie
curl -s -c /tmp/gp-cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"email":"superadmin@example.com","password":"<dev-password>"}'

# 2. POST /api/v1/condominiums → 201 + Location
curl -s -b /tmp/gp-cookies.txt -X POST http://localhost:3000/api/v1/condominiums \
  -H 'content-type: application/json' -d '{"name":"Torres del Sol"}'

# 3. POST /api/v1/buildings (condo_admin or superadmin) → 201
curl -s -b /tmp/gp-cookies.txt -X POST http://localhost:3000/api/v1/buildings \
  -H 'content-type: application/json' -d '{"name":"Edificio A","condominium_id":"<condo-id>"}'

# 4. POST /api/v1/units → 201
curl -s -b /tmp/gp-cookies.txt -X POST http://localhost:3000/api/v1/units \
  -H 'content-type: application/json' -d '{"number":"101","building_id":"<building-id>"}'

# 5. GET /api/v1/condominiums → 200 with array (no deleted_at)
curl -s -b /tmp/gp-cookies.txt http://localhost:3000/api/v1/condominiums

# RBAC sanity: no cookie → 401; resident cookie → 403
curl -s http://localhost:3000/api/v1/units                    # 401
curl -s -b /tmp/gp-cookies.txt http://localhost:3000/api/v1/condominiums  # 200 solo superadmin
```

Note: an equivalent automated harness (real `createApp().listen(0)` + fetch, temp DB migrated) was executed during apply and produced 201/201/201 + Location, 200 lists, 403 resident, 401 no-cookie.
