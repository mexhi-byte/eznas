import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import type { TrueNas } from "./truenas.js";
import type { Connection } from "./store.js";

/**
 * Serving file contents out of the NAS.
 *
 * The API gives no direct way to read a file. `core.download` mints a URL, and
 * that URL has two properties that decide the whole design here:
 *
 *   - it is single use — the job is consumed by the first GET, and a second
 *     request gets a 401;
 *   - it answers a Range request with a 401 rather than a 206.
 *
 * A browser playing a video does exactly the thing that fails: it opens with a
 * Range request, then re-opens on every seek. So media is copied to local disk
 * once and served from there, where ranges are ordinary. Images and documents
 * are small enough to stream straight through and are not worth the disk.
 */

const CACHE_DIR = process.env.PREVIEW_CACHE ?? "/opt/truenas-ui/data/cache";
/** Per file. Above this, previewing would cost more than it is worth. */
const MAX_CACHE_FILE = 1024 * 1024 * 1024;
/** Whole cache. The container's root filesystem is not large. */
const MAX_CACHE_TOTAL = 2 * 1024 * 1024 * 1024;
/** Streamed straight through, never cached. */
export const MAX_INLINE = 64 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".heic": "image/heic", ".heif": "image/heif", ".ico": "image/x-icon", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".opus": "audio/opus", ".aac": "audio/aac",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".sh": "text/plain; charset=utf-8", ".conf": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8", ".html": "text/plain; charset=utf-8",
  ".css": "text/plain; charset=utf-8", ".sql": "text/plain; charset=utf-8",
};

export type Kind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export function kindOf(name: string): Kind {
  const type = TYPES[extname(name).toLowerCase()];
  if (!type) return "other";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type.startsWith("application/json")) return "text";
  return "other";
}

export const contentType = (name: string): string =>
  TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

/* ------------------------------------------------------------------- cache */

const cachePath = (connId: string, path: string): string =>
  join(CACHE_DIR, createHash("sha256").update(`${connId}:${path}`).digest("hex"));

/**
 * Evict oldest-touched entries until the cache fits.
 *
 * Access time is what matters, not creation: the file someone is scrubbing
 * through right now must not be the one thrown away to make room.
 */
function evict(): void {
  if (!existsSync(CACHE_DIR)) return;
  const files = readdirSync(CACHE_DIR)
    .map((f) => {
      const full = join(CACHE_DIR, f);
      try {
        const st = statSync(full);
        return { full, size: st.size, atime: st.atimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { full: string; size: number; atime: number } => !!f);

  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= MAX_CACHE_TOTAL) return;

  files.sort((a, b) => a.atime - b.atime);
  for (const f of files) {
    if (total <= MAX_CACHE_TOTAL) break;
    try {
      unlinkSync(f.full);
      total -= f.size;
    } catch {
      /* a file being read right now; skip it */
    }
  }
}

/** Fetch a fresh single-use URL for a path. */
async function downloadUrl(nas: TrueNas, path: string): Promise<string> {
  const result = await nas.call<[number, string]>("core.download", [
    "filesystem.get",
    [path],
    basename(path),
    false,
  ], 30_000);
  if (!Array.isArray(result) || !result[1]) throw new Error("the NAS did not return a download URL");
  return result[1];
}

/**
 * Open the transfer.
 *
 * Uses https.request rather than fetch for two reasons: the NAS presents a
 * self-signed certificate, so ordinary verification cannot pass, and the same
 * fingerprint pin the JSON-RPC socket enforces has to apply here too. Turning
 * verification off without re-pinning would leave the one connection that
 * carries actual file contents unauthenticated.
 */
function fetchFromNas(nas: TrueNas, conn: Connection, path: string): Promise<IncomingMessage> {
  return downloadUrl(nas, path).then((urlPath) => new Promise<IncomingMessage>((resolve, reject) => {
    const base = new URL(conn.url.replace(/^ws/, "http").replace(/\/api\/current$/, ""));
    const req = request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === "https:" ? 443 : 80),
        path: urlPath,
        method: "GET",
        rejectUnauthorized: false,
        timeout: 30_000,
        // A fresh connection per transfer. On a reused keep-alive socket the
        // peer certificate is no longer retrievable, so the pin check below saw
        // an empty fingerprint and rejected every request after the first —
        // which looked exactly like a real certificate mismatch.
        agent: false,
      },
      (res) => {
        if (conn.fingerprint) {
          const socket = res.socket as TLSSocket;
          const raw =
            socket.getPeerX509Certificate?.()?.fingerprint256 ??
            socket.getPeerCertificate?.()?.fingerprint256;
          const seen = (raw ?? "").replace(/:/g, "").toLowerCase();
          const want = conn.fingerprint.replace(/:/g, "").toLowerCase();
          if (!seen) {
            res.destroy();
            reject(new Error("could not read the NAS certificate to check it against the pin"));
            return;
          }
          if (seen !== want) {
            res.destroy();
            reject(new Error(`the NAS certificate does not match the pin (saw ${seen.slice(0, 16)}…)`));
            return;
          }
        }
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          reject(new Error(`the NAS refused the transfer (${res.statusCode})`));
          return;
        }
        resolve(res);
      },
    );
    req.on("timeout", () => req.destroy(new Error("the NAS took too long to start the transfer")));
    req.on("error", reject);
    req.end();
  }));
}

