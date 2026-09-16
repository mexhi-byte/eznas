import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { poolIdOf, type PoolRow } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";
import { cronOf } from "./snapshots.js";

/**
 * Whether the data is safe, and the things that make it so.
 *
 * A NAS is bought for one reason, and TrueNAS scatters the evidence across
 * six screens: scrub schedules under Data Protection, SMART tests under
 * Disks, cloud sync and replication under their own tabs, encryption per
 * dataset, the UPS under Services. This gathers them into one answer and
 * offers the two-or-three-field version of each: a monthly scrub, a weekly
 * short test, a nightly copy to a bucket or a second pool.
 */

interface Task extends Record<string, unknown> {
  id: number;
  enabled?: boolean;
  schedule?: Record<string, string>;
  job?: { state?: string; time_finished?: { $date: number } } | null;
  state?: { state?: string; datetime?: { $date: number } } | null;
}

const when = (t: Task) => t.job?.time_finished?.$date ?? t.state?.datetime?.$date ?? null;
const stateOf = (t: Task) => t.job?.state ?? t.state?.state ?? null;

export async function handleSafetyRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, req, res, nas } = ctx;
  if (!path.startsWith("/api/safety") && !path.startsWith("/api/datasets/")) return false;

  if (path === "/api/safety" && method === "GET") {
    const q = <T>(m: string, params: unknown[] = []) => nas.call<T>(m, params).catch(() => null);
    const [pools, scrubs, smart, cloud, creds, repl, snapTasks, datasets, ups, services] = await Promise.all([
      q<PoolRow[]>("pool.query"),
      q<Task[]>("pool.scrub.query"),
      q<Task[]>("smart.test.query"),
      q<Task[]>("cloudsync.query"),
      q<Array<Record<string, unknown>>>("cloudsync.credentials.query"),
      q<Task[]>("replication.query"),
      q<Task[]>("pool.snapshottask.query"),
      q<Array<Record<string, unknown>>>("pool.dataset.query", [
        [["encrypted", "=", true]],
        { extra: { flat: true, properties: ["keyformat"], retrieve_children: true } },
      ]),
      q<Record<string, unknown>>("ups.config"),
      q<Array<{ service: string; state: string; enable: boolean }>>("service.query"),
    ]);
    const poolName = (id: unknown) =>
      (pools ?? []).find((p) => (p as unknown as { id: number }).id === id)?.name ?? String(id);
    json(res, 200, {
      pools: (pools ?? []).map((p) => ({
        name: p.name,
        healthy: p.healthy,
        lastScrub:
          p.scan?.function === "SCRUB" && p.scan.state === "FINISHED" ? (p.scan.end_time?.$date ?? null) : null,
        scrubErrors: (p.scan as { errors?: number } | null)?.errors ?? 0,
      })),
      scrubs: (scrubs ?? []).map((t) => ({
        id: t.id,
        pool: (t.pool_name as string) ?? poolName(t.pool),
        schedule: t.schedule,
        enabled: t.enabled !== false,
        description: t.description ?? "",
      })),
      smartTests: (smart ?? []).map((t) => ({
        id: t.id,
        type: t.type,
        allDisks: t.all_disks === true,
        disks: Array.isArray(t.disks) ? t.disks.length : 0,
        schedule: t.schedule,
        description: t.desc ?? "",
      })),
      cloud: (cloud ?? []).map((t) => {
        const cred = t.credentials as { name?: string; provider?: string | { type?: string } } | undefined;
        const attrs = (t.attributes ?? {}) as Record<string, unknown>;
        return {
          id: t.id,
          description: t.description ?? "",
          path: t.path,
          direction: t.direction,
          provider: typeof cred?.provider === "string" ? cred.provider : (cred?.provider?.type ?? ""),
          credential: cred?.name ?? "",
          bucket: attrs.bucket ?? null,
          folder: attrs.folder ?? "",
          schedule: t.schedule,
          enabled: t.enabled !== false,
          state: stateOf(t),
          lastAt: when(t),
        };
      }),
      credentials: (creds ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        provider: typeof c.provider === "string" ? c.provider : ((c.provider as { type?: string })?.type ?? ""),
      })),
      replication: (repl ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        transport: t.transport,
        source: Array.isArray(t.source_datasets) ? t.source_datasets : [],
        target: t.target_dataset,
        schedule: t.schedule,
        enabled: t.enabled !== false,
        state: stateOf(t),
        lastAt: when(t),
      })),
      snapshotTasks: (snapTasks ?? []).filter((t) => t.enabled !== false).length,
      encrypted: (datasets ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        locked: d.locked === true,
        keyFormat: ((d.key_format ?? d.keyformat) as { value?: string } | undefined)?.value ?? null,
      })),
      ups: {
        service: (services ?? []).find((s) => s.service === "ups") ?? null,
        mode: ups?.mode ?? null,
        driver: ups?.driver ?? null,
        port: ups?.port ?? null,
      },
    });
    return true;
  }

  /* --- scrub schedules --- */
  if (path === "/api/safety/scrubs" && method === "POST") {
    const b = await bodyOf(req);
    const pool = str(b, "pool");
    json(res, 200, {
      id: await nas.call("pool.scrub.create", [
        {
          pool: await poolIdOf(nas, pool),
          // Skip when the last scrub was recent; 35 days makes a monthly
          // schedule scrub exactly once a month however the calendar falls.
          threshold: Number(b.threshold ?? 35),
          description: optStr(b, "description") ?? `Monthly scrub of ${pool}`,
          schedule: cronOf(b.schedule ?? { minute: "0", hour: "3", dom: "1" }),
          enabled: true,
        },
      ]),
    });
    return true;
  }
  const scrubDel = /^\/api\/safety\/scrubs\/(\d+)$/.exec(path);
  if (scrubDel && method === "DELETE") {
    await nas.call("pool.scrub.delete", [Number(scrubDel[1])]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- SMART test schedules --- */
  if (path === "/api/safety/smart-tests" && method === "POST") {
    const b = await bodyOf(req);
    const type = String(b.type ?? "SHORT").toUpperCase();
    if (!["SHORT", "LONG"].includes(type)) throw new Error('"type" must be SHORT or LONG.');
    // SMART schedules have no minute field; the NAS runs them on the hour.
    const { minute: _m, ...schedule } = cronOf(
      b.schedule ?? (type === "SHORT" ? { hour: "2", dow: "0" } : { hour: "2", dom: "15" }),
    );
    json(res, 200, {
      id: await nas.call("smart.test.create", [
        {
          disks: [],
          all_disks: true,
          type,
          desc: optStr(b, "description") ?? `${type === "SHORT" ? "Weekly short" : "Monthly long"} self-test`,
          schedule,
        },
      ]),
    });
    return true;
  }
  const smartDel = /^\/api\/safety\/smart-tests\/(\d+)$/.exec(path);
  if (smartDel && method === "DELETE") {
    await nas.call("smart.test.delete", [Number(smartDel[1])]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- cloud backup --- */
  if (path === "/api/safety/cloud/credentials" && method === "POST") {
    const b = await bodyOf(req);
    const provider = String(b.provider ?? "").toUpperCase();
    const attrs = (b.attributes ?? {}) as Record<string, unknown>;
    const wanted: Record<string, string[]> = {
      B2: ["account", "key"],
      S3: ["access_key_id", "secret_access_key"],
      STORJ_IX: ["access_key_id", "secret_access_key"],
    };
    if (!wanted[provider]) throw new Error(`"provider" must be one of ${Object.keys(wanted).join(", ")}.`);
    for (const k of wanted[provider]) if (!optStr(attrs, k)) throw new Error(`"${k}" is required for ${provider}.`);
    json(res, 200, {
      id: await nas
        .call("cloudsync.credentials.create", [{ name: str(b, "name"), provider: { type: provider, ...attrs } }])
        // 25.04 takes provider as an object; older middleware took the type and attributes apart.
        .catch(() => nas.call("cloudsync.credentials.create", [{ name: str(b, "name"), provider, attributes: attrs }])),
    });
    return true;
  }
  if (path === "/api/safety/cloud" && method === "POST") {
    const b = await bodyOf(req);
    const direction = b.direction === "PULL" ? "PULL" : "PUSH";
    json(res, 200, {
      id: await nas.call("cloudsync.create", [
        {
          description: str(b, "description"),
          path: str(b, "path"),
          credentials: Number(b.credential),
          direction,
          // COPY leaves what is already in the bucket alone; SYNC would delete
          // there whatever was deleted here, which is the one thing a backup
          // must not do by default.
          transfer_mode: b.transferMode === "SYNC" ? "SYNC" : "COPY",
          attributes: { bucket: str(b, "bucket"), folder: optStr(b, "folder") ?? "" },
          schedule: cronOf(b.schedule ?? { minute: "0", hour: "1" }),
          enabled: true,
          snapshot: b.snapshot !== false,
        },
      ]),
    });
    return true;
  }
  const cloudRun = /^\/api\/safety\/cloud\/(\d+)\/run$/.exec(path);
  if (cloudRun && method === "POST") {
    json(res, 200, { jobId: await nas.startJob("cloudsync.sync", [Number(cloudRun[1])]) });
    return true;
  }
  const cloudDel = /^\/api\/safety\/cloud\/(\d+)$/.exec(path);
  if (cloudDel && method === "DELETE") {
    await nas.call("cloudsync.delete", [Number(cloudDel[1])]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- replication to a second pool --- */
  if (path === "/api/safety/replication" && method === "POST") {
    const b = await bodyOf(req);
    const source = str(b, "source");
    const target = str(b, "target");
    if (target === source || target.startsWith(`${source}/`))
      throw new Error("The copy cannot live inside what it copies.");
    json(res, 200, {
      id: await nas.call("replication.create", [
        {
          name: optStr(b, "name") ?? `Copy ${source} to ${target}`,
          direction: "PUSH",
          transport: "LOCAL",
          source_datasets: [source],
          target_dataset: target,
          recursive: b.recursive !== false,
          auto: true,
          schedule: cronOf(b.schedule ?? { minute: "0", hour: "4" }),
          // Keep on the copy what is kept on the source: expiring a snapshot
          // here expires it there too, so the copy never outgrows the original.
          retention_policy: "SOURCE",
          name_regex: ".*",
          readonly: "SET",
          enabled: true,
        },
      ]),
    });
    return true;
  }
  const replRun = /^\/api\/safety\/replication\/(\d+)\/run$/.exec(path);
  if (replRun && method === "POST") {
    json(res, 200, { jobId: await nas.startJob("replication.run", [Number(replRun[1])]) });
    return true;
  }
  const replDel = /^\/api\/safety\/replication\/(\d+)$/.exec(path);
  if (replDel && method === "DELETE") {
    await nas.call("replication.delete", [Number(replDel[1])]);
    json(res, 200, { ok: true });
    return true;
  }

  /* --- locked folders --- */
  const dsAction = /^\/api\/datasets\/(lock|unlock|export-key)$/.exec(path);
  if (dsAction && method === "POST") {
    const b = await bodyOf(req);
    const id = str(b, "id");
    if (dsAction[1] === "lock") {
      // Locking makes every file inside unreadable until the passphrase is
      // entered again; the name typed back is the pause before that.
      confirmed(b, id);
      json(res, 200, { jobId: await nas.startJob("pool.dataset.lock", [id, { force_umount: b.force === true }]) });
      return true;
    }
    if (dsAction[1] === "unlock") {
      const passphrase = str(b, "passphrase");
      const result = await nas.runJob("pool.dataset.unlock", [
        id,
        { datasets: [{ name: id, passphrase }], recursive: true },
      ]);
      const r = result.result as { failed?: Record<string, unknown>; unlocked?: string[] } | null;
      if (r?.failed && Object.keys(r.failed).length) throw new Error("That passphrase did not unlock it.");
      json(res, 200, { ok: true, unlocked: r?.unlocked ?? [id] });
      return true;
    }
    confirmed(b, id);
    const key = await nas.runJob("pool.dataset.export_key", [id]);
    json(res, 200, { key: key.result });
    return true;
  }

  return false;
}
