import * as store from "./store.js";
import * as settings from "./settings.js";
import type { TrueNas } from "./truenas.js";
import * as webhooks from "./webhooks.js";
import * as selfUpdate from "./self-update.js";
import { VERSION } from "./version.js";

/**
 * What the console watches, on its own behalf.
 *
 * TrueNAS raises alerts, and this console shows them — but it stays quiet
 * about a good deal that matters in a house rather than a datacentre. It says
 * nothing when an app falls over, nothing when a drive that was never in a
 * pool disappears, nothing when a pool crosses the capacity line *you* care
 * about rather than the one it ships with, and nothing when the NAS becomes
 * unreachable, because by then it cannot tell you anything at all.
 *
 * Each check produces a stable key, and a key that is already sitting in the
 * list is not raised again. That is the difference between a notification and
 * a nuisance: a pool at 91% is one notice, not one every thirty seconds until
 * somebody deletes a film. When the condition clears, the key is dropped, so
 * the next occurrence is reported afresh.
 */

interface Known { name: string; model: string; size: number; serial: string; pool: string | null }

interface PoolRow {
  name: string; status: string; healthy: boolean; size: number; allocated: number;
  scan?: { function?: string; state?: string; errors?: number; end_time?: { $date: number } } | null;
  topology?: Record<string, VdevNode[]>;
}
interface VdevNode {
  disk?: string | null; device?: string | null; status?: string; children?: VdevNode[];
  stats?: { read_errors?: number; write_errors?: number; checksum_errors?: number };
}
interface AppRow { name: string; state: string; upgrade_available?: boolean }

/** Per connection, because two NASes have their own sets of everything. */
const lastDisks = new Map<string, Map<string, Known>>();
const lastAppState = new Map<string, Map<string, string>>();
const lastScrubEnd = new Map<string, Map<string, number>>();

const shape = (d: Record<string, unknown>): Known => ({
  name: String(d.name),
  model: String(d.model ?? ""),
  size: Number(d.size ?? 0),
  serial: String(d.serial ?? ""),
  pool: (d.imported_zpool as string) ?? null,
});

/* --------------------------------------------------------------- raising */

