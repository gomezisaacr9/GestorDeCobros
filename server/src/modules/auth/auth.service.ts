import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { userRepository, type UserRow } from './user.repository';

const BCRYPT_COST = 12; // OWASP baseline; ~100–300ms per hash
const TOKEN_TTL = '8h';
const SCRYPT_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/;

/**
 * Static hash used for the dummy compare on the user-not-found path, so both
 * login 401 branches (unknown email / wrong password) take roughly the same
 * time — anti-enumeration. Precomputed once at module load (cost 12).
 */
const DUMMY_HASH = bcrypt.hashSync('dummy-anti-enumeration-secret', BCRYPT_COST);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verifies a password against any persisted hash format:
 * - `$2a/$2b/$2y…` → async bcrypt.compare
 * - `scrypt$N$r$p$saltHex$hashHex` → scryptSync with embedded params + timingSafeEqual
 * - anything else → false (invalid credentials, never a crash)
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$2')) {
    return bcrypt.compare(password, hash);
  }
  const match = SCRYPT_PATTERN.exec(hash);
  if (!match) {
    return false; // unsupported format → 401, no crash
  }
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  try {
    const derived = scryptSync(password, Buffer.from(match[4], 'hex'), 64, { N, r, p });
    return timingSafeEqual(derived, Buffer.from(match[5], 'hex'));
  } catch {
    return false; // invalid scrypt parameters (e.g. absurd N) → 401, no crash
  }
}

export function signToken(payload: { sub: string; role: string }): string {
  return jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL });
}

export interface TokenPayload {
  sub: string;
  role: string;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      return null;
    }
    return { sub: payload.sub, role: String(payload.role ?? '') };
  } catch {
    return null;
  }
}

/**
 * Login credential check. Runs a dummy bcrypt compare when the email is unknown
 * so the response time is indistinguishable from the wrong-password case.
 * Returns the active user on success, `null` on any failure.
 */
export async function verifyCredentials(email: string, password: string): Promise<UserRow | null> {
  const user = await userRepository.findByEmail(email);
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }
  const valid = await verifyPassword(password, user.password_hash);
  return valid ? user : null;
}