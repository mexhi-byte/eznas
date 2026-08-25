import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eznas-test-"));
process.env.ACCOUNTS_FILE = join(dir, "accounts.json");
process.env.DATA_FILE = join(dir, "connections.json");
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.UI_PASSWORD = "adminadminadmin";

// Imported after the environment is set: these modules read their file paths at
// module scope, so an earlier import would bind the production ones.
const accounts = await import("../server/accounts.js");
const { issue } = await import("../server/auth.js");
const { handleUpgrade } = await import("../server/shell.js");

class FakeSocket extends EventEmitter {
  written = "";
  destroyed = false;
  write(s: string): boolean { this.written += s; return true; }
  destroy(): void { this.destroyed = true; }
}

/** The status line handleUpgrade wrote, e.g. "HTTP/1.1 403 Forbidden". */
function upgradeAs(cookie: string | undefined): string {
  const socket = new FakeSocket();
  const req = {
    // A server id that does not exist, so an admin stops at 400 the moment
    // after clearing the role gate. That is what makes "authorised" and
    // "refused" tell each other apart without a live NAS to connect to.
    url: "/shell?c=does-not-exist",
    headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
  };
  handleUpgrade(req as never, socket as never, Buffer.alloc(0));
  return socket.written.split("\r\n")[0] ?? "";
}

const cookieFor = (id: string) => `tnui_session=${issue(id)}`;

describe("the shell WebSocket upgrade", () => {
  let adminId = "";
  let viewerId = "";

  beforeAll(() => {
    accounts.init();
    adminId = accounts.byName("admin")!.id;
    viewerId = accounts.create({
      username: "peeker", password: "hunter2hunter2", role: "viewer",
    }).id;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a request carrying no session", () => {
    expect(upgradeAs(undefined)).toContain("401");
  });

  it("refuses a viewer, who must not reach a root shell", () => {
    expect(upgradeAs(cookieFor(viewerId))).toContain("403");
  });

  it("lets an admin through the role gate", () => {
    // 400, not 200: it passed the gate and then failed on the unknown server
    // id. Anything else here means the gate is no longer being reached.
    expect(upgradeAs(cookieFor(adminId))).toContain("400");
  });
});
