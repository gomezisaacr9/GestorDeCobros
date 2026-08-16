import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { signToken as signAuthToken } from '../../src/modules/auth/auth.service';

const COOKIE_NAME = 'auth_token';

/** Mint a session cookie value for a role — hierarchy tests never need users. */
export function signToken(payload: { sub: string; role: string }): string {
  return signAuthToken(payload);
}

export function cookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}`;
}

export interface AppRequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Runs one request against the real Express app on an ephemeral port
 * (`listen(0)` + fetch, same pattern as server/scripts/smoke-auth.ts) and
 * closes the server afterwards. Owns the server lifecycle per call.
 */
export async function appRequest(
  app: Express,
  method: string,
  path: string,
  opts: AppRequestOptions = {},
): Promise<Response> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.cookie = cookieHeader(opts.token);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}