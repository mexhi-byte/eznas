import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eznas-session-"));
process.env.DATA_FILE = join(dir, "connections.json");
delete process.env.SESSION_SECRET;

// Imported after the environment is set: the store reads its path at module scope.
const { issue, read } = await import("../server/auth.js");

describe("session signing without SESSION_SECRET", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /*
   * The property: a token is signed with the secret kept beside the data
   * file, not one made up per process. A second process reading that file
   * — the same install after a restart — will verify it. Checked by
   * recomputing the signature from the file's contents.
   */
  it("signs with the secret kept beside the data file", () => {
    const token = issue("someone");
    const kept = readFileSync(`${process.env.DATA_FILE}.key`, "utf8").trim();
    const [body, mac] = token.split(".");
    const expected = createHmac("sha256", kept).update(body).digest("base64url");
    expect(mac).toBe(expected);
    expect(read(token)?.accountId).toBe("someone");
  });
});
