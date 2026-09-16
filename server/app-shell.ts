import { shellQuote } from "./nas-exec.js";

/**
 * Turning "show me this app's logs" into a command, without the browser
 * ever sending one.
 *
 * TrueNAS's shell endpoint accepts a command to run in place of a login
 * shell. The browser supplies a mode and a container id; this file turns
 * those into the command. It never accepts a command: a pass-through
 * parameter on an endpoint that already reaches root would be a remote
 * shell dressed as a log viewer, and would read as perfectly reasonable in
 * review. The id is validated to a shape that cannot carry a quote, a space
 * or a newline, and quoted anyway.
 */

export type ConsoleMode = "logs" | "exec";

export function isConsoleMode(value: string | null | undefined): value is ConsoleMode {
  return value === "logs" || value === "exec";
}

/** A Docker container id: 12 to 64 hex characters, nothing else. */
export function isContainerId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{12,64}$/.test(value);
}

/** An app name as TrueNAS allows them: lower-case, digits, dashes. */
export function isAppName(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

export function commandFor(mode: ConsoleMode, containerId: string): string {
  if (!isContainerId(containerId)) {
    throw new Error("That container id is not one this console will run a command against.");
  }
  const id = shellQuote(containerId);
  if (mode === "logs") {
    // The last two hundred lines, then follow. Timestamps because the point
    // of reading logs is usually "when did this start".
    return `docker logs --tail 200 --timestamps --follow ${id}`;
  }
  // bash where the image has it, sh where it does not — Alpine images ship
  // only sh, and a shell that fails to start is indistinguishable from a
  // container that is dead.
  return `docker exec -it ${id} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}
