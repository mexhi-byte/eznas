import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setPathsForTests, log, tail, type Entry } from "../server/audit.js";

/**
 * The audit log is the thing that answers "who deleted the pool, and when".
 * These tests pin that answerability: entries are appended in order, read back
 * newest first, and the file is rotated — not grown — once it crosses the cap
 * so a hostile write cannot push the beginning of the story out of reach.
 */

let dir = "";
let file = "";

const sampleAt = (ts: number, over: Partial<Entry> = {}): Entry => ({
  ts,
  accountId: "a1",
  username: "admin",
  method: "POST",
  path: "/api/storage/pools",
  status: 200,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eznas-audit-"));
  file = join(dir, "audit.jsonl");
  _setPathsForTests(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("audit.log", () => {
  it("writes one JSON object per line, in append order", () => {
    log(sampleAt(1000));
    log(sampleAt(2000, { method: "DELETE", status: 403 }));
    const text = readFileSync(file, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ ts: 1000, status: 200 });
    expect(JSON.parse(lines[1])).toMatchObject({ ts: 2000, status: 403 });
  });

  it("creates the containing directory if it does not exist", () => {
    const nested = join(dir, "sub", "sub2", "audit.jsonl");
    _setPathsForTests(nested);
    log(sampleAt(1));
    expect(readFileSync(nested, "utf8")).toContain('"ts":1');
  });

  it("sets a 0600 file mode so the log is not world-readable", () => {
    log(sampleAt(1));
    // Only the owner bits matter here. Umask on the host may already restrict,
    // and we want to prove that the writer does not loosen it either.
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("audit.tail", () => {
  it("returns the newest entries first", () => {
    log(sampleAt(1));
    log(sampleAt(2));
    log(sampleAt(3));
    const t = tail(10);
    expect(t.map((e) => e.ts)).toEqual([3, 2, 1]);
  });

  it("caps the number of entries returned", () => {
    for (let i = 0; i < 10; i += 1) log(sampleAt(i + 1));
    const t = tail(3);
    expect(t.map((e) => e.ts)).toEqual([10, 9, 8]);
  });

  it("skips a partially written line without throwing", () => {
    log(sampleAt(1));
    log(sampleAt(2));
    // A crash can leave an incomplete trailing line. The tail should recover.
    writeFileSync(file, readFileSync(file, "utf8") + '{"ts":3,"method":"POST","path":"/api/x"', { mode: 0o600 });
    const t = tail(10);
    expect(t.map((e) => e.ts)).toEqual([2, 1]);
  });

  it("returns an empty array when nothing has been written", () => {
    expect(tail(10)).toEqual([]);
  });

  it("reads the rotated file to fill the request when the current one is short", () => {
    // Hand-rolled rotation to decouple this test from the size trigger: write
    // older entries into .1, newer ones into the current file.
    writeFileSync(`${file}.1`, [sampleAt(1), sampleAt(2)].map((e) => JSON.stringify(e)).join("\n") + "\n");
    log(sampleAt(3));
    log(sampleAt(4));
    const t = tail(10);
    expect(t.map((e) => e.ts)).toEqual([4, 3, 2, 1]);
  });
});

describe("audit rotation", () => {
  it("renames the current file to .1 once it exceeds the five-megabyte cap", () => {
    // Write a 5 MB blob of plausible-looking lines in one go to cross the
    // threshold with one triggering call afterwards.
    const line = JSON.stringify(sampleAt(1, { path: "/api/" + "x".repeat(200) })) + "\n";
    const needed = 5 * 1024 * 1024 + 100;
    const blob = line.repeat(Math.ceil(needed / line.length));
    writeFileSync(file, blob, { mode: 0o600 });

    log(sampleAt(999_999));

    // The current file is now short (one line), and the rotated file holds
    // the big blob.
    const current = readFileSync(file, "utf8");
    expect(current.split("\n").filter(Boolean)).toHaveLength(1);
    const rotated = readFileSync(`${file}.1`, "utf8");
    expect(rotated.length).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("does not rotate a file under the cap", () => {
    log(sampleAt(1));
    log(sampleAt(2));
    expect(() => statSync(`${file}.1`)).toThrow();
  });
});
