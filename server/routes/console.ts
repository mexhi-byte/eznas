import { randomUUID } from "node:crypto";
import * as store from "../store.js";
import * as settings from "../settings.js";
import * as watcher from "../monitors.js";
import * as selfUpdate from "../self-update.js";
import * as webhooks from "../webhooks.js";
import * as accounts from "../accounts.js";
import { generateSecret, provisioningUri, recoveryCodes, verify as verifyTotp } from "../totp.js";
import { VERSION } from "../version.js";
import { bodyOf, json, optStr, str } from "../http.js";
import { probeCertificate } from "../tls-probe.js";
import { candidateHosts } from "../discover.js";
import type { ConsoleRouteContext } from "./context.js";

/**
 * The console's own routes: its accounts, its settings, its second factor,
 * its updates, its notifications, and the list of servers it knows. None of
 * these need a NAS, which is why they run before one is chosen — a console
 * with no server configured still has to let you add one.
 */

/** An in-flight 2FA enrolment, held only until it is confirmed or expires. */
let pendingMfa: { secret: string; at: number; accountId: string } | null = null;

export async function handleConsoleRoutes(ctx: ConsoleRouteContext): Promise<boolean> {
  const { path, method, url, req, res, me } = ctx;

  /* --- console accounts --- */

  if (path === "/api/accounts") {
    if (method === "GET") {
      json(res, 200, accounts.all().map(accounts.publicView));
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      json(
        res,
        200,
        accounts.publicView(
          accounts.create({
            username: str(b, "username"),
            password: str(b, "password"),
            role: b.role === "viewer" ? "viewer" : "admin",
          }),
        ),
      );
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
      json(
        res,
        200,
        accounts.publicView(
          accounts.update(id, {
            username: optStr(b, "username"),
            password: optStr(b, "password"),
            role: b.role === "viewer" ? "viewer" : b.role === "admin" ? "admin" : undefined,
          }),
        ),
      );
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
          emailLevel: ["info", "warn", "bad"].includes(String(n.emailLevel))
            ? (n.emailLevel as "info")
            : current.emailLevel,
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
                  kind: (["discord", "telegram", "ntfy", "generic"].includes(String(w.kind))
                    ? w.kind
                    : "generic") as never,
                  url: String(w.url ?? ""),
                  // A masked token means "unchanged" — the browser was never
                  // given the real one to send back.
                  botToken:
                    w.botToken === "********" ? existing?.botToken : w.botToken ? String(w.botToken) : undefined,
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
          const label = String(entry.label ?? "")
            .trim()
            .slice(0, 40);
          const icon = String(entry.icon ?? "")
            .trim()
            .slice(0, 8);
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
    await webhooks.deliver(
      hook,
      {
        level: "info",
        category: "test",
        title: "Test from your NAS",
        detail: "If you are reading this on your phone, notifications are working.",
        server: store.get(url.searchParams.get("c"))?.name ?? "EzNAS",
      },
      cfg.greetName || undefined,
    );
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
    const target = normaliseUrl(str(b, "url"));
    const [result, certificate] = await Promise.all([
      store.test({ url: target, apiKey: str(b, "apiKey"), fingerprint: optStr(b, "fingerprint") ?? null }),
      // Alongside the result, so the form can offer to pin what it just
      // reached without a second round trip. A probe failure is not a test
      // failure: the test itself already said whether the NAS answered.
      probeCertificate(target).catch(() => null),
    ]);
    json(res, 200, { ...result, certificate });
    return true;
  }

  /*
   * What certificate is at an address — before there is an API key, so the
   * first-run wizard can show it and offer to pin it. Trust-on-first-use is
   * only trust if the operator sees what they are trusting.
   */
  if (path === "/api/connections/certificate" && method === "POST") {
    const b = await bodyOf(req);
    json(res, 200, await probeCertificate(normaliseUrl(str(b, "url"))));
    return true;
  }

  /*
   * A guess at where the NAS is, for a console that runs on it. Each
   * candidate is probed so the wizard can say "a TrueNAS certificate for
   * truenas.local answered at 192.168.1.10" rather than offering a bare
   * gateway address. Probes run in parallel and failures are dropped.
   */
  if (path === "/api/setup/discover" && method === "GET") {
    const found = await Promise.all(
      candidateHosts().map(async (host) => ({
        host,
        certificate: await probeCertificate(`wss://${host}/api/current`, 2_500).catch(() => null),
      })),
    );
    json(res, 200, { candidates: found });
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

  return false;
}

/** Accept what people paste — an address, https://…, or a full ws:// URL. */
function normaliseUrl(input: string): string {
  let u = input.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = `wss://${u}`;
  u = u.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  if (!/\/api\/current$/.test(u)) u = `${u.replace(/\/+$/, "")}/api/current`;
  return u;
}
