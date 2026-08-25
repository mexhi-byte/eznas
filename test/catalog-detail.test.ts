import { describe, expect, it } from "vitest";
import { appDetail } from "../server/catalog-detail.js";

const full = {
  name: "nextcloud", title: "Nextcloud", train: "stable",
  description: "A personal cloud.", icon_url: "https://media/nc.png",
  categories: ["cloud", "productivity"],
  home: "https://nextcloud.com",
  sources: ["https://github.com/nextcloud"],
  screenshots: ["https://media/1.png", "https://media/2.png"],
  maintainers: [{ name: "truenas", email: "dev@truenas.com", url: "https://truenas.com" }],
  latest_version: "1.6.13", latest_human_version: "30.0.2_1.6.13",
  last_update: "2026-08-01 10:00:00",
  installed: true,
  versions: { "1.6.13": {}, "1.6.12": {} },
};

describe("appDetail", () => {
  it("carries the fields a person actually reads", () => {
    const d = appDetail(full);
    expect(d.title).toBe("Nextcloud");
    expect(d.description).toBe("A personal cloud.");
    expect(d.home).toBe("https://nextcloud.com");
    expect(d.categories).toEqual(["cloud", "productivity"]);
    expect(d.installed).toBe(true);
  });

  it("prefers the human version, which is the one on the app's own site", () =>
    expect(appDetail(full).version).toBe("30.0.2_1.6.13"));

  it("falls back to the catalog version when there is no human one", () =>
    expect(appDetail({ ...full, latest_human_version: undefined }).version).toBe("1.6.13"));

  it("counts the versions available to roll back to", () =>
    expect(appDetail(full).versionCount).toBe(2));

  /*
   * The reason this is a mapper and not a passthrough: these rows come from a
   * catalog whose shape varies by TrueNAS version, and a missing field must
   * produce an empty dialog section rather than a crashed page.
   */
  it("survives a row with nothing but a name", () => {
    const d = appDetail({ name: "mystery" });
    expect(d.title).toBe("mystery");
    expect(d.categories).toEqual([]);
    expect(d.screenshots).toEqual([]);
    expect(d.maintainers).toEqual([]);
    expect(d.home).toBeNull();
    expect(d.versionCount).toBe(0);
  });

  it("survives versions arriving as a list instead of a map", () =>
    expect(appDetail({ ...full, versions: ["1.6.13", "1.6.12", "1.6.11"] }).versionCount).toBe(3));

  it("keeps a maintainer given as a bare string", () =>
    expect(appDetail({ ...full, maintainers: ["someone"] }).maintainers)
      .toEqual([{ name: "someone", url: null }]));

  it("drops a maintainer with no name rather than rendering a blank row", () =>
    expect(appDetail({ ...full, maintainers: [{ email: "x@y.z" }] }).maintainers).toEqual([]));

  it("ignores non-string entries in lists that should hold strings", () =>
    expect(appDetail({ ...full, screenshots: ["https://a.png", 42, null] }).screenshots)
      .toEqual(["https://a.png"]));

  it("treats an absent title as the name, never as blank", () =>
    expect(appDetail({ ...full, title: "" }).title).toBe("nextcloud"));
});
