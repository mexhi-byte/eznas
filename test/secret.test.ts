import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_DEV_SECRET, keyFrom, resolveSecret } from "../server/secret.js";

const fresh = () => mkdtempSync(join(tmpdir(), "eznas-secret-"));

describe("resolveSecret", () => {
  it("uses the environment when it is set, and persists nothing", () => {
    const dir = fresh();
    const r = resolveSecret("supplied-by-the-operator", join(dir, "secret"));
    expect(r.secret).toBe("supplied-by-the-operator");
    expect(r.source).toBe("environment");
    expect(existsSync(join(dir, "secret"))).toBe(false);
  });

  /*
   * The whole point of this module. The key that encrypts stored TrueNAS API
   * keys and sudo passwords used to fall back to a constant in the source. That
   * is protection by obscurity, and publishing the source removes the
   * obscurity — anyone holding a copy of connections.json could then decrypt it
   * with a string printed in the repository.
   */
  it("generates one rather than falling back to a constant", () => {
    const dir = fresh();
    const r = resolveSecret(undefined, join(dir, "secret"));
    expect(r.secret).not.toBe(LEGACY_DEV_SECRET);
    expect(r.secret.length).toBeGreaterThanOrEqual(64);
    expect(r.source).toBe("generated");
  });

  it("keeps the generated one, so stored credentials survive a restart", () => {
    const dir = fresh();
    const path = join(dir, "secret");
    const first = resolveSecret(undefined, path);
    const second = resolveSecret(undefined, path);
    expect(second.secret).toBe(first.secret);
    expect(second.source).toBe("file");
  });

  it("writes it unreadable to anyone else", () => {
    const dir = fresh();
    const path = join(dir, "secret");
    resolveSecret(undefined, path);
    // 0600. A key file the rest of the machine can read is not a key file.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("ignores a blank environment value rather than encrypting with nothing", () => {
    const dir = fresh();
    expect(resolveSecret("   ", join(dir, "secret")).source).toBe("generated");
  });

  it("ignores an empty secret file and makes a real one", () => {
    const dir = fresh();
    const path = join(dir, "secret");
    writeFileSync(path, "\n");
    const r = resolveSecret(undefined, path);
    expect(r.source).toBe("generated");
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThanOrEqual(64);
  });

  it("gives two installations different keys", () => {
    expect(resolveSecret(undefined, join(fresh(), "s")).secret)
      .not.toBe(resolveSecret(undefined, join(fresh(), "s")).secret);
  });
});

describe("keyFrom", () => {
  it("is a 32-byte key, which is what aes-256 wants", () =>
    expect(keyFrom("anything").length).toBe(32));

  it("is stable for the same secret", () =>
    expect(keyFrom("abc").equals(keyFrom("abc"))).toBe(true));

  it("differs for different secrets", () =>
    expect(keyFrom("abc").equals(keyFrom("abd"))).toBe(false));
});
