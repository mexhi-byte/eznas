import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { isHost, isNetwork, nfsPayload } from "../server/nfs.js";
import { handleShareRoutes } from "../server/routes/shares.js";

describe("isNetwork", () => {
  it("accepts a CIDR block", () => expect(isNetwork("192.168.1.0/24")).toBe(true));
  it("accepts a single host as a /32", () => expect(isNetwork("192.168.1.50/32")).toBe(true));
  it("accepts an IPv6 block", () => expect(isNetwork("fd00::/64")).toBe(true));
  it("rejects a bare address with no prefix", () => expect(isNetwork("192.168.1.50")).toBe(false));
  it("rejects a prefix longer than the address allows", () => expect(isNetwork("192.168.1.0/33")).toBe(false));
  it("rejects an octet above 255", () => expect(isNetwork("192.168.300.0/24")).toBe(false));
  // 192.168.010.0 is 192.168.8.0 to anything parsing octets with inet_aton,
  // which reads a leading zero as octal. An export aimed at a subnet the
  // person did not type is the failure this whole module exists to prevent.
  it("rejects a leading-zero octet, which some resolvers read as octal", () =>
    expect(isNetwork("192.168.010.0/24")).toBe(false));
  it("rejects a hostname", () => expect(isNetwork("laptop.local")).toBe(false));
  it("rejects an empty string", () => expect(isNetwork("")).toBe(false));
});

describe("isHost", () => {
  it("accepts a bare IPv4 address", () => expect(isHost("192.168.1.50")).toBe(true));
  it("accepts a hostname", () => expect(isHost("laptop.local")).toBe(true));
  it("accepts a single label", () => expect(isHost("laptop")).toBe(true));
  it("rejects a CIDR block", () => expect(isHost("192.168.1.0/24")).toBe(false));
  it("rejects a space, which would split into two entries", () => expect(isHost("a b")).toBe(false));
  it("rejects an empty string", () => expect(isHost("")).toBe(false));
});

describe("nfsPayload", () => {
  const base = {
    path: "/mnt/tank/media", networks: ["192.168.1.0/24"], hosts: [],
    readOnly: false, comment: "", maproot: false,
  };

  it("refuses an export with no networks and no hosts", () => {
    // TrueNAS accepts this and exports to every machine that can reach the
    // NAS. Refusing it here is the whole reason this function exists.
    expect(() => nfsPayload({ ...base, networks: [], hosts: [] }))
      .toThrow(/which machines/i);
  });

  it("accepts hosts alone", () => {
    const p = nfsPayload({ ...base, networks: [], hosts: ["laptop.local"] });
    expect(p.hosts).toEqual(["laptop.local"]);
  });

  it("rejects a malformed network rather than passing it through", () => {
    expect(() => nfsPayload({ ...base, networks: ["192.168.1.0"] }))
      .toThrow(/192\.168\.1\.0/);
  });

  it("names the bad entry in the error, not just that one was bad", () => {
    expect(() => nfsPayload({ ...base, networks: ["10.0.0.0/8", "nonsense/24"] }))
      .toThrow(/nonsense\/24/);
  });

  it("carries the read-only flag through as ro", () => {
    expect(nfsPayload({ ...base, readOnly: true }).ro).toBe(true);
    expect(nfsPayload({ ...base, readOnly: false }).ro).toBe(false);
  });

  it("leaves maproot unset unless it was asked for", () => {
    // The dangerous default. Its absence is the point.
    expect(nfsPayload(base).maproot_user).toBeUndefined();
    expect(nfsPayload(base).maproot_group).toBeUndefined();
  });

  it("maps root only when explicitly asked", () => {
    const p = nfsPayload({ ...base, maproot: true });
    expect(p.maproot_user).toBe("root");
    expect(p.maproot_group).toBe("root");
  });

  it("enables the export", () => expect(nfsPayload(base).enabled).toBe(true));

  it("trims whitespace around entries", () => {
    expect(nfsPayload({ ...base, networks: [" 10.0.0.0/8 "] }).networks).toEqual(["10.0.0.0/8"]);
  });

  it("drops empty entries left behind by an editing UI", () => {
    const p = nfsPayload({ ...base, networks: ["10.0.0.0/8", "", "  "] });
    expect(p.networks).toEqual(["10.0.0.0/8"]);
  });
});

/**
 * The route, against a NAS that only records what it was asked to do.
 *
 * The claim worth testing is an ordering one: nothing reaches the NAS until
 * the machine list has been validated. Asserting that nfsPayload throws does
 * not test it — a route that created the export first and validated second
 * would pass that and still export the folder to the whole network.
 */
function fakeNas() {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    call: async (method: string, params: unknown[] = []) => {
      calls.push({ method, params });
      if (method === "service.query") return [{ state: "STOPPED" }];
      return { id: 7 };
    },
    startJob: async (method: string, params: unknown[] = []) => {
      calls.push({ method, params });
      return 42;
    },
  };
}

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  return {
    out,
    writeHead(status: number) { out.status = status; return this; },
    end(s: string) { out.body = JSON.parse(s); },
  };
}

