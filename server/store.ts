import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { TrueNas } from "./truenas.js";
import { LEGACY_DEV_SECRET, keyFrom, resolveSecret } from "./secret.js";

/**
 * Where TrueNAS servers are configured.
 *
 * Connections used to live in the environment file, which meant adding a second
 * NAS was a redeploy. They are stored here instead so the console can manage
 * more than one box, and so an operator can add one without shell access.
 *
 * API keys are encrypted at rest. A key for this API is equivalent to root on
 * the NAS, so a readable file of them would be worth more than the dashboard.
 */

export interface Connection {
  id: string;
  name: string;
  url: string;
  fingerprint: string | null;
  /** Never leaves the server; the wire format uses `hasKey` instead. */
  apiKeyEnc: string;
  /**
   * The NAS account's own password, for sudo.
   *
   * Separate from the API key and optional, because it buys exactly one thing:
   * the file operations TrueNAS has no API for. The JSON-RPC interface offers
   * mkdir but no move, rename or delete, so those have to go through a shell,
   * and the shell runs as an account that cannot write into a pool root
   * without sudo. Stored the same way as the API key and, like it, never sent
   * back to the browser.
   */
  sudoEnc?: string;
  isDefault: boolean;
}

export type PublicConnection = Omit<Connection, "apiKeyEnc" | "sudoEnc"> &
  { hasKey: boolean; hasSudo: boolean; connected: boolean; error: string | null };

const FILE = process.env.DATA_FILE ?? "/opt/truenas-ui/data/connections.json";

/**
 * Resolved once, because generating one twice would write two different keys
 * and orphan whatever the first encrypted.
 */
let resolved: ReturnType<typeof resolveSecret> | null = null;

function secret() {
  if (!resolved) {
    resolved = resolveSecret(process.env.SESSION_SECRET, `${FILE}.key`);
    if (resolved.source === "generated") {
      console.log(
        `[store] no SESSION_SECRET set — generated one and kept it at ${FILE}.key. ` +
          "Back it up with the data file: without it the stored API keys cannot be read.",
      );
    }
  }
  return resolved;
}

function secretKey(): Buffer {
  // Derived from the same secret that signs sessions: one thing to protect, and
  // rotating it invalidates stored keys and sessions together, which is the
  // correct behaviour rather than an inconvenience.
  return keyFrom(secret().secret);
}

/** True if `blob` had to be read with the old built-in key. */
let readWithLegacyKey = false;

function decryptWith(blob: string, key: Buffer): string {
  const [iv, tag, data] = blob.split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(blob: string): string {
  try {
    return decryptWith(blob, secretKey());
  } catch (e) {
    /*
     * Written before there was a real key.
     *
     * Anyone who ran a version that fell back to the built-in constant has a
     * file encrypted with it. Refusing to read that would bring their console
     * back up unable to reach their NAS and unable to say why, so it is read
     * once with the old key and re-encrypted with the real one on the next
     * save. The constant is never used to encrypt.
     */
    const viaLegacy = decryptWith(blob, keyFrom(LEGACY_DEV_SECRET));
    readWithLegacyKey = true;
    return viaLegacy;
  }
}

let connections: Connection[] = [];

function load(): void {
  if (!existsSync(FILE)) {
    connections = [];
    return;
  }
  try {
    connections = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error("[store] connections file is unreadable, starting empty:", e);
    connections = [];
    return;
  }
  try {
    migrateLegacySecrets();
  } catch (e) {
    // A credential that decrypts under neither key is not a reason to refuse
    // to start: the rest of the console still works, and the connection will
    // report its own failure when something tries to use it.
    console.error("[store] could not re-encrypt stored credentials:", e);
  }
}

function save(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(connections, null, 2), { mode: 0o600 });
}

/**
 * Re-encrypt anything still readable with the old built-in key.
 *
 * Reading it works, so nothing is broken — but it stays readable to anyone
 * holding the file and the published constant, which is the whole reason the
 * constant had to go. Rewritten once, at startup, and then never again.
 */
function migrateLegacySecrets(): void {
  if (!connections.length) return;
  readWithLegacyKey = false;
  const rewritten = connections.map((c) => {
    const apiKey = c.apiKeyEnc ? decrypt(c.apiKeyEnc) : null;
    const sudo = c.sudoEnc ? decrypt(c.sudoEnc) : null;
    return { conn: c, apiKey, sudo };
  });
  if (!readWithLegacyKey) return;

  for (const { conn, apiKey, sudo } of rewritten) {
    if (apiKey !== null) conn.apiKeyEnc = encrypt(apiKey);
    if (sudo !== null) conn.sudoEnc = encrypt(sudo);
  }
  save();
  console.log(
    `[store] re-encrypted ${rewritten.length} stored credential set(s) with this installation's own key. ` +
      "They were written with the built-in development key, which is public.",
  );
}

