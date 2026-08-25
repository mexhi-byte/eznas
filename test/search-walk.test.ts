import { describe, expect, it } from "vitest";
import {
  base64Command, decodeFindOutput, findCommand, hitFor, matches, parseFindOutput, walkFor,
  type Hit, type Limits,
} from "../server/search.js";

const LIMITS: Limits = { maxResults: 500, maxMs: 60_000 };

/** A fake filesystem: directory path -> its entries. */
function fakeListdir(tree: Record<string, Array<[string, "DIRECTORY" | "FILE"]>>) {
  return async (dir: string) =>
    (tree[dir] ?? []).map(([name, type]) => ({ name, path: `${dir}/${name}`, type }));
}

async function collect(gen: AsyncGenerator<Hit>): Promise<string[]> {
  const out: string[] = [];
  for await (const hit of gen) out.push(hit.path);
  return out;
}

describe("matches", () => {
  it("ignores case", () => expect(matches("Holiday.JPG", "holiday")).toBe(true));
  it("matches a substring anywhere in the name", () => expect(matches("my-holiday.jpg", "lida")).toBe(true));
  it("rejects a name that does not contain the query", () => expect(matches("cat.jpg", "dog")).toBe(false));
});

describe("hitFor", () => {
  it("splits a path into its name and its folder", () => {
    expect(hitFor("/mnt/tank/docs/tax.pdf"))
      .toEqual({ path: "/mnt/tank/docs/tax.pdf", name: "tax.pdf", dir: "/mnt/tank/docs" });
  });
});

describe("parseFindOutput", () => {
  it("splits on NUL, because a filename may contain a newline", () => {
    expect(parseFindOutput("/mnt/a\0/mnt/b\0")).toEqual(["/mnt/a", "/mnt/b"]);
  });
  it("keeps a path containing a newline intact", () => {
    expect(parseFindOutput("/mnt/two\nline.txt\0")).toEqual(["/mnt/two\nline.txt"]);
  });
  it("drops the trailing empty segment", () => {
    expect(parseFindOutput("/mnt/a\0")).toHaveLength(1);
  });
  it("returns nothing for empty output", () => {
    expect(parseFindOutput("")).toEqual([]);
  });
});

describe("findCommand", () => {
  it("quotes the root and the pattern", () => {
    expect(findCommand("/mnt/tank", "holiday"))
      .toBe("find '/mnt/tank' -iname '*holiday*' -print0 2>/dev/null");
  });

  it("neutralises a query that tries to end the command", () => {
    // The dangerous text is still present — it has to be, it is what was
    // searched for. What matters is that every quote in it became '\'' , so
    // the shell sees one contiguous argument to -iname and never a second
    // command. Asserting the exact string is the only way to say that.
    expect(findCommand("/mnt/tank", "'; rm -rf / #"))
      .toBe("find '/mnt/tank' -iname '*'\\''; rm -rf / #*' -print0 2>/dev/null");
  });

  it("escapes glob metacharacters so they match literally", () => {
    // Someone searching for "report[final]" means that name, not a character
    // class — find's -iname would otherwise read the brackets as a pattern.
    expect(findCommand("/mnt/tank", "report[final]")).toContain("report\\[final\\]");
  });

  it("refuses a root containing a newline", () => {
    expect(() => findCommand("/mnt/a\nb", "x")).toThrow();
  });
});

