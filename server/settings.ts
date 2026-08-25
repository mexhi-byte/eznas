import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt } from "./store.js";
import type { Webhook } from "./webhooks.js";

/**
 * Console settings — everything that belongs to this dashboard rather than to
 * a NAS. Theme, second factor, and who gets told when a disk vanishes.
 */

export interface Settings {
  theme: string;
  mfa: { enabled: boolean; secretEnc: string | null; recoveryHashes: string[] };
  notify: {
    /** Watch the disk list and raise an event when it changes. */
    watchDisks: boolean;
    /** Also send mail through the NAS's own SMTP configuration. */
    email: boolean;
    recipients: string[];
    /**
     * What the console watches for itself.
     *
     * TrueNAS raises alerts for some of this and stays quiet about the rest —
     * it says nothing when an app falls over, nothing when a pool crosses a
     * capacity line you care about rather than the one it cares about, and
     * nothing at all about a disk that was never in a pool. These are the
     * console's own checks, with thresholds that belong to this household.
     */
    watch: {
      poolHealth: boolean;
      capacity: boolean;
      capacityPercent: number;
      temperature: boolean;
      temperatureC: number;
      zfsErrors: boolean;
      apps: boolean;
      scrubs: boolean;
      /** TrueNAS having an update available. */
      updates: boolean;
      /** A newer EzNAS release being published. Not the same thing. */
      consoleUpdates: boolean;
      reachability: boolean;
    };
    /** Only email about things at least this serious. */
    emailLevel: "info" | "warn" | "bad";
    /** Push targets — Discord, Telegram, ntfy, or anything that takes a POST. */
    webhooks: Webhook[];
    /** Put a name in the message, so a push reads like a person wrote it. */
    greetName: string;
  };
  /**
   * What the household calls this server and its pools.
   *
   * "tank14" is a ZFS name and has to stay one — every command, every alert
   * and the NAS's own interface use it. This is a label drawn on top, kept
   * here rather than on the NAS so that renaming a pool in this console cannot
   * possibly rename anything real.
   */
  names: {
    server: string;
    pools: Record<string, { label?: string; icon?: string }>;
  };
}

const FILE = process.env.SETTINGS_FILE ?? "/opt/truenas-ui/data/settings.json";

const DEFAULTS: Settings = {
  theme: "midnight",
  mfa: { enabled: false, secretEnc: null, recoveryHashes: [] },
  notify: {
    watchDisks: true,
    email: false,
    recipients: [],
    watch: {
      poolHealth: true, capacity: true, capacityPercent: 85,
      temperature: true, temperatureC: 50,
      zfsErrors: true, apps: true, scrubs: true, updates: true, consoleUpdates: true,
      reachability: true,
    },
    emailLevel: "warn",
    webhooks: [],
    greetName: "",
  },
  names: { server: "", pools: {} },
};

let current: Settings = structuredClone(DEFAULTS);

export function load(): void {
  if (!existsSync(FILE)) {
    save();
    return;
  }
  try {
    // Merged over the defaults so a settings file written by an older build
    // gains new keys instead of leaving them undefined.
    const disk = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Settings>;
    current = {
      ...DEFAULTS,
      ...disk,
      mfa: { ...DEFAULTS.mfa, ...(disk.mfa ?? {}) },
      notify: {
        ...DEFAULTS.notify,
        ...(disk.notify ?? {}),
        watch: { ...DEFAULTS.notify.watch, ...((disk.notify as Partial<Settings["notify"]>)?.watch ?? {}) },
        webhooks: (disk.notify as Partial<Settings["notify"]>)?.webhooks ?? [],
      },
      names: { ...DEFAULTS.names, ...(disk.names ?? {}) },
    };
  } catch (e) {
    console.error("[settings] unreadable, using defaults:", e);
    current = structuredClone(DEFAULTS);
  }
}

function save(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
}

export const get = (): Settings => current;

export function patch(next: Partial<Settings>): Settings {
  current = {
    ...current,
    ...next,
    mfa: { ...current.mfa, ...(next.mfa ?? {}) },
    notify: {
      ...current.notify,
      ...(next.notify ?? {}),
      watch: { ...current.notify.watch, ...(next.notify?.watch ?? {}) },
    },
    names: { ...current.names, ...(next.names ?? {}) },
  };
  save();
  return current;
}

/** What the browser may see — never the TOTP secret or the recovery hashes. */
export function publicView() {
  return {
    theme: current.theme,
    mfa: { enabled: current.mfa.enabled, recoveryRemaining: current.mfa.recoveryHashes.length },
    notify: {
      ...current.notify,
      // A Telegram bot token is a credential: anybody holding it can post as
      // that bot. The browser gets to see that a hook exists, not its secret.
      webhooks: current.notify.webhooks.map((w) => ({
        ...w,
        botToken: w.botToken ? "********" : undefined,
      })),
    },
    names: current.names,
  };
}

