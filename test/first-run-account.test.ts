import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eznas-firstrun-"));
process.env.ACCOUNTS_FILE = join(dir, "accounts.json");
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
delete process.env.UI_PASSWORD;
delete process.env.UI_USERNAME;

// Imported after the environment is set: it reads its path at module scope.
const accounts = await import("../server/accounts.js");

describe("first run with no UI_PASSWORD", () => {
  it("creates an admin instead of leaving a console nobody can sign in to", () => {
    accounts.init();
    const all = accounts.all();
    expect(all).toHaveLength(1);
    expect(all[0].username).toBe("admin");
    expect(all[0].role).toBe("admin");
  });

  /*
   * The security property. There is no default password to publish, so the one
   * that exists is generated — and an account still holding it is marked, so
   * the server can refuse to let it do anything else.
   */
  it("marks the account as still holding a password nobody chose", () =>
    expect(accounts.all()[0].mustChangePassword).toBe(true));

  it("does not write the password anywhere, only its hash", () => {
    const raw = readFileSync(process.env.ACCOUNTS_FILE!, "utf8");
    expect(raw).toContain("scrypt$");
    // Whatever was generated, the file holds no field that could be one.
    const stored = JSON.parse(raw)[0] as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("password");
  });

  it("stops insisting once a password has been chosen", () => {
    const id = accounts.all()[0].id;
    accounts.update(id, { password: "a-properly-long-password" });
    expect(accounts.all()[0].mustChangePassword).toBeUndefined();
  });

  it("accepts the new password afterwards", () =>
    expect(accounts.authenticate("admin", "a-properly-long-password")).toBeTruthy());
});