/* ----------------------------------------------------------------- serving */

/** Stream a file straight through — used for images, documents and downloads. */
export async function streamThrough(
  nas: TrueNas,
  conn: Connection,
  path: string,
  res: ServerResponse,
  opts: { download?: boolean } = {},
): Promise<void> {
  const upstream = await fetchFromNas(nas, conn, path);
  const name = basename(path);
  res.writeHead(200, {
    "content-type": contentType(name),
    // inline so the browser renders it; attachment when it was asked for.
    "content-disposition": `${opts.download ? "attachment" : "inline"}; filename="${name.replace(/"/g, "")}"`,
    "cache-control": "private, max-age=300",
    ...(upstream.headers["content-length"] ? { "content-length": upstream.headers["content-length"] } : {}),
  });
  await pipeline(upstream, res);
}

/**
 * Serve media with working seek.
 *
 * The copy happens once per file; every later request, including each seek,
 * is an ordinary range read from local disk.
 */
export async function streamMedia(
  nas: TrueNas,
  conn: Connection,
  path: string,
  size: number,
  range: string | undefined,
  res: ServerResponse,
): Promise<void> {
  const local = cachePath(conn.id, path);

  if (!existsSync(local) || statSync(local).size !== size) {
    if (size > MAX_CACHE_FILE) {
      // Better to say so than to spend ten minutes copying and then fail.
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: `This file is ${(size / 1024 ** 3).toFixed(1)} GB. Files above ${(MAX_CACHE_FILE / 1024 ** 3).toFixed(0)} GB cannot be previewed in the browser — download it instead.`,
      }));
      return;
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    const upstream = await fetchFromNas(nas, conn, path);
    const tmp = `${local}.part`;
    try {
      await pipeline(upstream, createWriteStream(tmp));
      // Renamed only once complete, so an interrupted copy is never mistaken
      // for a cached file.
      const { renameSync } = await import("node:fs");
      renameSync(tmp, local);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw e;
    }
    evict();
  }

  const stat = statSync(local);
  const name = basename(path);
  const type = contentType(name);

  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "content-length": String(end - start + 1),
      "cache-control": "private, max-age=3600",
    });
    await pipeline(createReadStream(local, { start, end }), res);
    return;
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": String(stat.size),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });
  await pipeline(createReadStream(local), res);
}

export function cacheStats(): { files: number; bytes: number } {
  if (!existsSync(CACHE_DIR)) return { files: 0, bytes: 0 };
  const files = readdirSync(CACHE_DIR);
  let bytes = 0;
  for (const f of files) {
    try { bytes += statSync(join(CACHE_DIR, f)).size; } catch { /* gone */ }
  }
  return { files: files.length, bytes };
}

export function clearCache(): void {
  if (!existsSync(CACHE_DIR)) return;
  for (const f of readdirSync(CACHE_DIR)) {
    try { unlinkSync(join(CACHE_DIR, f)); } catch { /* in use */ }
  }
}
