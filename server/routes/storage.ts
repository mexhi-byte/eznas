import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { num, poolIdOf, summarisePool, sval, type PoolRow } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";
import { recommendLayouts } from "../layout.js";

/** Pools and datasets: what there is, making more of it, and taking it away. */

export async function handleStorageRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas } = ctx;

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
        jobId: await nas.startJob("pool.create", [
          {
            name: str(b, "name"),
            // One vdev of the requested type. Mixed-width topologies are a real
            // need but not one a form can express safely, so they stay in the
            // TrueNAS UI rather than being half-supported here.
            topology: { data: [{ type: layout, disks }] },
            allow_duplicate_serials: false,
          },
        ]),
      });
      return true;
    }
  }

  // What to build from the drives not in any pool, in words a first-time
  // owner can weigh: space, and how many drives may die.
  if (path === "/api/pools/layouts" && method === "GET") {
    const details = await nas.call<{ unused?: Array<{ name: string; size: number; type?: string }> }>("disk.details");
    const free = (details.unused ?? []).map((d) => ({ name: d.name, size: d.size, type: d.type }));
    json(res, 200, { drives: free, options: recommendLayouts(free) });
    return true;
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
      jobId: await nas.startJob("pool.export", [
        await poolIdOf(nas, name),
        {
          // destroy=false keeps the data and merely detaches the pool, which is
          // recoverable by importing it again. Wiping is opt-in and separate.
          destroy: b.destroy === true,
          cascade: true,
          restart_services: true,
        },
      ]),
    });
    return true;
  }

  /* --- datasets --- */
  if (path === "/api/datasets") {
    if (method === "GET") {
      const rows = await nas.call<Array<Record<string, unknown>>>("pool.dataset.query", [
        [["pool", "!=", "boot-pool"]],
        {
          extra: {
            flat: true,
            properties: [
              "used",
              "available",
              "referenced",
              "quota",
              "compressratio",
              "mountpoint",
              "encryption",
              "keyformat",
            ],
            retrieve_children: true,
          },
        },
      ]);
      json(
        res,
        200,
        rows.map((d) => ({
          id: d.id,
          name: d.name,
          pool: d.pool,
          type: d.type,
          encrypted: d.encrypted,
          locked: d.locked === true,
          keyFormat: sval(d.key_format) ?? sval(d.keyformat),
          used: num(d.used),
          available: num(d.available),
          referenced: num(d.referenced),
          quota: num(d.quota),
          compression: sval(d.compressratio),
          mountpoint: d.mountpoint,
        })),
      );
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
      // A folder that can be locked. Passphrase rather than a key file,
      // because a passphrase is something a household can keep and a hex
      // key on the same disks as the data protects nothing.
      if (b.encrypt === true) {
        const passphrase = str(b, "passphrase");
        if (passphrase.length < 8) throw new Error("A passphrase needs at least 8 characters.");
        payload.encryption = true;
        payload.inherit_encryption = false;
        payload.encryption_options = { generate_key: false, passphrase, algorithm: "AES-256-GCM" };
      }
      json(res, 200, await nas.call("pool.dataset.create", [payload]));
      return true;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw new Error("Which dataset?");
      const b = await bodyOf(req);
      confirmed(b, id);
      json(
        res,
        200,
        await nas.call("pool.dataset.delete", [id, { recursive: b.recursive === true, force: b.force === true }]),
      );
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

  return false;
}