/**
 * Adopt the environment-configured server on first run.
 *
 * Without this, upgrading an install that was configured through the .env file
 * would come up with no servers at all and look like data loss.
 */
export function init(): void {
  load();
  const envUrl = process.env.TRUENAS_URL;
  const envKey = process.env.TRUENAS_API_KEY;
  if (connections.length === 0 && envUrl && envKey) {
    connections.push({
      id: randomUUID(),
      name: process.env.TRUENAS_NAME ?? "TrueNAS",
      url: envUrl,
      fingerprint: process.env.TRUENAS_FINGERPRINT || null,
      apiKeyEnc: encrypt(envKey),
      isDefault: true,
    });
    save();
    console.log("[store] adopted the server from the environment");
  }
}

export const all = (): Connection[] => connections;

export function get(id: string | null | undefined): Connection | undefined {
  if (!id) return connections.find((c) => c.isDefault) ?? connections[0];
  return connections.find((c) => c.id === id);
}

export function add(input: { name: string; url: string; apiKey: string; fingerprint?: string | null; sudoPassword?: string }): Connection {
  const conn: Connection = {
    id: randomUUID(),
    name: input.name,
    url: input.url,
    fingerprint: input.fingerprint || null,
    apiKeyEnc: encrypt(input.apiKey),
    ...(input.sudoPassword ? { sudoEnc: encrypt(input.sudoPassword) } : {}),
    isDefault: connections.length === 0,
  };
  connections.push(conn);
  save();
  return conn;
}

export function update(id: string, patch: { name?: string; url?: string; apiKey?: string; fingerprint?: string | null; isDefault?: boolean; sudoPassword?: string | null }): Connection {
  const conn = connections.find((c) => c.id === id);
  if (!conn) throw new Error("No such connection.");
  if (patch.name !== undefined) conn.name = patch.name;
  if (patch.url !== undefined) conn.url = patch.url;
  if (patch.fingerprint !== undefined) conn.fingerprint = patch.fingerprint || null;
  // An empty key means "leave it alone", so that editing a name does not force
  // the operator to paste the key again.
  if (patch.apiKey) conn.apiKeyEnc = encrypt(patch.apiKey);
  // null clears it, "" (or absent) leaves it alone — same rule as the key, plus
  // a way to take the password back out again.
  if (patch.sudoPassword === null) delete conn.sudoEnc;
  else if (patch.sudoPassword) conn.sudoEnc = encrypt(patch.sudoPassword);
  if (patch.isDefault) for (const c of connections) c.isDefault = c.id === id;
  save();
  clients.get(id)?.close();
  clients.delete(id);
  return conn;
}

export function remove(id: string): void {
  const wasDefault = connections.find((c) => c.id === id)?.isDefault;
  connections = connections.filter((c) => c.id !== id);
  if (wasDefault && connections.length) connections[0].isDefault = true;
  save();
  clients.get(id)?.close();
  clients.delete(id);
}

/* ------------------------------------------------------------------ clients */

const clients = new Map<string, TrueNas>();

/** The live client for a connection, created on first use and then reused. */
export function clientFor(conn: Connection): TrueNas {
  const existing = clients.get(conn.id);
  if (existing) return existing;
  const client = new TrueNas(conn.url, decrypt(conn.apiKeyEnc), conn.fingerprint ?? undefined);
  clients.set(conn.id, client);
  return client;
}

export function publicView(conn: Connection): PublicConnection {
  const client = clients.get(conn.id);
  const { apiKeyEnc, sudoEnc, ...rest } = conn;
  return {
    ...rest, hasKey: !!apiKeyEnc, hasSudo: !!sudoEnc,
    connected: client?.connected ?? false, error: client?.lastError ?? null,
  };
}

/**
 * Try a set of credentials without saving them.
 *
 * Saving first and finding out later is how an operator ends up with a broken
 * entry they then have to guess the fault in; this reports the NAS's own reason
 * before anything is written.
 */
export async function test(input: { url: string; apiKey: string; fingerprint?: string | null }): Promise<{ ok: boolean; error?: string; version?: string; hostname?: string }> {
  const probe = new TrueNas(input.url, input.apiKey, input.fingerprint || undefined);
  try {
    const info = await probe.call<{ version: string; hostname: string }>("system.info");
    return { ok: true, version: info.version, hostname: info.hostname };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    probe.close();
  }
}

/** The stored sudo password, or null when this connection has none. */
export const sudoPasswordFor = (conn: Connection): string | null =>
  conn.sudoEnc ? decrypt(conn.sudoEnc) : null;

export function closeAll(): void {
  for (const c of clients.values()) c.close();
  clients.clear();
}
