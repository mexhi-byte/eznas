/**
 * What to call an app.
 *
 * TrueNAS gives every app deployed from a compose file the metadata title
 * "Custom App" — not a missing title, the same title for all of them. So a
 * `metadata.title ?? name` fallback never fires, and a console with fifteen
 * custom apps shows fifteen tiles reading "Custom App", each with a "C" for an
 * icon because the icon falls back to the first letter of the name.
 *
 * The name the operator typed when they deployed it is right there in `name`,
 * and it is the only thing that tells one of those apps from another.
 */

/**
 * Titles TrueNAS hands out that identify a category rather than an app.
 *
 * Compared lower-cased and trimmed. Kept as an explicit list rather than a
 * pattern: a new generic title should be a deliberate addition here, not
 * something a regex quietly swallows along with a real app called
 * "Custom Radarr".
 */
const GENERIC_TITLES = new Set(["custom app", "custom-app", "customapp", "custom"]);

/**
 * "wg-easy" -> "Wg Easy", "nextcloud" -> "Nextcloud".
 *
 * Only ever applied to a name being used *because* no real title exists, so it
 * cannot overwrite what a catalog author chose to call their app.
 */
function prettify(name: string): string {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  if (!words.length) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function appTitle(name: string, metadataTitle?: string | null): string {
  const title = (metadataTitle ?? "").trim();
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return prettify(name);
  return title;
}

/**
 * Whether TrueNAS is describing a category rather than this particular app.
 *
 * Exposed so the front end can say "custom app" as a quiet subtitle under the
 * real name, rather than losing that information entirely.
 */
export function isCustomApp(metadataTitle?: string | null): boolean {
  return GENERIC_TITLES.has((metadataTitle ?? "").trim().toLowerCase());
}
