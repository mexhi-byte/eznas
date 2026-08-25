import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);

/**
 * Updating this console from its own GitHub releases.
 *
 * The console manages a NAS, so it is the last thing anybody wants to babysit
 * over SSH. It checks the repository's published releases, compares them
 * against the version it is running, and can install one in place.
 *
 * Two rules make that safe enough to offer as a button:
 *
 *  - The current build is copied aside before anything is written, so a bad
 *    release is one command away from being undone rather than a restore from
 *    backup.
 *  - data/ is never touched. Connections, accounts, settings and the recycle
 *    cache live there, and an update that forgets which NAS it manages is
 *    indistinguishable from a broken one.
 */

const REPO = process.env.UPDATE_REPO ?? "mexhi-byte/eznas";
const ROOT = process.cwd();

export interface Release {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
}

/** "v0.4.0" and "0.4" both mean the same thing; compare them as numbers. */
function parse(v: string): number[] {
  return v.replace(/^v/i, "").split(/[.-]/).map((p) => Number(p) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Ask GitHub what has been published.
 *
 * Unauthenticated, which is rate-limited to 60 requests an hour per address —
 * ample for a check somebody presses, and the reason this is not polled on a
 * timer.
 */
export async function releases(): Promise<Release[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "eznas-console" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`The repository ${REPO} has no releases, or is private to this machine.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. It rate-limits unauthenticated checks to 60 an hour.`);

  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    version: String(r.tag_name ?? "").replace(/^v/i, ""),
    name: String(r.name ?? r.tag_name ?? ""),
    notes: String(r.body ?? "").slice(0, 4000),
    url: String(r.html_url ?? ""),
    publishedAt: (r.published_at as string) ?? null,
    prerelease: r.prerelease === true,
  }));
}

export interface UpdateCheck {
  current: string;
  latest: Release | null;
  updateAvailable: boolean;
  canSelfUpdate: boolean;
  reason: string | null;
}

export async function check(current: string): Promise<UpdateCheck> {
  const all = await releases();
  const stable = all.filter((r) => !r.prerelease && r.version);
  const latest = stable[0] ?? null;
  const git = existsSync(join(ROOT, ".git"));
  return {
    current,
    latest,
    updateAvailable: !!latest && isNewer(latest.version, current),
    canSelfUpdate: git,
    reason: git ? null : "This copy was not installed from git, so it cannot update itself in place.",
  };
}

/**
 * Fetch a tag, build it, and leave the previous build recoverable.
 *
 * Deliberately a plain sequence of git and npm rather than anything clever: an
 * updater that is hard to reason about is one nobody trusts to run unattended,
 * and every step here is something an operator could type themselves.
 */
export async function apply(tag: string, onLine: (line: string) => void): Promise<void> {
  if (!/^[\w.\-/]{1,64}$/.test(tag)) throw new Error("That does not look like a release tag.");
  if (!existsSync(join(ROOT, ".git"))) throw new Error("This copy was not installed from git.");

  const step = async (label: string, cmd: string, args: string[]) => {
    onLine(`$ ${cmd} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await run(cmd, args, { cwd: ROOT, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of `${stdout}${stderr}`.split("\n").filter(Boolean).slice(-12)) onLine(line);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      for (const line of `${err.stdout ?? ""}${err.stderr ?? ""}`.split("\n").filter(Boolean).slice(-12)) onLine(line);
      throw new Error(`${label} failed: ${err.message ?? "unknown error"}`);
    }
  };

  // The rollback point is the build, not the checkout: dist/ is what actually
  // serves, and restoring it is one move rather than a rebuild.
  await step("saving a rollback point", "sh", ["-c", "rm -rf dist.prev && cp -a dist dist.prev"]);
  await step("fetching", "git", ["fetch", "--tags", "--depth", "50", "origin"]);
  await step("checking out", "git", ["checkout", "--force", tag]);
  // The full install, dev dependencies included.
  //
  // --omit=dev looks right for a server and is wrong here: this updates by
  // building from source, and vite and typescript — the two things the build
  // actually invokes — are dev dependencies. Omitting them installs cleanly
  // and then fails the next step with "vite: not found".
  await step("installing dependencies", "npm", ["ci", "--no-audit", "--no-fund"]);
  await step("building", "npm", ["run", "build"]);
  onLine("Done. Restart the service to run the new build.");
}
