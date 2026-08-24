import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { encrypt, decrypt } from "./store.js";

/**
 * Who may sign in to this console.
 *
 * It used to be one shared password in the environment file, which meant one
 * password for the household and no way to let someone look at the dashboard
 * without also handing them the ability to destroy a pool. Accounts live here
 * instead, each with a role.
 *
 * Passwords are scrypt hashes with a per-account salt. Not HMAC, not a plain
 * digest: this file is the one thing an attacker who gets a copy of the data
 * directory would try to crack offline, and scrypt is what makes that expensive.
 */

export type Role = "admin" | "viewer";

export interface Account {
  id: string;
  username: string;
  /** scrypt$<salt-hex>$<hash-hex> — never leaves this module. */
  hash: string;
  role: Role;
  mfa: { enabled: boolean; secretEnc: string | null; recoveryHashes: string[] };
  createdAt: number;
  lastSeen: number | null;
}

export interface PublicAccount {
  id: string;
  username: string;
  role: Role;
  mfa: boolean;
  recoveryRemaining: number;
  createdAt: number;
  lastSeen: number | null;
}

const FILE = process.env.ACCOUNTS_FILE ?? "/opt/truenas-ui/data/accounts.json";
const SCRYPT_KEYLEN = 64;

let accounts: Account[] = [];

/* ---------------------------------------------------------------- hashing */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------- persistence */

function save(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

/**
 * Load the accounts, creating the first one if there are none.
 *
 * The seed matters more than it looks: an install that upgrades into this build
 * has a working UI_PASSWORD and no accounts file, and coming up with an empty
 * account list would lock the owner out of their own console. The existing
 * password becomes the first admin, and the old single global second factor
 * moves onto that account rather than being silently dropped.
 */
export function init(legacyMfa?: Account["mfa"]): void {
  if (existsSync(FILE)) {
    try {
      accounts = JSON.parse(readFileSync(FILE, "utf8"));
    } catch (e) {
      console.error("[accounts] unreadable, starting empty:", e);
      accounts = [];
    }
  }
  if (accounts.length) return;

  const seed = process.env.UI_PASSWORD;
  if (!seed) {
    console.warn("[accounts] no accounts and no UI_PASSWORD — nobody can sign in");
    return;
  }
  accounts = [{
    id: randomUUID(),
    username: process.env.UI_USERNAME ?? "admin",
    hash: hashPassword(seed),
    role: "admin",
    mfa: legacyMfa?.enabled ? legacyMfa : { enabled: false, secretEnc: null, recoveryHashes: [] },
    createdAt: Date.now(),
    lastSeen: null,
  }];
  save();
  console.log(`[accounts] created the first admin "${accounts[0].username}" from UI_PASSWORD`);
}

/* ------------------------------------------------------------------ lookup */

export const all = (): Account[] => accounts;
export const byId = (id: string): Account | undefined => accounts.find((a) => a.id === id);

/** Usernames are matched case-insensitively; nobody remembers the capitals. */
export const byName = (username: string): Account | undefined =>
  accounts.find((a) => a.username.toLowerCase() === username.trim().toLowerCase());

export const publicView = (a: Account): PublicAccount => ({
  id: a.id,
  username: a.username,
  role: a.role,
  mfa: a.mfa.enabled,
  recoveryRemaining: a.mfa.recoveryHashes.length,
  createdAt: a.createdAt,
  lastSeen: a.lastSeen,
});

/**
 * Check a username and password.
 *
 * A wrong username and a wrong password have to cost the same: returning early
 * on an unknown name makes the response measurably faster, which is how an
 * attacker enumerates who exists. The dummy hash keeps both paths doing the
 * same scrypt work.
 */
const DUMMY = hashPassword(randomBytes(16).toString("hex"));

export function authenticate(username: string, password: string): Account | null {
  const account = byName(username);
  const ok = verifyPassword(password, account?.hash ?? DUMMY);
  return ok && account ? account : null;
}

/* ------------------------------------------------------------------ writing */

export function create(input: { username: string; password: string; role: Role }): Account {
  const username = input.username.trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    throw new Error("A username can use letters, numbers, dot, dash and underscore, 2 to 32 characters.");
  }
  if (byName(username)) throw new Error(`Somebody is already called "${username}".`);
  requireStrong(input.password);

  const account: Account = {
    id: randomUUID(),
    username,
    hash: hashPassword(input.password),
    role: input.role,
    mfa: { enabled: false, secretEnc: null, recoveryHashes: [] },
    createdAt: Date.now(),
    lastSeen: null,
  };
  accounts.push(account);
  save();
  return account;
}

export function update(id: string, patch: { username?: string; password?: string; role?: Role }): Account {
  const account = byId(id);
  if (!account) throw new Error("No such account.");

  if (patch.username && patch.username.trim() !== account.username) {
    const username = patch.username.trim();
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
      throw new Error("A username can use letters, numbers, dot, dash and underscore, 2 to 32 characters.");
    }
    if (byName(username)) throw new Error(`Somebody is already called "${username}".`);
    account.username = username;
  }
  if (patch.password) {
    requireStrong(patch.password);
    account.hash = hashPassword(patch.password);
  }
  if (patch.role && patch.role !== account.role) {
    // Demoting the last admin would leave a console nobody can administer, and
    // no way back in short of editing JSON on the box.
    if (account.role === "admin" && admins().length === 1) {
      throw new Error("This is the only administrator. Make somebody else an administrator first.");
    }
    account.role = patch.role;
  }
  save();
  return account;
}

export function remove(id: string): void {
  const account = byId(id);
  if (!account) return;
  if (account.role === "admin" && admins().length === 1) {
    throw new Error("This is the only administrator, so it cannot be deleted.");
  }
  accounts = accounts.filter((a) => a.id !== id);
  save();
}

export function touch(id: string): void {
  const account = byId(id);
  if (!account) return;
  account.lastSeen = Date.now();
  save();
}

const admins = (): Account[] => accounts.filter((a) => a.role === "admin");

function requireStrong(password: string): void {
  if (password.length < 8) throw new Error("A password needs at least 8 characters.");
}

/* --------------------------------------------------------------------- 2FA */

export const mfaSecret = (a: Account): string | null => (a.mfa.secretEnc ? decrypt(a.mfa.secretEnc) : null);

export function setMfa(id: string, secret: string | null, recovery: string[]): void {
  const account = byId(id);
  if (!account) throw new Error("No such account.");
  account.mfa = {
    enabled: !!secret,
    secretEnc: secret ? encrypt(secret) : null,
    recoveryHashes: recovery.map(hashRecovery),
  };
  save();
}

const hashRecovery = (code: string): string =>
  createHash("sha256").update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()).digest("hex");

/** Spend a recovery code. Used once, it stops working — that is the point. */
export function consumeRecovery(id: string, code: string): boolean {
  const account = byId(id);
  if (!account) return false;
  const h = hashRecovery(code);
  const idx = account.mfa.recoveryHashes.indexOf(h);
  if (idx === -1) return false;
  account.mfa.recoveryHashes.splice(idx, 1);
  save();
  return true;
}
