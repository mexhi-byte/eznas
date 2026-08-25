import { describe, expect, it } from "vitest";
import { isNewer } from "../server/self-update.js";

describe("isNewer", () => {
  it("sees a patch bump", () => expect(isNewer("0.4.1", "0.4.0")).toBe(true));
  it("sees a minor bump", () => expect(isNewer("0.5.0", "0.4.9")).toBe(true));
  it("sees a major bump", () => expect(isNewer("1.0.0", "0.9.9")).toBe(true));

  it("is false for the same version", () => expect(isNewer("0.4.0", "0.4.0")).toBe(false));
  it("is false for an older one", () => expect(isNewer("0.3.9", "0.4.0")).toBe(false));

  it("compares numerically, not as text", () => {
    // The one that matters. As strings "0.10.0" < "0.9.0", so a lexical
    // comparison stops announcing releases the moment the minor reaches 10.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("2.0.0", "10.0.0")).toBe(false);
  });

  it("ignores a leading v on either side", () => {
    expect(isNewer("v0.5.0", "0.4.0")).toBe(true);
    expect(isNewer("0.5.0", "v0.4.0")).toBe(true);
    expect(isNewer("V0.5.0", "v0.5.0")).toBe(false);
  });

  it("treats a missing segment as zero", () => {
    expect(isNewer("0.5", "0.4.9")).toBe(true);
    expect(isNewer("0.4", "0.4.0")).toBe(false);
    expect(isNewer("0.4.1", "0.4")).toBe(true);
  });

  it("does not report an equal version as newer, however it is written", () => {
    // Nothing here should produce a notification telling somebody to install
    // what they are already running.
    expect(isNewer("v0.4.0", "0.4.0")).toBe(false);
    expect(isNewer("0.4.0.0", "0.4.0")).toBe(false);
  });

  it("ranks a prerelease above its own release, which is why they are filtered", () => {
    // Documents real behaviour rather than endorsing it: "-beta" parses to 0,
    // and the trailing number then wins. check() only ever passes stable
    // releases in, and this test is here so that stays deliberate.
    expect(isNewer("0.5.0-beta.1", "0.5.0")).toBe(true);
  });
});
