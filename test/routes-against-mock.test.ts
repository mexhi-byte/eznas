import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMock, type RunningMock } from "../mock/truenas-mock.js";
import { TrueNas } from "../server/truenas.js";
import { handleAppRoutes } from "../server/routes/apps.js";
import { handleDiskRoutes } from "../server/routes/disks.js";
import { handleNasUserRoutes } from "../server/routes/nas-users.js";
import { handleSnapshotRoutes } from "../server/routes/snapshots.js";
import { handleStorageRoutes } from "../server/routes/storage.js";
import { handleSystemRoutes } from "../server/routes/system.js";
import type { NasRouteContext } from "../server/routes/context.js";

/**
 * The route modules, against a NAS that speaks the protocol.
 *
 * The fake-object tests elsewhere pin down ordering — what reaches the NAS
 * and in which order. These pin down shape: that a route turns the rows the
 * NAS actually sends into the answer the browser expects, over a real
 * JSON-RPC socket, login and all. The mock's fixtures are the ones a person
 * sees when they try the demo, so a change that breaks a page here breaks it
 * there too.
 */

let mock: RunningMock;
let nas: TrueNas;

beforeAll(async () => {
  mock = await startMock(0);
  nas = new TrueNas(mock.url, "1-mock");
  await nas.call("system.info");
});
afterAll(async () => {
  nas.close();
  await mock.close();
});

const me = { id: "acct", username: "admin", role: "admin" } as NasRouteContext["me"];

function drive(handler: (ctx: NasRouteContext) => Promise<boolean>, method: string, path: string, body?: unknown) {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(s: string) {
      out.body = s ? JSON.parse(s) : undefined;
    },
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const url = new URL(`http://console.local${path}`);
  const run = handler({ path: url.pathname, method, url, req: req as never, res: res as never, nas, me });
  return { run, out };
}

describe("storage", () => {
  it("summarises pools with their vdevs", async () => {
    const { run, out } = drive(handleStorageRoutes, "GET", "/api/pools");
    expect(await run).toBe(true);
    const pools = out.body as Array<{ name: string; vdevs: Array<{ type: string; disks: unknown[] }> }>;
    expect(pools.map((p) => p.name)).toEqual(["tank", "fast"]);
    expect(pools[0].vdevs[0]).toMatchObject({ type: "RAIDZ2" });
    expect(pools[0].vdevs[0].disks).toHaveLength(4);
  });

  it("refuses to create a pool with no disks before asking the NAS", async () => {
    const { run } = drive(handleStorageRoutes, "POST", "/api/pools", { name: "new", layout: "MIRROR", disks: [] });
    await expect(run).rejects.toThrow(/at least one disk/);
  });

  it("lists datasets with numbers, not the NAS's property objects", async () => {
    const { run, out } = drive(handleStorageRoutes, "GET", "/api/datasets");
    await run;
    const rows = out.body as Array<{ name: string; used: number | null; compression: string | null }>;
    const media = rows.find((r) => r.name === "tank/media")!;
    expect(typeof media.used).toBe("number");
    expect(media.compression).toBe("1.12x");
  });
});

describe("disks", () => {
  it("gives the drive with checksum errors a verdict that is not green", async () => {
    const { run, out } = drive(handleDiskRoutes, "GET", "/api/disks");
    await run;
    const disks = out.body as Array<{ name: string; health: { level: string }; inUse: boolean; tempC: number | null }>;
    expect(disks.find((d) => d.name === "sdc")?.health.level).not.toBe("ok");
    expect(disks.find((d) => d.name === "sda")?.health.level).toBe("ok");
    expect(disks.find((d) => d.name === "sde")?.inUse).toBe(false);
    expect(disks.find((d) => d.name === "sda")?.tempC).toBe(36);
  });

  it("assembles one drive's health from four calls", async () => {
    const { run, out } = drive(handleDiskRoutes, "GET", "/api/disks/sdc/health");
    await run;
    const h = out.body as {
      zfs: { checksumErrors: number; pool: string };
      health: { level: string; reasons: string[] };
    };
    expect(h.zfs).toMatchObject({ pool: "tank", checksumErrors: 3 });
    expect(h.health.reasons.length).toBeGreaterThan(0);
  });
});

