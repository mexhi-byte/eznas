import { describe, expect, it } from "vitest";
import { appTitle, isCustomApp } from "../server/apps.js";

describe("appTitle", () => {
  it("keeps a real catalog title", () => {
    expect(appTitle("wg-easy", "WG Easy")).toBe("WG Easy");
  });

  it("uses the operator's own name when TrueNAS says Custom App", () => {
    // The bug. Fifteen custom apps all reported metadata.title "Custom App",
    // so `metadata.title ?? name` never reached the name and every tile read
    // the same thing.
    expect(appTitle("nextcloud", "Custom App")).toBe("Nextcloud");
    expect(appTitle("jellyfin", "Custom App")).toBe("Jellyfin");
  });

  it("gives two custom apps two different names", () => {
    expect(appTitle("sonarr", "Custom App")).not.toBe(appTitle("radarr", "Custom App"));
  });

  it("ignores case and padding in the generic title", () => {
    expect(appTitle("paperless", " custom app ")).toBe("Paperless");
    expect(appTitle("paperless", "CUSTOM APP")).toBe("Paperless");
  });

  it("falls back to the name when there is no title at all", () => {
    expect(appTitle("immich", undefined)).toBe("Immich");
    expect(appTitle("immich", null)).toBe("Immich");
    expect(appTitle("immich", "")).toBe("Immich");
    expect(appTitle("immich", "   ")).toBe("Immich");
  });

  it("turns separators into spaces and capitalises", () => {
    expect(appTitle("wg-easy", "Custom App")).toBe("Wg Easy");
    expect(appTitle("home_assistant", "Custom App")).toBe("Home Assistant");
    expect(appTitle("audio.bookshelf", "Custom App")).toBe("Audio Bookshelf");
  });

  it("does not touch a real title that merely contains the word custom", () => {
    // "Custom Radarr" is somebody's app, not a category. A regex over /custom/
    // would have thrown its name away.
    expect(appTitle("radarr", "Custom Radarr")).toBe("Custom Radarr");
  });

  it("leaves a name it cannot split alone", () => {
    expect(appTitle("---", "Custom App")).toBe("---");
  });
});

describe("isCustomApp", () => {
  it("recognises the generic title", () => expect(isCustomApp("Custom App")).toBe(true));
  it("does not claim a catalog app", () => expect(isCustomApp("WG Easy")).toBe(false));
  it("treats a missing title as not custom", () => expect(isCustomApp(undefined)).toBe(false));
});
