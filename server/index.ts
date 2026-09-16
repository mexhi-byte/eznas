import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Realtime, TrueNas } from "./truenas.js";
import * as store from "./store.js";
import * as settings from "./settings.js";
import * as watcher from "./monitors.js";
import { handleUpgrade } from "./shell.js";
import { clearedCookie, cookieHeader, COOKIE, issue, read as readSessionCookie, readCookie } from "./auth.js";
import * as accounts from "./accounts.js";
import { verify as verifyTotp } from "./totp.js";
import { CHANNEL, VERSION } from "./version.js";

export { VERSION };
import {
  acceptableWriteType,
  bodyOf,
  clientAddress,
  json,
  sameOrigin,
  SECURITY_HEADERS,
  statusForError,
  trustProxy,
} from "./http.js";
import { handleFileRoutes } from "./routes/files.js";
import { handleShareRoutes } from "./routes/shares.js";
import { handleConsoleRoutes } from "./routes/console.js";
import { handleAppRoutes } from "./routes/apps.js";
import { handleNasUserRoutes } from "./routes/nas-users.js";
import { handleStorageRoutes } from "./routes/storage.js";
import { handleDiskRoutes } from "./routes/disks.js";
import { handleSnapshotRoutes } from "./routes/snapshots.js";
import { handleNetworkRoutes } from "./routes/network.js";
import { handleSystemRoutes } from "./routes/system.js";

// 8080, not 80: the same number the Dockerfile, the Vite proxy and the docs
// use, and one that does not need root to bind on a laptop.
const PORT = Number(process.env.PORT ?? 8080);

const WEB_ROOT = join(process.cwd(), "dist", "web");

store.init();
settings.load();
accounts.init(settings.get().mfa);
settings.loadEvents();
watcher.start();

/* ------------------------------------------------------------------ helpers */

