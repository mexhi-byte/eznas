import * as store from "../store.js";
import type { TrueNas } from "../truenas.js";
import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { appTitle, isCustomApp } from "../apps.js";
import { catalogIconIndex, hostOf, iconFor, portLinks } from "../app-links.js";
import { appDetail } from "../catalog-detail.js";
import type { AppRow } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";
import { containersOf } from "../shell.js";

/**
 * Apps and the catalog: list, install, configure, start, stop, upgrade,
 * delete, and the credentials an app generated and never showed again.
 */

const APP_ACTIONS: Record<string, string> = { start: "app.start", stop: "app.stop", restart: "app.redeploy" };

export async function handleAppRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas } = ctx;

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

  // For the logs and shell buttons: which container to point them at.
  const appContainers = /^\/api\/apps\/([^/]+)\/containers$/.exec(path);
  if (appContainers && method === "GET") {
    json(res, 200, await containersOf(nas, appContainers[1]));
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
      jobId: await nas.startJob("app.create", [
        {
          app_name: str(b, "appName"),
          catalog_app: str(b, "catalogApp"),
          train: optStr(b, "train") ?? "stable",
          values: (b.values as Record<string, unknown>) ?? {},
        },
      ]),
    });
    return true;
  }

  if (path === "/api/catalog") {
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    const category = url.searchParams.get("category") ?? "";
    const rows = await nas.call<Array<Record<string, unknown>>>("app.available", [
      [],
      { select: ["name", "title", "categories", "latest_version", "train", "description", "icon_url", "installed"] },
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

  /*
   * One app, in full.
   *
   * app.available with a filter rather than a dedicated details method: it is
   * the same call the catalog list already makes, so it is known to work on
   * this NAS, and asking for no `select` returns every field the catalog has
   * instead of the handful the list needs. Which fields those are varies by
   * version, which is why what comes back is mapped rather than forwarded.
   */
  /*
   * The questions a catalog app asks at install, with the version they belong
   * to. The same schema the config form renders after install, fetched before
   * it, so installing can be a real form rather than "defaults, then go and
   * fix it in TrueNAS".
   */
  if (path === "/api/catalog/app/schema") {
    const name = str({ name: url.searchParams.get("name") }, "name");
    const train = url.searchParams.get("train") ?? "stable";
    const d = await nas.call<Record<string, unknown>>("catalog.get_app_details", [name, { train }]);
    const versions = (d.versions ?? {}) as Record<string, { schema?: { questions?: unknown } }>;
    const version = String(d.latest_version ?? "");
    json(res, 200, { name, train, version, questions: versions[version]?.schema?.questions ?? null });
    return true;
  }

  if (path === "/api/catalog/app") {
    const name = str({ name: url.searchParams.get("name") }, "name");
    const train = url.searchParams.get("train");
    const filters: unknown[] = [["name", "=", name]];
    if (train) filters.push(["train", "=", train]);
    const [row] = await nas.call<Array<Record<string, unknown>>>("app.available", [filters]);
    if (!row) throw new Error(`The catalog has no app called "${name}".`);
    json(res, 200, appDetail(row));
    return true;
  }

  if (path === "/api/apps" && method === "GET") {
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
    const [apps, icons] = await Promise.all([nas.call<AppRow[]>("app.query"), catalogIcons(nas)]);
    const host = hostOf(store.get(url.searchParams.get("c"))?.url ?? "");
    json(
      res,
      200,
      apps.map((a) => {
        const links = portLinks(host, a.active_workloads?.used_ports);
        return {
          name: a.name,
          state: a.state,
          version: a.human_version || a.version,
          updatable: a.upgrade_available,
          title: appTitle(a.name, a.metadata?.title),
          train: a.metadata?.train,
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
      }),
    );
    return true;
  }

  return false;
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
      [],
      { select: ["name", "icon_url"] },
    ]);
    iconIndex = { at: Date.now(), index: catalogIconIndex(rows) };
  } catch (e) {
    console.error(`[apps] could not read the catalog for icons: ${e instanceof Error ? e.message : String(e)}`);
    iconIndex = { at: Date.now(), index: null };
  }
  return iconIndex.index;
}

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