describe("apps", () => {
  it("lists apps and marks the one deployed from a compose file", async () => {
    const { run, out } = drive(handleAppRoutes, "GET", "/api/apps");
    await run;
    const apps = out.body as Array<{ name: string; custom: boolean; containers: number }>;
    expect(apps.map((a) => a.name).sort()).toEqual(["homepage", "jellyfin", "nextcloud", "plex"]);
    expect(apps.find((a) => a.name === "homepage")?.custom).toBe(true);
    expect(apps.find((a) => a.name === "homepage")?.containers).toBe(1);
  });

  it("returns an app's containers for the logs and shell buttons", async () => {
    const { run, out } = drive(handleAppRoutes, "GET", "/api/apps/nextcloud/containers");
    await run;
    const list = out.body as Array<{ id: string; name: string }>;
    expect(list.map((c) => c.name)).toEqual(["nextcloud", "postgres", "redis"]);
    expect(list.every((c) => /^[0-9a-f]{12,64}$/.test(c.id))).toBe(true);
  });

  it("digs an app's generated password out of its config", async () => {
    const { run, out } = drive(handleAppRoutes, "GET", "/api/apps/nextcloud/config");
    await run;
    const cfg = out.body as {
      credentials: Array<{ key: string; secret: boolean }>;
      schema: unknown;
      values: Record<string, unknown>;
    };
    expect(cfg.credentials.some((c) => c.key === "admin_password" && c.secret)).toBe(true);
    expect(cfg.schema).not.toBeNull();
    // The middleware's own scaffolding is not a setting.
    expect(cfg.values).not.toHaveProperty("ix_context");
  });
});

describe("users and groups", () => {
  it("hides built-in users unless asked", async () => {
    const hidden = drive(handleNasUserRoutes, "GET", "/api/users");
    await hidden.run;
    expect((hidden.out.body as Array<{ username: string }>).map((u) => u.username)).not.toContain("root");
    const shown = drive(handleNasUserRoutes, "GET", "/api/users?builtin=1");
    await shown.run;
    expect((shown.out.body as Array<{ username: string }>).map((u) => u.username)).toContain("root");
  });

  it("lists groups with their members", async () => {
    const { run, out } = drive(handleNasUserRoutes, "GET", "/api/groups");
    await run;
    const family = (out.body as Array<{ name: string; members: number[] }>).find((g) => g.name === "family")!;
    expect(family.members).toEqual([10, 11, 12]);
  });

  it("names the shared folders a group deletion would orphan", async () => {
    const { run, out } = drive(handleNasUserRoutes, "GET", "/api/groups/21/orphans");
    await run;
    const o = out.body as { warning: string | null; affected: Array<{ name: string }> };
    expect(o.affected.length).toBeGreaterThan(0);
    expect(o.warning).toMatch(/numeric id/);
  });

  it("will not delete a group without its name typed back, nor a built-in one at all", async () => {
    await expect(drive(handleNasUserRoutes, "DELETE", "/api/groups/21", { confirm: "wrong" }).run).rejects.toThrow(
      /confirm/,
    );
    await expect(drive(handleNasUserRoutes, "DELETE", "/api/groups/1", { confirm: "root" }).run).rejects.toThrow(
      /built in/,
    );
  });
});

describe("snapshots", () => {
  it("filters by dataset and reads the creation time in milliseconds", async () => {
    const { run, out } = drive(handleSnapshotRoutes, "GET", "/api/snapshots?dataset=tank/family");
    await run;
    const snaps = out.body as Array<{ dataset: string; createdAt: number; held: boolean }>;
    expect(snaps).toHaveLength(5);
    expect(snaps.every((s) => s.dataset === "tank/family")).toBe(true);
    // Milliseconds, and within the last month — not fifty thousand years out.
    expect(Date.now() - snaps[0].createdAt).toBeLessThan(31 * 86_400_000);
  });
});

describe("system", () => {
  it("answers the overview from five calls", async () => {
    const { run, out } = drive(handleSystemRoutes, "GET", "/api/overview");
    await run;
    const o = out.body as { system: { hostname: string }; pools: unknown[]; apps: { running: number }; disks: number };
    expect(o.system.hostname).toBe("demo-nas");
    expect(o.pools).toHaveLength(2);
    expect(o.apps.running).toBe(3);
    expect(o.disks).toBe(7);
  });

  it("refuses to reboot without the hostname typed back", async () => {
    const { run } = drive(handleSystemRoutes, "POST", "/api/system/power", { action: "reboot", confirm: "nope" });
    await expect(run).rejects.toThrow(/demo-nas/);
  });

  it("downsamples a day of history into a few hundred points", async () => {
    const { run, out } = drive(handleSystemRoutes, "GET", "/api/history?metric=cpu&unit=DAY");
    await run;
    const h = out.body as { points: unknown[]; summary: { max: number } | null };
    expect(h.points.length).toBeGreaterThan(50);
    expect(h.points.length).toBeLessThanOrEqual(200);
    expect(h.summary?.max).toBeGreaterThan(0);
  });
});
