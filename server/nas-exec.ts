import { WebSocket } from "ws";
import * as store from "./store.js";

/**
 * Running a command on the NAS.
 *
 * This exists because TrueNAS 25.04's JSON-RPC API cannot move, rename or
 * delete a file. It has filesystem.mkdir, get, put, stat, listdir, chown and
 * setperm — and nothing else. Every other way of reorganising a folder goes
 * through a shell, so that is what this does, over the same /websocket/shell
 * endpoint the terminal page uses.
 *
 * Three things make it safe enough to build on:
 *
 *  - Arguments are single-quoted with embedded quotes escaped, and callers
 *    confine every path to /mnt before it gets here. Nothing is interpolated
 *    raw.
 *  - Terminal echo is turned off before the command is sent, so the sudo
 *    password never appears in the output stream, and HISTFILE is unset so the
 *    command never lands in the account's shell history.
 *  - sudo is invoked with -k, which discards any cached credential and
 *    guarantees the password prompt. Without it a cached sudo would consume no
 *    password and the shell would execute the password line as a command.
 */

/** Single-quote a string for the shell, escaping any quote inside it. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Reject anything that could break out of the quoting or confuse the protocol.
 *
 * A newline in a path would end the command line early and start a second one;
 * a carriage return would do the same. Neither is legal in a path that this
 * console will ever have listed, so refusing them costs nothing.
 */
export function safePath(path: string): string {
  if (/[\r\n\0]/.test(path)) throw new Error("That path contains a character that cannot be used.");
  return path;
}

export interface CommandResult {
  code: number;
  output: string;
}

const CONNECT_WAIT = 700;
const STEP_WAIT = 350;
const TIMEOUT = 30_000;

/**
 * Run one command as root and return its exit status.
 *
 * The marker is printed in two pieces so that the shell's own echo of the
 * command — which contains the literal source text — can never be mistaken for
 * the command having finished.
 */
export async function run(conn: store.Connection, command: string): Promise<CommandResult> {
  const password = store.sudoPasswordFor(conn);
  if (!password) {
    throw new Error(
      "This needs the NAS account's password, which is not saved for this server. Add it under Settings → Servers.",
    );
  }

  const token = await store.clientFor(conn).call<string>("auth.generate_token", [300, {}, false]);
  const target = conn.url.replace(/\/api\/current$/, "/websocket/shell");

  return await new Promise<CommandResult>((resolve, reject) => {
    const ws = new WebSocket(target, { rejectUnauthorized: false });
    const send = (text: string) => ws.send(Buffer.from(text, "utf8"), { binary: true });
    let buffer = "";
    let ready = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error("The NAS did not answer in time."))),
      TIMEOUT,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ token, options: { command: "", tty_size: { rows: 24, cols: 400 } } }));
    });

    ws.on("message", (raw) => {
      const text = raw.toString();

      if (!ready) {
        if (!text.includes('"connected"')) return;
        ready = true;
        // Echo off before anything sensitive is typed.
        setTimeout(() => send("unset HISTFILE; stty -echo\r"), CONNECT_WAIT);
        setTimeout(() => {
          send(
            `sudo -k -S -p '' -- ${command}; __rc=$?; stty echo; ` +
              `printf '\\n__TNUI'; printf '_RC_%s__\\n' "$__rc"\r`,
          );
        }, CONNECT_WAIT + STEP_WAIT);
        setTimeout(() => send(`${password}\r`), CONNECT_WAIT + STEP_WAIT * 2);
        return;
      }

      buffer += text;
      const done = /__TNUI_RC_(\d+)__/.exec(buffer);
      if (done) finish(() => resolve({ code: Number(done[1]), output: clean(buffer, password) }));
    });

    ws.on("error", (e) => finish(() => reject(new Error(`Could not reach the NAS shell: ${e.message}`))));
    ws.on("close", () =>
      finish(() => reject(new Error("The NAS closed the shell before the command finished."))),
    );
  });
}

/**
 * Run a command as the API user and hand back everything it printed.
 *
 * Deliberately not built on top of run() above, and not the other way round.
 * That one exists to get a short error message out of a command that failed,
 * so it uses sudo, needs the stored password, and keeps only the last few
 * lines. This one exists to collect a command's whole output, needs no
 * password, and must not lose a byte of it. Sharing a body would mean five
 * flags deciding which of two functions you actually get, and the sudo path is
 * the one that moves and deletes files — not somewhere to take a chance on a
 * refactor that cannot be tested without a NAS to hand.
 *
 * The caller is expected to make the output terminal-safe; this arrives over a
 * pseudo-terminal, which mangles anything that looks like a control code. See
 * base64Command in search.ts.
 */
