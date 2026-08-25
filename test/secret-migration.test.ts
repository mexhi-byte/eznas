import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eznas-mig-"));
const FILE = join(dir, "connections.json");

/** Exactly how the old code encrypted: with a constant printed in the source. */
const PUBLIC_KEY = createHash("sha256").update("truenas-ui-development-only").digest();
function encryptWithPublicConstant(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", PUBLIC_KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

function readableWithPublicConstant(blob: string): boolean {
  try {
    const [iv, tag, data] = blob.split(".");
    const d = createDecipheriv("aes-256-gcm", PUBLIC_KEY, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]);
    return true;
  } catch {
    return false;
  }
}

writeFileSync(FILE, JSON.stringify([{
  id: "x", name: "nas", url: "wss://10.0.0.2/api/current", fingerprint: null,
  apiKeyEnc: encryptWithPublicConstant("SECRET-API-KEY-1234"),
  sudoEnc: encryptWithPublicConstant("root-password"),
  isDefault: true,
}], null, 2));

process.env.DATA_FILE = FILE;
delete process.env.SESSION_SECRET;

// Imported after the environment is set: the module reads its path at load.
const store = await import("../server/store.js");

describe("upgrading an install that ran without SESSION_SECRET", () => {
  beforeAll(() => store.init());

  const stored = () => JSON.parse(readFileSync(FILE, "utf8"))[0] as { apiKeyEnc: string; sudoEnc: string };

  it("generates a key of its own and keeps it beside the data", () =>
    expect(existsSync(`${FILE}.key`)).toBe(true));

  it("does not lose the credentials it could already read", () => {
    expect(store.decrypt(stored().apiKeyEnc)).toBe("SECRET-API-KEY-1234");
    expect(store.decrypt(stored().sudoEnc)).toBe("root-password");
  });

  /*
   * The reason all of this exists. Before, these bytes could be decrypted by
   * anyone holding the file and a constant that is about to be published.
   */
  it("leaves nothing on disk that the published constant can decrypt", () => {
    expect(readableWithPublicConstant(stored().apiKeyEnc)).toBe(false);
    expect(readableWithPublicConstant(stored().sudoEnc)).toBe(false);
  });

  it("does not rewrite the file again once migrated", () => {
    const before = readFileSync(FILE, "utf8");
    store.init();
    expect(readFileSync(FILE, "utf8")).toBe(before);
  });
});
