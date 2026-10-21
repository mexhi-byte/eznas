import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "./paths.js";

/**
 * An append-only log of state-changing API calls.
 *
 * The notification feed in settings is a feed, not a record: entries roll off
 * once the user clears them, and nothing captures that the pool named `tank`
 * was destroyed, by which account, at which minute. For a console that holds a
 * credential equivalent to root on the NAS and lets more than one person sign
 * in, that is a gap. This file closes it with the simplest thing that works —
 * one JSON object per line, appended under file mode 0600, rotated once at
 * five megabytes so the file never grows unbounded.
 *
 * Entries are made from the HTTP layer at response finish: that way the status
 * is the one the user actually got (a refused viewer write shows up as 403, a
 * failed destroy as 400 or 500), and every route is covered without having to
 * remember to call anything from inside it.
 */

export interface Entry {
  /** Milliseconds since the epoch. The client formats; the server stores. */
  ts: number;
  /** The signed-in account at the time, or null for pre-session calls. */
  accountId: string | null;
  /** The username at the time, so a tail can be read without resolving ids. */
  username: string | null;
  method: string;
  path: string;
  /** Final HTTP status. 2xx did it, 4xx refused it, 5xx is the console's fault. */
  status: number;
}

const FILE = dataFile("AUDIT_FILE", "audit.jsonl");
const ROTATED = `${FILE}.1`;

/*
 * Five megabytes. Twenty thousand entries, more or less, for the typical
 * one-household NAS running at a few writes a day. One rotated copy is kept —
 * the point is forensics after an incident, not a lifetime archive, and
 * anything older than the rotated copy belongs in an external log drain.
 */
const MAX_BYTES = 5 * 1024 * 1024;

/** For tests to override. The directory is created lazily on the first write. */
let fileFor = (): string => FILE;
let rotatedFor = (): string => ROTATED;

/** Point the module at a different file. Only tests should call this. */
export function _setPathsForTests(file: string): void {
  fileFor = () => file;
  rotatedFor = () => `${file}.1`;
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function rotateIfLarge(path: string): void {
  if (size(path) < MAX_BYTES) return;
  try {
    renameSync(path, rotatedFor());
  } catch {
    // The next write will try again. Losing one rotation attempt is better
    // than throwing out of the HTTP response-finish handler.
  }
}

export function log(entry: Entry): void {
  const file = fileFor();
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfLarge(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (e) {
    // Audit is not critical path; failing it must not break the request that
    // triggered it. Loud enough to be noticed, quiet enough to be ignored.
    console.error("[audit] could not append:", e instanceof Error ? e.message : e);
  }
}

/**
 * The most recent `limit` entries, newest first.
 *
 * Reads the current file in full and the rotated one only if the current one
 * does not have enough to answer. Both files are capped at five megabytes, so
 * line-by-line parsing is cheap; a reverse-reading optimisation would only
 * matter if `limit` were routinely tiny compared to the file size, and the
 * cap keeps that from being the case.
 */
export function tail(limit: number): Entry[] {
  const n = Math.max(1, Math.min(Math.floor(limit), 5000));
  const parsed: Entry[] = [];
  const parse = (path: string): void => {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        parsed.push(JSON.parse(line) as Entry);
      } catch {
        // A truncated line at the end of a crash can be ignored — the next
        // append writes a fresh one and the broken line stays as a scar.
      }
    }
  };
  parse(fileFor());
  if (parsed.length < n) parse(rotatedFor());
  return parsed.sort((a, b) => b.ts - a.ts).slice(0, n);
}
