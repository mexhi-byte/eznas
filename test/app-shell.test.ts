import { describe, expect, it } from "vitest";
import { commandFor, isAppName, isConsoleMode, isContainerId } from "../server/app-shell.js";

const ID = "3f9a1c2b4d5e6f7a8b9c";

describe("isContainerId", () => {
  it("accepts a short or full docker id", () => {
    expect(isContainerId("3f9a1c2b4d5e")).toBe(true);
    expect(isContainerId("a".repeat(64))).toBe(true);
  });

  /*
   * The property the whole feature rests on. Anything that could end the
   * command and start another is not an id, however it is dressed.
   */
  it("refuses everything that is not hex", () => {
    for (const bad of [
      "3f9a1c2b4d5e; rm -rf /",
      "3f9a1c2b4d5e && cat /etc/shadow",
      "3f9a1c2b4d5e\nwhoami",
      "3f9a1c2b4d5e'",
      "$(id)",
      "`id`",
      "3F9A1C2B4D5E",
      "",
      "abc",
      "a".repeat(65),
    ]) {
      expect(isContainerId(bad), bad).toBe(false);
    }
  });
});

describe("commandFor", () => {
  it("follows the logs with timestamps", () => {
    expect(commandFor("logs", ID)).toBe(`docker logs --tail 200 --timestamps --follow '${ID}'`);
  });

  it("opens bash when the image has it and sh when it does not", () => {
    const c = commandFor("exec", ID);
    expect(c).toContain(`docker exec -it '${ID}'`);
    expect(c).toContain("exec bash || exec sh");
  });

  it("refuses to build a command around a bad id, even when asked nicely", () => {
    expect(() => commandFor("logs", "3f9a1c2b4d5e; reboot")).toThrow(/container id/);
    expect(() => commandFor("exec", "")).toThrow(/container id/);
  });
});

describe("isConsoleMode and isAppName", () => {
  it("knows the two modes and nothing else", () => {
    expect(isConsoleMode("logs")).toBe(true);
    expect(isConsoleMode("exec")).toBe(true);
    expect(isConsoleMode("shell")).toBe(false);
    expect(isConsoleMode(null)).toBe(false);
  });

  it("accepts the names TrueNAS gives apps and refuses anything shell-shaped", () => {
    expect(isAppName("nextcloud")).toBe(true);
    expect(isAppName("plex-2")).toBe(true);
    expect(isAppName("Next Cloud")).toBe(false);
    expect(isAppName("a;b")).toBe(false);
  });
});
