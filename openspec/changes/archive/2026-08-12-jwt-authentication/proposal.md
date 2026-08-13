# Proposal: JWT Authentication & Credential Rotation

## Intent

Add stateless JWT authentication to the backend: login with email/password, session persistence via HttpOnly cookies, and mandatory rotation of the provisional superadmin credential created in `multi-tenant-data-foundation`. This change unlocks the rest of the platform (all protected endpoints depend on `requireAuth`).

## Scope

### In Scope

- `POST /api/v1/auth/login` — email + password validation (Zod), generic 401 on failure, JWT in `Set-Cookie` (HttpOnly, Secure, SameSite=Strict), public user data in response.
- `GET /api/v1/auth/me` — read user from DB (ensure not deleted), return public data; guarded by `requireAuth`.
- `PATCH /api/v1/auth/password/rotate` — verify `currentPassword` against stored hash, re-hash `newPassword` (min 8 chars), update DB; guarded by `requireAuth`. This is the mechanism that migrates the provisional superadmin scrypt hash to bcrypt/argon2.
- Middleware `requireAuth` — extract JWT from HttpOnly cookie, verify signature; 401 on missing/invalid; inject `req.user` (id, role).
- Strict Zod validation on every request body before controller.
- Password hashing with `bcrypt` or `argon2` (never plaintext).
- `.env` with `JWT_SECRET`; server MUST crash on boot if `JWT_SECRET` is missing (fail-fast); `.env.example` committed, `.env` gitignored.
- Backend layers: routes, middlewares, controllers, services (hashing + token), repositories (Knex user queries), Zod schemas.

### Out of Scope

- client-web (admin) login screens
- client-mobile (resident) login
- Refresh token rotation / logout endpoint (session is stateless; logout = cookie clearing at client)
- Password reset flows, email verification
- Tenant-isolation middleware beyond `req.user` injection

## Capabilities

### New Capabilities

- `jwt-auth`: login, session persistence, credential rotation, JWT issuance/verification, hashing, fail-fast secret handling.

### Modified Capabilities

- `tenant-data-model`: no schema change required (users.email + password_hash already exist). Rotation updates `users.password_hash`.

## Approach

Express routes under `/api/v1/auth`; controllers thin (HTTP), services own business logic (bcrypt/argon2 verify+hash, JWT sign/verify), repositories query users by email/id via Knex. `requireAuth` reads the HttpOnly cookie, verifies the JWT synchronously (stateless), injects `req.user`, then controllers re-check user existence in DB where required by contract (`/me`). Zod schemas validated in middleware before controllers. JWT_SECRET loaded from `.env` at boot with fail-fast crash.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `server/src/routes/auth.routes.ts` | New | Login, me, rotate endpoints |
| `server/src/middlewares/requireAuth.ts` | New | Cookie extraction + JWT verification |
| `server/src/middlewares/validateZod.ts` | New | Body validation middleware |
| `server/src/controllers/auth.controller.ts` | New | HTTP logic |
| `server/src/services/auth.service.ts` | New | Password hashing, JWT sign/verify |
| `server/src/repositories/user.repository.ts` | New | Knex queries: findByEmail, findById, updatePasswordHash |
| `server/src/schemas/auth.schemas.ts` | New | Zod schemas |
| `.env.example` / `.env` | New | JWT_SECRET (fail-fast) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cookie `Secure` flag blocks local HTTP development | Med | Document dev override in spec (NODE_ENV=development allows non-Secure) without weakening production defaults |
| bcrypt vs argon2 choice | Low | Design decides with justification; contract allows either |
| No test runner | Med | Smoke probes via `tsx -e` for constraint/routes per verify phase |
| Provisional scrypt hash must migrate | Low | Rotation writes bcrypt/argon2 hash, replacing scrypt on first rotate |

## Rollback Plan

Stateless auth: revoke trust by rotating `JWT_SECRET` (invalidates all tokens). No DB schema changes; rollback = revert code. All endpoints live under `/api/v1/auth`.

## Dependencies

- npm: `jsonwebtoken`, `bcrypt` (or `argon2`), `@types/jsonwebtoken`, `dotenv`, `zod` (already in stack intent). Existing: knex, better-sqlite3.

## Success Criteria

- [ ] `POST /api/v1/auth/login` with valid credentials returns 200 + Set-Cookie HttpOnly + public user
- [ ] Login with wrong password or unknown email returns generic 401 (no user enumeration)
- [ ] `GET /api/v1/auth/me` returns 200 with user when cookie valid; 401 without/invalid cookie
- [ ] `PATCH /api/v1/auth/password/rotate` verifies current password, applies new password (min 8), returns 200
- [ ] Provisional superadmin can rotate its scrypt-hashed password to bcrypt/argon2 and log in afterwards
- [ ] Server crashes at boot when `JWT_SECRET` missing from `.env`
- [ ] All request bodies rejected with 400 by Zod when invalid