describe("walkFor", () => {
  it("finds a match in a subdirectory", async () => {
    const listdir = fakeListdir({
      "/mnt/tank": [["photos", "DIRECTORY"], ["notes.txt", "FILE"]],
      "/mnt/tank/photos": [["holiday.jpg", "FILE"], ["cat.png", "FILE"]],
    });
    expect(await collect(walkFor(listdir, "/mnt/tank", "holiday", LIMITS)))
      .toEqual(["/mnt/tank/photos/holiday.jpg"]);
  });

  it("stops at maxResults", async () => {
    const listdir = fakeListdir({
      "/mnt/tank": Array.from({ length: 50 }, (_, i) => [`a${i}.txt`, "FILE"] as [string, "FILE"]),
    });
    expect(await collect(walkFor(listdir, "/mnt/tank", "a", { maxResults: 10, maxMs: 60_000 })))
      .toHaveLength(10);
  });

  it("stops when the time budget runs out", async () => {
    const listdir = fakeListdir({
      "/mnt/tank": [["a.txt", "FILE"], ["b.txt", "FILE"], ["c.txt", "FILE"]],
    });
    // A clock that jumps a minute every reading: the first hit is yielded and
    // the budget is spent before the second.
    let t = 0;
    const now = () => (t += 60_000);
    expect((await collect(walkFor(listdir, "/mnt/tank", "txt", { maxResults: 500, maxMs: 1000 }, now))).length)
      .toBeLessThan(3);
  });

  it("does not follow a directory that loops back on itself", async () => {
    // A bind mount or a symlink can make /mnt/tank/self resolve to /mnt/tank.
    // Without visited-tracking this recurses until the stack gives out.
    const listdir = fakeListdir({
      "/mnt/tank": [["self", "DIRECTORY"], ["found.txt", "FILE"]],
      "/mnt/tank/self": [["self", "DIRECTORY"], ["found.txt", "FILE"]],
      "/mnt/tank/self/self": [["self", "DIRECTORY"]],
    });
    const hits = await collect(walkFor(listdir, "/mnt/tank", "found", { maxResults: 500, maxMs: 5000 }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(500);
  });

  it("keeps going when one directory cannot be read", async () => {
    const listdir = async (dir: string) => {
      if (dir === "/mnt/tank/private") throw new Error("permission denied");
      if (dir === "/mnt/tank") {
        return [
          { name: "private", path: "/mnt/tank/private", type: "DIRECTORY" },
          { name: "open", path: "/mnt/tank/open", type: "DIRECTORY" },
        ];
      }
      if (dir === "/mnt/tank/open") {
        return [{ name: "found.txt", path: "/mnt/tank/open/found.txt", type: "FILE" }];
      }
      return [];
    };
    // One unreadable folder is the normal state of a NAS with per-user folders
    // on it, not a reason to abandon the search.
    expect(await collect(walkFor(listdir, "/mnt/tank", "found", LIMITS)))
      .toEqual(["/mnt/tank/open/found.txt"]);
  });

  it("reports the containing folder alongside each hit", async () => {
    const listdir = fakeListdir({
      "/mnt/tank": [["docs", "DIRECTORY"]],
      "/mnt/tank/docs": [["tax.pdf", "FILE"]],
    });
    const out: Hit[] = [];
    for await (const hit of walkFor(listdir, "/mnt/tank", "tax", LIMITS)) out.push(hit);
    expect(out).toEqual([{ path: "/mnt/tank/docs/tax.pdf", name: "tax.pdf", dir: "/mnt/tank/docs" }]);
  });

  it("searches breadth-first, so a shallow hit arrives before a deep one", async () => {
    // The file someone half-remembers is usually near the top. Depth-first
    // would exhaust one deep branch before looking at the sibling next to it.
    const listdir = fakeListdir({
      "/mnt/tank": [["deep", "DIRECTORY"], ["shallow-match.txt", "FILE"]],
      "/mnt/tank/deep": [["deeper", "DIRECTORY"]],
      "/mnt/tank/deep/deeper": [["deep-match.txt", "FILE"]],
    });
    expect(await collect(walkFor(listdir, "/mnt/tank", "match", LIMITS)))
      .toEqual(["/mnt/tank/shallow-match.txt", "/mnt/tank/deep/deeper/deep-match.txt"]);
  });

  it("does not match a directory whose name contains the query", async () => {
    // Directories are traversed, not returned: a folder called "holiday" is
    // not what someone searching for a file is asking for.
    const listdir = fakeListdir({
      "/mnt/tank": [["holiday", "DIRECTORY"]],
      "/mnt/tank/holiday": [],
    });
    expect(await collect(walkFor(listdir, "/mnt/tank", "holiday", LIMITS))).toEqual([]);
  });
});

describe("base64Command", () => {
  it("wraps the command so its output crosses the terminal as plain ASCII", () => {
    // The shell WebSocket is a pseudo-terminal, not a pipe. It rewrites
    // anything that looks like a control code, and find -print0 is all NULs.
    const wrapped = base64Command("find / -print0");
    expect(wrapped).toContain("find / -print0");
    expect(wrapped).toContain("base64");
    // No wrapping newlines: the marker that says the command finished has to
    // be the only newline the reader sees after the payload.
    expect(wrapped).toContain("tr -d");
  });

  it("groups the inner command so the pipe applies to all of it", () => {
    // Without braces, "a; b | base64" pipes only b.
    expect(base64Command("a; b")).toMatch(/\{\s*a; b;?\s*\}/);
  });
});

describe("decodeFindOutput", () => {
  it("decodes and splits what the NAS sent", () => {
    const raw = "/mnt/a.txt\0/mnt/b.txt\0";
    expect(decodeFindOutput(Buffer.from(raw, "utf8").toString("base64")))
      .toEqual(["/mnt/a.txt", "/mnt/b.txt"]);
  });

  it("survives whitespace the terminal may have inserted", () => {
    const b64 = Buffer.from("/mnt/a.txt\0", "utf8").toString("base64");
    expect(decodeFindOutput(` ${b64.slice(0, 4)}\n ${b64.slice(4)} `)).toEqual(["/mnt/a.txt"]);
  });

  it("returns nothing for an empty result", () => {
    expect(decodeFindOutput("")).toEqual([]);
  });

  it("keeps a UTF-8 filename intact", () => {
    const raw = "/mnt/caf\u00e9.txt\0";
    expect(decodeFindOutput(Buffer.from(raw, "utf8").toString("base64")))
      .toEqual(["/mnt/café.txt"]);
  });

  it("keeps a filename containing a newline intact", () => {
    const raw = "/mnt/two\nline.txt\0";
    expect(decodeFindOutput(Buffer.from(raw, "utf8").toString("base64")))
      .toEqual(["/mnt/two\nline.txt"]);
  });

  it("returns nothing rather than throwing on output that is not base64", () => {
    // A shell that printed an error where the payload should be must produce
    // an empty search, not a crash — the caller falls back to the walk.
    expect(decodeFindOutput("bash: find: command not found")).toEqual([]);
  });
});
