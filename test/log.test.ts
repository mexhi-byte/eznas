import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as log from "../server/log.js";

/**
 * The log helper is the thing every other module reaches for, so two
 * properties matter: the human text matches what the shelf of `console.log`
 * calls was producing before this landed (so an operator reading stdout sees
 * no regression), and the JSON mode is one object per line (so a drain can
 * split on `\n` without a two-pass parser).
 */

let out: string[] = [];
let err: string[] = [];
const stdout = vi.spyOn(process.stdout, "write");
const stderr = vi.spyOn(process.stderr, "write");

beforeEach(() => {
  out = [];
  err = [];
  stdout.mockImplementation(((s: string | Uint8Array): boolean => {
    out.push(String(s));
    return true;
  }) as never);
  stderr.mockImplementation(((s: string | Uint8Array): boolean => {
    err.push(String(s));
    return true;
  }) as never);
  delete process.env.LOG_FORMAT;
});

afterEach(() => {
  stdout.mockReset();
  stderr.mockReset();
});

describe("log in text mode", () => {
  it("emits info to stdout in the [mod] msg shape", () => {
    log.info("truenas", "connected and subscribed");
    expect(out).toEqual(["[truenas] connected and subscribed\n"]);
    expect(err).toEqual([]);
  });

  it("emits warn and error to stderr", () => {
    log.warn("watch", "release check cold");
    log.error("api", "GET /x", "boom");
    expect(out).toEqual([]);
    expect(err).toEqual(["[watch] release check cold\n", "[api] GET /x: boom\n"]);
  });

  it("flattens an Error to its message in the colon tail", () => {
    const e = new Error("the gate shut");
    log.error("watch", "poll failed", e);
    expect(err).toEqual(["[watch] poll failed: the gate shut\n"]);
  });

  it("JSON-encodes a non-string, non-Error detail so the line is still parseable", () => {
    log.error("store", "bad shape", { kind: "x", count: 2 });
    expect(err).toEqual([`[store] bad shape: {"kind":"x","count":2}\n`]);
  });

  it("omits the tail entirely when no detail was supplied", () => {
    log.info("eznas", "listening on :8080");
    expect(out).toEqual(["[eznas] listening on :8080\n"]);
  });
});

describe("log in JSON mode", () => {
  beforeEach(() => {
    process.env.LOG_FORMAT = "json";
  });

  it("emits one object per line, info to stdout", () => {
    log.info("truenas", "connected and subscribed");
    expect(out).toHaveLength(1);
    expect(out[0].endsWith("\n")).toBe(true);
    const o = JSON.parse(out[0]);
    expect(o).toMatchObject({ level: "info", mod: "truenas", msg: "connected and subscribed" });
    expect(typeof o.ts).toBe("string");
    expect("detail" in o).toBe(false);
  });

  it("sends warn and error to stderr with the right level", () => {
    log.warn("watch", "cold");
    log.error("api", "oops");
    const w = JSON.parse(err[0]);
    const e = JSON.parse(err[1]);
    expect(w.level).toBe("warn");
    expect(e.level).toBe("error");
  });

  it("serialises an Error to {message, stack} instead of {}", () => {
    const thrown = new Error("the gate shut");
    log.error("watch", "poll failed", thrown);
    const o = JSON.parse(err[0]);
    expect(o.detail.message).toBe("the gate shut");
    expect(typeof o.detail.stack).toBe("string");
  });

  it("passes through a plain object as the detail", () => {
    log.info("store", "migrated", { count: 2 });
    const o = JSON.parse(out[0]);
    expect(o.detail).toEqual({ count: 2 });
  });

  it("emits ISO-8601 timestamps so a drain can parse them without a format hint", () => {
    log.info("eznas", "up");
    const o = JSON.parse(out[0]);
    expect(() => new Date(o.ts).toISOString()).not.toThrow();
    expect(o.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
