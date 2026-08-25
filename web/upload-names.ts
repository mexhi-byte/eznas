/**
 * Deciding what an uploaded file should be called.
 *
 * Kept apart from the page because it is the part with rules in it: the
 * difference between "archive.tar.gz" and "archive.tar (2).gz" is not
 * something a component should be deciding inline, and it is the sort of thing
 * that is only ever noticed when it is wrong.
 */

/**
 * The names in `wanted` that already exist in this folder.
 *
 * A folder counts as a clash too — uploading "photos" into a directory that
 * already has a folder called "photos" fails on the NAS, and finding that out
 * before any bytes move is the whole point of asking.
 */
export function clashingNames(wanted: string[], present: string[]): string[] {
  const here = new Set(present);
  return wanted.filter((n) => here.has(n));
}

/**
 * "a.txt" -> "a (2).txt", the way a desktop does it.
 *
 * Splits on the LAST dot, so "archive.tar.gz" keeps ".gz" and not ".tar.gz" —
 * matching what the file manager on the other end of the drag would do. A
 * leading dot is part of the name rather than an extension, so ".bashrc"
 * becomes ".bashrc (2)" and not " (2).bashrc".
 *
 * Mutates `taken`, so renaming several files in one drop cannot hand the same
 * new name to two of them.
 */
export function nextFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (taken.has(`${stem} (${n})${ext}`)) n++;
  const chosen = `${stem} (${n})${ext}`;
  taken.add(chosen);
  return chosen;
}
