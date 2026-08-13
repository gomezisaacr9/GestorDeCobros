# Tasks: JWT Authentication & Credential Rotation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 650–750 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | single PR (under 800-line session budget) |
| Delivery strategy | ask-on-risk |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Medium

> Budget is under the 800-line session guard but exceeds the 400-line default PR review budget. Since `delivery_strategy: ask-on-risk` and the session allows 800 lines, a single PR is appropriate. The orchestrator should confirm before apply.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Foundation: deps, config, migration, schemas | PR 1 | `npm run typecheck` | N/A — infra only, no runtime behavior | Revert package.json, .env.example, .gitignore, migration 005 |
| 2 | Core: services, repositories, controllers, routes, middlewares | PR 1 | `npm run typecheck` | N/A — compiles but untested | Revert server/src/** files; migration stays |
| 3 | Smoke verification | PR 1 | `npx tsx server/scripts/smoke-auth.ts` | In-process app.listen(0) + fetch | Revert smoke-auth.ts only |

## Phase 1: Foundation & Infrastructure

- [x] 1.1 Create `server/db/migrations/005_users_add_name.ts` — `ALTER TABLE users ADD COLUMN name TEXT` (nullable) in `up()`; `dropColumn('name')` in `down()`
- [x] 1.2 Run `npm run migrate:latest` — verify migration applies cleanly on `server/dev.sqlite3`
- [x] 1.3 Update `package.json` — add deps: `express`, `zod`, `dotenv`, `cookie-parser`, `jsonwebtoken`, `bcrypt`; add devDeps: `@types/express`, `@types/cookie-parser`, `@types/jsonwebtoken`, `@types/bcrypt`; add scripts: `"dev": "tsx watch server/src/index.ts"`, `"start": "tsx server/src/index.ts"`
- [x] 1.4 Run `npm install`
- [x] 1.5 Create `.env.example` with `JWT_SECRET=`, `NODE_ENV=development`, `PORT=3000`
- [x] 1.6 Update `.gitignore` — add `.env` line
- [x] 1.7 Create `.env` locally with a test `JWT_SECRET` value
- [x] 1.8 Create `server/src/config/env.ts` — `dotenv.config()`, assert `JWT_SECRET` non-empty (throw on missing), export `env` object with `JWT_SECRET`, `NODE_ENV`, `PORT`

## Phase 2: Schemas & Middlewares

- [x] 2.1 Create `server/src/schemas/auth.schemas.ts` — `LoginSchema` (email: string+email, password: string); `RotateSchema` (currentPassword: string, newPassword: string min 8 max 128)
- [x] 2.2 Create `server/src/middlewares/validateZod.ts` — generic middleware: `schema.parse(req.body)` on success, catch ZodError → 400 with details array
- [x] 2.3 Create `server/src/middlewares/requireAuth.ts` — read `auth_token` from `req.cookies`, `jwt.verify()` with `env.JWT_SECRET`, inject `req.user = { id: sub, role }`, 401 on missing/invalid/expired

## Phase 3: Core Implementation

- [x] 3.1 Create `server/src/repositories/user.repository.ts` — `findByEmail(email)` selecting explicit columns `[id, email, role, name, password_hash, deleted_at]` WHERE `deleted_at IS NULL`; `findById(id)` same columns; `updatePasswordHash(id, hash)` UPDATE
- [x] 3.2 Create `server/src/services/auth.service.ts` — `verifyPassword(password, hash)`: dispatch by prefix (`$2*` → bcrypt.compare; `scrypt$...` → scryptSync+timingSafeEqual; else → false); `hashPassword(password)` → bcrypt hash cost 12; `signToken(payload)` → jwt.sign 8h HS256; `verifyToken(token)` → jwt.verify; include dummy bcrypt.compare on user-not-found path for anti-enumeration
- [x] 3.3 Create `server/src/controllers/auth.controller.ts` — `login`: validateZod → service.verifyCredentials → signToken → `res.cookie('auth_token', token, { httpOnly, secure, sameSite: 'strict', path: '/', maxAge: 8h })` → 200 `{ id, email, role, name }`; 401 generic; `me`: requireAuth → repo.findById → 200 public shape or 401; `rotate`: requireAuth → validateZod → verify currentPassword → hashPassword(new) → repo.updatePasswordHash → 200
- [x] 3.4 Create `server/src/routes/auth.routes.ts` — `POST /login`, `GET /me`, `PATCH /password/rotate` with validateZod + requireAuth middleware
- [x] 3.5 Create `server/src/app.ts` — Express factory: `express.json()`, `cookieParser()`, mount auth router at `/api/v1/auth`; export `app` (no listen)
- [x] 3.6 Create `server/src/index.ts` — import `./config/env` (triggers fail-fast), `import app from './app'`, `app.listen(PORT ?? 3000)`

## Phase 4: Smoke Verification

- [x] 4.1 Create `server/scripts/smoke-auth.ts` — in-process probes: (1) login OK → 200, cookie flags HttpOnly+SameSite=Strict, body `{id,email,role,name}`; (2) login wrong pw → 401 generic; (3) login unknown email → 401 identical body; (4) `/me` valid cookie → 200; (5) `/me` no cookie → 401; (6) `/me` soft-deleted user → 401; (7) rotate success → 200, old pw fails, new pw logs in, stored hash starts with `$2b$`; (8) rotate wrong current → 401; (9) Zod 400s: missing email, 7-char new pw; (10) fail-fast: `env -u JWT_SECRET tsx server/src/index.ts` exits non-zero
- [x] 4.2 Run `npm run typecheck` — verify zero TS errors
- [x] 4.3 Run `npx tsx server/scripts/smoke-auth.ts` — all probes pass

## Phase 5: Cleanup

- [x] 5.1 Verify `.env` is gitignored: `git status` shows `.env` untracked
- [x] 5.2 Verify migration 005 down: run `npm run migrate:rollback` then `npm run migrate:latest` — column `name` drops and re-adds cleanly
