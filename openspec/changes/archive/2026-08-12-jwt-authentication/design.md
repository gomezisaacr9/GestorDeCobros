# Design: JWT Authentication & Credential Rotation

## Technical Approach

Stateless JWT sessions on a new Express layer under `server/src/` (topology per `openspec/config.yaml`: routes → middlewares → controllers → services → repositories → schemas). `POST /api/v1/auth/login` verifies the stored hash (bcrypt or legacy `scrypt$`), signs an 8h HS256 JWT, and issues it via `Set-Cookie`. `requireAuth` reads the HttpOnly cookie, verifies the token, injects `req.user`. `PATCH /api/v1/auth/password/rotate` re-verifies credentials and replaces the legacy scrypt hash with bcrypt. `JWT_SECRET` is asserted at boot — missing/empty crashes (non-zero) before serving. No logout/refresh (out of scope, per spec).

## Architecture Decisions

**Decision: cookie-parser vs raw header handling**

| Option | Tradeoff | Decision |
|---|---|---|
| `res.setHeader` + manual parse of `req.headers.cookie` | Fragile: URL-encoding, quoted values, multiple cookies | Rejected |
| `cookie-parser` (read) + native `res.cookie()` (write) | One small standard dep; clean `req.cookies` access | **Chosen** |

`res.cookie()` is built into Express — cookie-parser is needed only for robust *reading*.

**Decision: password hashing & format dispatch**

| Option | Tradeoff | Decision |
|---|---|---|
| bcrypt cost 10 vs 12 | 12 is OWASP baseline; ~100-300ms — use **async** `bcrypt.hash/compare` to avoid blocking the loop | **Cost 12, async API** |
| scrypt legacy verify | Must dispatch by prefix: `$2a/$2b/$2y` → bcrypt; `scrypt$N$r$p$salt$hash` → `crypto.scryptSync` with `{N,r,p}` from the hash + `timingSafeEqual`; anything else → invalid (401, never crash) | **Prefix dispatch in one `verifyPassword()`** |
| Unknown email timing | User-not-found must still run a **dummy `bcrypt.compare`** so both 401 cases are timing-identical (anti-enumeration) | **Dummy compare** |
| bcrypt 72-byte truncation | Silent truncation of long passwords | Zod `max(128)` defensive cap |

**Decision: JWT**

| Option | Tradeoff | Decision |
|---|---|---|
| Expiry 1h / 8h / 24h | No refresh token exists; 1h forces constant re-login, 24h widens exposure window | **8h** (work-day session; compromise mitigation = rotate `JWT_SECRET`, invalidates all tokens) |
| Payload | Minimal, stateless | `{ sub: id, role }`, HS256, `jsonwebtoken` |

Cookie `maxAge` = 8h, aligned with expiry; `httpOnly: true`, `secure: NODE_ENV !== 'development'`, `sameSite: 'strict'`, `path: '/'`.

**Decision: fail-fast boot**

`server/src/config/env.ts` runs `dotenv.config()` then `assertEnv()` — throws if `JWT_SECRET` missing/empty (no default, no derivation). `index.ts` imports env first, so the uncaught throw exits non-zero before `listen`.

**Decision: public user shape**

