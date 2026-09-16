import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "./store.js";

/**
 * Signed session cookies naming the account that holds them.
 *
 * The console used to carry a single shared password and a cookie that said
 * nothing but "somebody signed in". It now has accounts with roles, so the
 * cookie has to say *who* — a role check is worthless if the request cannot be
 * attributed.
 *
 * The payload is signed, not encrypted: it holds an account id and an expiry,
 * neither of which is a secret. What matters is that a browser cannot mint one,
 * and cannot edit the role or the expiry out of the one it was given.
 */

const MAX_AGE_SECONDS = 12 * 60 * 60;
// Renamed from tnui_session with the project. Old cookies simply do not match
// and their holders sign in once more.
export const COOKIE = "eznas_session";

export interface Session {
  accountId: string;
  expires: number;
}

/*
 * The secret is resolved on first use rather than at import, and through the
 * store rather than from the environment directly. The store already knows
 * the answer when SESSION_SECRET is unset — it generated one and kept it
 * beside the data file — and a signer that made up its own instead
 * invalidated every session on every restart.
 */
function sign(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

export function issue(accountId: string): string {
  const payload: Session = { accountId, expires: Date.now() + MAX_AGE_SECONDS * 1000 };
  // base64url so the payload can never contain the separator, whatever an
  // account id turns out to look like.
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The session a cookie proves, or null if it proves nothing. */
export function read(token: string | undefined): Session | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;

  const expected = sign(body);
  // Both sides are base64url of a fixed-width digest, so lengths match unless
  // the token was mangled — in which case it is invalid anyway.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (!payload?.accountId || !Number.isFinite(payload.expires)) return null;
    return payload.expires > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export const valid = (token: string | undefined): boolean => read(token) !== null;

export function cookieHeader(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
