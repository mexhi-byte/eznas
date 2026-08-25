/**
 * One catalog app, reduced to what somebody deciding whether to install it
 * actually reads.
 *
 * A mapper rather than a passthrough for two reasons. The rows come from a
 * catalog whose shape moves between TrueNAS versions — `versions` is a map on
 * some and a list on others, `maintainers` holds objects or bare strings — and
 * a field that went missing should leave an empty section in the dialog, not a
 * crashed page. And the raw row carries an `app_readme` of catalog-authored
 * HTML, which is not forwarded: rendering it would mean trusting a third
 * party's markup inside the console.
 */

export interface Maintainer {
  name: string;
  url: string | null;
}

export interface AppDetail {
  name: string;
  title: string;
  train: string | null;
  description: string | null;
  icon: string | null;
  version: string | null;
  categories: string[];
  home: string | null;
  sources: string[];
  screenshots: string[];
  maintainers: Maintainer[];
  /** How many versions exist, which is how far back you could roll. */
  versionCount: number;
  lastUpdated: string | null;
  installed: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

/** Either a list of versions or a map keyed by version, depending on the NAS. */
function countVersions(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
}

function maintainers(v: unknown): Maintainer[] {
  if (!Array.isArray(v)) return [];
  const out: Maintainer[] = [];
  for (const m of v) {
    if (typeof m === "string" && m.trim()) {
      out.push({ name: m, url: null });
      continue;
    }
    if (m && typeof m === "object") {
      const name = str((m as Record<string, unknown>).name);
      // A row with an email and no name renders as a blank line with a link on
      // it, which is worse than leaving the maintainer out.
      if (name) out.push({ name, url: str((m as Record<string, unknown>).url) });
    }
  }
  return out;
}

export function appDetail(row: Record<string, unknown>): AppDetail {
  const name = str(row.name) ?? "";
  return {
    name,
    title: str(row.title) ?? name,
    train: str(row.train),
    description: str(row.description),
    icon: str(row.icon_url),
    // The human version is the one printed on the app's own site; the catalog
    // version is the chart's, which matches nothing the user has seen.
    version: str(row.latest_human_version) ?? str(row.latest_version),
    categories: strings(row.categories),
    home: str(row.home),
    sources: strings(row.sources),
    screenshots: strings(row.screenshots),
    maintainers: maintainers(row.maintainers),
    versionCount: countVersions(row.versions),
    lastUpdated: str(row.last_update),
    installed: row.installed === true,
  };
}