User-confirmed: `name` is added back via migration `005_users_add_name` (it was lost in the first cycle's spec→apply chain even though the original entity contract v2.0 defined it). Response is `{ id, email, role, name }`; `name` is nullable in the schema so existing rows (superadmin seed) stay valid. `password_hash`/`deleted_at` never leave the repository layer.

**Decision: server entry**

`app.ts` = factory (no `listen`, probe-friendly); `index.ts` = boot (`listen`, `PORT` default 3000). Scripts: `dev: tsx watch server/src/index.ts`, `start: tsx server/src/index.ts`. `express.json()` + `cookieParser()` only — no CORS/static.

## Data Flow

```
login:  validateZod → controller → service.verifyCredentials(email, pw)
          → repo.findByEmail (deleted_at IS NULL) → null? dummy compare → 401
          → dispatch verify (bcrypt|scrypt) → fail → 401 "Credenciales inválidas"
          → sign JWT → res.cookie(auth_token) → 200 {id,email,role,name}

/me:    requireAuth (cookie→jwt.verify→req.user) → repo.findById (excl. deleted)
          → null/deleted → 401 │ 200 {id,email,role,name}

rotate: requireAuth → validateZod → verify currentPassword (dispatch)
          → bcrypt.hash(newPassword, 12) → repo.updatePasswordHash → 200
```

## File Changes

| File | Action | Description |
|---|---|---|
| `server/db/migrations/005_users_add_name.ts` | Create | `ALTER TABLE users ADD COLUMN name` (nullable — SQLite supports ADD COLUMN; no table-recreation needed) |
| `server/src/config/env.ts` | Create | dotenv load + `JWT_SECRET` fail-fast assert |
| `server/src/app.ts` | Create | Express factory: json, cookieParser, mount auth router |
| `server/src/index.ts` | Create | Import env → boot/`listen` |
| `server/src/routes/auth.routes.ts` | Create | login, me, rotate wiring |
| `server/src/middlewares/requireAuth.ts` | Create | Cookie → verify → `req.user`; 401 |
| `server/src/middlewares/validateZod.ts` | Create | `schema.parse` → 400 with Zod details |
| `server/src/controllers/auth.controller.ts` | Create | Thin HTTP logic, public shape |
| `server/src/services/auth.service.ts` | Create | Hash dispatch, dummy compare, JWT sign/verify |
| `server/src/repositories/user.repository.ts` | Create | `findByEmail`/`findById` (excl. deleted), `updatePasswordHash`; explicit columns |
| `server/src/schemas/auth.schemas.ts` | Create | `LoginSchema` (email/password), `RotateSchema` (currentPassword, newPassword min 8, max 128) |
| `server/scripts/smoke-auth.ts` | Create | Verify probes (no test runner) |
| `package.json` | Modify | +`express`, `zod`, `dotenv`, `cookie-parser`, `jsonwebtoken`, `bcrypt` (+`@types/*`); scripts `dev`/`start` |
| `.env.example` | Create | `JWT_SECRET`, `NODE_ENV`, `PORT` |
| `.gitignore` | Modify | Add `.env` (currently **absent** — verified) |

## Interfaces / Contracts

```
POST  /api/v1/auth/login          {email, password}           → 200 {id,email,role,name} + Set-Cookie auth_token | 400 Zod | 401 "Credenciales inválidas"
GET   /api/v1/auth/me             (cookie)                    → 200 {id,email,role,name} | 401
PATCH /api/v1/auth/password/rotate {currentPassword, newPassword(≥8)} → 200 | 400 Zod | 401 wrong current
req.user = { id: string, role: string }
```

Dispatch (non-obvious core):

```ts
const SCRYPT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/;
if (hash.startsWith('$2')) return bcrypt.compare(pw, hash);       // bcrypt
const m = SCRYPT.exec(hash);
if (!m) return false;                                             // unsupported → 401, no crash
const [N, r, p] = [m[1], m[2], m[3]].map(Number);
const deriv = scryptSync(pw, Buffer.from(m[4], 'hex'), 64, { N, r, p });
return timingSafeEqual(deriv, Buffer.from(m[5], 'hex'));
```

## Testing Strategy

No runner (`strict_tdd: false`) — smoke probes run in-process (`app.listen(0)` + `fetch`):

| Layer | What to Test | Approach |
|---|---|---|
| Smoke | login OK: 200, cookie flags, public body | `server/scripts/smoke-auth.ts` |
| Smoke | 401 generic: wrong pw vs unknown email — identical bodies | assert both |
| Smoke | `/me` 200 valid cookie; 401 none/tampered; 401 soft-deleted | fetch asserts |
| Smoke | rotate: +200, old pw fails, new pw logs in, stored hash now `$2b$` | repo read-back |
| Smoke | rotate wrong current 401; Zod 400s (missing email, 7-char pw) | status asserts |
| Boot | fail-fast | `env -u JWT_SECRET tsx server/src/index.ts` → non-zero; `JWT_SECRET=` → non-zero |
| Type | typecheck | `npm run typecheck` |

## Threat Matrix

N/A overall — the change introduces no shell commands, subprocesses, VCS/PR automation, or executable-file classification (Express HTTP routes only). Rows: Documentation-like paths **N/A** (no executable docs); Git repo selection **N/A**; Commit state **N/A**; Push state **N/A**; PR commands **N/A**. The fail-fast process exit is a spec requirement covered by the boot smoke probe above, not a matrix boundary.

## Migration / Rollout

One schema migration: `005_users_add_name` adds nullable `users.name` (SQLite `ALTER TABLE ADD COLUMN` — supported, no table-recreation). Credential migration is lazy: scrypt → bcrypt occurs on the first successful rotation (spec: "Scrypt migrates on rotation"). Rollback: revert code; invalidate all sessions by rotating `JWT_SECRET`; migration `down()` drops the column.

## Open Questions

- ~~`name` in public shape~~ **Resolved by user**: add `name` column (migration 005) and expose `{ id, email, role, name }`.

## Risks

- bcrypt native build on Node v26: prebuilds expected; fallback node-gyp (env risk).
- Brute force on login: no rate limiting (out of scope) — posture noted for a future change.