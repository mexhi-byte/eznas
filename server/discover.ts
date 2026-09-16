import { readFileSync } from "node:fs";

/**
 * Where the NAS probably is, when this console runs on it.
 *
 * Installed as a TrueNAS app or through install.sh, the console runs in a
 * container on the NAS itself, and the NAS is then the container's default
 * gateway: the one address that is always right there. Offering it saves the
 * first-run wizard's first question for most people, and costs nothing when
 * the guess is wrong — it is a suggestion, shown with the certificate found
 * at that address, never a default that is saved unseen.
 */

/**
 * The default gateway in a Linux /proc/net/route table, or null.
 *
 * The table is hex, little-endian, one line per route. The default route is
 * the one whose destination is 0.0.0.0 with the gateway flag (0x2) set.
 */
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [, destination, gateway, flags] = cols;
    if (destination !== "00000000") continue;
    if ((parseInt(flags, 16) & 0x2) === 0) continue;
    if (!/^[0-9a-fA-F]{8}$/.test(gateway)) continue;
    const bytes = gateway.match(/../g)!.map((h) => parseInt(h, 16));
    return bytes.reverse().join(".");
  }
  return null;
}

/** Candidate NAS addresses, most likely first. Empty when nothing suggests itself. */
export function candidateHosts(): string[] {
  const out: string[] = [];
  try {
    const gw = defaultGateway(readFileSync("/proc/net/route", "utf8"));
    if (gw) out.push(gw);
  } catch {
    // Not Linux, or not permitted to read it. Then there is no suggestion,
    // which is fine: the wizard asks.
  }
  return out;
}
