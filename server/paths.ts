import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the console keeps its own state.
 *
 * Five modules each hard-coded a default under /opt/truenas-ui/data — the
 * project's first name — and each read its own environment variable to move
 * it. Renaming the default without care would have made an existing source
 * install come up with no servers, no accounts and no settings, which looks
 * exactly like data loss. So the old directory is still honoured: it is used
 * whenever it exists and the new one does not.
 *
 * DATA_DIR moves everything at once. The per-file variables still work and
 * win over it, because the Dockerfile and any hand-written unit file set them.
 */
const DEFAULT_DIR = "/opt/eznas/data";
const LEGACY_DIR = "/opt/truenas-ui/data";

let chosen: string | null = null;

export function dataDir(): string {
  if (chosen) return chosen;
  const env = process.env.DATA_DIR?.trim();
  if (env) chosen = env;
  else if (!existsSync(DEFAULT_DIR) && existsSync(LEGACY_DIR)) chosen = LEGACY_DIR;
  else chosen = DEFAULT_DIR;
  return chosen;
}

/** The path for one state file: its own variable if set, else a name under the data directory. */
export function dataFile(envName: string, filename: string): string {
  const own = process.env[envName]?.trim();
  return own || join(dataDir(), filename);
}
