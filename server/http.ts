import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";

/**
 * The small things every route needs.
 *
 * These lived in index.ts, which was fine while index.ts was the only file
 * with routes in it. Now that route modules exist they cannot import from
 * index.ts — it starts the server and the watcher at module scope, so an
 * import from a module index.ts itself imports would be a cycle resolving to a
 * half-initialised module. A third module both sides import has no such edge.
 */

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    throw new Error("expected JSON");
  }
}

export const str = (b: Record<string, unknown>, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" is required.`);
  return v.trim();
};

export const optStr = (b: Record<string, unknown>, k: string): string | undefined => {
  const v = b[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/**
 * Destructive calls must name the thing they are destroying.
 *
 * The UI asks for confirmation too, but a dialog is not a control: it lives in
 * the browser, and anything that can reach this API skips it entirely. Making
 * the exact name part of the request means a mis-aimed call fails instead of
 * succeeding on the wrong pool.
 */
export function confirmed(body: Record<string, unknown>, expected: string): void {
  if (String(body.confirm ?? "") !== expected) {
    throw new Error(`To confirm, this request must include "confirm": "${expected}".`);
  }
}

/**
 * Confine a path to /mnt.
 *
 * A prefix test alone is not enough: "/mnt/../etc/passwd" starts with "/mnt"
 * and the NAS resolves it happily, which turned the file browser into a way to
 * read anything on the box. Normalising first collapses the "..", so the check
 * runs against the path that will actually be opened.
 */
export function underMnt(raw: string): string {
  const path = posix.normalize(raw);
  if (path !== "/mnt" && !path.startsWith("/mnt/")) {
    throw new Error("Only paths under /mnt can be reached.");
  }
  return path;
}

/**
 * An error that already knows how it should be reported.
 *
 * Everything used to be classified by matching the message text, which works
 * until a message happens to contain one of the words being matched for. An
 * upload whose connection to the NAS dropped said "socket hang up", was read
 * as "this console cannot reach the NAS", and went out as a 502 — where a
 * proxy replaced the body with its own error page and the reason was lost.
 * The browser could only say "Upload failed (502)".
 */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * 4xx unless this console genuinely could not reach the NAS.
 *
 * The distinction is not academic. A reverse proxy may replace a 5xx body with
 * its own HTML — Cloudflare does — so a 5xx arrives at the browser as markup
 * the client then fails to parse as JSON, and the reason never reaches the
 * person who could act on it. 502 is kept for the one case it describes.
 */
export function statusForError(e: unknown): number {
  const chosen = (e as { status?: unknown } | null)?.status;
  // A status the thrower picked beats anything guessed from the wording.
  if (typeof chosen === "number" && chosen >= 100 && chosen <= 599) return chosen;
  const message = e instanceof Error ? e.message : String(e);
  return /not reachable|ECONNREFUSED|ETIMEDOUT|socket hang up|certificate|WebSocket|no TrueNAS server/i.test(message)
    ? 502
    : 400;
}

/**
 * Where a request came from, for the login rate limit.
 *
 * A forwarded-address header is believed only when the operator has said a
 * proxy is setting it. Believed unconditionally, the header is chosen by the
 * client — and a lockout keyed on a value the client chooses is a lockout
 * anyone can step around by changing one string per attempt. cf-connecting-ip
 * is preferred because Cloudflare sets exactly one; x-forwarded-for is a list
 * and only its first entry is the original client.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const cf = headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xff = headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? "unknown";
}

/** Whether TRUST_PROXY is set to something that means yes. */
export const trustProxy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? "").trim());

/**
 * Headers every response carries.
 *
 * The console's own pages load scripts and styles from itself, images from
 * itself and from wherever an app catalog keeps its logos, and nothing else;
 * the policy says so, which means a script that somehow lands in a page — a
 * catalog description, a filename — has nowhere to run and nowhere to send
 * anything. frame-ancestors is 'self', not 'none', because the file browser
 * previews PDFs in an iframe served from this same origin and a stricter
 * value would blank it. 'unsafe-inline' for styles is what React's style
 * attributes and xterm's injected stylesheet need; scripts get no such
 * allowance.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * Whether a write came from this console's own pages.
 *
 * The session cookie is SameSite=Lax, which already stops a browser attaching
 * it to a cross-site POST. This is the second lock on the same door: a
 * request that names an Origin is refused when that origin is not the host
 * the request arrived at. Behind a trusted proxy the public host is in
 * x-forwarded-host, since the proxy may have rewritten Host to its upstream.
 * A request with no Origin at all — curl, a script, an old browser — is
 * allowed through; it carries no ambient cookie to abuse.
 */
export function sameOrigin(
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean,
): boolean {
  const origin = headers.origin;
  if (typeof origin !== "string" || !origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const candidates = new Set<string>();
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (host) candidates.add(host.toLowerCase());
  if (trustProxy) {
    const fwd = Array.isArray(headers["x-forwarded-host"]) ? headers["x-forwarded-host"][0] : headers["x-forwarded-host"];
    for (const h of (fwd ?? "").split(",")) if (h.trim()) candidates.add(h.trim().toLowerCase());
  }
  return candidates.has(originHost);
}

/**
 * The body types a write may carry.
 *
 * Everything the console's own client sends is JSON, except an upload, which
 * is the file's bytes. A form post from another site arrives as
 * x-www-form-urlencoded or text/plain — the two types a browser will send
 * cross-site without asking — and is refused before a route ever sees it.
 * No content type at all is allowed: a POST with no body has none.
 */
export function acceptableWriteType(contentType: string | undefined): boolean {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return type === "" || type === "application/json" || type === "application/octet-stream";
}