/* ---------------------------------------------------------------- 2FA bits */

export const mfaSecret = (): string | null =>
  current.mfa.secretEnc ? decrypt(current.mfa.secretEnc) : null;

export function setMfa(secret: string | null, recovery: string[]): void {
  patch({
    mfa: {
      enabled: !!secret,
      secretEnc: secret ? encrypt(secret) : null,
      recoveryHashes: recovery.map(hashRecovery),
    },
  });
}

const hashRecovery = (code: string): string =>
  createHash("sha256").update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()).digest("hex");

/**
 * Spend a recovery code.
 *
 * Removing it on use is the whole point: a recovery code that still works
 * after it has been used is just a second password with none of the care.
 */
export function consumeRecovery(code: string): boolean {
  const h = hashRecovery(code);
  const idx = current.mfa.recoveryHashes.indexOf(h);
  if (idx === -1) return false;
  const left = [...current.mfa.recoveryHashes];
  left.splice(idx, 1);
  patch({ mfa: { ...current.mfa, recoveryHashes: left } });
  return true;
}

/* ------------------------------------------------------------------ events */

/**
 * One thing worth telling somebody about.
 *
 * Generalised from a disk-only record: the console now watches pools, space,
 * temperature, apps, scrubs and its own connection, and every one of those has
 * to arrive in the same place as "a disk was pulled" rather than in a second
 * inbox.
 *
 * `key` is what stops a standing condition becoming a notification per poll. A
 * pool that is 91% full is one notice, not one every thirty seconds until
 * somebody deletes something.
 */
export type NoticeLevel = "info" | "warn" | "bad";

export interface Notice {
  id: string;
  at: number;
  level: NoticeLevel;
  category: string;
  key: string;
  title: string;
  detail: string;
  server: string;
  seen: boolean;
  emailed: boolean;
}

/** The old disk-shaped record, still on disk in installs that predate notices. */
interface LegacyDiskEvent {
  id: string; at: number; kind: "removed" | "added";
  disk: string; model: string; size: number; serial: string;
  pool: string | null; seen: boolean; emailed: boolean;
}

const EVENTS_FILE = process.env.EVENTS_FILE ?? "/opt/truenas-ui/data/events.json";
let events: Notice[] = [];

export function loadEvents(): void {
  if (!existsSync(EVENTS_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(EVENTS_FILE, "utf8")) as Array<Notice | LegacyDiskEvent>;
    // Anything written by an older build is disk-shaped. Converting rather
    // than discarding keeps the notification history across the upgrade.
    events = raw.map((e) =>
      "kind" in e
        ? {
            id: e.id, at: e.at, seen: e.seen, emailed: e.emailed,
            level: e.kind === "removed" ? "bad" : "info",
            category: "disk",
            key: `disk:${e.kind}:${e.serial || e.disk}`,
            title: e.kind === "removed" ? `Disk removed: ${e.disk}` : `New disk: ${e.disk}`,
            detail: `${e.model || "unknown model"} · ${(e.size / 1024 ** 3).toFixed(0)} GB${e.pool ? ` · was in ${e.pool}` : ""}`,
            server: "",
          }
        : e,
    );
  } catch {
    events = [];
  }
}

function saveEvents(): void {
  mkdirSync(dirname(EVENTS_FILE), { recursive: true });
  // Kept bounded: this is a notification feed, not an audit log, and an
  // unbounded file would grow forever on a flapping backplane.
  writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(0, 200), null, 2), { mode: 0o600 });
}

export function addEvent(e: Omit<Notice, "id" | "at" | "seen" | "emailed">): Notice {
  const full: Notice = { ...e, id: randomUUID(), at: Date.now(), seen: false, emailed: false };
  events.unshift(full);
  events = events.slice(0, 200);
  saveEvents();
  return full;
}

export const allEvents = (): Notice[] => events;

/** Whether this exact condition is already sitting unresolved in the list. */
export const hasActive = (key: string): boolean => events.some((e) => e.key === key);

/** Forget a condition so that, if it happens again, it is reported again. */
export function clearKey(key: string): void {
  const before = events.length;
  events = events.filter((e) => e.key !== key);
  if (events.length !== before) saveEvents();
}

export function markSeen(): void {
  events = events.map((e) => ({ ...e, seen: true }));
  saveEvents();
}

export function markEmailed(id: string): void {
  events = events.map((e) => (e.id === id ? { ...e, emailed: true } : e));
  saveEvents();
}

export function clearEvents(): void {
  events = [];
  saveEvents();
}
