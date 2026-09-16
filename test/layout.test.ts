import { describe, expect, it } from "vitest";
import { recommendLayouts } from "../server/layout.js";

const TiB = 1024 ** 4;
const drives = (sizes: number[]) => sizes.map((s, i) => ({ name: `sd${i}`, size: s * TiB }));
const pick = (sizes: number[]) => recommendLayouts(drives(sizes)).find((o) => o.recommended)!;

describe("recommendLayouts", () => {
  it("offers nothing for no drives", () => expect(recommendLayouts([])).toEqual([]));

  it("says plainly that one drive protects nothing", () => {
    const only = recommendLayouts(drives([8]));
    expect(only).toHaveLength(1);
    expect(only[0].layout).toBe("STRIPE");
    expect(only[0].survives).toBe(0);
    expect(only[0].summary).toMatch(/loses everything/);
  });

  it("mirrors two or three drives", () => {
    expect(pick([8, 8]).layout).toBe("MIRROR");
    expect(pick([8, 8, 8]).layout).toBe("MIRROR");
    expect(pick([8, 8, 8]).survives).toBe(2);
  });

  it("picks RAIDZ2 from four drives up, and says why", () => {
    const p = pick([8, 8, 8, 8, 8]);
    expect(p.layout).toBe("RAIDZ2");
    expect(p.usable).toBe(3 * 8 * TiB);
    expect(p.survives).toBe(2);
    expect(p.note).toMatch(/rebuild/);
  });

  it("uses mixed sizes at the smallest and names the waste", () => {
    const p = pick([8, 8, 4, 8]);
    expect(p.usable).toBe(2 * 4 * TiB);
    expect(p.summary).toMatch(/12 TiB across them goes unused/);
  });

  it("lists every layout the count allows, exactly one recommended", () => {
    const all = recommendLayouts(drives([8, 8, 8, 8]));
    expect(all.map((o) => o.layout)).toEqual(["STRIPE", "MIRROR", "RAIDZ1", "RAIDZ2"]);
    expect(all.filter((o) => o.recommended)).toHaveLength(1);
  });
});
