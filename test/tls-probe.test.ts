import { describe, expect, it } from "vitest";
import { hostPortOf, normaliseFingerprint, prettyFingerprint } from "../server/tls-probe.js";

describe("hostPortOf", () => {
  it("reads the NAS URL as the console stores it", () =>
    expect(hostPortOf("wss://192.168.1.10/api/current")).toEqual({ host: "192.168.1.10", port: 443 }));

  it("honours an explicit port", () =>
    expect(hostPortOf("wss://nas.local:8443/api/current")).toEqual({ host: "nas.local", port: 8443 }));

  it("defaults to 80 only for a plain connection", () =>
    expect(hostPortOf("ws://nas.local/api/current").port).toBe(80));
});

describe("fingerprints", () => {
  /*
   * Node reports "AB:CD:…", TrueNAS's own UI shows the same, an operator may
   * paste either or type lower-case without colons. They all have to compare
   * equal, so there is one stored shape.
   */
  it("normalise to lower-case hex without separators", () => {
    expect(normaliseFingerprint("AB:CD:EF:01")).toBe("abcdef01");
    expect(normaliseFingerprint("abcdef01")).toBe("abcdef01");
    expect(normaliseFingerprint(" ab cd ef 01 ")).toBe("abcdef01");
  });

  it("pretty-print as colon-separated pairs for reading off a screen", () =>
    expect(prettyFingerprint("abcdef01")).toBe("AB:CD:EF:01"));
});
