/**
 * Where a binned item goes when it is put back.
 *
 * Restoring used to have exactly one answer: the place it was deleted from.
 * That is the right default and a poor rule — the folder may be gone, the name
 * may since have been taken by something else, or the whole point may be to
 * file it somewhere better than where it was. So the destination is now a
 * choice, and this is the part that decides whether a given choice is allowed.
 *
 * Pure, because every rule here is a rule about strings, and because the
 * consequences of getting one wrong are a file written outside /mnt or back
 * into a bin it can never leave.
 */

export interface RestoreRequest {
  /** The item's full path inside the bin. */
  from: string;
  /** The bin it is in: /mnt/<pool>/.recycle */
  bin: string;
  /** Somewhere other than where it came from. */
  toDir?: string | null;
  /** A different name. */
  name?: string | null;
}

export interface RestoreTarget {
  dir: string;
  name: string;
  path: string;
}

/** The suffix the bin adds to de-collide. Stripped to recover the real name. */
const STAMP = /\.\d{8}-\d{6}$/;

function checkedDir(raw: string): string {
  const dir = raw.trim().replace(/\/+$/, "");
  if (!dir.startsWith("/")) throw new Error("A destination folder has to be a full path, starting with /.");
  // Checked before resolving, so a path that climbs is refused rather than
  // silently landing somewhere the person did not name.
  if (dir.split("/").includes("..")) throw new Error("A destination folder cannot contain “..”.");
  const parts = dir.split("/").filter(Boolean);
  if (parts[0] !== "mnt" || parts.length < 2) {
    throw new Error("Files can only be restored somewhere under /mnt.");
  }
  /*
   * Not into a bin. Restoring into one is not restoring — the item would sit
   * in a place whose whole contract is "this was deleted", and the normal
   * delete route refuses to bin something that is already binned, so it could
   * not be got out again the ordinary way.
   */
  if (parts.includes(".recycle")) throw new Error("That is a recycle bin — pick somewhere else.");
  return dir;
}

function checkedName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Give the file a name.");
  if (name.includes("/")) throw new Error("A name cannot contain “/” — use the folder field to move it.");
  if (name === "." || name === "..") throw new Error("That is not a name.");
  return name;
}

export function restoreTarget(req: RestoreRequest): RestoreTarget {
  const { from, bin } = req;
  if (!from.startsWith(`${bin}/`)) throw new Error("That is not in a recycle bin.");

  // The pool root the bin belongs to, and where the item sat under it.
  const root = bin.slice(0, -"/.recycle".length);
  const original = `${root}${from.slice(bin.length)}`.replace(STAMP, "");
  const cut = original.lastIndexOf("/");

  const dir = req.toDir ? checkedDir(req.toDir) : original.slice(0, cut);
  const name = req.name ? checkedName(req.name) : original.slice(cut + 1);

  return { dir, name, path: `${dir}/${name}` };
}
