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

describe("URLs from the catalog", () => {
  /*
   * These fields are written by whoever published the chart, not by TrueNAS.
   * A javascript: href runs in the console's own origin the moment somebody
   * clicks it, and target/rel do nothing to prevent that — so the scheme is
   * checked here, at the boundary, rather than trusted downstream.
   */
  it("drops a javascript: home page", () =>
    expect(appDetail({ ...full, home: "javascript:alert(document.cookie)" }).home).toBeNull());

  it("drops a javascript: home page whatever its casing", () =>
    expect(appDetail({ ...full, home: "JaVaScRiPt:alert(1)" }).home).toBeNull());

  it("drops one hiding behind leading whitespace", () =>
    expect(appDetail({ ...full, home: "  javascript:alert(1)" }).home).toBeNull());

  it("drops a data: URI", () =>
    expect(appDetail({ ...full, home: "data:text/html,<script>alert(1)</script>" }).home).toBeNull());

  it("drops a vbscript: URI", () =>
    expect(appDetail({ ...full, home: "vbscript:msgbox(1)" }).home).toBeNull());

  it("keeps an ordinary https link", () =>
    expect(appDetail({ ...full, home: "https://nextcloud.com" }).home).toBe("https://nextcloud.com"));

  it("keeps http, which a self-hosted project may well be on", () =>
    expect(appDetail({ ...full, home: "http://example.local" }).home).toBe("http://example.local"));

  it("filters sources rather than passing the bad one through", () =>
    expect(appDetail({ ...full, sources: ["https://ok.example", "javascript:alert(1)"] }).sources)
      .toEqual(["https://ok.example"]));

  it("filters screenshots the same way", () =>
    expect(appDetail({ ...full, screenshots: ["javascript:alert(1)", "https://ok.example/1.png"] }).screenshots)
      .toEqual(["https://ok.example/1.png"]));

  it("keeps a maintainer whose url is unsafe, but without the link", () => {
    // The name is still worth showing; only the href is dangerous.
    const m = appDetail({ ...full, maintainers: [{ name: "someone", url: "javascript:alert(1)" }] }).maintainers;
    expect(m).toEqual([{ name: "someone", url: null }]);
  });

  it("rejects a scheme-relative url, whose scheme is whatever the page is", () =>
    expect(appDetail({ ...full, home: "//evil.example" }).home).toBeNull());
});
