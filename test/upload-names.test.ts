import { describe, expect, it } from "vitest";
import { clashingNames, nextFreeName } from "../web/upload-names.js";

describe("nextFreeName", () => {
  it("leaves a name alone when nothing is in the way", () =>
    expect(nextFreeName("a.txt", new Set())).toBe("a.txt"));

  // What every desktop does, so the result is not a surprise.
  it("adds (2) when the name is taken", () =>
    expect(nextFreeName("a.txt", new Set(["a.txt"]))).toBe("a (2).txt"));

  it("counts past the copies that already exist", () =>
    expect(nextFreeName("a.txt", new Set(["a.txt", "a (2).txt", "a (3).txt"]))).toBe("a (4).txt"));

  it("keeps a multi-part extension out of the stem", () =>
    // "archive.tar.gz" must not become "archive.tar (2).gz" — only the last
    // dot separates the extension a person thinks of.
    expect(nextFreeName("archive.tar.gz", new Set(["archive.tar.gz"]))).toBe("archive.tar (2).gz"));

  it("handles a name with no extension at all", () =>
    expect(nextFreeName("README", new Set(["README"]))).toBe("README (2)"));

  it("treats a dotfile as a name, not as an extension", () =>
    // ".bashrc" is not a file called "" of type "bashrc".
    expect(nextFreeName(".bashrc", new Set([".bashrc"]))).toBe(".bashrc (2)"));

  it("does not reuse a name it just handed out", () => {
    const taken = new Set(["a.txt"]);
    expect(nextFreeName("a.txt", taken)).toBe("a (2).txt");
    // The caller renames several files in one go; the second must not collide
    // with the first.
    expect(nextFreeName("a.txt", taken)).toBe("a (3).txt");
  });
});

describe("clashingNames", () => {
  const here = ["a.txt", "b.txt", "photos"];

  it("finds the names already present", () =>
    expect(clashingNames(["a.txt", "c.txt"], here)).toEqual(["a.txt"]));

  it("finds nothing when everything is new", () =>
    expect(clashingNames(["c.txt"], here)).toEqual([]));

  it("clashes with a folder of the same name, which would also fail", () =>
    expect(clashingNames(["photos"], here)).toEqual(["photos"]));

  it("finds nothing in an empty folder", () =>
    expect(clashingNames(["a.txt"], [])).toEqual([]));
});
