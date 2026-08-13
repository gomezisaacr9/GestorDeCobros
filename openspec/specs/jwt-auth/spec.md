# Spec: jwt-auth

## Purpose

New capability introduced by change `jwt-authentication` (no prior spec). Adds stateless JWT session authentication: login, HttpOnly-cookie sessions, the `requireAuth` guard, credential rotation, strict Zod validation, bcrypt/argon2 hashing, and fail-fast `JWT_SECRET` handling. Out of scope: logout/refresh endpoints, password reset, email verification, client UIs.

## Requirements

### Requirement: JWT_SECRET Fail-Fast

The server MUST load `JWT_SECRET` from `.env` at boot and MUST crash (non-zero exit) if missing or empty; it MUST NOT fall back to a default, hardcoded, or derived secret.

#### Scenario: Boot without secret crashes

- GIVEN `JWT_SECRET` absent from `.env`
- WHEN the server starts
- THEN the process exits non-zero before serving

#### Scenario: Boot with secret serves

- GIVEN `JWT_SECRET` set in `.env`
- WHEN the server starts
- THEN it boots normally

### Requirement: Password Hashing

Credentials MUST be persisted only as bcrypt or argon2 hashes, never plaintext or reversible encodings; hashes MUST NOT appear in API responses.

#### Scenario: Stored hash verifies

- GIVEN a password submitted for hashing
- WHEN the hash is stored
- THEN it is a bcrypt/argon2 hash, not the plaintext
- AND correct passwords verify while wrong ones fail

### Requirement: Zod Body Validation

Every request body MUST pass strict Zod validation before its controller runs; invalid bodies MUST return HTTP 400. `login`: `email` (string, email) + `password` (string). `rotate`: `currentPassword` (string) + `newPassword` (string, min 8).

#### Scenario: Login body invalid

- GIVEN `POST /api/v1/auth/login` with `email` missing
- WHEN validation runs
- THEN HTTP 400 and the controller never runs

#### Scenario: Short new password

- GIVEN rotate with `newPassword` of 7 characters
- WHEN validation runs
- THEN HTTP 400

### Requirement: Login Endpoint

`POST /api/v1/auth/login` MUST find the user by email, verify the stored hash, and on success return HTTP 200 with public user data and the JWT session cookie. Any failure (unknown email or wrong password) MUST return HTTP 401 `Credenciales inválidas`, identical in both cases — no user enumeration.

#### Scenario: Valid credentials

- GIVEN an active user with matching email and password
- WHEN login is called
- THEN HTTP 200 with public data (id, role, email) and the session cookie set

#### Scenario: Wrong password

- GIVEN an existing user
- WHEN login uses a wrong password
- THEN HTTP 401 `Credenciales inválidas`

#### Scenario: Unknown email not enumerated

- GIVEN no user with the submitted email
- WHEN login is attempted
- THEN HTTP 401 identical to the wrong-password response

### Requirement: HttpOnly Session Cookie

The JWT MUST be issued via `Set-Cookie` with `HttpOnly`, `Secure`, and `SameSite=Strict`. NOTE: in `NODE_ENV=development` over local plain HTTP, `Secure` MAY be disabled for testing; production defaults MUST NOT be weakened.

#### Scenario: Flags on login response

- GIVEN a successful production login
- WHEN response headers are inspected
- THEN `Set-Cookie` carries HttpOnly, Secure, and SameSite=Strict

### Requirement: requireAuth Middleware

The guard MUST extract the JWT from the HttpOnly cookie, verify its signature, and on success inject `req.user` (at least `id`, `role`) before the controller. Missing or invalid tokens MUST return HTTP 401 without executing the controller.

#### Scenario: Valid token injects user

- GIVEN a request with a valid signed JWT cookie
- WHEN the guard runs
- THEN `req.user` carries the token's `id` and `role` and the controller executes

#### Scenario: Missing or invalid token

- GIVEN no session cookie or a cookie whose JWT signature fails verification
- WHEN the guard runs on a protected route
- THEN HTTP 401 and the controller never executes

### Requirement: Current User Endpoint

`GET /api/v1/auth/me` MUST run behind `requireAuth`, re-fetch the user from the database excluding soft-deleted rows, and return public data with HTTP 200; a deleted user or invalid token MUST return HTTP 401.

#### Scenario: Active user with valid cookie

- GIVEN a valid JWT cookie and an active user
- WHEN `GET /api/v1/auth/me` runs
- THEN HTTP 200 with the user's public data

#### Scenario: Deleted user after issuance

- GIVEN a valid JWT cookie and a user whose `deleted_at` is set
- WHEN `GET /api/v1/auth/me` runs
- THEN HTTP 401

#### Scenario: Missing or invalid cookie

- GIVEN no cookie or a tampered cookie
- WHEN `GET /api/v1/auth/me` runs
- THEN HTTP 401

### Requirement: Password Rotation Endpoint

`PATCH /api/v1/auth/password/rotate` MUST run behind `requireAuth`, verify `currentPassword` against the stored hash, hash the validated `newPassword` (min 8), and persist it. Success MUST return HTTP 200; wrong `currentPassword` MUST return HTTP 401; invalid body MUST return HTTP 400.

#### Scenario: Successful rotation

- GIVEN a valid cookie and correct `currentPassword`
- WHEN rotating to a new password of 8+ characters
- THEN HTTP 200, the hash updates, and later login with the new password succeeds

#### Scenario: Wrong current password

- GIVEN a valid cookie and an incorrect `currentPassword`
- WHEN rotate is attempted
- THEN HTTP 401

#### Scenario: Short new password

- GIVEN a valid cookie and `newPassword` under 8 characters
- WHEN rotate is attempted
- THEN HTTP 400 (Zod rejection)

### Requirement: Provisional Superadmin Hash Migration

Rotation MUST accept the legacy `scrypt$N$r$p$salt$hash` superadmin seed hash, verify it, and replace it with a bcrypt/argon2 hash on first successful rotation; later logins MUST verify against the new hash. Unsupported hash formats MUST be treated as invalid credentials (HTTP 401), never a crash.

#### Scenario: Scrypt migrates on rotation

- GIVEN a superadmin with a `scrypt$...` hash
- WHEN a valid rotation completes
- THEN the stored hash becomes bcrypt/argon2
- AND a later login with the new password returns HTTP 200

#### Scenario: Unknown hash format

- GIVEN a `password_hash` matching neither scrypt nor bcrypt/argon2
- WHEN login or rotate is attempted
- THEN HTTP 401 and the server keeps running