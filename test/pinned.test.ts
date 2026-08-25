import { describe, expect, it } from "vitest";
import { fingerprintMatches, httpBase } from "../server/pinned.js";
import type { Connection } from "../server/store.js";

const conn = (url: string) => ({ url } as Connection);

describe("fingerprintMatches", () => {
  const want = "AB:CD:EF:01";

  it("matches ignoring colons", () => expect(fingerprintMatches("ABCDEF01", want)).toBe(true));
  it("matches ignoring case", () => expect(fingerprintMatches("ab:cd:ef:01", want)).toBe(true));
  it("matches an identical string", () => expect(fingerprintMatches(want, want)).toBe(true));
  it("rejects a different fingerprint", () => expect(fingerprintMatches("00:00:00:00", want)).toBe(false));

  it("rejects an empty reading rather than treating it as a match", () => {
    // A reused keep-alive socket cannot produce the peer certificate, and an
    // empty string comparing equal to an empty pin would turn that into a
    // silent pass.
    expect(fingerprintMatches("", want)).toBe(false);
    expect(fingerprintMatches(undefined, want)).toBe(false);
    expect(fingerprintMatches("", "")).toBe(false);
  });

  it("rejects a prefix of the pinned value", () => {
    expect(fingerprintMatches("ABCD", want)).toBe(false);
  });
});

describe("httpBase", () => {
  it("turns the websocket API url into an http origin", () => {
    expect(httpBase(conn("wss://nas.local/api/current")).toString()).toBe("https://nas.local/");
  });
  it("keeps a non-default port", () => {
    expect(httpBase(conn("wss://nas.local:8443/api/current")).port).toBe("8443");
  });
  it("maps ws to http", () => {
    expect(httpBase(conn("ws://nas.local/api/current")).protocol).toBe("http:");
  });
});