export async function runCapture(
  conn: store.Connection,
  command: string,
  timeoutMs = TIMEOUT,
): Promise<CommandResult> {
  const token = await store.clientFor(conn).call<string>("auth.generate_token", [300, {}, false]);
  const target = conn.url.replace(/\/api\/current$/, "/websocket/shell");

  return await new Promise<CommandResult>((resolve, reject) => {
    const ws = new WebSocket(target, { rejectUnauthorized: false });
    const send = (text: string) => ws.send(Buffer.from(text, "utf8"), { binary: true });
    let buffer = "";
    let ready = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error("The NAS did not answer in time."))),
      timeoutMs,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ token, options: { command: "", tty_size: { rows: 24, cols: 400 } } }));
    });

    ws.on("message", (raw) => {
      const text = raw.toString();

      if (!ready) {
        if (!text.includes('"connected"')) return;
        ready = true;
        setTimeout(() => send("unset HISTFILE; stty -echo\r"), CONNECT_WAIT);
        setTimeout(() => {
          // Same two-piece marker as run(): the shell echoes the command line
          // itself, and a one-piece marker in that echo would look like the
          // command having already finished.
          send(
            `${command}; __rc=$?; stty echo; printf '\\n__TNUI'; printf '_RC_%s__\\n' "$__rc"\r`,
          );
        }, CONNECT_WAIT + STEP_WAIT);
        return;
      }

      buffer += text;
      const done = /__TNUI_RC_(\d+)__/.exec(buffer);
      if (done) {
        finish(() => resolve({ code: Number(done[1]), output: between(buffer) }));
      }
    });

    ws.on("error", (e) => finish(() => reject(new Error(`Could not reach the NAS shell: ${e.message}`))));
    ws.on("close", () =>
      finish(() => reject(new Error("The NAS closed the shell before the command finished."))),
    );
  });
}

/**
 * What the command printed, without the shell's own noise around it.
 *
 * Everything before the echoed command line is the login banner and the
 * prompt; everything from the marker on is the marker. Escape sequences are
 * stripped for the same reason clean() strips them, but nothing else is
 * dropped — the caller asked for the whole output.
 */
function between(raw: string): string {
  const end = raw.indexOf("__TNUI_RC_");
  const body = end === -1 ? raw : raw.slice(0, end);
  return body
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[>=]/g, "")
    .replace(/\r/g, "");
}

/**
 * The readable part of what the shell said.
 *
 * Terminal output is full of cursor moves, colour codes and the prompt being
 * redrawn. What a caller wants is the one line where mv explained itself. The
 * password is scrubbed as a belt-and-braces measure: echo is already off, but
 * this string must never be the thing that leaks it.
 */
function clean(raw: string, password: string): string {
  return raw
    .split(password).join("********")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[>=]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("__TNUI") && !/^%?\s*$/.test(l) && !/\[~\]\$/.test(l))
    .slice(-4)
    .join("; ");
}

/**
 * Move one path to another, refusing to replace anything.
 *
 * `mv -n` alone is not enough to report on: it declines to overwrite, which is
 * the behaviour we want, but it then exits 0 exactly as if it had moved the
 * file. A caller cannot tell the two apart, so a refused move was reported to
 * the browser as a completed one and the file appeared not to have moved for
 * no stated reason.
 *
 * Testing for the destination first gives a distinct exit code to report. The
 * -n stays as the guarantee: if something does appear in the gap between the
 * test and the move, the worst case is a move that quietly does not happen,
 * never one that overwrites.
 */
const MOVE_SCRIPT = 'if [ -e "$2" ]; then exit 17; fi; exec mv -n -- "$1" "$2"';
export const EXISTS = 17;

export const moveCommand = (from: string, to: string): string =>
  `sh -c ${shellQuote(MOVE_SCRIPT)} mv ${shellQuote(from)} ${shellQuote(to)}`;

/**
 * Move into the recycle bin, keeping the original location.
 *
 * Two things have to survive a delete for a restore to be possible: what the
 * thing was called, and where it lived. The bin therefore mirrors the original
 * path underneath it — /mnt/tank/photos/cat.jpg becomes
 * /mnt/tank/.recycle/photos/cat.jpg — so restoring is the same move backwards
 * and needs no index file that could drift out of step with the folder.
 *
 * A name that already exists in the bin gets a suffix rather than replacing
 * what is there: deleting two different files with the same name a week apart
 * must not lose the first one.
 */
const RECYCLE_SCRIPT = [
  'set -e',
  'dst="$2"',
  'mkdir -p "$(dirname "$dst")"',
  'if [ -e "$dst" ]; then dst="$dst.$(date +%Y%m%d-%H%M%S)"; fi',
  'exec mv -- "$1" "$dst"',
].join("; ");

export const recycleCommand = (from: string, to: string): string =>
  `sh -c ${shellQuote(RECYCLE_SCRIPT)} recycle ${shellQuote(from)} ${shellQuote(to)}`;

/** Empty a bin. Confined to a path ending in /.recycle by the caller. */
export const emptyBinCommand = (bin: string): string =>
  `sh -c ${shellQuote('rm -rf -- "$1"/* "$1"/.[!.]* 2>/dev/null; exit 0')} empty ${shellQuote(bin)}`;

/** Turn a non-zero exit into the message the shell actually printed. */
export function orThrow(result: CommandResult, fallback: string): void {
  if (result.code === 0) return;
  if (result.code === EXISTS) throw new Error("Something with that name is already there.");
  const said = result.output.replace(/^.*?:\s*(?=cannot|failed|permission)/i, "");
  throw new Error(said || `${fallback} (exit ${result.code})`);
}
