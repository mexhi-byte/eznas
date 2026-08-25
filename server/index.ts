import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, posix } from "node:path";
import type { Realtime, TrueNas } from "./truenas.js";
import * as store from "./store.js";
import * as settings from "./settings.js";
import * as watcher from "./monitors.js";
import { handleUpgrade } from "./shell.js";
import * as files from "./files.js";
import * as exec from "./nas-exec.js";
import * as selfUpdate from "./self-update.js";
import * as webhooks from "./webhooks.js";
import { generateSecret, provisioningUri, recoveryCodes, verify as verifyTotp } from "./totp.js";
import { clearedCookie, cookieHeader, COOKIE, issue, read as readSessionCookie, readCookie, valid } from "./auth.js";
import * as accounts from "./accounts.js";

const PORT = Number(process.env.PORT ?? 80);

/**
 * The running version, and what it calls itself.
 *
 * Read from package.json rather than written out twice: a version that has to
 * be kept in step by hand is a version that eventually lies, and the updater
 * compares this against the tags published on GitHub.
 */
const PKG = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string; name: string };
export const VERSION = PKG.version;
const CHANNEL = process.env.RELEASE_CHANNEL ?? "demo";
const WEB_ROOT = join(process.cwd(), "dist", "web");

store.init();
settings.load();
accounts.init(settings.get().mfa);
settings.loadEvents();
watcher.start();

/* ------------------------------------------------------------------ helpers */

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("expected JSON");
  }
}

const str = (b: Record<string, unknown>, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" is required.`);
  return v.trim();
};
const optStr = (b: Record<string, unknown>, k: string): string | undefined => {
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
function confirmed(body: Record<string, unknown>, expected: string): void {
  if (String(body.confirm ?? "") !== expected) {
    throw new Error(`To confirm, this request must include "confirm": "${expected}".`);
  }
}

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

/** An in-flight 2FA enrolment, held only until it is confirmed or expires. */
let pendingMfa: { secret: string; at: number; accountId: string } | null = null;

/** The session a request carries, if any. */
const readSession = (req: IncomingMessage) => readSessionCookie(readCookie(req.headers.cookie, COOKIE));

const clientIp = (req: IncomingMessage): string =>
  (req.headers["cf-connecting-ip"] as string) ?? req.socket.remoteAddress ?? "unknown";

/**
 * Confine a path to /mnt.
 *
 * A prefix test alone is not enough: "/mnt/../etc/passwd" starts with "/mnt"
 * and the NAS resolves it happily, which turned the file browser into a way to
 * read anything on the box. Normalising first collapses the "..", so the check
 * runs against the path that will actually be opened.
 */
function underMnt(raw: string): string {
  const path = posix.normalize(raw);
  if (path !== "/mnt" && !path.startsWith("/mnt/")) {
    throw new Error("Only paths under /mnt can be reached.");
  }
  return path;
}

/** The NAS this request is about, chosen by ?c= and falling back to the default. */
function nasFor(url: URL): TrueNas {
  const conn = store.get(url.searchParams.get("c"));
  if (!conn) throw new Error("No TrueNAS server is configured yet. Add one under Settings.");
  return store.clientFor(conn);
}

/* ------------------------------------------------------------------- shapes */

interface PoolRow {
  name: string; status: string; healthy: boolean; size: number; allocated: number; free: number;
  fragmentation?: string;
  topology?: { data?: VdevRow[]; cache?: VdevRow[]; log?: VdevRow[]; spare?: VdevRow[] };
  scan?: { function?: string; state?: string; percentage?: number; end_time?: { $date: number } } | null;
}
interface VdevRow { type: string; status?: string; disk?: string | null; children?: Array<{ disk?: string | null; status?: string; type?: string }> }
interface AppRow {
  name: string; state: string; upgrade_available: boolean; human_version: string; version: string;
  portals?: Record<string, string>;
  active_workloads?: { containers?: number; used_ports?: Array<{ host_ports?: Array<{ host_port: number }> }> };
  metadata?: { icon?: string; title?: string; train?: string; app_version?: string; description?: string };
}
interface AclPerms { READ?: boolean; WRITE?: boolean; EXECUTE?: boolean }
interface AclEntry { tag: string; id: number; who?: string | null; perms: Required<AclPerms>; default: boolean }
interface AclResult {
  path: string; uid: number; gid: number; acltype: string; trivial: boolean;
  acl: Array<{ tag: string; id: number; who?: string | null; perms?: AclPerms; default?: boolean }>;
}

/**
 * Three levels, because nobody wants to reason about the execute bit.
 *
 * On a directory the execute bit is what allows entering it at all, so "read"
 * without it produces a folder somebody can see and not open — the single most
 * confusing permission state there is. Read therefore always carries execute.
 */
function levelToPerms(level: string): Required<AclPerms> {
  switch (level) {
    case "none": return { READ: false, WRITE: false, EXECUTE: false };
    case "write": return { READ: true, WRITE: true, EXECUTE: true };
    case "full": return { READ: true, WRITE: true, EXECUTE: true };
    default: return { READ: true, WRITE: false, EXECUTE: true };
  }
}

interface AlertRow { uuid: string; level: string; formatted: string; dismissed: boolean; datetime: { $date: number }; klass?: string }
interface DiskRow { name: string; model: string; serial: string; size: number; type: string; rotationrate: number | null; pool: string | null; imported_zpool?: string | null; description?: string }

function summarisePool(p: PoolRow) {
  const disksOf = (v: VdevRow[] = []): string[] =>
    v.flatMap((d) => (d.children?.length ? d.children.map((c) => c.disk ?? "?") : [d.disk ?? "?"]));
  return {
    name: p.name, status: p.status, healthy: p.healthy, size: p.size, allocated: p.allocated,
    free: p.free, fragmentation: p.fragmentation,
    vdevs: (p.topology?.data ?? []).map((v) => ({
      type: v.type, status: v.status,
      disks: v.children?.length ? v.children.map((c) => ({ disk: c.disk ?? "?", status: c.status })) : [{ disk: v.disk ?? "?", status: v.status }],
    })),
    cache: disksOf(p.topology?.cache), log: disksOf(p.topology?.log), spare: disksOf(p.topology?.spare),
    scan: p.scan ? { function: p.scan.function, state: p.scan.state, percentage: p.scan.percentage, endedAt: p.scan.end_time?.$date } : null,
  };
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "parsed" in v) return Number((v as { parsed: unknown }).parsed) || null;
  return null;
};
/**
 * ZFS timestamps, in milliseconds.
 *
 * A parsed `creation` property is not a number — it is `{"$date": 1787569084000}`,
 * already in milliseconds. Treating it as seconds put every snapshot fifty
 * thousand years in the future, which the relative formatter rendered as a
 * blank dash.
 */
const epochMs = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  if (v && typeof v === "object" && "$date" in v) return Number((v as { $date: unknown }).$date) || null;
  return null;
};

const sval = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) return String((v as { value: unknown }).value);
  return null;
};

/* ------------------------------------------------------------------- routes */

async function overview(nas: TrueNas) {
  const [info, pools, apps, alerts, disks] = await Promise.all([
    nas.call<Record<string, unknown>>("system.info"),
    nas.call<PoolRow[]>("pool.query"),
    nas.call<AppRow[]>("app.query"),
    nas.call<AlertRow[]>("alert.list"),
    nas.call<DiskRow[]>("disk.query"),
  ]);
  return {
    system: {
      version: info.version, hostname: info.hostname, uptime: info.uptime_seconds ?? info.uptime,
      cores: info.cores, model: info.model, memoryBytes: info.physmem, loadavg: info.loadavg,
    },
    pools: pools.map(summarisePool),
    apps: {
      total: apps.length,
      running: apps.filter((a) => a.state === "RUNNING").length,
      stopped: apps.filter((a) => a.state !== "RUNNING").length,
      updatable: apps.filter((a) => a.upgrade_available).length,
    },
    alerts: {
      total: alerts.filter((a) => !a.dismissed).length,
      critical: alerts.filter((a) => !a.dismissed && ["CRITICAL", "ERROR", "ALERT", "EMERGENCY"].includes(a.level)).length,
      warning: alerts.filter((a) => !a.dismissed && a.level === "WARNING").length,
    },
    disks: disks.length,
  };
}