async function postNfs(body: Record<string, unknown>) {
  const nas = fakeNas();
  const res = fakeRes();
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  const run = handleShareRoutes({
    path: "/api/shares/nfs",
    method: "POST",
    url: new URL("http://nas.local/api/shares/nfs"),
    req: req as never,
    res: res as never,
    nas: nas as never,
  });
  return { run, nas, res };
}

describe("the NFS route", () => {
  const machines = { path: "/mnt/tank/media", networks: ["192.168.1.0/24"] };

  it("reaches the NAS not at all when no machines are named", async () => {
    const { run, nas } = await postNfs({ path: "/mnt/tank/media", networks: [], hosts: [] });
    await expect(run).rejects.toThrow(/which machines/i);
    // Not "did not create the export" — did not speak to the NAS at all, so
    // no service was started and no half-made export was left behind.
    expect(nas.calls).toEqual([]);
  });

  it("refuses a malformed network without creating anything", async () => {
    const { run, nas } = await postNfs({ path: "/mnt/tank/media", networks: ["192.168.1.0"] });
    await expect(run).rejects.toThrow(/192\.168\.1\.0/);
    expect(nas.calls).toEqual([]);
  });

  it("creates the export, then starts nfs when it is off", async () => {
    const { run, nas, res } = await postNfs(machines);
    await expect(run).resolves.toBe(true);
    const order = nas.calls.map((c) => c.method);
    expect(order[0]).toBe("sharing.nfs.create");
    expect(order).toContain("service.start");
    expect(res.out.status).toBe(200);
    expect((res.out.body as { startedService: boolean }).startedService).toBe(true);
  });

  it("does not touch the folder's permissions when no group was chosen", async () => {
    const { run, nas, res } = await postNfs(machines);
    await run;
    expect(nas.calls.map((c) => c.method)).not.toContain("filesystem.setperm");
    expect((res.out.body as { permissionsJobId: number | null }).permissionsJobId).toBeNull();
  });

  it("makes the folder group-writable when a group was chosen", async () => {
    const { run, nas } = await postNfs({ ...machines, group: 1001 });
    await run;
    const perm = nas.calls.find((c) => c.method === "filesystem.setperm");
    expect(perm).toBeDefined();
    expect((perm!.params[0] as { gid: number; mode: string }).gid).toBe(1001);
    expect((perm!.params[0] as { gid: number; mode: string }).mode).toBe("775");
  });

  it("leaves a read-only export's permissions alone", async () => {
    const { run, nas } = await postNfs({ ...machines, readOnly: true, group: 1001 });
    await run;
    expect(nas.calls.map((c) => c.method)).not.toContain("filesystem.setperm");
  });

  it("sends no maproot to the NAS unless it was asked for", async () => {
    const { run, nas } = await postNfs(machines);
    await run;
    const created = nas.calls[0].params[0] as Record<string, unknown>;
    expect(created.maproot_user).toBeUndefined();
    expect(created.ro).toBe(false);
    expect(created.enabled).toBe(true);
  });
});

describe("removing an export", () => {
  function fakeDelete(body: Record<string, unknown>, existing: Array<{ path: string }> = [{ path: "/mnt/tank/media" }]) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const nas = {
      calls,
      call: async (method: string, params: unknown[] = []) => {
        calls.push({ method, params });
        return method === "sharing.nfs.query" ? existing : { ok: true };
      },
      startJob: async () => 1,
    };
    const res = fakeRes();
    return {
      run: handleShareRoutes({
        path: "/api/shares/nfs/7",
        method: "DELETE",
        url: new URL("http://nas.local/api/shares/nfs/7"),
        req: Readable.from([Buffer.from(JSON.stringify(body))]) as never,
        res: res as never,
        nas: nas as never,
      }),
      nas,
      res,
    };
  }

  it("deletes when the path is typed back correctly", async () => {
    const { run, nas } = fakeDelete({ confirm: "/mnt/tank/media" });
    await expect(run).resolves.toBe(true);
    expect(nas.calls.map((c) => c.method)).toContain("sharing.nfs.delete");
  });

  it("refuses when the confirmation does not match, and deletes nothing", async () => {
    const { run, nas } = fakeDelete({ confirm: "/mnt/tank/other" });
    await expect(run).rejects.toThrow();
    expect(nas.calls.map((c) => c.method)).not.toContain("sharing.nfs.delete");
  });

  it("refuses with no confirmation at all", async () => {
    const { run, nas } = fakeDelete({});
    await expect(run).rejects.toThrow();
    expect(nas.calls.map((c) => c.method)).not.toContain("sharing.nfs.delete");
  });

  it("says so when the export is already gone rather than deleting by id blindly", async () => {
    const { run, nas } = fakeDelete({ confirm: "/mnt/tank/media" }, []);
    await expect(run).rejects.toThrow(/no such export/i);
    expect(nas.calls.map((c) => c.method)).not.toContain("sharing.nfs.delete");
  });
});
