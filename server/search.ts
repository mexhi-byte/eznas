import { runCapture, safePath, shellQuote } from "./nas-exec.js";
import type { TrueNas } from "./truenas.js";
import type { Connection } from "./store.js";

/**
 * Finding a file by name.
 *
 * TrueNAS has no filesystem search method at all, so this has two routes to the
 * same answer behind one async iterator: `find` over the NAS shell, which is
 * fast at any pool size, and a walk over filesystem.listdir, which needs
 * nothing but the API key and is slow on a large tree.
 *
 * Both are bounded. An unbounded search over a full pool is a request that
 * never returns, and by the time it might have, nobody is still watching.
 */

export interface Hit {
  path: string;
  name: string;
  dir: string;
}

export interface Limits {
  maxResults: number;
  maxMs: number;
}

export function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Split `find -print0` output.
 *
 * NUL rather than newline, because a filename may legally contain a newline and
 * splitting on one would report a single file as two that do not exist.
 */
export function parseFindOutput(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

const nameOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf("/")) || "/";

export const hitFor = (path: string): Hit => ({ path, name: nameOf(path), dir: dirOf(path) });

/**
 * Build the find command.
 *
 * The query never reaches the shell unquoted. shellQuote wraps it in single
 * quotes with any embedded quote escaped, so a search for `'; rm -rf /` is a
 * search for a file with an unusual name and nothing more. The glob
 * metacharacters are escaped separately, for correctness rather than safety:
 * someone searching for "report[final]" means that name, and -iname would
 * otherwise read the brackets as a character class and match nothing.
 */
export function findCommand(root: string, query: string): string {
  const pattern = `*${query.replace(/[*?[\]\\]/g, "\\$&")}*`;
  return `find ${shellQuote(safePath(root))} -iname ${shellQuote(pattern)} -print0 2>/dev/null`;
}

/**
 * Wrap a command so its output survives the crossing.
 *
 * The NAS shell is a pseudo-terminal, not a pipe: it inserts escape codes,
 * redraws the prompt, and rewrites anything resembling a control character —
 * which find -print0 output is almost entirely made of. Base64 turns it into
 * plain ASCII with nothing a terminal wants to interpret, and `tr -d` removes
 * the wrapping newlines so the only newline after the payload is the marker
 * saying the command finished.
 *
 * The braces matter: without them the pipe would apply to the last command in
 * the group rather than to all of it.
 */
export function base64Command(inner: string): string {
  // Fenced, because the caller cannot otherwise tell where the payload starts.
  //
  // What comes back from the shell is everything the terminal printed: the
  // TrueNAS login banner, the prompt, then the output. Handing all of that to
  // a base64 decoder does not fail — Buffer.from ignores characters outside
  // the alphabet and decodes the rest — so the banner decoded into binary that
  // happened to contain a NUL, satisfied the "looks like find output" check,
  // and reached the browser as a list of garbage paths.
  //
  // The sentinels are printed in two pieces so a shell echoing the command
  // line back cannot produce a matching pair.
  return `printf '__B64'; printf '_BEGIN__'; { ${inner}; } | base64 | tr -d '\\n'; printf '__B64'; printf '_END__'`;
}

const BEGIN = "__B64_BEGIN__";
const END = "__B64_END__";

/** Decode what base64Command produced, back into paths. */
export function decodeFindOutput(encoded: string): string[] {
  // Take only what sits between the sentinels. Without this the surrounding
  // terminal output is decoded along with the payload.
  const from = encoded.indexOf(BEGIN);
  const to = encoded.indexOf(END, from + 1);
  const payload = from !== -1 && to !== -1 ? encoded.slice(from + BEGIN.length, to) : encoded;

  // Whatever whitespace the terminal added is not part of the payload.
  const clean = payload.replace(/\s+/g, "");
  if (!clean) return [];
  try {
    const decoded = Buffer.from(clean, "base64").toString("utf8");
    // Buffer.from is lenient: it decodes what it can and ignores the rest, so a
    // shell error message where the payload should be comes back as mojibake
    // rather than an exception. A result with no NUL in it was not find output.
    if (!decoded.includes("\0")) return [];
    return parseFindOutput(decoded);
  } catch {
    return [];
  }
}

export type Listdir = (dir: string) => Promise<Array<{ name: string; path: string; type: string }>>;

/**
 * Walk the tree breadth-first, yielding matches as they are found.
 *
 * Breadth-first so a hit near the top of the tree — which is where the file
 * somebody half-remembers usually is — appears immediately, instead of after
 * one deep branch has been exhausted.
 */
export async function* walkFor(
  listdir: Listdir,
  root: string,
  query: string,
  limits: Limits,
  now: () => number = Date.now,
): AsyncGenerator<Hit> {
  const deadline = now() + limits.maxMs;
  const queue: string[] = [root];
  // A bind mount or a symlink can make a directory contain itself. Without
  // this, the walk goes round until the process runs out of stack.
  const seen = new Set<string>([root]);
  let found = 0;

  while (queue.length) {
    if (found >= limits.maxResults || now() > deadline) return;
    const dir = queue.shift()!;

    let entries: Array<{ name: string; path: string; type: string }>;
    try {
      entries = await listdir(dir);
    } catch {
      // One unreadable folder is the ordinary state of a NAS with per-user
      // folders on it, not a reason to abandon the search.
      continue;
    }

    for (const entry of entries) {
      if (entry.type === "DIRECTORY") {
        if (!seen.has(entry.path)) {
          seen.add(entry.path);
          queue.push(entry.path);
        }
        continue;
      }
      if (matches(entry.name, query)) {
        yield hitFor(entry.path);
        found += 1;
        if (found >= limits.maxResults) return;
        if (now() > deadline) return;
      }
    }
  }
}

/**
 * Search, by whichever route this server can take.
 *
 * `find` is tried first and is all-or-nothing: the shell returns when the
 * command finishes, so nothing streams out of it — but it finishes in about a
 * second on a pool where the walk would take a minute, so the operator sees
 * everything at once rather than nothing for a minute.
 *
 * The walk is the fallback, and it does stream. It runs when there is no shell
 * to be had, when find is not there, or when find found nothing but exited
 * non-zero — which is what a permission-denied traversal looks like.
 */
export async function* searchFiles(
  nas: TrueNas,
  conn: Connection,
  root: string,
  query: string,
  limits: Limits,
): AsyncGenerator<Hit> {
  try {
    const result = await runCapture(conn, base64Command(findCommand(root, query)), limits.maxMs);
    if (result.code === 0) {
      const paths = decodeFindOutput(result.output);
      // An exit of 0 with nothing decoded is a genuinely empty result, and
      // reporting it as such is right — falling back to the walk would spend a
      // minute confirming what find already answered.
      for (const p of paths.slice(0, limits.maxResults)) yield hitFor(p);
      return;
    }
  } catch {
    // No shell, no token, or the NAS refused it. The walk needs none of those.
  }

  const listdir: Listdir = (dir) =>
    nas.call<Array<{ name: string; path: string; type: string }>>("filesystem.listdir", [dir]);
  yield* walkFor(listdir, root, query, limits);
}