const APP_ACTIONS: Record<string, string> = { start: "app.start", stop: "app.stop", restart: "app.redeploy" };

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";

  /* --- unauthenticated --- */
  if (path === "/api/session") {
    const current = readSession(req);
    const who = current ? accounts.byId(current.accountId) : undefined;
    json(res, 200, {
      authenticated: !!who,
      username: who?.username ?? null,
      role: who?.role ?? null,
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
    json(res, 200, { ok: true, username: account.username, role: account.role },
      { "set-cookie": cookieHeader(issue(account.id)) });
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

  /* --- console accounts --- */

  if (path === "/api/accounts") {
    if (method === "GET") {
      json(res, 200, accounts.all().map(accounts.publicView));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      json(res, 200, accounts.publicView(accounts.create({
        username: str(b, "username"),
        password: str(b, "password"),
        role: b.role === "viewer" ? "viewer" : "admin",
      })));
      return true;
    }
  }

  const accountMatch = /^\/api\/accounts\/([^/]+)$/.exec(path);
  if (accountMatch) {
    const id = accountMatch[1];
    if (method === "PUT") {
      const b = await bodyOf(req);
      // Changing your own password means proving you know the current one. A
      // signed-in session is not proof: it is what an unlocked laptop hands to
      // whoever walks past it.
      if (id === me.id && optStr(b, "password")) {
        if (!accounts.authenticate(me.username, String(b.currentPassword ?? ""))) {
          throw new Error("Enter your current password to change it.");
        }
      }
      json(res, 200, accounts.publicView(accounts.update(id, {
        username: optStr(b, "username"),
        password: optStr(b, "password"),
        role: b.role === "viewer" ? "viewer" : b.role === "admin" ? "admin" : undefined,
      })));
      return true;
    }
    if (method === "DELETE") {
      if (id === me.id) throw new Error("You cannot delete the account you are signed in with.");
      accounts.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* --- console settings --- */

  if (path === "/api/settings") {
    if (method === "GET") {
      json(res, 200, settings.publicView());
      return true;
    }
    if (method === "PUT") {
      const b = await bodyOf(req);
      const next: Record<string, unknown> = {};
      if (optStr(b, "theme")) next.theme = optStr(b, "theme");
      if (b.notify && typeof b.notify === "object") {
        const n = b.notify as Record<string, unknown>;
        const current = settings.get().notify;
        const w = (n.watch ?? {}) as Record<string, unknown>;
        const bool = (k: keyof typeof current.watch) => (w[k] === undefined ? current.watch[k] : w[k] === true);
        const num = (k: "capacityPercent" | "temperatureC", lo: number, hi: number) =>
          w[k] === undefined ? current.watch[k] : Math.min(hi, Math.max(lo, Number(w[k]) || current.watch[k]));
        next.notify = {
          watchDisks: n.watchDisks !== false,
          email: n.email === true,
          recipients: Array.isArray(n.recipients) ? (n.recipients as string[]).map(String).filter(Boolean) : [],
          emailLevel: ["info", "warn", "bad"].includes(String(n.emailLevel)) ? (n.emailLevel as "info") : current.emailLevel,
          watch: {
            poolHealth: bool("poolHealth"),
            capacity: bool("capacity"),
            capacityPercent: num("capacityPercent", 50, 99),
            temperature: bool("temperature"),
            temperatureC: num("temperatureC", 30, 80),
            zfsErrors: bool("zfsErrors"),
            apps: bool("apps"),
            scrubs: bool("scrubs"),
            updates: bool("updates"),
            reachability: bool("reachability"),
          },
          greetName: n.greetName === undefined ? current.greetName : String(n.greetName).trim().slice(0, 40),
          webhooks: Array.isArray(n.webhooks)
            ? (n.webhooks as Array<Record<string, unknown>>).map((w) => {
                const existing = current.webhooks.find((x) => x.id === w.id);
                const problem = webhooks.validate(w as never);
                if (problem) throw new Error(problem);
                return {
                  id: String(w.id ?? randomUUID()),
                  kind: (["discord", "telegram", "ntfy", "generic"].includes(String(w.kind)) ? w.kind : "generic") as never,
                  url: String(w.url ?? ""),
                  // A masked token means "unchanged" — the browser was never
                  // given the real one to send back.
                  botToken: w.botToken === "********" ? existing?.botToken : (w.botToken ? String(w.botToken) : undefined),
                  chatId: w.chatId ? String(w.chatId) : undefined,
                  topic: w.topic ? String(w.topic) : undefined,
                  enabled: w.enabled !== false,
                  level: (["info", "warn", "bad"].includes(String(w.level)) ? w.level : "warn") as never,
                };
              })
            : current.webhooks,
        };
      }
      if (b.names && typeof b.names === "object") {
        const n = b.names as Record<string, unknown>;
        const pools: Record<string, { label?: string; icon?: string }> = { ...settings.get().names.pools };
        for (const [pool, v] of Object.entries((n.pools as Record<string, unknown>) ?? {})) {
          const entry = (v ?? {}) as Record<string, unknown>;
          const label = String(entry.label ?? "").trim().slice(0, 40);
          const icon = String(entry.icon ?? "").trim().slice(0, 8);
          // An empty label is how a nickname is removed, so it deletes the
          // entry rather than storing a blank one that would render as a gap.
          if (!label && !icon) delete pools[pool];
          else pools[pool] = { ...(label ? { label } : {}), ...(icon ? { icon } : {}) };
        }
        next.names = {
          server: n.server === undefined ? settings.get().names.server : String(n.server).trim().slice(0, 40),
          pools,
        };
      }
      settings.patch(next as Parameters<typeof settings.patch>[0]);
      json(res, 200, settings.publicView());
      return true;
    }
  }

  /* --- second factor, on your own account --- */

  if (path === "/api/mfa/begin" && method === "POST") {
    // The secret is handed out once, here, so it can be shown as a QR code. It
    // is only persisted when a valid code proves the app holds the same one.
    const secret = generateSecret();
    pendingMfa = { secret, at: Date.now(), accountId: me.id };
    json(res, 200, { secret, uri: provisioningUri(secret, me.username, "TrueNAS console") });
    return true;
  }

  if (path === "/api/mfa/enable" && method === "POST") {
    const b = await bodyOf(req);
    // Tied to the account that started it, so one person's enrolment can never
    // be completed onto somebody else's account.
    if (!pendingMfa || pendingMfa.accountId !== me.id || Date.now() - pendingMfa.at > 10 * 60_000) {
      throw new Error("That enrolment expired. Start again.");
    }
    if (!verifyTotp(pendingMfa.secret, String(b.code ?? ""))) {
      throw new Error("That code is not right. Check the clock on your phone and try again.");
    }
    const codes = recoveryCodes();
    accounts.setMfa(me.id, pendingMfa.secret, codes);
    pendingMfa = null;
    // Shown once. Storing them in the clear to display later would defeat the
    // point of hashing them.
    json(res, 200, { ok: true, recovery: codes });
    return true;
  }

  if (path === "/api/mfa/disable" && method === "POST") {
    const b = await bodyOf(req);
    const secret = accounts.mfaSecret(me);
    const code = String(b.code ?? "");
    if (me.mfa.enabled && !(secret && verifyTotp(secret, code)) && !accounts.consumeRecovery(me.id, code)) {
      throw new Error("Enter a current code to turn this off.");
    }
    accounts.setMfa(me.id, null, []);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- updating this console itself --- */

  if (path === "/api/console/update") {
    if (method === "GET") {
      json(res, 200, await selfUpdate.check(VERSION));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const tag = str(b, "tag");
      // Streamed as it happens: an update that prints nothing for two minutes
      // while npm works is indistinguishable from one that has hung.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      try {
        await selfUpdate.apply(tag, (line) => res.write(`${line}\n`));
        res.end("\nOK\n");
      } catch (e) {
        res.end(`\nFAILED: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      return true;
    }
  }

  /* --- disk events --- */

  if (path === "/api/notify/test" && method === "POST") {
    const b = await bodyOf(req);
    const cfg = settings.get().notify;
    // Test the saved hook where one is named, so a masked token is still
    // testable; otherwise test exactly what is on screen.
    const saved = cfg.webhooks.find((w) => w.id === b.id);
    const hook = saved ?? (b as unknown as webhooks.Webhook);
    const problem = webhooks.validate(hook);
    if (problem) throw new Error(problem);
    await webhooks.deliver(hook, {
      level: "info",
      category: "test",
      title: "Test from your NAS",
      detail: "If you are reading this on your phone, notifications are working.",
      server: store.get(url.searchParams.get("c"))?.name ?? "EzNAS",
    }, cfg.greetName || undefined);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/events/check" && method === "POST") {
    await watcher.runNow();
    json(res, 200, { ok: true, events: settings.allEvents().length });
    return true;
  }

  if (path === "/api/events") {
    if (method === "GET") {
      json(res, 200, settings.allEvents());
      return true;
    }
    if (method === "POST") {
      settings.markSeen();
      json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE") {
      settings.clearEvents();
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* --- connections (settings) --- */

  if (path === "/api/connections") {
    if (method === "GET") {
      json(res, 200, store.all().map(store.publicView));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const conn = store.add({
        name: str(b, "name"),
        url: normaliseUrl(str(b, "url")),
        apiKey: str(b, "apiKey"),
        fingerprint: optStr(b, "fingerprint") ?? null,
        sudoPassword: optStr(b, "sudoPassword"),
      });
      json(res, 200, store.publicView(conn));
      return true;
    }
  }

  if (path === "/api/connections/test" && method === "POST") {
    const b = await bodyOf(req);
    json(res, 200, await store.test({
      url: normaliseUrl(str(b, "url")),
      apiKey: str(b, "apiKey"),
      fingerprint: optStr(b, "fingerprint") ?? null,
    }));
    return true;
  }

  const connMatch = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (connMatch) {
    const id = connMatch[1];
    if (method === "PUT") {
      const b = await bodyOf(req);
      const conn = store.update(id, {
        name: optStr(b, "name"),
        url: b.url ? normaliseUrl(String(b.url)) : undefined,
        apiKey: optStr(b, "apiKey"),
        fingerprint: b.fingerprint === undefined ? undefined : (optStr(b, "fingerprint") ?? null),
        // Explicit null clears the stored password; absent leaves it alone.
        sudoPassword: b.sudoPassword === null ? null : optStr(b, "sudoPassword"),
        isDefault: b.isDefault === true,
      });
      json(res, 200, store.publicView(conn));
      return true;
    }
    if (method === "DELETE") {
      store.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* --- everything below acts on one NAS --- */
  const nas = nasFor(url);

  if (path === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-store",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    const send = (r: Realtime) => res.write(`data: ${JSON.stringify(r)}\n\n`);
    if (nas.realtime) send(nas.realtime);
    const off = nas.onRealtime(send);
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { off(); clearInterval(beat); });
    return true;
  }

  /* --- jobs --- */
  const jobMatch = /^\/api\/jobs\/(\d+)$/.exec(path);
  if (jobMatch) {
    json(res, 200, await nas.jobStatus(Number(jobMatch[1])));
    return true;
  }

  /* --- apps --- */
  const appAction = /^\/api\/apps\/([^/]+)\/(start|stop|restart|upgrade)$/.exec(path);
  if (appAction && method === "POST") {
    const [, name, action] = appAction;
    if (action === "upgrade") {
      json(res, 200, { jobId: await nas.startJob("app.upgrade", [name, {}]) });
      return true;
    }
    await nas.call(APP_ACTIONS[action], [name]);
    json(res, 200, { ok: true });
    return true;
  }

  const appDelete = /^\/api\/apps\/([^/]+)$/.exec(path);
  if (appDelete && method === "DELETE") {
    const name = appDelete[1];
    confirmed(await bodyOf(req), name);
    json(res, 200, { jobId: await nas.startJob("app.delete", [name, { remove_ix_volumes: false }]) });
    return true;
  }

  const appConfig = /^\/api\/apps\/([^/]+)\/config$/.exec(path);
  if (appConfig) {
    const name = appConfig[1];
    if (method === "GET") {
      const [row] = await nas.call<AppRow[]>("app.query", [[["name", "=", name]]]);
      if (!row) throw new Error(`There is no app called "${name}".`);
      const raw = await nas.call<Record<string, unknown>>("app.config", [name]);
      // ix_* keys are the middleware's own scaffolding — certificates it
      // injected, the install context. They are not settings, and echoing them
      // back on save is how an update gets rejected.
      const values = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("ix_")));
      const custom = (row as unknown as { custom_app?: boolean }).custom_app === true;

      // Only a catalog app has questions to render a form from; a custom app is
      // a compose file and is edited as one.
      let schema: unknown = null;
      if (!custom) {
        schema = await nas
          .call<Record<string, unknown>>("catalog.get_app_details", [name, { train: row.metadata?.train ?? "stable" }])
          .then((d) => {
            const versions = (d.versions ?? {}) as Record<string, { schema?: { questions?: unknown } }>;
            return versions[String(d.latest_version)]?.schema?.questions ?? null;
          })
          .catch(() => null);
      }

      json(res, 200, {
        name,
        title: row.metadata?.title ?? name,
        version: row.human_version || row.version,
        custom,
        portals: row.portals ?? {},
        values,
        schema,
        credentials: credentialsIn(values),
      });
      return true;
    }
    if (method === "PUT") {
      const b = await bodyOf(req);
      const values = b.values;
      if (!values || typeof values !== "object") throw new Error("Nothing to save.");
      const [row] = await nas.call<AppRow[]>("app.query", [[["name", "=", name]]]);
      if (!row) throw new Error(`There is no app called "${name}".`);
      const custom = (row as unknown as { custom_app?: boolean }).custom_app === true;
      // A custom app's settings *are* its compose file, and it goes back under
      // a different key than a catalog app's answers.
      const payload = custom ? { custom_compose_config: values } : { values };
      json(res, 200, { jobId: await nas.startJob("app.update", [name, payload]) });
      return true;
    }
  }

  if (path === "/api/apps" && method === "POST") {
    const b = await bodyOf(req);
    json(res, 200, {
      jobId: await nas.startJob("app.create", [{
        app_name: str(b, "appName"),
        catalog_app: str(b, "catalogApp"),
        train: optStr(b, "train") ?? "stable",
        values: (b.values as Record<string, unknown>) ?? {},
      }]),
    });
    return true;
  }

  if (path === "/api/catalog") {
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    const category = url.searchParams.get("category") ?? "";
    const rows = await nas.call<Array<Record<string, unknown>>>("app.available", [
      [], { select: ["name", "title", "categories", "latest_version", "train", "description", "icon_url", "installed"] },
    ]);
    const filtered = rows.filter((a) => {
      const hay = `${a.name} ${a.title} ${a.description ?? ""}`.toLowerCase();
      const cats = (a.categories as string[]) ?? [];
      return (!q || hay.includes(q)) && (!category || cats.includes(category));
    });
    json(res, 200, {
      categories: await nas.call<string[]>("app.categories").catch(() => []),
      total: filtered.length,
      apps: filtered.slice(0, 120),
    });
    return true;
  }

  /* --- users and groups --- */
  if (path === "/api/users") {
    if (method === "GET") {
      const showBuiltin = url.searchParams.get("builtin") === "1";
      const users = await nas.call<Array<Record<string, unknown>>>("user.query", [[["local", "=", true]]]);
      json(res, 200, users
        .filter((u) => showBuiltin || !u.builtin)
        .map((u) => ({
          id: u.id, uid: u.uid, username: u.username, fullName: u.full_name,
          email: u.email, shell: u.shell, home: u.home, locked: u.locked,
          builtin: u.builtin, smb: u.smb, sudo: (u.sudo_commands as string[])?.length > 0,
          groups: u.groups,
        })));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = {
        username: str(b, "username"),
        full_name: optStr(b, "fullName") ?? str(b, "username"),
        // A new account gets its own group unless one was named, which is the
        // behaviour people expect from useradd and avoids everyone sharing one.
        group_create: !b.group,
        home_create: b.homeCreate === true,
        smb: b.smb !== false,
      };
      if (b.group) payload.group = Number(b.group);
      if (optStr(b, "password")) payload.password = optStr(b, "password");
      else payload.password_disabled = true;
      if (optStr(b, "email")) payload.email = optStr(b, "email");
      if (optStr(b, "shell")) payload.shell = optStr(b, "shell");
      if (optStr(b, "sshpubkey")) payload.sshpubkey = optStr(b, "sshpubkey");
      json(res, 200, safeUser(await nas.call("user.create", [payload])));
      return true;
    }
  }

  const userMatch = /^\/api\/users\/(\d+)$/.exec(path);
  if (userMatch) {
    const id = Number(userMatch[1]);
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "fullName")) patch.full_name = optStr(b, "fullName");
      if (optStr(b, "email")) patch.email = optStr(b, "email");
      if (optStr(b, "shell")) patch.shell = optStr(b, "shell");
      if (optStr(b, "password")) patch.password = optStr(b, "password");
      if (typeof b.locked === "boolean") patch.locked = b.locked;
      if (typeof b.smb === "boolean") patch.smb = b.smb;
      json(res, 200, safeUser(await nas.call("user.update", [id, patch])));
      return true;
    }
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const users = await nas.call<Array<Record<string, unknown>>>("user.query", [[["id", "=", id]]]);
      const username = String(users[0]?.username ?? "");
      confirmed(b, username);
      json(res, 200, await nas.call("user.delete", [id, { delete_group: b.deleteGroup === true }]));
      return true;
    }
  }

  if (path === "/api/groups") {
    const groups = await nas.call<Array<Record<string, unknown>>>("group.query", [[["local", "=", true]]]);
    json(res, 200, groups.map((g) => ({ id: g.id, gid: g.gid, name: g.group, builtin: g.builtin, users: (g.users as unknown[])?.length ?? 0 })));
    return true;
  }

  if (path === "/api/shells") {
    json(res, 200, await nas.call("user.shell_choices").catch(() => ({})));
    return true;
  }

  /* --- pools --- */
  if (path === "/api/pools") {
    if (method === "GET") {
      json(res, 200, (await nas.call<PoolRow[]>("pool.query")).map(summarisePool));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const disks = (b.disks as string[]) ?? [];
      if (!disks.length) throw new Error("Select at least one disk.");
      const layout = String(b.layout ?? "STRIPE").toUpperCase();
      json(res, 200, {
        jobId: await nas.startJob("pool.create", [{
          name: str(b, "name"),
          // One vdev of the requested type. Mixed-width topologies are a real
          // need but not one a form can express safely, so they stay in the
          // TrueNAS UI rather than being half-supported here.
          topology: { data: [{ type: layout, disks }] },
          allow_duplicate_serials: false,
        }]),
      });
      return true;
    }
  }

  const poolScrub = /^\/api\/pools\/([^/]+)\/scrub$/.exec(path);
  if (poolScrub && method === "POST") {
    json(res, 200, { jobId: await nas.startJob("pool.scrub", [await poolIdOf(nas, poolScrub[1]), "START"]) });
    return true;
  }

  const poolMatch = /^\/api\/pools\/([^/]+)$/.exec(path);
  if (poolMatch && method === "DELETE") {
    const name = poolMatch[1];
    const b = await bodyOf(req);
    confirmed(b, name);
    json(res, 200, {
      jobId: await nas.startJob("pool.export", [await poolIdOf(nas, name), {
        // destroy=false keeps the data and merely detaches the pool, which is
        // recoverable by importing it again. Wiping is opt-in and separate.
        destroy: b.destroy === true,
        cascade: true,
        restart_services: true,
      }]),
    });
    return true;
  }

  /**
   * The last day, rather than the last minute.
   *
   * The live feed on the home screen answers "what is it doing now", which is
   * no help at all for a container that leaked memory overnight or a backup
   * that pinned the disks at four in the morning. TrueNAS keeps the history in
   * netdata; this reads it back.
   *
   * Downsampled here rather than in the browser: a day at one-second
   * resolution is three thousand points per metric, and shipping that to draw
   * a line 240 pixels wide wastes the transfer and then throws it away.
   */
  if (path === "/api/history") {
    const metric = url.searchParams.get("metric") ?? "cpu";
    const unit = (url.searchParams.get("unit") ?? "DAY").toUpperCase();
    if (!["HOUR", "DAY", "WEEK", "MONTH"].includes(unit)) throw new Error("Unknown time span.");

    const wanted: Record<string, { name: string; identifier?: string }> = {
      cpu: { name: "cpu" },
      memory: { name: "memory" },
      network: { name: "interface" },
    };
    const spec = wanted[metric];
    if (!spec) throw new Error(`There is no "${metric}" history.`);

    // The interface graph is per NIC and needs naming; pick the busiest rather
    // than guessing at a name that differs on every machine.
    let identifier = spec.identifier;
    if (metric === "network") {
      const nics = await nas.call<Array<Record<string, unknown>>>("interface.query");
      identifier = String(nics.find((n) => n.state && (n.state as { link_state?: string }).link_state === "LINK_STATE_UP")?.name ?? nics[0]?.name ?? "");
      if (!identifier) throw new Error("No network interface to report on.");
    }

    const [graph] = await nas.call<Array<{
      name: string; legend: string[]; data: number[][]; start: number; end: number;
      aggregations?: { min?: Record<string, number>; mean?: Record<string, number>; max?: Record<string, number> };
    }>>("reporting.netdata_get_data", [[{ name: spec.name, ...(identifier ? { identifier } : {}) }], { unit, page: 1 }], 30_000);

    if (!graph?.data?.length) {
      json(res, 200, { metric, unit, points: [], series: [], summary: null });
      return true;
    }

    // memory reports what is *available*; everybody thinks in what is used.
    const total = metric === "memory"
      ? Number((await nas.call<Record<string, unknown>>("system.info")).physmem ?? 0)
      : 0;

    const cols = graph.legend.slice(1);
    const keep = metric === "cpu" ? [0] : metric === "memory" ? [0] : [0, 1];
    const series = keep.map((i) => (metric === "memory" ? "used" : cols[i] ?? `series ${i}`));

    const BUCKETS = 160;
    const step = Math.max(1, Math.ceil(graph.data.length / BUCKETS));
    const points: Array<{ t: number; v: number[] }> = [];
    for (let i = 0; i < graph.data.length; i += step) {
      const slice = graph.data.slice(i, i + step).filter((row) => row.every((n) => n !== null));
      if (!slice.length) continue;
      const at = slice[0][0];
      const v = keep.map((k) => {
        const mean = slice.reduce((sum, row) => sum + (Number(row[k + 1]) || 0), 0) / slice.length;
        // available → used %, which is what the live card shows too.
        return metric === "memory" && total ? Math.max(0, ((total - mean) / total) * 100) : mean;
      });
      points.push({ t: at * 1000, v });
    }

    const flat = points.flatMap((p) => p.v);
    json(res, 200, {
      metric,
      unit,
      identifier: identifier ?? null,
      series,
      points,
      summary: flat.length
        ? {
            min: Math.min(...flat),
            max: Math.max(...flat),
            mean: flat.reduce((a, b) => a + b, 0) / flat.length,
            from: graph.start * 1000,
            to: graph.end * 1000,
          }
        : null,
    });
    return true;
  }

  /* --- disks --- */
  if (path === "/api/disks") {
    const [details, temps] = await Promise.all([
      nas.call<{ used: DiskRow[]; unused: DiskRow[] }>("disk.details"),
      nas.call<Record<string, number | null>>("disk.temperatures").catch(() => ({}) as Record<string, number | null>),
    ]);
    // imported_zpool is where the pool name actually lives. disk.query's own
    // `pool` field reads null for every disk on 25.04, which made every disk in
    // a healthy pool render as "unassigned".
    const shape = (d: DiskRow, inUse: boolean) => ({
      name: d.name, model: d.model, serial: d.serial, size: d.size, type: d.type,
      rpm: d.rotationrate, pool: d.imported_zpool ?? d.pool ?? null, inUse, tempC: temperature(temps[d.name]),
    });
    json(res, 200, [
      ...(details.used ?? []).map((d) => shape(d, true)),
      ...(details.unused ?? []).map((d) => shape(d, false)),
    ]);
    return true;
  }

  if (path === "/api/disks/rescan" && method === "POST") {
    // retaste makes the NAS re-read every disk's label, which is how a drive
    // hot-plugged after boot becomes visible without a reboot.
    await nas.call("disk.retaste", [[]]).catch(() => nas.call("disk.retaste"));
    const details = await nas.call<{ unused: DiskRow[] }>("disk.details");
    json(res, 200, { unused: (details.unused ?? []).map((d) => ({ name: d.name, model: d.model, size: d.size, serial: d.serial })) });
    return true;
  }

  const diskWipe = /^\/api\/disks\/([^/]+)\/wipe$/.exec(path);
  if (diskWipe && method === "POST") {
    const name = diskWipe[1];
    const b = await bodyOf(req);
    confirmed(b, name);
    json(res, 200, { jobId: await nas.startJob("disk.wipe", [name, String(b.mode ?? "QUICK")]) });
    return true;
  }

  /**
   * Replacing a failed drive, guided.
   *
   * In the NAS's own interface this is ten steps across four screens, and the
   * one that goes wrong is picking the disk: the failed member is identified
   * by a ZFS guid, the replacement by a device name, and the two look nothing
   * alike. Getting it wrong offlines a healthy drive in an already-degraded
   * pool, which is how a recoverable failure becomes a lost pool.
   *
   * So the console does the identification. It reports the physical serial to
   * look for, offlines by guid, and afterwards replaces using the guid it
   * already knows — never a name the operator had to retype.
   */
  const replaceMatch = /^\/api\/pools\/([^/]+)\/replace\/(identify|offline|scan|replace)$/.exec(path);
  if (replaceMatch) {
    const [, poolName, step] = replaceMatch;
    const poolId = await poolIdOf(nas, poolName);
    const b = method === "POST" ? await bodyOf(req) : {};

    if (step === "identify" && method === "GET") {
      const [pool] = await nas.call<PoolRow[]>("pool.query", [[["name", "=", poolName]]]);
      if (!pool) throw new Error(`There is no pool called "${poolName}".`);
      const [details, disks] = await Promise.all([
        nas.call<{ used?: Array<Record<string, unknown>>; unused?: Array<Record<string, unknown>> }>("disk.details"),
        nas.call<Array<Record<string, unknown>>>("disk.query"),
      ]);
      const byName = new Map(disks.map((d) => [String(d.name), d]));

      // Every member that is not ONLINE, with whatever the NAS still knows
      // about the physical device behind it.
      const faulted: Array<Record<string, unknown>> = [];
      for (const [role, vdevs] of Object.entries((pool.topology ?? {}) as Record<string, VdevLeaf[]>)) {
        for (const vdev of vdevs ?? []) {
          const walk = (node: VdevLeaf & { guid?: string; name?: string }) => {
            const kids = node.children ?? [];
            if (!kids.length) {
              const dev = node.disk ?? node.device ?? null;
              if (node.status && node.status !== "ONLINE") {
                const d = dev ? byName.get(dev) : undefined;
                faulted.push({
                  guid: node.guid ?? node.name ?? null,
                  device: dev,
                  status: node.status,
                  role,
                  vdev: vdev.type,
                  model: d?.model ?? null,
                  serial: d?.serial ?? null,
                  size: d?.size ?? null,
                });
              }
            }
            for (const c of kids) walk(c as never);
          };
          walk(vdev as never);
        }
      }

      json(res, 200, {
        pool: poolName,
        status: pool.status,
        faulted,
        spare: (details.unused ?? []).map((d) => ({
          name: d.name, model: d.model, serial: d.serial, size: d.size, type: d.type,
        })),
      });
      return true;
    }

    if (step === "offline" && method === "POST") {
      const label = str(b, "label");
      confirmed(b, label);
      await nas.call("pool.offline", [poolId, { label }]);
      json(res, 200, { ok: true });
      return true;
    }

    if (step === "scan" && method === "POST") {
      // retaste makes the NAS re-read every disk's label, which is how a drive
      // plugged in after boot becomes visible without a reboot.
      await nas.call("disk.retaste", [[]]).catch(() => nas.call("disk.retaste"));
      const details = await nas.call<{ unused?: Array<Record<string, unknown>> }>("disk.details");
      json(res, 200, {
        spare: (details.unused ?? []).map((d) => ({
          name: d.name, model: d.model, serial: d.serial, size: d.size, type: d.type,
        })),
      });
      return true;
    }

    if (step === "replace" && method === "POST") {
      const label = str(b, "label");
      const disk = str(b, "disk");
      confirmed(b, disk);
      json(res, 200, {
        jobId: await nas.startJob("pool.replace", [poolId, {
          label,
          disk,
          force: b.force === true,
          preserve_settings: true,
        }]),
      });
      return true;
    }
  }

  const diskHealth = /^\/api\/disks\/([^/]+)\/health$/.exec(path);
  if (diskHealth && method === "GET") {
    json(res, 200, await diskHealthOf(nas, diskHealth[1]));
    return true;
  }

  const diskTest = /^\/api\/disks\/([^/]+)\/smart-test$/.exec(path);
  if (diskTest && method === "POST") {
    const name = diskTest[1];
    const b = await bodyOf(req);
    const kind = String(b.type ?? "SHORT").toUpperCase();
    if (!["SHORT", "LONG", "CONVEYANCE", "OFFLINE"].includes(kind)) throw new Error(`Unknown test type "${kind}".`);
    // manual_test is addressed by the disk's stable identifier, not its device
    // name: sdb can become sdc across a reboot, and starting a long test on the
    // wrong drive is a real cost in a pool that is already degraded.
    const identifier = await identifierOf(nas, name);
    const out = await nas.call<Array<Record<string, unknown>>>("smart.test.manual_test", [
      [{ identifier, mode: "BACKGROUND", type: kind }],
    ]);
    const first = out?.[0] ?? {};
    if (first.error) throw new Error(readableSmartError(String(first.error), name));
    json(res, 200, { ok: true, expectedAt: (first.expected_result_time as { $date?: number })?.$date ?? null });
    return true;
  }

  /* --- datasets --- */
  if (path === "/api/datasets") {
    if (method === "GET") {
      const rows = await nas.call<Array<Record<string, unknown>>>("pool.dataset.query", [
        [["pool", "!=", "boot-pool"]],
        { extra: { flat: true, properties: ["used", "available", "referenced", "quota", "compressratio", "mountpoint", "encryption"], retrieve_children: true } },
      ]);
      json(res, 200, rows.map((d) => ({
        id: d.id, name: d.name, pool: d.pool, type: d.type, encrypted: d.encrypted,
        used: num(d.used), available: num(d.available), referenced: num(d.referenced),
        quota: num(d.quota), compression: sval(d.compressratio), mountpoint: d.mountpoint,
      })));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = { name: str(b, "name"), type: String(b.type ?? "FILESYSTEM") };
      if (optStr(b, "comments")) payload.comments = optStr(b, "comments");
      if (optStr(b, "compression")) payload.compression = optStr(b, "compression");
      if (b.quota) payload.quota = Number(b.quota);
      if (payload.type === "VOLUME") {
        payload.volsize = Number(b.volsize ?? 0);
        payload.sparse = b.sparse === true;
      }
      json(res, 200, await nas.call("pool.dataset.create", [payload]));
      return true;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw new Error("Which dataset?");
      const b = await bodyOf(req);
      confirmed(b, id);
      json(res, 200, await nas.call("pool.dataset.delete", [id, { recursive: b.recursive === true, force: b.force === true }]));
      return true;
    }
    if (method === "PUT") {
      const id = url.searchParams.get("id");
      if (!id) throw new Error("Which dataset?");
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "comments") !== undefined) patch.comments = optStr(b, "comments") ?? "";
      if (optStr(b, "compression")) patch.compression = optStr(b, "compression");
      if (b.quota !== undefined) patch.quota = b.quota === null ? 0 : Number(b.quota);
      json(res, 200, await nas.call("pool.dataset.update", [id, patch]));
      return true;
    }
  }

  /* --- shares --- */

  /**
   * One share, with the permissions that make it work.
   *
   * Creating an SMB share and setting who can reach it are two unrelated calls
   * on the NAS, and doing only the first is the classic homelab dead end: the
   * folder appears on the network and then refuses everybody, because the
   * share is not what grants access — the filesystem ACL is. This does both,
   * in the order that leaves nothing half-done.
   */
  const shareMatch = /^\/api\/shares\/smb\/(\d+)$/.exec(path);
  if (shareMatch) {
    const id = Number(shareMatch[1]);
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "name")) patch.name = optStr(b, "name");
      if (optStr(b, "comment") !== undefined) patch.comment = optStr(b, "comment") ?? "";
      if (b.enabled !== undefined) patch.enabled = b.enabled === true;
      if (b.readOnly !== undefined) {
        patch.ro = b.readOnly === true;
        // The purpose preset overwrites individual flags, so read-only only
        // survives when the share carries no preset.
        if (b.readOnly === true) patch.purpose = "NO_PRESET";
      }
      json(res, 200, await nas.call("sharing.smb.update", [id, patch]));
      return true;
    }
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const [existing] = await nas.call<Array<{ name: string }>>("sharing.smb.query", [[["id", "=", id]]]);
      if (!existing) throw new Error("There is no such share.");
      confirmed(b, existing.name);
      await nas.call("sharing.smb.delete", [id]);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (path === "/api/shares/smb" && method === "POST") {
    const b = await bodyOf(req);
    const target = underMnt(str(b, "path"));
    // The purpose presets overwrite individual flags — asking for DEFAULT_SHARE
    // and read-only produced a writable share, silently. NO_PRESET is the only
    // way the ro flag survives the create.
    const readOnly = b.readOnly === true;
    const share = await nas.call<Record<string, unknown>>("sharing.smb.create", [{
      name: str(b, "name"),
      path: target,
      purpose: optStr(b, "purpose") ?? (readOnly ? "NO_PRESET" : "DEFAULT_SHARE"),
      comment: optStr(b, "comment") ?? "",
      ro: readOnly,
      browsable: true,
      enabled: true,
    }]);
    if (readOnly && share.ro !== true) {
      throw new Error("The NAS created the share but would not make it read-only. Check it under Shared folders.");
    }
    // A share nobody can reach is not a share. SMB is off by default on a
    // fresh install, and the failure it produces — the folder simply not
    // appearing on the network — gives no clue why.
    const [cifs] = await nas.call<Array<{ state: string }>>("service.query", [[["service", "=", "cifs"]]]);
    let started = false;
    if (cifs?.state !== "RUNNING" && b.startService !== false) {
      await nas.call("service.update", [{ service: "cifs" }, { enable: true }]).catch(() => nas.call("service.update", ["cifs", { enable: true }]));
      await nas.call("service.start", ["cifs"]);
      started = true;
    }

    /*
     * Now make it actually reachable.
     *
     * A share is only a name pointing at a folder; whether anyone can open it
     * is decided by the folder's ACL. Every dataset here starts owned by root
     * with everybody-else set to read-only, so a freshly shared folder is
     * visible on the network and refuses every write — which reads as "SMB is
     * broken" rather than "nobody has been given access".
     */
    const grants = Array.isArray(b.access) ? (b.access as Array<Record<string, unknown>>) : [];
    let permissions: number | null = null;
    if (grants.length) {
      const named = grants.map((g) => ({
        tag: g.kind === "group" ? "GROUP" : "USER",
        id: Number(g.id),
        perms: levelToPerms(String(g.level ?? "read")),
        default: false,
      }));
      const mask = named.reduce(
        (acc, e) => ({ READ: acc.READ || e.perms.READ, WRITE: acc.WRITE || e.perms.WRITE, EXECUTE: acc.EXECUTE || e.perms.EXECUTE }),
        { READ: true, WRITE: false, EXECUTE: true },
      );
      const dacl: AclEntry[] = [
        { tag: "USER_OBJ", id: -1, perms: levelToPerms("full"), default: false },
        { tag: "GROUP_OBJ", id: -1, perms: levelToPerms("read"), default: false },
        ...named,
        { tag: "MASK", id: -1, perms: mask, default: false },
        // Everybody else gets nothing: naming who may use a share and leaving
        // it open to all is worse than not asking at all.
        { tag: "OTHER", id: -1, perms: levelToPerms("none"), default: false },
      ];
      for (const e of [...dacl]) dacl.push({ ...e, default: true });
      permissions = await nas.startJob("filesystem.setacl", [{
        path: target, dacl, acltype: "POSIX1E", options: { recursive: b.recursive === true, traverse: false },
      }]);
    }

    json(res, 200, { share, startedService: started, permissionsJobId: permissions });
    return true;
  }

  /* --- snapshots --- */
  if (path === "/api/snapshots") {
    if (method === "GET") {
      const dataset = url.searchParams.get("dataset");
      const filters: unknown[] = [["pool", "!=", "boot-pool"]];
      // A dataset filter has to match the dataset itself and its children,
      // which is what an operator means by "snapshots of tank14/media".
      if (dataset) filters.push(["dataset", "^", dataset]);
      const snaps = await nas.call<Array<Record<string, unknown>>>("zfs.snapshot.query", [
        // holds only appear when asked for; without extra the field is absent
        // and every snapshot looks deletable, including ones ZFS will refuse.
        filters, { extra: { holds: true }, limit: 500, order_by: ["-name"] },
      ]);
      json(res, 200, snaps.map((s) => {
        const props = (s.properties ?? {}) as Record<string, { value?: string; parsed?: unknown }>;
        return {
          name: s.name,
          dataset: s.dataset ?? String(s.name).split("@")[0],
          snapshot: s.snapshot_name ?? String(s.name).split("@")[1],
          used: num(props.used),
          referenced: num(props.referenced),
          createdAt: epochMs(props.creation?.parsed),
          held: Object.keys((s.holds ?? {}) as Record<string, unknown>).length > 0,
        };
      }));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = { dataset: str(b, "dataset"), recursive: b.recursive === true };
      // Either an explicit name or a strftime schema, never both — the NAS
      // rejects a create carrying the two of them.
      if (optStr(b, "namingSchema")) payload.naming_schema = optStr(b, "namingSchema");
      else payload.name = optStr(b, "name") ?? defaultSnapshotName();
      json(res, 200, await nas.call("zfs.snapshot.create", [payload]));
      return true;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw new Error("Which snapshot?");
      const b = await bodyOf(req);
      confirmed(b, id);
      json(res, 200, await nas.call("zfs.snapshot.delete", [id, { recursive: b.recursive === true, defer: b.defer === true }]));
      return true;
    }
  }

  if (path === "/api/snapshots/rollback" && method === "POST") {
    const b = await bodyOf(req);
    const id = str(b, "id");
    confirmed(b, id);
    // force unmounts whatever is using the dataset; recursive_clones also
    // destroys clones that depend on newer snapshots. Both are opt-in because
    // either one silently throws away more than the operator asked for.
    json(res, 200, await nas.call("zfs.snapshot.rollback", [id, {
      force: b.force === true,
      recursive: b.newer === true,
      recursive_clones: b.clones === true,
    }]));
    return true;
  }

  if (path === "/api/snapshots/clone" && method === "POST") {
    const b = await bodyOf(req);
    // A clone is the safe way back into a snapshot: the new dataset is writable
    // and the original is untouched, so it can be compared before anything is
    // rolled back.
    json(res, 200, await nas.call("zfs.snapshot.clone", [{
      snapshot: str(b, "id"),
      dataset_dst: str(b, "target"),
    }]));
    return true;
  }

  const snapHold = /^\/api\/snapshots\/(hold|release)$/.exec(path);
  if (snapHold && method === "POST") {
    const b = await bodyOf(req);
    await nas.call(`zfs.snapshot.${snapHold[1]}`, [str(b, "id")]);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/snapshots/copy" && method === "POST") {
    const b = await bodyOf(req);
    const source = str(b, "source");
    const target = str(b, "target");
    if (target === source || target.startsWith(`${source}/`)) {
      throw new Error("The destination cannot be inside the dataset being copied.");
    }
    // Where the snapshots are kept.
    //
    // ZFS snapshots live inside the dataset they were taken from, so "store
    // them somewhere else" means replicating them to another dataset — usually
    // on a second pool, so that losing the first pool does not take the
    // snapshots with it. LOCAL transport is a send/recv on this same machine,
    // which needs no SSH credential.
    json(res, 200, {
      jobId: await nas.startJob("replication.run_onetime", [{
        direction: "PUSH",
        transport: "LOCAL",
        source_datasets: [source],
        target_dataset: target,
        recursive: b.recursive === true,
        retention_policy: "NONE",
        name_regex: ".*",
        readonly: "IGNORE",
      }]),
    });
    return true;
  }

  /* --- scheduled snapshots, with retention --- */
  if (path === "/api/snapshot-tasks") {
    if (method === "GET") {
      const tasks = await nas.call<Array<Record<string, unknown>>>("pool.snapshottask.query");
      json(res, 200, tasks.map((t) => ({
        id: t.id, dataset: t.dataset, recursive: t.recursive, enabled: t.enabled,
        namingSchema: t.naming_schema, lifetimeValue: t.lifetime_value, lifetimeUnit: t.lifetime_unit,
        schedule: t.schedule, allowEmpty: t.allow_empty, state: (t.state as { state?: string })?.state ?? null,
      })));
      return true;
    }
    if (method === "POST" || method === "PUT") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = {
        dataset: str(b, "dataset"),
        recursive: b.recursive === true,
        enabled: b.enabled !== false,
        naming_schema: optStr(b, "namingSchema") ?? "auto-%Y-%m-%d_%H-%M",
        lifetime_value: Math.max(1, Number(b.lifetimeValue ?? 2)),
        lifetime_unit: String(b.lifetimeUnit ?? "WEEK"),
        schedule: cronOf(b.schedule),
        allow_empty: b.allowEmpty !== false,
      };
      if (method === "POST") {
        json(res, 200, await nas.call("pool.snapshottask.create", [payload]));
      } else {
        const id = Number(url.searchParams.get("id"));
        if (!id) throw new Error("Which schedule?");
        json(res, 200, await nas.call("pool.snapshottask.update", [id, payload]));
      }
      return true;
    }
    if (method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (!id) throw new Error("Which schedule?");
      json(res, 200, await nas.call("pool.snapshottask.delete", [id]));
      return true;
    }
  }

  const taskRun = /^\/api\/snapshot-tasks\/(\d+)\/run$/.exec(path);
  if (taskRun && method === "POST") {
    await nas.call("pool.snapshottask.run", [Number(taskRun[1])]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- file browser --- */
  if (path === "/api/files") {
    // Confined to /mnt: everything a storage console has business showing is
    // under it, and letting the path float free would turn a read-only browser
    // into a way to page through /etc.
    const target = underMnt(url.searchParams.get("path") || "/mnt");
    const [entries, space] = await Promise.all([
      nas.call<Array<Record<string, unknown>>>("filesystem.listdir", [target]),
      // Which dataset this folder actually sits on, and how full it is. "/mnt"
      // itself is not a filesystem, so it has none.
      nas
        .call<Record<string, unknown>>("filesystem.statfs", [target])
        .then((s) => ({
          source: s.source as string,
          total: Number(s.total_bytes ?? 0),
          free: Number(s.avail_bytes ?? 0),
        }))
        .catch(() => null),
    ]);
    json(res, 200, {
      path: target,
      parent: target === "/mnt" ? null : target.split("/").slice(0, -1).join("/") || "/mnt",
      space,
      // Moving needs a shell, which needs the account password. Without it the
      // browser should not offer drag-and-drop at all rather than let every
      // drop fail.
      canMove: !!store.sudoPasswordFor(store.get(url.searchParams.get("c"))!),
      entries: entries
        // The bin is machinery, not a folder somebody put there. It gets its
        // own view rather than sitting in the listing being mistaken for data.
        .filter((e) => e.name !== ".recycle")
        .map((e) => ({
          name: e.name, path: e.path, type: e.type, size: e.size,
          mode: e.mode, uid: e.uid, gid: e.gid, isMountpoint: e.is_mountpoint,
          kind: e.type === "DIRECTORY" ? "dir" : files.kindOf(String(e.name)),
        }))
        .sort((a, b) => (a.type === b.type ? String(a.name).localeCompare(String(b.name)) : a.type === "DIRECTORY" ? -1 : 1)),
    });
    return true;
  }

  /**
   * File contents.
   *
   * Split in two because the NAS's download URLs cannot serve a byte range:
   * media is cached locally and served with ranges so seeking works, while
   * images and documents stream straight through.
   */
  if (path === "/api/files/content" || path === "/api/files/download") {
    const raw = url.searchParams.get("path");
    if (!raw) throw new Error("Which file?");
    const target = underMnt(raw);

    const conn = store.get(url.searchParams.get("c"));
    if (!conn) throw new Error("No TrueNAS server is configured.");

    const stat = await nas.call<Record<string, unknown>>("filesystem.stat", [target]);
    if (String(stat.type) !== "FILE") throw new Error("That is not a file.");
    // And where it really lands: a symlink inside /mnt pointing at /etc would
    // otherwise pass every check above.
    const real = typeof stat.realpath === "string" ? posix.normalize(stat.realpath) : target;
    if (real !== "/mnt" && !real.startsWith("/mnt/")) {
      throw new Error("That file resolves to somewhere outside /mnt.");
    }
    const size = Number(stat.size ?? 0);
    const kind = files.kindOf(target);
    const wantsDownload = path === "/api/files/download";

    if (!wantsDownload && (kind === "video" || kind === "audio")) {
      await files.streamMedia(nas, conn, target, size, req.headers.range, res);
      return true;
    }

    if (!wantsDownload && size > files.MAX_INLINE) {
      throw new Error(`This file is ${(size / 1024 ** 2).toFixed(0)} MB, too large to open in the browser. Download it instead.`);
    }

    await files.streamThrough(nas, conn, target, res, { download: wantsDownload });
    return true;
  }

  if (path === "/api/files/cache") {
    if (method === "GET") {
      json(res, 200, files.cacheStats());
      return true;
    }
    if (method === "DELETE") {
      files.clearCache();
      json(res, 200, { ok: true });
      return true;
    }
  }

  /**
   * Who can get at a folder.
   *
   * ZFS on this NAS uses POSIX draft ACLs, which are three fixed entries —
   * owner, owning group, everyone else — plus a named entry per extra user or
   * group, and a MASK that caps what any of the named ones actually get. The
   * mask is the part that surprises people: an entry granting write is
   * silently reduced to read if the mask says read, so it is always recomputed
   * here rather than left to whatever was there before.
   */
  if (path === "/api/files/permissions") {
    if (method === "GET") {
      const target = underMnt(url.searchParams.get("path") || "/mnt");
      const [acl, stat, users, groups] = await Promise.all([
        nas.call<AclResult>("filesystem.getacl", [target]),
        nas.call<Record<string, unknown>>("filesystem.stat", [target]),
        nas.call<Array<Record<string, unknown>>>("user.query", [[["builtin", "=", false]]]),
        nas.call<Array<Record<string, unknown>>>("group.query", [[["builtin", "=", false]]]),
      ]);
      json(res, 200, {
        path: target,
        acltype: acl.acltype,
        trivial: acl.trivial,
        owner: { uid: acl.uid, name: stat.user ?? null },
        group: { gid: acl.gid, name: stat.group ?? null },
        mode: Number(stat.mode ?? 0) & 0o777,
        isDirectory: stat.type === "DIRECTORY",
        entries: (acl.acl ?? []).map((e) => ({
          tag: e.tag, id: e.id, who: e.who ?? null, isDefault: e.default === true,
          perms: { read: !!e.perms?.READ, write: !!e.perms?.WRITE, execute: !!e.perms?.EXECUTE },
        })),
        users: users.map((u) => ({ uid: u.uid, username: u.username, full: u.full_name })),
        groups: groups.map((g) => ({ gid: g.gid, group: g.group })),
      });
      return true;
    }

    if (method === "PUT") {
      const b = await bodyOf(req);
      const target = underMnt(str(b, "path"));
      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");

      const acl = await nas.call<AclResult>("filesystem.getacl", [target]);
      if (acl.acltype !== "POSIX1E") {
        throw new Error(`This folder uses ${acl.acltype} permissions, which this console cannot edit yet.`);
      }

      const owner = (b.owner ?? {}) as { uid?: unknown; gid?: unknown };
      const recursive = b.recursive === true;
      const inherit = b.inherit !== false;

      // Owner first, with chown, and waited for.
      //
      // Not setperm: that refuses a payload carrying only uid and gid —
      // "must either explicitly specify permissions or contain the stripacl
      // option" — and both of those escapes are wrong here. A mode would
      // collapse the ACL down to three entries and stripacl would delete it
      // outright, which is the opposite of what this endpoint is for.
      //
      // Waited for, because setacl runs next against the same path. Fired
      // together they raced, and the folder silently kept its old owner.
      const uid = owner.uid === undefined || owner.uid === null ? undefined : Number(owner.uid);
      const gid = owner.gid === undefined || owner.gid === null ? undefined : Number(owner.gid);
      if (uid !== undefined || gid !== undefined) {
        await nas.runJob("filesystem.chown", [{
          path: target,
          ...(uid !== undefined ? { uid } : {}),
          ...(gid !== undefined ? { gid } : {}),
          options: { recursive, traverse: false },
        }]);
      }

      const grants = Array.isArray(b.access) ? (b.access as Array<Record<string, unknown>>) : [];
      const named = grants.map((g) => ({
        tag: g.kind === "group" ? "GROUP" : "USER",
        id: Number(g.id),
        perms: levelToPerms(String(g.level ?? "read")),
        default: false,
      }));

      const base = {
        ownerPerms: levelToPerms(String((b.ownerLevel as string) ?? "full")),
        groupPerms: levelToPerms(String((b.groupLevel as string) ?? "read")),
        otherPerms: levelToPerms(String((b.otherLevel as string) ?? "none")),
      };

      // The mask has to be at least as permissive as the most permissive named
      // entry, or that entry does nothing.
      const mask = named.reduce(
        (acc, e) => ({ READ: acc.READ || e.perms.READ, WRITE: acc.WRITE || e.perms.WRITE, EXECUTE: acc.EXECUTE || e.perms.EXECUTE }),
        { ...base.groupPerms },
      );

      const dacl: AclEntry[] = [
        { tag: "USER_OBJ", id: -1, perms: base.ownerPerms, default: false },
        { tag: "GROUP_OBJ", id: -1, perms: base.groupPerms, default: false },
        ...named,
        ...(named.length ? [{ tag: "MASK", id: -1, perms: mask, default: false } as AclEntry] : []),
        { tag: "OTHER", id: -1, perms: base.otherPerms, default: false },
      ];

      // Default entries are what a directory hands to things created inside it
      // later. Without them, granting somebody write and then having them find
      // every new file unreadable is the next question.
      if (inherit && b.isDirectory !== false) {
        for (const e of [...dacl]) dacl.push({ ...e, default: true });
      }

      json(res, 200, {
        jobId: await nas.startJob("filesystem.setacl", [{
          path: target,
          dacl,
          acltype: "POSIX1E",
          options: { recursive, traverse: false },
        }]),
      });
      return true;
    }
  }

  /**
   * The recycle bin.
   *
   * TrueNAS has no delete in its API at all, so this console could not offer
   * one — and the first thing that would have been built on a shell rm is the
   * one operation with no undo whatsoever. Deleting therefore moves the item
   * into a bin at the root of its own dataset instead.
   *
   * Per dataset rather than one global bin, because a move between datasets is
   * a copy of every byte: binning a 40 GB video has to be instant, and it has
   * to stay on the pool whose space it is already using.
   */
  if (path === "/api/files/recycle") {
    const conn = store.get(url.searchParams.get("c"));
    if (!conn) throw new Error("No TrueNAS server is configured.");

    if (method === "GET") {
      const bin = binFor(underMnt(url.searchParams.get("path") || "/mnt"));
      if (!bin) {
        json(res, 200, { bin: null, entries: [] });
        return true;
      }
      const entries = await nas
        .call<Array<Record<string, unknown>>>("filesystem.listdir", [bin])
        .catch(() => [] as Array<Record<string, unknown>>);
      json(res, 200, {
        bin,
        entries: await binContents(nas, bin, bin, entries),
      });
      return true;
    }

    // Delete: move each item into its dataset's bin, mirroring where it was.
    if (method === "POST") {
      const b = await bodyOf(req);
      const items = Array.isArray(b.paths) ? (b.paths as unknown[]).map(String) : [];
      if (!items.length) throw new Error("Nothing to delete.");

      const binned: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const raw of items) {
        const from = exec.safePath(underMnt(raw));
        const bin = binFor(from);
        if (!bin) {
          failed.push({ path: from, error: "A pool root cannot be deleted." });
          continue;
        }
        if (from.includes("/.recycle/") || from.endsWith("/.recycle")) {
          failed.push({ path: from, error: "That is already in the bin." });
          continue;
        }
        const to = `${bin}${from.slice(bin.length - "/.recycle".length)}`;
        try {
          exec.orThrow(await exec.run(conn, exec.recycleCommand(from, to)), `Could not delete ${from}`);
          binned.push(from);
        } catch (e) {
          failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
        }
      }
      json(res, 200, { binned, failed });
      return true;
    }

    // Restore: the same move backwards, to where the item came from.
    if (method === "PUT") {
      const b = await bodyOf(req);
      const from = exec.safePath(underMnt(str(b, "path")));
      const bin = binFor(from);
      if (!bin || !from.startsWith(`${bin}/`)) throw new Error("That is not in a recycle bin.");
      const root = bin.slice(0, -"/.recycle".length);
      const to = `${root}${from.slice(bin.length)}`.replace(/\.\d{8}-\d{6}$/, "");
      exec.orThrow(await exec.run(conn, exec.recycleCommand(from, to)), `Could not restore ${from}`);
      json(res, 200, { ok: true, path: to });
      return true;
    }

    // Empty: the one genuinely destructive operation, named to confirm.
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const bin = binFor(underMnt(str(b, "path")));
      if (!bin) throw new Error("There is no bin for that path.");
      confirmed(b, bin);
      exec.orThrow(await exec.run(conn, exec.emptyBinCommand(bin)), "Could not empty the bin");
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (path === "/api/files/mkdir" && method === "POST") {
    const b = await bodyOf(req);
    // Parent and name kept apart so a name can never widen the target: sending
    // "../../etc/x" as the name would otherwise climb out of the folder the
    // person is looking at, and underMnt alone would still allow it as long as
    // the result landed somewhere under /mnt.
    const parent = underMnt(str(b, "path"));
    const name = str(b, "name");
    if (name.includes("/") || name === "." || name === "..") {
      throw new Error("A folder name cannot contain a slash.");
    }
    const target = underMnt(`${parent}/${name}`);
    json(res, 200, await nas.call("filesystem.mkdir", [{ path: target }]));
    return true;
  }

  /**
   * Moving and renaming.
   *
   * Both are the same shell mv; they are separate routes because the mistakes
   * they can make are different. Rename takes a bare name and builds the
   * destination itself, so a name can never redirect the operation elsewhere.
   * Move takes a destination folder and appends each source's own basename.
   *
   * -n means an existing file at the destination is never overwritten: mv would
   * otherwise silently replace it, and there is no undo here.
   */
  if (path === "/api/files/rename" && method === "POST") {
    const b = await bodyOf(req);
    const from = exec.safePath(underMnt(str(b, "path")));
    const name = str(b, "name");
    if (name.includes("/") || name === "." || name === "..") throw new Error("A name cannot contain a slash.");
    if (from === "/mnt") throw new Error("/mnt itself cannot be renamed.");
    const to = exec.safePath(underMnt(`${from.split("/").slice(0, -1).join("/")}/${name}`));
    const conn = store.get(url.searchParams.get("c"));
    if (!conn) throw new Error("No TrueNAS server is configured.");
    const result = await exec.run(conn, exec.moveCommand(from, to));
    exec.orThrow(result, `Could not rename ${from}`);
    json(res, 200, { ok: true, path: to });
    return true;
  }

  if (path === "/api/files/move" && method === "POST") {
    const b = await bodyOf(req);
    const to = exec.safePath(underMnt(str(b, "to")));
    const sources = Array.isArray(b.from) ? (b.from as unknown[]).map(String) : [];
    if (!sources.length) throw new Error("Nothing to move.");
    if (sources.length > 100) throw new Error("Too many items in one move.");

    const conn = store.get(url.searchParams.get("c"));
    if (!conn) throw new Error("No TrueNAS server is configured.");

    const moved: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const raw of sources) {
      const from = exec.safePath(underMnt(raw));
      const base = from.split("/").pop() ?? "";
      // A folder cannot be moved into itself or into its own child: mv would
      // either refuse or, for the second case, quietly build a loop.
      if (to === from || to.startsWith(`${from}/`)) {
        failed.push({ path: from, error: "A folder cannot be moved inside itself." });
        continue;
      }
      if (to === from.split("/").slice(0, -1).join("/")) {
        failed.push({ path: from, error: "It is already there." });
        continue;
      }
      try {
        const result = await exec.run(conn, exec.moveCommand(from, `${to}/${base}`));
        exec.orThrow(result, `Could not move ${base}`);
        moved.push(from);
      } catch (e) {
        failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
      }
    }
    json(res, 200, { moved, failed });
    return true;
  }

  /* --- network --- */

  if (path === "/api/network") {
    const [ifaces, global, pending] = await Promise.all([
      nas.call<Array<Record<string, unknown>>>("interface.query"),
      nas.call<Record<string, unknown>>("network.configuration.config"),
      nas.call<boolean>("interface.has_pending_changes"),
    ]);
    json(res, 200, {
      pendingChanges: pending,
      global: {
        hostname: global.hostname, domain: global.domain,
        ipv4gateway: global.ipv4gateway, ipv6gateway: global.ipv6gateway,
        nameserver1: global.nameserver1, nameserver2: global.nameserver2, nameserver3: global.nameserver3,
      },
      interfaces: ifaces.map((i) => {
        const state = (i.state ?? {}) as Record<string, unknown>;
        return {
          id: i.id, name: i.name, type: i.type, description: i.description,
          dhcp: i.ipv4_dhcp, autoconf: i.ipv6_auto, mtu: i.mtu,
          aliases: ((i.aliases ?? []) as Array<Record<string, unknown>>).map((a) => ({ address: a.address, netmask: a.netmask, type: a.type })),
          linkState: state.link_state, activeMediaSubtype: state.active_media_subtype,
          mac: state.link_address,
        };
      }),
    });
    return true;
  }

  const ifaceMatch = /^\/api\/network\/interfaces\/([^/]+)$/.exec(path);
  if (ifaceMatch && method === "PUT") {
    const b = await bodyOf(req);
    const patch: Record<string, unknown> = {};
    if (typeof b.dhcp === "boolean") patch.ipv4_dhcp = b.dhcp;
    if (b.mtu !== undefined) patch.mtu = b.mtu === null ? null : Number(b.mtu);
    if (optStr(b, "description") !== undefined) patch.description = optStr(b, "description") ?? "";
    if (Array.isArray(b.aliases)) {
      patch.aliases = (b.aliases as Array<Record<string, unknown>>).map((a) => ({
        address: String(a.address),
        netmask: Number(a.netmask),
        type: String(a.type ?? "INET"),
      }));
    }
    json(res, 200, await nas.call("interface.update", [ifaceMatch[1], patch]));
    return true;
  }

  if (path === "/api/network/global" && method === "PUT") {
    const b = await bodyOf(req);
    const patch: Record<string, unknown> = {};
    for (const k of ["hostname", "domain", "ipv4gateway", "nameserver1", "nameserver2", "nameserver3"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] ?? "");
    }
    json(res, 200, await nas.call("network.configuration.update", [patch]));
    return true;
  }

  if (path === "/api/network/commit" && method === "POST") {
    const b = await bodyOf(req);
    // checkin_timeout is the safety net: if nobody confirms within it, the NAS
    // rolls the change back on its own. Changing an address over the network
    // being changed is exactly how a box becomes unreachable.
    await nas.call("interface.commit", [{ rollback: true, checkin_timeout: Number(b.timeout ?? 60) }]);
    json(res, 200, { ok: true, checkinTimeout: Number(b.timeout ?? 60) });
    return true;
  }

  if (path === "/api/network/checkin" && method === "POST") {
    await nas.call("interface.checkin");
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/network/rollback" && method === "POST") {
    await nas.call("interface.rollback");
    json(res, 200, { ok: true });
    return true;
  }

  /* --- mail --- */

  if (path === "/api/mail") {
    if (method === "GET") {
      const cfg = await nas.call<Record<string, unknown>>("mail.config");
      // pass is returned by the NAS; it has no business reaching the browser.
      const { pass, oauth, ...rest } = cfg;
      json(res, 200, { ...rest, hasPassword: !!pass });
      return true;
    }
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {
        fromemail: str(b, "fromemail"),
        fromname: optStr(b, "fromname") ?? "",
        outgoingserver: str(b, "outgoingserver"),
        port: Number(b.port ?? 587),
        security: String(b.security ?? "TLS"),
        smtp: b.smtp === true,
      };
      if (b.smtp === true) patch.user = optStr(b, "user") ?? "";
      // An empty password means "keep the stored one".
      if (optStr(b, "pass")) patch.pass = optStr(b, "pass");
      json(res, 200, { ok: true, result: await nas.call("mail.update", [patch]) });
      return true;
    }
  }

  if (path === "/api/mail/test" && method === "POST") {
    const b = await bodyOf(req);
    const to = Array.isArray(b.to) ? (b.to as string[]) : [];
    if (!to.length) throw new Error("Who should the test go to?");
    await nas.call("mail.send", [{
      subject: "Test message from the storage console",
      text: "If you are reading this, the NAS can send mail and notifications will reach you.",
      to,
    }], 30_000);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- updates and licensing --- */

  if (path === "/api/update") {
    const [trains, product, info] = await Promise.all([
      nas.call<{ trains: Record<string, { description: string }>; current: string; selected: string }>("update.get_trains"),
      nas.call<string>("system.product_type"),
      nas.call<Record<string, unknown>>("system.info"),
    ]);
    let available: Record<string, unknown> | null = null;
    try {
      available = await nas.call<Record<string, unknown>>("update.check_available", [], 45_000);
    } catch (e) {
      available = { status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    }
    json(res, 200, {
      currentVersion: info.version,
      productType: product,
      trains: Object.entries(trains.trains).map(([name, t]) => ({ name, description: t.description })),
      currentTrain: trains.current,
      selectedTrain: trains.selected,
      available,
      bootEnvironments: await nas.call<Array<Record<string, unknown>>>("boot.environment.query")
        .then((r) => r.map((b) => ({ id: b.id, active: b.active, created: b.created })))
        .catch(() => []),
    });
    return true;
  }

  if (path === "/api/update/train" && method === "PUT") {
    const b = await bodyOf(req);
    json(res, 200, { ok: true, result: await nas.call("update.set_train", [str(b, "train")]) });
    return true;
  }

  if (path === "/api/update/download" && method === "POST") {
    json(res, 200, { jobId: await nas.startJob("update.download") });
    return true;
  }

  if (path === "/api/update/apply" && method === "POST") {
    const b = await bodyOf(req);
    // Naming the version is the confirmation. Applying an update reboots the
    // NAS and every service on it; a bare button press is too little ceremony.
    confirmed(b, String(b.version ?? ""));
    json(res, 200, { jobId: await nas.startJob("update.update", [{ reboot: b.reboot === true }]) });
    return true;
  }

  if (path === "/api/update/license" && method === "POST") {
    const b = await bodyOf(req);
    await nas.call("system.license_update", [str(b, "license")]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- the read-only rest --- */
  switch (path) {
    case "/api/overview":
      json(res, 200, await overview(nas));
      return true;

    case "/api/apps": {
      const apps = await nas.call<AppRow[]>("app.query");
      json(res, 200, apps.map((a) => ({
        name: a.name, state: a.state, version: a.human_version || a.version,
        updatable: a.upgrade_available, title: a.metadata?.title ?? a.name, train: a.metadata?.train,
        // Custom apps carry no icon at all, so the browser has to be ready to
        // draw its own tile rather than a broken image.
        icon: a.metadata?.icon ?? null,
        containers: a.active_workloads?.containers ?? 0,
        ports: (a.active_workloads?.used_ports ?? []).flatMap((p) => (p.host_ports ?? []).map((h) => h.host_port)),
        portals: a.portals ?? {},
      })));
      return true;
    }

    case "/api/shares": {
      const [smb, nfs] = await Promise.all([
        nas.call<Array<Record<string, unknown>>>("sharing.smb.query"),
        nas.call<Array<Record<string, unknown>>>("sharing.nfs.query"),
      ]);
      json(res, 200, {
        smb: smb.map((s) => ({ id: s.id, name: s.name, path: s.path, enabled: s.enabled, comment: s.comment, purpose: s.purpose, readOnly: s.ro === true })),
        nfs: nfs.map((s) => ({ path: s.path, enabled: s.enabled, comment: s.comment, networks: s.networks, hosts: s.hosts })),
      });
      return true;
    }

    case "/api/alerts": {
      const alerts = await nas.call<AlertRow[]>("alert.list");
      json(res, 200, alerts.filter((a) => !a.dismissed)
        .map((a) => ({ uuid: a.uuid, level: a.level, text: a.formatted, at: a.datetime?.$date, klass: a.klass })));
      return true;
    }

    case "/api/services": {
      const svc = await nas.call<Array<Record<string, unknown>>>("service.query");
      json(res, 200, svc.map((s) => ({ service: s.service, state: s.state, enable: s.enable })));
      return true;
    }

    case "/api/health":
      json(res, 200, { connected: nas.connected, error: nas.lastError });
      return true;
  }

  const alertDismiss = /^\/api\/alerts\/([^/]+)\/dismiss$/.exec(path);
  if (alertDismiss && method === "POST") {
    await nas.call("alert.dismiss", [alertDismiss[1]]);
    json(res, 200, { ok: true });
    return true;
  }

  const svcAction = /^\/api\/services\/([^/]+)\/(start|stop|restart)$/.exec(path);
  if (svcAction && method === "POST") {
    await nas.call(`service.${svcAction[2]}`, [svcAction[1]]);
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: "No such endpoint." });
  return true;
}

/**
 * Strip the secrets TrueNAS hands back.
 *
 * user.create and user.update echo the whole record, which includes the unix
 * and SMB password hashes and — for a create — the plaintext password that was
 * just submitted. None of it is needed to render a user list, and sending it to
 * the browser would put password hashes in devtools, logs and any proxy in
 * between.
 */
function safeUser(u: unknown): unknown {
  if (!u || typeof u !== "object") return u;
  const { unixhash, smbhash, password, password_history, sid, api_keys, ...rest } = u as Record<string, unknown>;
  return rest;
}

/**
 * "manual-2026-08-24_14-05" — sortable, and obvious months later.
 *
 * Local time, not UTC: the operator taking the snapshot is reading the clock on
 * the wall, and a name an hour off from the event they are snapshotting around
 * is worse than useless.
 */
function defaultSnapshotName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `manual-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** The five cron fields the NAS wants, defaulted so a partial schedule is still valid. */
function cronOf(v: unknown): Record<string, string> {
  const s = (v ?? {}) as Record<string, unknown>;
  const field = (k: string, fallback: string): string => {
    const raw = s[k];
    const out = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
    // Cron fields reach the NAS as strings; anything outside this alphabet is a
    // mistake worth catching here rather than as a schema error later.
    if (!/^[0-9*,\-/]+$/.test(out)) throw new Error(`"${out}" is not a valid schedule field.`);
    return out;
  };
  return {
    minute: field("minute", "00"),
    hour: field("hour", "*"),
    dom: field("dom", "*"),
    month: field("month", "*"),
    dow: field("dow", "*"),
  };
}

/**
 * The recycle bin belonging to a path, or null if it has none.
 *
 * One per pool, at its root. /mnt itself and a bare pool root have no bin —
 * there is nowhere above them to put one, and "delete the pool" is not a file
 * operation.
 */
function binFor(path: string): string | null {
  const parts = path.split("/").filter(Boolean); // ["mnt", "tank", ...]
  if (parts[0] !== "mnt" || parts.length < 3) return null;
  return `/mnt/${parts[1]}/.recycle`;
}

/**
 * Everything in a bin, flattened.
 *
 * The bin mirrors the original folder structure, so a plain listing of its top
 * level would show a folder called "photos" rather than the file that was
 * deleted out of it. Walking it gives back the actual items, each still
 * knowing where it came from.
 */
async function binContents(
  nas: TrueNas,
  bin: string,
  dir: string,
  entries: Array<Record<string, unknown>>,
  depth = 0,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const full = String(e.path);
    const original = `${bin.slice(0, -"/.recycle".length)}${full.slice(bin.length)}`.replace(/\.\d{8}-\d{6}$/, "");
    // A deleted folder is one item, not a tree to walk into: restoring it puts
    // the whole thing back. Only mirror directories are descended, and only so
    // far — a deep tree of them is still just structure.
    const mirrorOnly = e.type === "DIRECTORY" && depth < 6 && (await isMirror(nas, full));
    if (mirrorOnly) {
      const kids = await nas.call<Array<Record<string, unknown>>>("filesystem.listdir", [full]).catch(() => []);
      out.push(...(await binContents(nas, bin, full, kids, depth + 1)));
      continue;
    }
    out.push({
      name: e.name,
      path: full,
      type: e.type,
      size: e.size,
      original,
      from: original.split("/").slice(0, -1).join("/"),
    });
  }
  return out;
}

/**
 * A directory the bin created to mirror the original path, rather than one
 * somebody deleted. The difference: a mirror only ever contains the things
 * that were binned out of it, and a folder that was itself deleted is restored
 * whole. There is no flag for this, so the test is whether the same folder
 * still exists outside the bin — if it does, this copy is structure.
 */
async function isMirror(nas: TrueNas, dir: string): Promise<boolean> {
  const bin = "/.recycle";
  const idx = dir.indexOf(bin);
  if (idx === -1) return false;
  const outside = dir.slice(0, idx) + dir.slice(idx + bin.length);
  return await nas.call("filesystem.stat", [outside]).then(() => true).catch(() => false);
}

/**
 * What smartctl said, in a sentence.
 *
 * The NAS hands back the tool's whole banner — version, copyright, build
 * string — with the actual reason on the last line. Showing that in a dialog
 * buries the one line that matters under four that never do.
 */
function readableSmartError(raw: string, disk: string): string {
  const last = raw.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? raw;
  if (/unsupported scsi opcode|not supported|unsupported/i.test(last)) {
    return `${disk} does not support self-tests. Virtual disks and some USB enclosures pass the drive through without SMART, so there is nothing to run — the health above is based on what ZFS has seen instead.`;
  }
  if (/device is busy|already running/i.test(last)) return `A test is already running on ${disk}.`;
  return last;
}

/** smart.test.manual_test addresses disks by identifier ("{serial}9KG1859L"). */
async function identifierOf(nas: TrueNas, name: string): Promise<string> {
  const rows = await nas.call<Array<{ identifier: string }>>("disk.query", [[["name", "=", name]]]);
  if (!rows.length || !rows[0].identifier) throw new Error(`There is no disk called "${name}".`);
  return rows[0].identifier;
}

interface VdevLeaf {
  type?: string; status?: string; disk?: string | null; device?: string | null; path?: string;
  children?: VdevLeaf[];
  stats?: {
    read_errors?: number; write_errors?: number; checksum_errors?: number; self_healed?: number;
    size?: number; allocated?: number; fragmentation?: number;
    ops?: number[]; bytes?: number[];
  };
}

interface VdevMember {
  pool: string; role: string; vdev: string; status?: string; stats?: VdevLeaf["stats"];
}

/**
 * Find the vdev leaf backed by one device, wherever it sits.
 *
 * Every pool, every role (data, cache, log, spare) and every level of nesting,
 * because a disk in a mirror inside a raidz is two levels down and its error
 * counters are the only place they exist. The leaf names the partition
 * ("sdc1"), so the trailing number is stripped before comparing.
 */
function vdevMemberOf(pools: PoolRow[], name: string): VdevMember | null {
  let found: VdevMember | null = null;
  for (const p of pools) {
    const topo = (p.topology ?? {}) as Record<string, VdevLeaf[]>;
    for (const [role, vdevs] of Object.entries(topo)) {
      for (const vdev of vdevs ?? []) {
        const walk = (node: VdevLeaf): void => {
          if (node.disk === name || node.device === name || String(node.device ?? "").replace(/\d+$/, "") === name) {
            found = { pool: p.name, role, vdev: vdev.type ?? "stripe", status: node.status, stats: node.stats };
          }
          for (const c of node.children ?? []) walk(c);
        };
        walk(vdev);
      }
    }
  }
  return found;
}

/**
 * Everything the NAS knows about one drive, gathered for the health dialog.
 *
 * The interesting parts come from four places that do not agree with each
 * other: disk.query has the identity, disk.details has the partitions and the
 * pool it is actually imported into, pool.query's topology has the ZFS error
 * counters, and smart.* has the tests. SMART is the one that most often is not
 * there at all — on a VM every disk answers "Only ATA/SCSI/NVMe devices support
 * S.M.A.R.T. attributes" — so it is fetched last and its absence is reported as
 * a fact about the device rather than as a failure of the page.
 */
async function diskHealthOf(nas: TrueNas, name: string) {
  const [rows, details, temps, pools] = await Promise.all([
    nas.call<Array<Record<string, unknown>>>("disk.query", [[["name", "=", name]]]),
    nas.call<{ used?: Array<Record<string, unknown>>; unused?: Array<Record<string, unknown>> }>("disk.details"),
    nas.call<Record<string, number | null>>("disk.temperatures").catch(() => ({}) as Record<string, number | null>),
    nas.call<PoolRow[]>("pool.query"),
  ]);
  const disk = rows[0];
  if (!disk) throw new Error(`There is no disk called "${name}".`);
  const detail =
    (details.used ?? []).find((d) => d.name === name) ?? (details.unused ?? []).find((d) => d.name === name) ?? {};
  const inUse = (details.used ?? []).some((d) => d.name === name);

  const member = vdevMemberOf(pools, name);

  const smart = await nas
    .call<Array<Record<string, unknown>>>("disk.smart_attributes", [name])
    .then((attrs) => ({ supported: true, reason: null as string | null, attributes: attrs }))
    .catch((e: unknown) => ({
      supported: false,
      reason: e instanceof Error ? e.message.replace(/^\[EFAULT\]\s*/, "") : "SMART data is unavailable.",
      attributes: [] as Array<Record<string, unknown>>,
    }));

  const results = await nas
    .call<Array<Record<string, unknown>>>("smart.test.results")
    .then((all) => all.find((r) => r.disk === name || r.name === name) ?? null)
    .catch(() => null);
  const tests = ((results?.tests as Array<Record<string, unknown>>) ?? []).slice(0, 12);

  const stats = member?.stats ?? {};
  const errors = (stats.read_errors ?? 0) + (stats.write_errors ?? 0) + (stats.checksum_errors ?? 0);
  const tempC = temperature(temps[name]);
  const failedTests = tests.filter((t) => !/without error|completed/i.test(String(t.status_verbose ?? t.status ?? ""))).length;

  // One verdict, and the reasons behind it, so the dialog leads with an answer
  // instead of a wall of counters the reader has to grade themselves.
  const reasons: string[] = [];
  let level: "ok" | "warn" | "bad" = "ok";
  const worse = (l: "warn" | "bad") => { if (l === "bad" || level === "ok") level = l; };
  if (member && member.status && member.status !== "ONLINE") {
    worse("bad");
    reasons.push(`ZFS reports this device as ${member.status} in ${member.pool}.`);
  }
  if (errors > 0) {
    worse("bad");
    reasons.push(`${errors} ZFS error${errors === 1 ? "" : "s"}: ${stats.read_errors ?? 0} read, ${stats.write_errors ?? 0} write, ${stats.checksum_errors ?? 0} checksum.`);
  }
  if (failedTests > 0) {
    worse("bad");
    reasons.push(`${failedTests} SMART self-test${failedTests === 1 ? "" : "s"} did not finish cleanly.`);
  }
  if (tempC !== null && tempC >= 50) {
    worse("bad");
    reasons.push(`Running at ${tempC}°C.`);
  } else if (tempC !== null && tempC >= 42) {
    worse("warn");
    reasons.push(`Running warm at ${tempC}°C.`);
  }
  if ((stats.self_healed ?? 0) > 0) {
    worse("warn");
    reasons.push(`ZFS repaired ${bytesish(stats.self_healed)} of bad data on this device.`);
  }
  if (level === "ok") {
    reasons.unshift(member ? "ZFS reports no read, write or checksum errors on this device." : "Nothing is reporting a problem with this device.");
  }
  if (!smart.supported) reasons.push(smart.reason ?? "This device does not report SMART data.");

  return {
    name,
    identity: {
      identifier: disk.identifier, model: disk.model, serial: disk.serial, size: disk.size,
      type: disk.type, rpm: disk.rotationrate, bus: disk.bus, subsystem: disk.subsystem,
      description: disk.description || detail.descr || null, lunid: disk.lunid,
      sectorSize: detail.sectorsize ?? null, transferMode: disk.transfermode,
      standby: disk.hddstandby, powerManagement: disk.advpowermgmt, smartEnabled: disk.togglesmart === true,
      duplicateSerial: (detail.duplicate_serial as string[] | undefined) ?? [],
    },
    tempC,
    inUse,
    pool: (detail.imported_zpool as string | null) ?? member?.pool ?? null,
    exportedPool: (detail.exported_zpool as string | null) ?? null,
    partitions: ((detail.partitions as Array<Record<string, unknown>>) ?? []).map((p) => ({
      name: p.name ?? p.partition_name, size: p.size, type: p.partition_type ?? p.type,
    })),
    zfs: member
      ? {
          pool: member.pool, role: member.role, vdev: member.vdev, status: member.status ?? null,
          readErrors: stats.read_errors ?? 0, writeErrors: stats.write_errors ?? 0,
          checksumErrors: stats.checksum_errors ?? 0, selfHealed: stats.self_healed ?? 0,
          size: stats.size ?? null, allocated: stats.allocated ?? null, fragmentation: stats.fragmentation ?? null,
          // ops/bytes are [null, read, write, ...] counters since import.
          readBytes: stats.bytes?.[1] ?? null, writeBytes: stats.bytes?.[2] ?? null,
        }
      : null,
    smart: { supported: smart.supported, reason: smart.reason, attributes: smart.attributes },
    tests: tests.map((t) => ({
      num: t.num, type: t.type, status: t.status_verbose ?? t.status,
      remaining: t.remaining, lifetime: t.lifetime, description: t.description,
    })),
    runningTest: results?.current_test ?? null,
    health: { level, reasons },
  };
}

/**
 * A drive that cannot answer reports 0, not null.
 *
 * Every virtual disk on this NAS comes back as exactly 0°C, which the UI drew
 * as a healthy green zero. Nothing spinning is at freezing point, so treat it
 * as "no reading" rather than as a very cold drive.
 */
const temperature = (v: number | null | undefined): number | null => (v === null || v === undefined || v === 0 ? null : v);

const bytesish = (n: number | undefined): string => {
  if (!n) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/**
 * The passwords an app was installed with, dug out of its own settings.
 *
 * Apps generate these at install time and then never show them again: the
 * Nextcloud admin password, MinIO's root key, Authentik's bootstrap token. They
 * are sitting in the app's config the whole time, and the only way most people
 * ever find one is by reading a compose file over SSH.
 *
 * Matching is on the key, not the value, and deliberately narrow. Flags like
 * GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN contain "token" and hold "true"; listing
 * those as credentials trains people to ignore the panel.
 */
function credentialsIn(values: unknown): Array<{ path: string; key: string; value: string; secret: boolean }> {
  const out: Array<{ path: string; key: string; value: string; secret: boolean }> = [];
  const SECRET = /(pass|passwd|password|secret|token|api_?key|private_?key|credential)/i;
  const LOGIN = /(^|_)(user|username|admin_user|login|email)$/i;
  const NOT_A_SECRET = /(enable|enabled|required|_file$|_path$|policy|method|type|mode)/i;

  const walk = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
      return;
    }
    const key = path[path.length - 1] ?? "";
    const value = String(node ?? "");
    if (!value || value === "true" || value === "false") return;
    if (NOT_A_SECRET.test(key)) return;
    const secret = SECRET.test(key);
    // A three-character "password" is a placeholder, not a credential.
    if (secret && value.length < 6) return;
    if (secret || LOGIN.test(key)) out.push({ path: path.join("."), key, value, secret });
  };

  walk(values, []);
  // Compose files repeat the same secret in every service that needs it —
  // authentik lists its Postgres password twice, once per container. One row
  // per distinct credential.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.key} ${c.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** pool.scrub and pool.export take the numeric id, not the name shown in the UI. */
async function poolIdOf(nas: TrueNas, name: string): Promise<number> {
  const rows = await nas.call<Array<{ id: number; name: string }>>("pool.query", [[["name", "=", name]]]);
  if (!rows.length) throw new Error(`There is no pool called "${name}".`);
  return rows[0].id;
}

/** Accept what people paste — an address, https://…, or a full ws:// URL. */
function normaliseUrl(input: string): string {
  let u = input.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = `wss://${u}`;
  u = u.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  if (!/\/api\/current$/.test(u)) u = `${u.replace(/\/+$/, "")}/api/current`;
  return u;
}

/* ------------------------------------------------------------------- static */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
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
      const unreachable = /not reachable|ECONNREFUSED|ETIMEDOUT|socket hang up|certificate|WebSocket|no TrueNAS server/i
        .test(message);
      json(res, unreachable ? 502 : 400, { error: message });
    } else {
      res.end();
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  if (handleUpgrade(req, socket, head)) return;
  socket.destroy();
});

server.listen(PORT, () => console.log(`[truenas-ui] listening on :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    watcher.stop();
    store.closeAll();
    process.exit(0);
  });
}
