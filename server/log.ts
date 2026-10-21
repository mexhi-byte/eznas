/**
 * One place every operational log line comes out of.
 *
 * The console was growing a shelf of `console.log("[module] ...")` calls, one
 * shape per author, which made two things awkward: an operator who piped
 * everything into a drain had to parse each flavour back into fields by hand,
 * and a reader skimming the output could not tell at a glance which lines were
 * errors — `[truenas] login failed` and `[truenas] connected and subscribed`
 * both arrived on stdout with no level in the line.
 *
 * This module takes a level, a short module name and a message, and emits
 * either the human line (`[truenas] connected and subscribed`) that the shelf
 * already had or, when `LOG_FORMAT=json` is set, one JSON object per line with
 * `ts`, `level`, `mod`, `msg` and `detail`. info goes to stdout; warn and
 * error go to stderr — matching the semantics console.log/warn/error already
 * had, so an existing systemd unit that split stdout and stderr still works.
 *
 * Errors passed as the `detail` argument are flattened to their `message` in
 * text mode and to `{message, stack}` in JSON — a bare `Error` serialises to
 * `{}` otherwise, which has filled many a log drain with nothing.
 */

export type Level = "info" | "warn" | "error";

const asJson = (): boolean => process.env.LOG_FORMAT === "json";

function flatten(detail: unknown): unknown {
  if (detail instanceof Error) {
    // The stack carries the message, so one of the two would be redundant.
    // Keep both: tooling splits on `\n` to show the first line, which is why
    // the message is held separately rather than inferred from the stack.
    return { message: detail.message, stack: detail.stack ?? null };
  }
  return detail;
}

function emit(level: Level, mod: string, msg: string, detail: unknown): void {
  const line = asJson()
    ? JSON.stringify({
        ts: new Date().toISOString(),
        level,
        mod,
        msg,
        ...(detail === undefined ? {} : { detail: flatten(detail) }),
      }) + "\n"
    : (() => {
        const tail =
          detail === undefined
            ? ""
            : detail instanceof Error
              ? `: ${detail.message}`
              : typeof detail === "string"
                ? `: ${detail}`
                : `: ${JSON.stringify(detail)}`;
        return `[${mod}] ${msg}${tail}\n`;
      })();
  if (level === "info") process.stdout.write(line);
  else process.stderr.write(line);
}

export const info = (mod: string, msg: string, detail?: unknown): void => emit("info", mod, msg, detail);
export const warn = (mod: string, msg: string, detail?: unknown): void => emit("warn", mod, msg, detail);
export const error = (mod: string, msg: string, detail?: unknown): void => emit("error", mod, msg, detail);
