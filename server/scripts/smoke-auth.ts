/**
 * SDD smoke probes for the jwt-authentication change (no test runner).
 * Runs the Express app in-process on an ephemeral port and asserts the spec
 * scenarios over real HTTP. Exit code 0 = all probes pass.
 *
 * Run: npx tsx server/scripts/smoke-auth.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { hashPassword, signToken, verifyPassword } from '../src/services/auth.service';
import connection from '../db/connection';

const BASE = '/api/v1/auth';
const COOKIE_NAME = 'auth_token';
const SEED_EMAIL = 'root@gestionpagos.local';
const SEED_PW = 'ChangeMe!2026'; // only valid for the scrypt seed hash
const PW_A = 'AlphaChange!2026'; // first rotation target
const PW_B = 'BetaChange!2027'; // re-run rotation target (idempotent)

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function setCookieValue(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return '';
  return cookie.split(';')[0].split('=')[1] ?? '';
}

async function main(): Promise<void> {
  // Resolve the seed password from the CURRENT stored hash so the rotation
  // probes are idempotent across ANY number of runs (scrypt → bcrypt happens
  // on the first rotation; later runs cycle PW_A ↔ PW_B as the live credential).
  const seedRow = await connection('users').where({ email: SEED_EMAIL }).first();
  if (!seedRow) {
    console.error('Seed user missing — run migrations first.');
    process.exit(1);
  }
  const candidates = [SEED_PW, PW_A, PW_B];
  let currentPw = '';
  for (const c of candidates) {
    if (await verifyPassword(c, seedRow.password_hash)) {
      currentPw = c;
      break;
    }
  }
  if (!currentPw) {
    console.error('Could not resolve seed credential — unexpected hash format.');
    process.exit(1);
  }
  const targetPw = currentPw === PW_A ? PW_B : PW_A;

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}`;

  console.log('\n[1/10] login OK — 200, cookie flags, public body');
  {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: SEED_EMAIL, password: currentPw }),
    });
    check('status 200', res.status === 200);
    const sc = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? '';
    check('cookie HttpOnly', sc.includes('HttpOnly'), sc);
    check('cookie SameSite=Strict', sc.includes('SameSite=Strict'), sc);
    check(
      'cookie NOT Secure in development',
      !sc.includes('Secure'),
      `NODE_ENV=${process.env.NODE_ENV}`,
    );
    const body = (await res.json()) as { id: string; email: string; role: string; name: string | null };
    check(
      'body {id,email,role,name} and no password_hash',
      typeof body.id === 'string' &&
        body.email === SEED_EMAIL &&
        body.role === 'superadmin' &&
        'name' in body &&
        !('password_hash' in body) &&
        !('deleted_at' in body),
    );
    globalThis.__authCookie = setCookieValue(res);
  }

  console.log('\n[2/10] login wrong password — 401 generic');
  let wrongBody = '';
  {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: SEED_EMAIL, password: 'NotThePassword!' }),
    });
    wrongBody = await res.text();
    check('status 401', res.status === 401, wrongBody);
  }

  console.log('\n[3/10] login unknown email — 401 IDENTICAL body (no enumeration)');
  {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@gestionpagos.local', password: 'NotThePassword!' }),
    });
    const body = await res.text();
    check('status 401', res.status === 401, body);
    check('body identical to wrong-password case', body === wrongBody, wrongBody);
  }

  console.log('\n[4/10] /me with valid cookie — 200');
  {
    const res = await fetch(`${base}/me`, { headers: { cookie: `${COOKIE_NAME}=${globalThis.__authCookie}` } });
    const body = (await res.json()) as { email?: string; name?: unknown };
    check('status 200', res.status === 200);
    check('identity matches', body.email === SEED_EMAIL);
    check('name present', 'name' in body);
  }

  console.log('\n[5/10] /me without cookie — 401');
  {
    const res = await fetch(`${base}/me`);
    check('status 401', res.status === 401);
  }

  console.log('\n[6/10] /me for soft-deleted user — 401');
  {
    const probeId = '00000000-0000-4000-8000-00000000dead';
    await connection('users').insert({
      id: probeId,
      email: 'deleted-probe@gestionpagos.local',
      password_hash: await hashPassword('ProbeUser!2026'),
      role: 'superadmin',
      condominium_id: null,
      building_id: null,
      unit_id: null,
      deleted_at: new Date().toISOString(),
    });
    const token = signToken({ sub: probeId, role: 'superadmin' });
    const res = await fetch(`${base}/me`, { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    check('status 401', res.status === 401);
    await connection('users').where({ id: probeId }).del();
  }

  console.log('\n[7/10] rotate — 200, old pw fails, new pw logs in, hash now $2b$');
  let rotatedOk = false;
  {
    const res = await fetch(`${base}/password/rotate`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `${COOKIE_NAME}=${globalThis.__authCookie}`,
      },
      body: JSON.stringify({ currentPassword: currentPw, newPassword: targetPw }),
    });
    check('rotate status 200', res.status === 200, (await res.text()).slice(0, 120));
    rotatedOk = res.status === 200;
    const after = await connection('users').where({ email: SEED_EMAIL }).first();
    check('stored hash is bcrypt ($2b$)', typeof after.password_hash === 'string' && after.password_hash.startsWith('$2b$'), after.password_hash?.slice(0, 7));
    const oldRes = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: SEED_EMAIL, password: currentPw }),
    });
    check('old password now fails (401)', oldRes.status === 401);
    const newRes = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: SEED_EMAIL, password: targetPw }),
    });
    check('new password logs in (200)', newRes.status === 200);
  }

  console.log('\n[8/10] rotate wrong current password — 401');
  {
    const res = await fetch(`${base}/password/rotate`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `${COOKIE_NAME}=${globalThis.__authCookie}`,
      },
      body: JSON.stringify({ currentPassword: 'DefinitelyWrong!', newPassword: 'AnotherPass!2026' }),
    });
    check('status 401', res.status === 401);
  }

  console.log('\n[9/10] Zod 400s — missing email, 7-char new password');
  {
    const noEmail = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    });
    check('login missing email → 400', noEmail.status === 400, (await noEmail.text()).slice(0, 120));
    const shortPw = await fetch(`${base}/password/rotate`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `${COOKIE_NAME}=${globalThis.__authCookie}`,
      },
      body: JSON.stringify({ currentPassword: targetPw, newPassword: '1234567' }),
    });
    check('rotate 7-char new password → 400', shortPw.status === 400, (await shortPw.text()).slice(0, 120));
  }
  void rotatedOk;

  console.log('\n[10/10] fail-fast boot — missing and empty JWT_SECRET exit non-zero');
  {
    const tsxBin = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    const indexEntry = path.resolve(__dirname, '../src/index.ts');

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gp-jwt-failfast-'));
    const missingEnv = { ...process.env };
    delete missingEnv.JWT_SECRET;
    const missing = spawnSync(process.execPath, [tsxBin, indexEntry], {
      cwd: tmp, // no .env here → JWT_SECRET stays absent
      env: missingEnv,
      encoding: 'utf8',
      timeout: 30_000,
    });
    check('missing JWT_SECRET exits non-zero', missing.status !== 0, `status=${missing.status}`);

    const empty = spawnSync(process.execPath, [tsxBin, indexEntry], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, JWT_SECRET: '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    check('empty JWT_SECRET exits non-zero', empty.status !== 0, `status=${empty.status}`);
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n[10b/10] login with unknown hash format — 401, no crash');
  {
    const probeId = '00000000-0000-4000-8000-00000000beef';
    const hashes = await Promise.all([
      verifyPassword('whatever', 'not-a-valid-hash'),
      verifyPassword('whatever', 'plaintext-ish$weird'),
    ]);
    check(
      'verifyPassword returns false (never throws) for unsupported formats',
      hashes.every((h) => h === false),
    );
    await connection('users').insert({
      id: probeId,
      email: 'unknown-hash-probe@gestionpagos.local',
      password_hash: 'not-a-valid-hash',
      role: 'superadmin',
      condominium_id: null,
      building_id: null,
      unit_id: null,
    });
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unknown-hash-probe@gestionpagos.local', password: 'whatever' }),
    });
    check('login → 401 (invalid credentials, no crash)', res.status === 401, (await res.text()).slice(0, 120));
    const alive = await fetch(`${base}/me`);
    check('server still serving after unknown hash (no crash)', alive.status === 401);
    await connection('users').where({ id: probeId }).del();
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await connection.destroy();

  console.log(`\n${failures === 0 ? 'ALL PROBES PASSED' : `${failures} PROBE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

declare global {
  var __authCookie: string;
}

main().catch((err) => {
  console.error('smoke-auth crashed:', err);
  process.exit(1);
});