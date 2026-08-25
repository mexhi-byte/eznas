import { describe, expect, it } from "vitest";
import { restoreTarget } from "../server/restore-target.js";

const bin = "/mnt/tank/.recycle";
const from = "/mnt/tank/.recycle/photos/holiday.jpg";

describe("restoreTarget", () => {
  it("puts an item back where it came from by default", () => {
    const t = restoreTarget({ from, bin });
    expect(t.dir).toBe("/mnt/tank/photos");
    expect(t.name).toBe("holiday.jpg");
    expect(t.path).toBe("/mnt/tank/photos/holiday.jpg");
  });

  // The bin appends .YYYYMMDD-HHMMSS to de-collide; the original name is the
  // one without it, and that is what the person expects back.
  it("strips the bin's timestamp suffix", () =>
    expect(restoreTarget({ from: `${from}.20260825-120000`, bin }).name).toBe("holiday.jpg"));

  it("restores an item from the bin's top level to the pool root", () =>
    expect(restoreTarget({ from: `${bin}/notes.txt`, bin }).path).toBe("/mnt/tank/notes.txt"));

  describe("renaming", () => {
    it("uses the name given, in the original folder", () =>
      expect(restoreTarget({ from, bin, name: "holiday-2026.jpg" }).path)
        .toBe("/mnt/tank/photos/holiday-2026.jpg"));

    it("refuses a name containing a slash, which would move it elsewhere", () =>
      expect(() => restoreTarget({ from, bin, name: "a/b.jpg" })).toThrow(/name/i));

    it("refuses a name that climbs out of the folder", () =>
      expect(() => restoreTarget({ from, bin, name: ".." })).toThrow());

    it("refuses a single dot", () => expect(() => restoreTarget({ from, bin, name: "." })).toThrow());

    it("refuses an empty name rather than restoring to the folder itself", () =>
      expect(() => restoreTarget({ from, bin, name: "   " })).toThrow());

    it("trims a name somebody pasted with spaces around it", () =>
      expect(restoreTarget({ from, bin, name: "  clean.jpg  " }).name).toBe("clean.jpg"));
  });

  describe("restoring somewhere else", () => {
    it("uses the folder given, keeping the name", () =>
      expect(restoreTarget({ from, bin, toDir: "/mnt/tank/sorted" }).path)
        .toBe("/mnt/tank/sorted/holiday.jpg"));

    it("takes a folder and a new name together", () =>
      expect(restoreTarget({ from, bin, toDir: "/mnt/tank/sorted", name: "x.jpg" }).path)
        .toBe("/mnt/tank/sorted/x.jpg"));

    it("drops a trailing slash rather than producing a doubled one", () =>
      expect(restoreTarget({ from, bin, toDir: "/mnt/tank/sorted/" }).path)
        .toBe("/mnt/tank/sorted/holiday.jpg"));

    it("refuses a destination outside /mnt", () =>
      expect(() => restoreTarget({ from, bin, toDir: "/etc" })).toThrow(/\/mnt/));

    it("refuses a relative destination", () =>
      expect(() => restoreTarget({ from, bin, toDir: "somewhere" })).toThrow());

    it("refuses one that climbs out with ..", () =>
      expect(() => restoreTarget({ from, bin, toDir: "/mnt/tank/../../etc" })).toThrow());

    // Restoring into a bin is not restoring. It would also be undeletable by
    // the normal route, since the bin's own contents are what this reads.
    it("refuses restoring back into a recycle bin", () =>
      expect(() => restoreTarget({ from, bin, toDir: "/mnt/tank/.recycle/x" })).toThrow(/bin/i));

    it("refuses another pool's bin too", () =>
      expect(() => restoreTarget({ from, bin, toDir: "/mnt/other/.recycle" })).toThrow(/bin/i));

    it("refuses /mnt itself, which is not a filesystem", () =>
      expect(() => restoreTarget({ from, bin, toDir: "/mnt" })).toThrow());
  });

  describe("what may be restored", () => {
    it("refuses an item that is not in the bin at all", () =>
      expect(() => restoreTarget({ from: "/mnt/tank/photos/a.jpg", bin })).toThrow(/bin/i));

    it("refuses the bin itself", () =>
      expect(() => restoreTarget({ from: bin, bin })).toThrow(/bin/i));
  });
});
