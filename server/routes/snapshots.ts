import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { epochMs, num } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";

/** Snapshots: taking, listing, rolling back, cloning, holding, copying elsewhere, and scheduling. */

export async function handleSnapshotRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas } = ctx;

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
        filters,
        { extra: { holds: true }, limit: 500, order_by: ["-name"] },
      ]);
      json(
        res,
        200,
        snaps.map((s) => {
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
        }),
      );
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
      json(
        res,
        200,
        await nas.call("zfs.snapshot.delete", [id, { recursive: b.recursive === true, defer: b.defer === true }]),
      );
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
    json(
      res,
      200,
      await nas.call("zfs.snapshot.rollback", [
        id,
        {
          force: b.force === true,
          recursive: b.newer === true,
          recursive_clones: b.clones === true,
        },
      ]),
    );
    return true;
  }

  if (path === "/api/snapshots/clone" && method === "POST") {
    const b = await bodyOf(req);
    // A clone is the safe way back into a snapshot: the new dataset is writable
    // and the original is untouched, so it can be compared before anything is
    // rolled back.
    json(
      res,
      200,
      await nas.call("zfs.snapshot.clone", [
        {
          snapshot: str(b, "id"),
          dataset_dst: str(b, "target"),
        },
      ]),
    );
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
      jobId: await nas.startJob("replication.run_onetime", [
        {
          direction: "PUSH",
          transport: "LOCAL",
          source_datasets: [source],
          target_dataset: target,
          recursive: b.recursive === true,
          retention_policy: "NONE",
          name_regex: ".*",
          readonly: "IGNORE",
        },
      ]),
    });
    return true;
  }

  /* --- scheduled snapshots, with retention --- */
  if (path === "/api/snapshot-tasks") {
    if (method === "GET") {
      const tasks = await nas.call<Array<Record<string, unknown>>>("pool.snapshottask.query");
      json(
        res,
        200,
        tasks.map((t) => ({
          id: t.id,
          dataset: t.dataset,
          recursive: t.recursive,
          enabled: t.enabled,
          namingSchema: t.naming_schema,
          lifetimeValue: t.lifetime_value,
          lifetimeUnit: t.lifetime_unit,
          schedule: t.schedule,
          allowEmpty: t.allow_empty,
          state: (t.state as { state?: string })?.state ?? null,
        })),
      );
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

  return false;
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
export function cronOf(v: unknown): Record<string, string> {
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
