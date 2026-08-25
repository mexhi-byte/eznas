import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
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
import { CHANNEL, VERSION } from "./version.js";
import { appTitle, isCustomApp } from "./apps.js";

export { VERSION };
import { bodyOf, confirmed, json, optStr, str, underMnt } from "./http.js";
import { levelToPerms, type AclEntry } from "./acl.js";
import { handleFileRoutes } from "./routes/files.js";
import { diskVerdict, failedTestCount, temperatureOf, testsForDisk } from "./disk-verdict.js";
import { catalogIconIndex, hostOf, iconFor, portLinks } from "./app-links.js";
import { handleShareRoutes } from "./routes/shares.js";

const PORT = Number(process.env.PORT ?? 80);

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

/** An in-flight 2FA enrolment, held only until it is confirmed or expires. */
let pendingMfa: { secret: string; at: number; accountId: string } | null = null;

/** The session a request carries, if any. */
const readSession = (req: IncomingMessage) => readSessionCookie(readCookie(req.headers.cookie, COOKIE));

const clientIp = (req: IncomingMessage): string =>
  (req.headers["cf-connecting-ip"] as string) ?? req.socket.remoteAddress ?? "unknown";

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
        title: appTitle(name, row.metadata?.title),
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
    /*
     * Four bulk calls, and a verdict for every drive.
     *
     * The map used to get names and a temperature, so its tiles could only
     * show a number or a status word — and nothing at all for a drive that had
     * neither. Every input the verdict needs is already a single call covering
     * every device, so asking for all of them costs the same whether the NAS
     * has four drives or forty.
     */
    const [details, temps, pools, testResults] = await Promise.all([
      nas.call<{ used: DiskRow[]; unused: DiskRow[] }>("disk.details"),
      readTemperatures(nas),
      nas.call<PoolRow[]>("pool.query").catch(() => [] as PoolRow[]),
      nas.call<Array<Record<string, unknown>>>("smart.test.results").catch(() => [] as Array<Record<string, unknown>>),
    ]);
    // imported_zpool is where the pool name actually lives. disk.query's own
    // `pool` field reads null for every disk on 25.04, which made every disk in
    // a healthy pool render as "unassigned".
    const shape = (d: DiskRow, inUse: boolean) => {
      const member = vdevMemberOf(pools, d.name);
      const stats = member?.stats ?? {};
      const tempC = temperatureOf(temps.values[d.name]);
      const verdict = diskVerdict({
        zfs: member
          ? {
              pool: member.pool,
              status: member.status ?? null,
              readErrors: stats.read_errors ?? 0,
              writeErrors: stats.write_errors ?? 0,
              checksumErrors: stats.checksum_errors ?? 0,
              selfHealed: stats.self_healed ?? 0,
            }
          : null,
        tempC,
        failedTests: failedTestCount(testsForDisk(testResults, d.name)),
      });
      return {
        name: d.name, model: d.model, serial: d.serial, size: d.size, type: d.type,
        rpm: d.rotationrate, pool: d.imported_zpool ?? d.pool ?? null, inUse, tempC,
        // Why there is no reading, so the tile can say it instead of going
        // blank. A blank space reads as a bug in the console; "this device
        // does not report one" reads as a fact about the drive.
        tempNote: tempC !== null ? null : temps.note,
        status: member?.status ?? null,
        health: verdict,
      };
    };
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
  if (path.startsWith("/api/shares")) {
    if (await handleShareRoutes({ path, method, url, req, res, nas })) return true;
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
  if (path.startsWith("/api/files")) {
    if (await handleFileRoutes({ path, method, url, req, res, nas })) return true;
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
      /*
       * An app deployed from a compose file has no icon and no portal.
       *
       * TrueNAS fills both in from the catalog entry an app was installed
       * from, and the "Custom App" button in its own UI creates apps that have
       * no such entry. On a server where most apps were set up that way, this
       * list arrived as a wall of letters with nothing to click, which reads
       * as the console failing rather than as data the NAS never sent. Both
       * are recoverable: the ports it listens on, and the catalog entry that
       * shares its name.
       */
      const [apps, icons] = await Promise.all([
        nas.call<AppRow[]>("app.query"),
        catalogIcons(nas),
      ]);
      const host = hostOf(store.get(url.searchParams.get("c"))?.url ?? "");
      json(res, 200, apps.map((a) => {
        const links = portLinks(host, a.active_workloads?.used_ports);
        return {
          name: a.name, state: a.state, version: a.human_version || a.version,
          updatable: a.upgrade_available, title: appTitle(a.name, a.metadata?.title), train: a.metadata?.train,
          // Kept so the tile can say "custom app" quietly under the real name,
          // rather than losing that it is one.
          custom: isCustomApp(a.metadata?.title),
          icon: iconFor(a.name, a.metadata?.icon, icons),
          containers: a.active_workloads?.containers ?? 0,
          ports: links.map((l) => l.port),
          // Every published port, addressed. Not one "open this app" link:
          // several of these are databases, and a link labelled Open that
          // leads to Redis is a worse answer than a bare port number.
          links,
          portals: a.portals ?? {},
        };
      }));
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
    readTemperatures(nas),
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
  const tempC = temperatureOf(temps.values[name]);

  // The same verdict the drive map shows, from the same function, so a drive
  // cannot be amber on the map and green in its own dialog.
  const { level, reasons } = diskVerdict({
    zfs: member
      ? {
          pool: member.pool,
          status: member.status ?? null,
          readErrors: stats.read_errors ?? 0,
          writeErrors: stats.write_errors ?? 0,
          checksumErrors: stats.checksum_errors ?? 0,
          selfHealed: stats.self_healed ?? 0,
        }
      : null,
    tempC,
    failedTests: failedTestCount(tests),
  });
  // SMART support is a fact about the device rather than a judgement on it, so
  // it is appended to the reasons without moving the verdict.
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
    tempNote: tempC !== null ? null : temps.note,
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
 * name -> icon url for every app in the catalog, refreshed at most hourly.
 *
 * app.available returns on the order of a thousand rows and the apps list
 * polls every ten seconds, so looking this up per request would spend most of
 * the NAS's time answering a question whose answer changes when a catalog is
 * updated — which is to say, almost never.
 *
 * A failure here is not an error: it costs a logo, and an app with no logo
 * already has a perfectly good coloured letter. So it is cached as "no index"
 * for a minute rather than retried on every poll.
 */
let iconIndex: { at: number; index: Map<string, string> | null } | null = null;
const ICON_TTL_MS = 60 * 60 * 1000;
const ICON_RETRY_MS = 60 * 1000;

async function catalogIcons(nas: TrueNas): Promise<Map<string, string> | null> {
  const ttl = iconIndex?.index ? ICON_TTL_MS : ICON_RETRY_MS;
  if (iconIndex && Date.now() - iconIndex.at < ttl) return iconIndex.index;
  try {
    const rows = await nas.call<Array<Record<string, unknown>>>("app.available", [
      [], { select: ["name", "icon_url"] },
    ]);
    iconIndex = { at: Date.now(), index: catalogIconIndex(rows) };
  } catch (e) {
    console.error(`[apps] could not read the catalog for icons: ${e instanceof Error ? e.message : String(e)}`);
    iconIndex = { at: Date.now(), index: null };
  }
  return iconIndex.index;
}

/**
 * Every drive's temperature, and why there is none when there is none.
 *
 * This call used to be wrapped in a bare `.catch(() => ({}))`, which collapsed
 * two different situations into one blank space: a drive with no sensor, and a
 * call that failed outright. Only one of those is worth investigating, and the
 * console gave no way to tell which had happened.
 */
async function readTemperatures(nas: TrueNas): Promise<{
  values: Record<string, number | null>;
  note: string;
}> {
  try {
    const values = await nas.call<Record<string, number | null>>("disk.temperatures");
    return {
      values,
      note: "This device does not report a temperature. Virtual disks, and drives behind a RAID controller that is not in passthrough mode, usually cannot.",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[disks] could not read temperatures: ${message}`);
    return { values: {}, note: `The NAS could not report temperatures: ${message}` };
  }
}


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