async function raise(
  conn: store.Connection,
  n: {
    level: settings.NoticeLevel; category: string; key: string; title: string; detail: string;
    /** Overrides the server name, for a notice that is not about a NAS. */
    server?: string;
  },
): Promise<void> {
  if (settings.hasActive(n.key)) return;
  const notice = settings.addEvent({ ...n, server: n.server ?? conn.name });
  console.log(`[watch] ${conn.name}: ${n.title}`);

  const cfg = settings.get().notify;

  // Rank so "only tell me about problems" is a setting rather than an
  // all-or-nothing switch.
  const rank = { info: 0, warn: 1, bad: 2 };

  // Push first: it is the one somebody will actually see tonight, and it must
  // not be held up by an SMTP server that is slow or misconfigured.
  for (const hook of cfg.webhooks ?? []) {
    if (!hook.enabled || rank[n.level] < rank[hook.level]) continue;
    try {
      await webhooks.deliver(hook, { ...n, server: n.server ?? conn.name }, cfg.greetName || undefined);
    } catch (e) {
      // One dead webhook must not stop the others, or the email.
      console.error(`[watch] webhook ${hook.kind} failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (!cfg.email || !cfg.recipients.length) return;
  if (rank[n.level] < rank[cfg.emailLevel]) return;

  try {
    await store.clientFor(conn).call("mail.send", [{
      subject: `[${n.server ?? conn.name}] ${n.title}`,
      text: `${n.title}\n\n${n.detail}\n\nSeen on ${conn.name} at ${new Date().toLocaleString()}.`,
      to: cfg.recipients,
    }], 20_000);
    settings.markEmailed(notice.id);
  } catch (e) {
    console.error("[watch] could not send mail:", e instanceof Error ? e.message : e);
  }
}

/** A condition that has gone away: forget it so a recurrence is reported. */
const clear = (key: string) => settings.clearKey(key);

/* --------------------------------------------------------------- checks */

async function checkDisks(conn: store.Connection, nas: TrueNas): Promise<void> {
  if (!settings.get().notify.watchDisks) return;
  const details = await nas.call<{ used?: Array<Record<string, unknown>>; unused?: Array<Record<string, unknown>> }>(
    "disk.details", [], 8000,
  );

  const now = new Map<string, Known>();
  for (const d of [...(details.used ?? []), ...(details.unused ?? [])]) {
    const k = shape(d);
    // Keyed by serial where there is one: a drive that comes back under a
    // different device name is the same physical disk, and reporting that as
    // remove-plus-add would be noise.
    now.set(k.serial || k.name, k);
  }

  const before = lastDisks.get(conn.id);
  lastDisks.set(conn.id, now);
  // The first poll after a restart establishes the baseline; treating it as
  // "everything just appeared" would fire an event per disk on every deploy.
  if (!before) return;

  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(0)} GB`;
  for (const [key, d] of before) {
    if (now.has(key)) continue;
    await raise(conn, {
      level: d.pool ? "bad" : "warn",
      category: "disk",
      key: `disk:removed:${key}`,
      title: `Disk removed: ${d.name}`,
      detail: `${d.model || "unknown model"} · ${gb(d.size)} · serial ${d.serial || "unknown"}` +
        (d.pool ? `. This disk was part of pool "${d.pool}" — check that pool now.` : ". It was not part of a pool."),
    });
  }
  for (const [key, d] of now) {
    if (before.has(key)) continue;
    clear(`disk:removed:${key}`);
    await raise(conn, {
      level: "info",
      category: "disk",
      key: `disk:added:${key}:${Date.now()}`,
      title: `New disk: ${d.name}`,
      detail: `${d.model || "unknown model"} · ${gb(d.size)} · serial ${d.serial || "unknown"}.`,
    });
  }
}

async function checkPools(conn: store.Connection, nas: TrueNas): Promise<void> {
  const cfg = settings.get().notify.watch;
  const pools = await nas.call<PoolRow[]>("pool.query", [], 10_000);

  for (const p of pools) {
    /* --- health --- */
    if (cfg.poolHealth) {
      const key = `pool:health:${p.name}`;
      if (!p.healthy || p.status !== "ONLINE") {
        await raise(conn, {
          level: "bad", category: "pool", key,
          title: `Pool ${p.name} is ${p.status.toLowerCase()}`,
          detail: `ZFS no longer reports this pool as healthy. Open the drive array map to see which member is at fault.`,
        });
      } else {
        clear(key);
      }
    }

    /* --- how full --- */
    if (cfg.capacity && p.size) {
      const pct = (p.allocated / p.size) * 100;
      const key = `pool:full:${p.name}`;
      if (pct >= cfg.capacityPercent) {
        await raise(conn, {
          level: pct >= 95 ? "bad" : "warn", category: "capacity", key,
          title: `Pool ${p.name} is ${pct.toFixed(0)}% full`,
          detail: `${((p.size - p.allocated) / 1024 ** 3).toFixed(0)} GB left. ZFS slows down noticeably past about 90%, ` +
            `and a pool with no free space cannot even delete files cleanly.`,
        });
      } else if (pct < cfg.capacityPercent - 2) {
        // Two points of hysteresis, so a pool hovering on the line does not
        // notify every time a log file rotates.
        clear(key);
      }
    }

    /* --- read/write/checksum errors on any member --- */
    if (cfg.zfsErrors) {
      for (const [role, vdevs] of Object.entries(p.topology ?? {})) {
        for (const vdev of vdevs ?? []) {
          const walk = async (node: VdevNode): Promise<void> => {
            const s = node.stats ?? {};
            const total = (s.read_errors ?? 0) + (s.write_errors ?? 0) + (s.checksum_errors ?? 0);
            const name = node.disk ?? node.device;
            if (name && total > 0) {
              await raise(conn, {
                level: "bad", category: "zfs", key: `zfs:errors:${p.name}:${name}`,
                title: `${name} is returning errors in ${p.name}`,
                detail: `${s.read_errors ?? 0} read, ${s.write_errors ?? 0} write, ${s.checksum_errors ?? 0} checksum ` +
                  `on the ${role} vdev. Checksum errors mean the drive handed back data that was wrong rather than failing outright.`,
              });
            }
            for (const c of node.children ?? []) await walk(c);
          };
          await walk(vdev);
        }
      }
    }

    /* --- a scrub that has just finished --- */
    if (cfg.scrubs && p.scan?.function === "SCRUB" && p.scan.state === "FINISHED") {
      const ended = p.scan.end_time?.$date ?? 0;
      const seen = lastScrubEnd.get(conn.id) ?? new Map<string, number>();
      lastScrubEnd.set(conn.id, seen);
      if (ended && seen.get(p.name) !== ended) {
        const first = !seen.has(p.name);
        seen.set(p.name, ended);
        // The first poll only records where things stand; announcing the last
        // scrub on every restart would be a lie about when it happened.
        if (!first) {
          const errors = p.scan.errors ?? 0;
          await raise(conn, {
            level: errors > 0 ? "bad" : "info", category: "scrub", key: `scrub:${p.name}:${ended}`,
            title: errors > 0 ? `Scrub of ${p.name} found ${errors} error${errors === 1 ? "" : "s"}` : `Scrub of ${p.name} finished cleanly`,
            detail: errors > 0
              ? "ZFS checked every byte and could not repair everything it found. Look at the drives in this pool."
              : "ZFS read every byte in the pool and found nothing wrong.",
          });
        }
      }
    }
  }
}

async function checkTemperatures(conn: store.Connection, nas: TrueNas): Promise<void> {
  const cfg = settings.get().notify.watch;
  if (!cfg.temperature) return;
  const temps = await nas.call<Record<string, number | null>>("disk.temperatures", [], 10_000);
  for (const [disk, t] of Object.entries(temps)) {
    // 0 is what a drive that cannot report says, not a very cold drive.
    if (t === null || t === 0) continue;
    const key = `temp:${disk}`;
    if (t >= cfg.temperatureC) {
      await raise(conn, {
        level: t >= cfg.temperatureC + 8 ? "bad" : "warn", category: "temperature", key,
        title: `${disk} is running at ${t}°C`,
        detail: `Above the ${cfg.temperatureC}°C mark set for this server. Check that the fans are turning and that nothing is blocking airflow.`,
      });
    } else if (t < cfg.temperatureC - 3) {
      clear(key);
    }
  }
}

async function checkApps(conn: store.Connection, nas: TrueNas): Promise<void> {
  const cfg = settings.get().notify.watch;
  if (!cfg.apps && !cfg.updates) return;
  const apps = await nas.call<AppRow[]>("app.query", [], 10_000);

  const before = lastAppState.get(conn.id);
  const now = new Map(apps.map((a) => [a.name, a.state]));
  lastAppState.set(conn.id, now);

  if (cfg.apps && before) {
    for (const [name, state] of now) {
      const was = before.get(name);
      const key = `app:down:${name}`;
      if (was === "RUNNING" && state !== "RUNNING") {
        await raise(conn, {
          level: "bad", category: "app", key,
          title: `${name} stopped`,
          detail: `The app was running and is now ${String(state).toLowerCase()}. TrueNAS does not raise an alert for this.`,
        });
      } else if (state === "RUNNING") {
        clear(key);
      }
    }
  }

  if (cfg.updates) {
    const updatable = apps.filter((a) => a.upgrade_available).map((a) => a.name);
    const key = `apps:updates:${updatable.sort().join(",")}`;
    if (updatable.length) {
      await raise(conn, {
        level: "info", category: "update", key,
        title: `${updatable.length} app${updatable.length === 1 ? "" : "s"} can be updated`,
        detail: updatable.join(", "),
      });
    }
  }
}

/* ----------------------------------------------------------------- loop */

/* ------------------------------------------------- the console's own updates */

/**
 * Six hours between checks of this repository's releases.
 *
 * GitHub allows an unauthenticated address 60 requests an hour. The watch loop
 * runs every minute, so checking on every pass would spend the entire budget
 * on this one thing and start failing at the top of each hour — and a release
 * that lands is not something anybody needs to hear about within the minute.
 */
const RELEASE_INTERVAL = 6 * 60 * 60 * 1000;
let nextReleaseCheck = 0;

/**
 * Somewhere to deliver a notice that is not about any particular NAS.
 *
 * Mail goes through a NAS's own SMTP configuration, so one has to be picked.
 * A connected server is preferred over the default, because mail through a
 * server that is not answering does not arrive.
 */
function deliveryConn(): store.Connection | null {
  const all = store.all();
  return all.find((c) => store.clientFor(c).connected)
    ?? all.find((c) => c.isDefault)
    ?? all[0]
    ?? null;
}

/**
 * Is there a newer EzNAS than the one running.
 *
 * Deliberately separate from the `updates` watch above, which is about TrueNAS
 * having an update. Folding the two together would mean one switch quietly
 * governing two unrelated things, and somebody turning off NAS update noise
 * would stop hearing about security fixes to this console.
 */
async function checkConsoleRelease(): Promise<void> {
  if (!settings.get().notify.watch.consoleUpdates) return;
  if (Date.now() < nextReleaseCheck) return;
  // Stamped before the request, not after: a GitHub outage must not turn into
  // a retry every minute.
  nextReleaseCheck = Date.now() + RELEASE_INTERVAL;

  const conn = deliveryConn();
  if (!conn) return;

  const result = await selfUpdate.check(VERSION);
  if (!result.updateAvailable || !result.latest) return;

  const release = result.latest;
  const notes = release.notes.trim().split(/\r?\n/).slice(0, 6).join("\n");

  await raise(conn, {
    level: "info",
    category: "console-update",
    // Keyed by version, so each release is announced once and the next one is
    // still announced.
    key: `console:update:${release.version}`,
    server: "EzNAS",
    title: `EzNAS ${release.version} is available`,
    detail:
      `You are running ${VERSION}.` +
      (notes ? `\n\n${notes}` : "") +
      `\n\nInstall it under Settings → App updates.`,
  });
}

async function pollOnce(): Promise<void> {
  const cfg = settings.get().notify.watch;

  // Not inside the loop below: a release of this console is not a property of
  // any one NAS, and checking once per configured server would announce it
  // twice to somebody with two.
  try {
    await checkConsoleRelease();
  } catch (e) {
    // GitHub being unreachable is not a problem with the NAS, and must not
    // stop the checks that are.
    console.error("[watch] release check:", e instanceof Error ? e.message : e);
  }

  for (const conn of store.all()) {
    const nas = store.clientFor(conn);
    const key = `nas:unreachable:${conn.id}`;

    if (!nas.connected) {
      if (cfg.reachability) {
        await raise(conn, {
          level: "bad", category: "reachability", key,
          title: `${conn.name} is not answering`,
          detail: nas.lastError ?? "The console cannot reach this server. Nothing else about it can be checked until it comes back.",
        });
      }
      // Everything below needs a live connection, and a NAS that is down has
      // not "lost every disk" — skipping keeps a reboot from generating a
      // removal event for the whole chassis.
      continue;
    }
    clear(key);

    // One failing check must not stop the others: a NAS that refuses
    // disk.temperatures should still have its pools watched.
    for (const check of [checkDisks, checkPools, checkTemperatures, checkApps]) {
      try {
        await check(conn, nas);
      } catch (e) {
        console.error(`[watch] ${conn.name} ${check.name}:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function start(intervalMs = 60_000): void {
  if (timer) return;
  // A short delay so the first poll happens after connections are up, which
  // avoids a baseline built from an empty list.
  setTimeout(() => void pollOnce().catch((e) => console.error("[watch]", e)), 8000);
  timer = setInterval(() => void pollOnce().catch((e) => console.error("[watch]", e)), intervalMs);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run every check immediately, for the "check now" button. */
export const runNow = pollOnce;
