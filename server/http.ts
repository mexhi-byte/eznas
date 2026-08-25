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
