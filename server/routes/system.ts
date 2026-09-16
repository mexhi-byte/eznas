import * as store from "../store.js";
import * as settings from "../settings.js";
import type { TrueNas } from "../truenas.js";
import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { summarisePool, type AlertRow, type AppRow, type DiskRow, type PoolRow } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";

/**
 * The NAS as a machine: the overview, its history, alerts, services, mail,
 * TrueNAS updates, and power. Everything a route module could not claim as a
 * subject of its own.
 */

export async function handleSystemRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas, me } = ctx;

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
      identifier = String(
        nics.find((n) => n.state && (n.state as { link_state?: string }).link_state === "LINK_STATE_UP")?.name ??
          nics[0]?.name ??
          "",
      );
      if (!identifier) throw new Error("No network interface to report on.");
    }

    const [graph] = await nas.call<
      Array<{
        name: string;
        legend: string[];
        data: number[][];
        start: number;
        end: number;
        aggregations?: { min?: Record<string, number>; mean?: Record<string, number>; max?: Record<string, number> };
      }>
    >(
      "reporting.netdata_get_data",
      [[{ name: spec.name, ...(identifier ? { identifier } : {}) }], { unit, page: 1 }],
      30_000,
    );

    if (!graph?.data?.length) {
      json(res, 200, { metric, unit, points: [], series: [], summary: null });
      return true;
    }

    // memory reports what is *available*; everybody thinks in what is used.
    const total =
      metric === "memory" ? Number((await nas.call<Record<string, unknown>>("system.info")).physmem ?? 0) : 0;

    const cols = graph.legend.slice(1);
    const keep = metric === "cpu" ? [0] : metric === "memory" ? [0] : [0, 1];
    const series = keep.map((i) => (metric === "memory" ? "used" : (cols[i] ?? `series ${i}`)));

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

  /* --- mail --- */

  if (path === "/api/mail") {
    if (method === "GET") {
      const cfg = await nas.call<Record<string, unknown>>("mail.config");
      // pass is returned by the NAS; it has no business reaching the browser.
      const { pass, oauth: _oauth, ...rest } = cfg;
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
    await nas.call(
      "mail.send",
      [
        {
          subject: "Test message from the storage console",
          text: "If you are reading this, the NAS can send mail and notifications will reach you.",
          to,
        },
      ],
      30_000,
    );
    json(res, 200, { ok: true });
    return true;
  }

  /* --- updates and licensing --- */

  if (path === "/api/update") {
    const [trains, product, info] = await Promise.all([
      nas.call<{ trains: Record<string, { description: string }>; current: string; selected: string }>(
        "update.get_trains",
      ),
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
      bootEnvironments: await nas
        .call<Array<Record<string, unknown>>>("boot.environment.query")
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

    case "/api/shares": {
      const [smb, nfs] = await Promise.all([
        nas.call<Array<Record<string, unknown>>>("sharing.smb.query"),
        nas.call<Array<Record<string, unknown>>>("sharing.nfs.query"),
      ]);
      json(res, 200, {
        smb: smb.map((s) => ({
          id: s.id,
          name: s.name,
          path: s.path,
          enabled: s.enabled,
          comment: s.comment,
          purpose: s.purpose,
          readOnly: s.ro === true,
        })),
        // id, because without it an export can be listed but not removed —
        // and sharing.nfs.delete takes an id, not a path.
        nfs: nfs.map((s) => ({
          id: s.id,
          path: s.path,
          enabled: s.enabled,
          comment: s.comment,
          networks: s.networks,
          hosts: s.hosts,
        })),
      });
      return true;
    }

    case "/api/alerts": {
      const alerts = await nas.call<AlertRow[]>("alert.list");
      json(
        res,
        200,
        alerts
          .filter((a) => !a.dismissed)
          .map((a) => ({ uuid: a.uuid, level: a.level, text: a.formatted, at: a.datetime?.$date, klass: a.klass })),
      );
      return true;
    }

    case "/api/services": {
      const svc = await nas.call<Array<Record<string, unknown>>>("service.query");
      json(
        res,
        200,
        svc.map((s) => ({ service: s.service, state: s.state, enable: s.enable })),
      );
      return true;
    }

    case "/api/health":
      json(res, 200, { connected: nas.connected, error: nas.lastError });
      return true;
  }

  /* --- power --- */

  if (path === "/api/system/power") {
    const info = await nas.call<{ hostname?: string }>("system.info");
    const hostname = String(info.hostname ?? "");
    if (method === "GET") {
      json(res, 200, { hostname });
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const action = b.action === "reboot" || b.action === "shutdown" ? b.action : null;
      if (!action) throw new Error('"action" must be "reboot" or "shutdown".');
      // The hostname, not the console's nickname for the server: it is what
      // the machine calls itself, and the thing about to go dark.
      confirmed(b, hostname);
      const reason = `${action === "reboot" ? "Restart" : "Shutdown"} requested from EzNAS by ${me.username}`;
      try {
        await nas.call(`system.${action}`, [reason, { delay: 0 }]);
      } catch (e) {
        // The NAS may close the socket before its answer arrives. That is the
        // request taking effect, not failing, and saying "failed" to somebody
        // watching the lights go off would be the wrong sentence.
        const message = e instanceof Error ? e.message : String(e);
        if (!/dropped|not connected|not reachable/i.test(message)) throw e;
      }
      settings.addEvent({
        level: "info",
        category: "power",
        key: `power:${action}:${Date.now()}`,
        title: action === "reboot" ? `${hostname} is restarting` : `${hostname} is shutting down`,
        detail: `${reason}.`,
        server: store.get(url.searchParams.get("c"))?.name ?? hostname,
      });
      json(res, 200, { ok: true, action, hostname });
      return true;
    }
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

  return false;
}

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
      version: info.version,
      hostname: info.hostname,
      uptime: info.uptime_seconds ?? info.uptime,
      cores: info.cores,
      model: info.model,
      memoryBytes: info.physmem,
      loadavg: info.loadavg,
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
      critical: alerts.filter((a) => !a.dismissed && ["CRITICAL", "ERROR", "ALERT", "EMERGENCY"].includes(a.level))
        .length,
      warning: alerts.filter((a) => !a.dismissed && a.level === "WARNING").length,
    },
    disks: disks.length,
  };
}
