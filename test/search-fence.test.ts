import { describe, expect, it } from "vitest";
import { base64Command, decodeFindOutput } from "../server/search.js";

/**
 * The payload has to be findable inside the terminal's own noise.
 *
 * What comes back from the NAS shell is not just the command's output: it is
 * the login banner, the prompt, escape codes, and somewhere in the middle the
 * base64. Buffer.from(…, "base64") does not reject the rest — it skips
 * characters outside the alphabet and decodes whatever is left — so a banner
 * with no payload at all decoded into binary that happened to contain a NUL,
 * satisfied the "looks like find output" test, and was served to the browser
 * as a list of unreadable paths.
 */

const b64 = (raw: string) => Buffer.from(raw, "utf8").toString("base64");
const fenced = (payload: string) => `__B64_BEGIN__${payload}__B64_END__`;

const BANNER =
  "Linux truenas 6.12.15-production+truenas #1 SMP PREEMPT_DYNAMIC\n" +
  "\tTrueNAS (c) 2009-2025, iXsystems, Inc.\n" +
  "Welcome to TrueNAS\nLast login: Mon Aug 25 09:12:04 PDT 2026 on pts/4\n" +
  "truenas_admin@truenas[~]$ ";

describe("base64Command", () => {
  it("fences the payload so the caller can find it", () => {
    const cmd = base64Command("find / -print0");
    expect(cmd).toContain("find / -print0");
    expect(cmd).toContain("base64");
    // Split across two printfs, so the shell echoing the command line back
    // cannot itself produce a matching pair of sentinels.
    expect(cmd).not.toContain("__B64_BEGIN__");
    expect(cmd).toContain("'__B64'");
  });
});

describe("decodeFindOutput", () => {
  it("reads only what sits between the sentinels", () => {
    const raw = "/mnt/tank/a.txt\0/mnt/tank/b.txt\0";
    expect(decodeFindOutput(BANNER + fenced(b64(raw)))).toEqual([
      "/mnt/tank/a.txt",
      "/mnt/tank/b.txt",
    ]);
  });

  it("returns nothing for a banner with an empty payload", () => {
    // The regression: this used to decode the banner itself into binary and
    // report it as paths.
    expect(decodeFindOutput(BANNER + fenced(""))).toEqual([]);
  });

  it("returns nothing when the search ran but matched nothing", () => {
    expect(decodeFindOutput(fenced(""))).toEqual([]);
  });

  it("ignores the prompt being redrawn after the payload", () => {
    const raw = "/mnt/tank/report.pdf\0";
    expect(decodeFindOutput(`${fenced(b64(raw))}\ntruenas_admin@truenas[~]$ `)).toEqual([
      "/mnt/tank/report.pdf",
    ]);
  });

  it("keeps a filename containing a newline as one path", () => {
    const raw = "/mnt/tank/two\nlines.txt\0/mnt/tank/b.txt\0";
    expect(decodeFindOutput(fenced(b64(raw)))).toEqual([
      "/mnt/tank/two\nlines.txt",
      "/mnt/tank/b.txt",
    ]);
  });

  it("tolerates the terminal wrapping the payload across lines", () => {
    const payload = b64("/mnt/tank/a.txt\0");
    const wrapped = `${payload.slice(0, 6)}\n${payload.slice(6)}`;
    expect(decodeFindOutput(fenced(wrapped))).toEqual(["/mnt/tank/a.txt"]);
  });
});
