import { describe, expect, it } from "vitest";
import { isHost, isNetwork, nfsPayload } from "../server/nfs.js";

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
