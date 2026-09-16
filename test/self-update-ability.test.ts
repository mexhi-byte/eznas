import { describe, expect, it } from "vitest";
import { selfUpdateAbility } from "../server/self-update.js";

describe("selfUpdateAbility", () => {
  /*
   * A container cannot replace its own image from the inside, so the button
   * must be off however the image was made — even if somebody baked a .git
   * directory into it.
   */
  it("never offers in-place update inside a container", () => {
    expect(selfUpdateAbility("container", true).canSelfUpdate).toBe(false);
    expect(selfUpdateAbility("container", false).canSelfUpdate).toBe(false);
  });

  it("tells a container where its updates come from", () => {
    const { reason } = selfUpdateAbility("container", false);
    expect(reason).toMatch(/Apps/);
    expect(reason).toMatch(/install\.sh/);
  });

  it("offers in-place update to a git checkout", () =>
    expect(selfUpdateAbility("source", true)).toEqual({ canSelfUpdate: true, reason: null }));

  it("tells a tarball install how to update by hand", () => {
    const a = selfUpdateAbility("source", false);
    expect(a.canSelfUpdate).toBe(false);
    expect(a.reason).toMatch(/tarball/);
  });
});
