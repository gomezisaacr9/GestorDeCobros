# Spec: hierarchy-api

## Purpose

New capability introduced by change `hierarchy-api`. Adds secured REST endpoints to create and list the physical hierarchy (Condominiums → Buildings → Units) under `/api/v1/`, enforcing per-resource RBAC through a new `requireRole` guard stacked on the existing `requireAuth`, strict Zod validation before controllers, soft-delete-aware queries, and duplicate detection. Out of scope: update/delete endpoints, resident-unit linking, pagination, client-web/mobile consumers.

## Requirements

### Requirement: RBAC Matrix

Hierarchy endpoints MUST run behind `requireAuth` (missing/invalid session → HTTP 401) and MUST restrict access per resource; authenticated roles outside the allowed set MUST receive HTTP 403. Role hierarchy: `superadmin > condo_admin > building_admin > resident`.

| Resource | Allowed roles |
|----------|---------------|
| condominiums | superadmin |
| buildings | superadmin, condo_admin |
| units | superadmin, condo_admin, building_admin |

#### Scenario: Superadmin has full access

- GIVEN a valid session with role `superadmin`
- WHEN creating or listing any hierarchy resource
- THEN the controller executes (201/200)

#### Scenario: Resident always denied

- GIVEN a valid session with role `resident`
- WHEN any hierarchy endpoint is called
- THEN HTTP 403 and the controller never runs

#### Scenario: No session denied first

- GIVEN no session cookie
- WHEN a hierarchy endpoint is called
- THEN HTTP 401 from `requireAuth`, before any role check runs

### Requirement: requireRole Middleware

The system MUST provide a `requireRole(...allowedRoles)` middleware that reads `req.user.role` (injected by `requireAuth`). It MUST call `next()` only for roles in the allowed set; otherwise it MUST respond HTTP 403 with body `{ "error": "Prohibido" }` and stop the chain.

#### Scenario: Allowed role passes

- GIVEN `req.user.role = "condo_admin"` injected by `requireAuth`
- WHEN `requireRole("superadmin", "condo_admin")` runs
- THEN `next()` is called and the controller executes

#### Scenario: Disallowed role blocked

- GIVEN `req.user.role = "building_admin"` injected by `requireAuth`
- WHEN `requireRole("superadmin")` runs
- THEN HTTP 403 `{ "error": "Prohibido" }` and the controller never executes

### Requirement: Create Hierarchy Endpoints

`POST /api/v1/condominiums`, `POST /api/v1/buildings`, and `POST /api/v1/units` MUST validate the body with Zod before the controller (pattern `validateZod`) and on success MUST return HTTP 201 with the created resource (`id`, `name`|`number`, `created_at`, `updated_at`) and a `Location` header. Bodies: condominiums `{ name: string 1-255 }`; buildings `{ name: string 1-255, condominium_id: uuid }`; units `{ number: string 1-50, building_id: uuid }`. These endpoints MUST return HTTP 400 for invalid bodies, 404 for missing or soft-deleted parents, 409 for duplicates (condominium `name` globally; building `name` within its condominium; unit `number` within its building), 401 without session, 403 for disallowed roles.

#### Scenario: Create building succeeds

- GIVEN an active condominium and a valid `condo_admin` session
- WHEN `POST /api/v1/buildings` sends a valid body
- THEN HTTP 201 with the resource and timestamps, plus a `Location` header

#### Scenario: Invalid unit number

- GIVEN a valid session calling `POST /api/v1/units`
- WHEN `number` is empty or longer than 50 characters
- THEN HTTP 400 with `{ error, details }` and the controller never runs

#### Scenario: Unknown parent building

- GIVEN a valid session calling `POST /api/v1/buildings`
- WHEN `condominium_id` does not exist or belongs to a soft-deleted condominium
- THEN HTTP 404

#### Scenario: Duplicate unit number

- GIVEN an active unit `number: "101"` in building `b1`
- WHEN a unit with `number: "101"` and `building_id: "b1"` is created
- THEN HTTP 409

### Requirement: List Hierarchy Endpoints

`GET /api/v1/condominiums`, `GET /api/v1/buildings?condominium_id=`, `GET /api/v1/condominiums/:id/buildings`, `GET /api/v1/units?building_id=`, and `GET /api/v1/buildings/:id/units` MUST return HTTP 200 with arrays shaped `{ id, name|number, created_at, updated_at }`, MUST exclude soft-deleted rows (`deleted_at IS NULL`), and MUST NOT expose `deleted_at`. Nested routes MUST return HTTP 200 `[]` when the parent exists but is soft-deleted, and HTTP 404 when the parent id does not exist.

#### Scenario: Flat scoped list

- GIVEN condominium `c1` with two active buildings and one soft-deleted building
- WHEN `GET /api/v1/buildings?condominium_id=c1`
- THEN HTTP 200 with exactly the two active buildings and no `deleted_at` key

#### Scenario: Soft-deleted parent list

- GIVEN a building whose `deleted_at` is set
- WHEN `GET /api/v1/buildings/:id/units`
- THEN HTTP 200 with an empty array

#### Scenario: Nonexistent parent list

- GIVEN no condominium with `id = c999`
- WHEN `GET /api/v1/condominiums/c999/buildings`
- THEN HTTP 404

### Requirement: TDD Test Coverage

The change MUST add `vitest` as a dev dependency and a `test` script running `vitest run`; every new component (migration, middleware, schemas, routes, controllers, services, repositories) MUST ship vitest specs under `server/test`, and the FIRST implementation task of each component MUST be its failing spec (RED) before the component code (GREEN). Migration 006 MUST be exercised through `migrate:latest`/`migrate:rollback` in specs.

#### Scenario: Suite passes as evidence

- GIVEN all hierarchy tasks complete
- WHEN `npm test` (or `npx vitest run`) executes
- THEN the suite runs and every hierarchy spec passes

#### Scenario: RED-first ordering

- GIVEN a component task list
- WHEN the first task of a component is inspected
- THEN it writes the failing spec (RED) and the component code lands in a later task
