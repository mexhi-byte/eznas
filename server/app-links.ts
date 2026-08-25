/**
 * Logos and links for apps TrueNAS did not deploy from its catalog.
 *
 * An app installed from the catalog arrives with `metadata.icon` and a
 * `portals` map. An app deployed from a compose file — which is what the
 * "Custom App" button in the TrueNAS UI produces — arrives with neither, and
 * never will: there is no catalog entry behind it to read them from. On a
 * server where most apps were set up that way, the console showed a wall of
 * coloured letters and no way to open any of them, which reads as the console
 * failing rather than as data that was never sent.
 *
 * Both are recoverable from things the NAS does report: the ports the app is
 * actually listening on, and the catalog entry that shares its name.
 */

/** One exposed port, and where to reach it. */
export interface PortLink {
  port: number;
  url: string;
}

/**
 * The address this browser reaches the NAS on.
 *
 * Taken from the connection the console was configured with, not from the
 * NAS's own `system.info` hostname — that is whatever the machine calls
 * itself, which on a home network is routinely not resolvable from the laptop
 * looking at it. The NAS's own port is dropped: the app has its own.
 */
export function hostOf(connectionUrl: string): string | null {
  try {
    const host = new URL(connectionUrl).hostname;
    if (!host) return null;
    // URL already brackets an IPv6 literal. Bracketing it again produces
    // [[fd00::1]], which resolves to nothing.
    if (host.startsWith("[")) return host;
    return host.includes(":") ? `[${host}]` : host;
  } catch {
    return null;
  }
}

interface Workload {
  host_ports?: Array<{ host_port?: number }>;
}

/**
 * A link for every port the app publishes.
 *
 * Deliberately not one "open this app" URL. Half of these apps are databases —
 * a link to Redis on 6379 opens a tab that will never load, and a button
 * labelled "Open" makes a promise about that which a bare port number does
 * not. The browser renders these as the port chips it already draws.
 */
export function portLinks(host: string | null, workloads: Workload[] | undefined): PortLink[] {
  if (!host) return [];
  const seen = new Set<number>();
  const links: PortLink[] = [];
  for (const w of workloads ?? []) {
    for (const p of w.host_ports ?? []) {
      const port = p.host_port;
      if (typeof port !== "number" || seen.has(port)) continue;
      seen.add(port);
      // http, because that is what an app's own web interface almost always
      // is behind a NAS. Guessing https would break far more of them than it
      // fixed, and the browser upgrades the ones that need it.
      links.push({ port, url: `http://${host}:${port}` });
    }
  }
  return links;
}

/** name (lower-cased) -> icon url, from the catalog. */
export function catalogIconIndex(rows: Array<Record<string, unknown>>): Map<string, string> {
  const index = new Map<string, string>();
  for (const r of rows) {
    const name = typeof r.name === "string" ? r.name.toLowerCase() : null;
    const icon = typeof r.icon_url === "string" && r.icon_url ? r.icon_url : null;
    if (name && icon && !index.has(name)) index.set(name, icon);
  }
  return index;
}

/**
 * The app's own icon, or the catalog's icon for an app of the same name.
 *
 * Matched on the name the app was deployed under, because that is the only
 * thing a compose app and a catalog entry reliably share. Someone who deploys
 * a compose file and calls it "nextcloud" gets the Nextcloud logo; someone who
 * calls it "monitoring" gets a letter, which is correct — the console has no
 * way to know what that is, and inventing a logo for it would be worse than
 * admitting so.
 */
export function iconFor(
  appName: string,
  ownIcon: string | null | undefined,
  index: Map<string, string> | null,
): string | null {
  if (ownIcon) return ownIcon;
  return index?.get(appName.toLowerCase()) ?? null;
}
