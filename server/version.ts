import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What this build calls itself.
 *
 * Its own module rather than a constant in index.ts, because index.ts imports
 * monitors.ts and monitors.ts needs this to know whether a published release
 * is newer than what is running. Importing back the other way would be a cycle
 * into the module that starts the server.
 *
 * Read from package.json rather than written out twice: a version kept in step
 * by hand is a version that eventually lies, and the updater compares this
 * against the tags published on GitHub.
 */
const PKG = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  version: string;
  name: string;
};

export const VERSION = PKG.version;
export const CHANNEL = process.env.RELEASE_CHANNEL ?? "demo";