const attempts = new Map<string, { count: number; until: number }>();
function tooManyAttempts(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function noteFailure(ip: string): void {
  const rec = attempts.get(ip) ?? { count: 0, until: Date.now() + 15 * 60_000 };
  rec.count += 1;
  attempts.set(ip, rec);
}

/** The session a request carries, if any. */
const readSession = (req: IncomingMessage) => readSessionCookie(readCookie(req.headers.cookie, COOKIE));

const TRUST_PROXY = trustProxy(process.env.TRUST_PROXY);
const clientIp = (req: IncomingMessage): string => clientAddress(req.headers, req.socket.remoteAddress, TRUST_PROXY);

/** The NAS this request is about, chosen by ?c= and falling back to the default. */
function nasFor(url: URL): TrueNas {
  const conn = store.get(url.searchParams.get("c"));
  if (!conn) throw new Error("No TrueNAS server is configured yet. Add one under Settings.");
  return store.clientFor(conn);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";

  /*
   * Writes must come from this console's own pages, in one of the two shapes
   * its client sends. Checked before anything else, including sign-in: a
   * cross-site sign-in form is how a session gets planted in someone's
   * browser.
   */
  if (method !== "GET" && method !== "HEAD") {
    if (!sameOrigin(req.headers, TRUST_PROXY)) {
      json(res, 403, {
        error:
          "This request came from a different site than the console is served from, so it was refused. " +
          "If the console is behind a reverse proxy, set TRUST_PROXY=1 and make sure the proxy passes " +
          "x-forwarded-host.",
      });
      return true;
    }
    if (!acceptableWriteType(req.headers["content-type"])) {
      json(res, 415, { error: "Send JSON. This console does not accept form posts." });
      return true;
    }
  }

  /* --- unauthenticated --- */
  if (path === "/api/session") {
    const current = readSession(req);
    const who = current ? accounts.byId(current.accountId) : undefined;
    json(res, 200, {
      authenticated: !!who,
      username: who?.username ?? null,
      role: who?.role ?? null,
      // So the console can put the change in front of the person rather than
      // letting them find out by having everything they try refused.
      mustChangePassword: who?.mustChangePassword === true,
      accountId: who?.id ?? null,
      // The sign-in page needs the theme before there is a session, or it
      // flashes the default theme and then repaints.
      theme: settings.get().theme,
      version: VERSION,
      channel: CHANNEL,
    });
    return true;
  }

  if (path === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) {
      json(res, 429, { error: "Too many attempts. Try again in a few minutes." });
      return true;
    }
    const body = await bodyOf(req);
    const account = accounts.authenticate(String(body.username ?? ""), String(body.password ?? ""));
    if (!account) {
      noteFailure(ip);
      // One message for both halves, so this cannot be used to find out which
      // usernames exist.
      json(res, 401, { error: "That username and password do not match." });
      return true;
    }

    if (account.mfa.enabled) {
      const code = String(body.code ?? "").trim();
      if (!code) {
        // Not an error: the password was right and the client now needs to ask
        // for the code. Saying so plainly avoids a second password prompt.
        json(res, 401, { error: "Enter the code from your authenticator app.", mfaRequired: true });
        return true;
      }
      const secret = accounts.mfaSecret(account);
      const ok = (secret && verifyTotp(secret, code)) || accounts.consumeRecovery(account.id, code);
      if (!ok) {
        noteFailure(ip);
        json(res, 401, { error: "That code is not right.", mfaRequired: true });
        return true;
      }
    }

    attempts.delete(ip);
    accounts.touch(account.id);
    json(
      res,
      200,
      { ok: true, username: account.username, role: account.role },
      { "set-cookie": cookieHeader(issue(account.id)) },
    );
    return true;
  }

  if (path === "/api/logout" && method === "POST") {
    json(res, 200, { ok: true }, { "set-cookie": clearedCookie() });
    return true;
  }

  const session = readSession(req);
  const me = session ? accounts.byId(session.accountId) : undefined;
  if (!me) {
    json(res, 401, { error: "Not signed in." });
    return true;
  }

  /*
   * A viewer may look, and nothing else.
   *
   * Enforced here rather than by hiding buttons: the browser is not a security
   * boundary, and anyone who can open devtools can call the API directly. The
   * rule is deliberately blunt — every method that is not a read is refused —
   * because an allow-list of safe writes is a list somebody has to remember to
   * extend every time a route is added, and forgetting is silent.
   */
  if (me.role !== "admin" && method !== "GET") {
    json(res, 403, { error: "This account can view the console but not change anything." });
    return true;
  }

  /*
   * An account still using the password the console generated may do one thing.
   *
   * Enforced here rather than by showing a dialog, for the same reason the
   * viewer rule is: the browser is not a boundary. A generated password that
   * is never changed is a credential sitting in a log file and in whatever
   * scrollback or terminal history the install left behind.
   *
   * Reads are allowed so the console still renders — a change-password form on
   * an otherwise blank page is harder to act on than one on the page it
   * belongs to.
   */
  if (me.mustChangePassword && method !== "GET" && !(path === `/api/accounts/${me.id}` && method === "PUT")) {
    json(res, 403, {
      error: "Change the password this console generated before doing anything else with it.",
      mustChangePassword: true,
    });
    return true;
  }

  /*
   * The console's own routes: accounts, settings, servers, its updates.
   * These need no NAS, and the first-run setup depends on that — a console
   * with no server yet still has to let you add one.
   */
  if (await handleConsoleRoutes({ path, method, url, req, res, me })) return true;

  /* --- everything below acts on one NAS --- */
  const nas = nasFor(url);

  if (path === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (r: Realtime) => res.write(`data: ${JSON.stringify(r)}\n\n`);
    if (nas.realtime) send(nas.realtime);
    const off = nas.onRealtime(send);
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      off();
      clearInterval(beat);
    });
    return true;
  }

  /* --- jobs --- */
  const jobMatch = /^\/api\/jobs\/(\d+)$/.exec(path);
  if (jobMatch) {
    json(res, 200, await nas.jobStatus(Number(jobMatch[1])));
    return true;
  }

  /*
   * One NAS, one module after another until one answers. Order matters only
   * where prefixes overlap: /api/files and /api/shares are whole subtrees and
   * claim theirs first.
   */
  const ctx = { path, method, url, req, res, nas, me };
  if (path.startsWith("/api/shares") && (await handleShareRoutes(ctx))) return true;
  if (path.startsWith("/api/files") && (await handleFileRoutes(ctx))) return true;
  for (const handle of [
    handleAppRoutes,
    handleNasUserRoutes,
    handleStorageRoutes,
    handleDiskRoutes,
    handleSnapshotRoutes,
    handleNetworkRoutes,
    handleSystemRoutes,
  ]) {
    if (await handle(ctx)) return true;
  }

  json(res, 404, { error: "No such endpoint." });
  return true;
}

/* ------------------------------------------------------------------- static */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(WEB_ROOT, rel);
  const file = rel === "/" || !extname(rel) ? join(WEB_ROOT, "index.html") : candidate;
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

/* -------------------------------------------------------------------- serve */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    if (await handleApi(req, res, url)) return;
    await serveStatic(url, res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[api] ${req.method} ${url.pathname}: ${message}`);
    if (!res.headersSent) {
      /*
       * 400, not 502.
       *
       * Nearly everything that lands here is the NAS declining something —
       * "this drive does not support self-tests", "dataset is busy", "pool not
       * found". That is a bad request, not a broken gateway, and the
       * distinction is not academic: a reverse proxy is entitled to replace a
       * 5xx body with its own error page, and Cloudflare does. Through the
       * tunnel every one of these arrived at the browser as
       * "error code: 502" in HTML, which the client then tried to parse as
       * JSON — so the user saw `Unexpected token '<'` instead of the reason.
       *
       * 502 is kept for the one case it describes: this console could not
       * reach the NAS at all.
       */
      json(res, statusForError(e), { error: message });
    } else {
      res.end();
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  if (handleUpgrade(req, socket, head)) return;
  socket.destroy();
});

server.listen(PORT, () => console.log(`[eznas] ${VERSION} listening on :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    watcher.stop();
    store.closeAll();
    process.exit(0);
  });
}
