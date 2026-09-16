import type { TrueNas } from "./truenas.js";

/**
 * The rows the NAS returns, as far as this console reads them, and the small
 * parsers for the value shapes ZFS uses. One module, so a route module and
 * the monitor agree on what a pool row looks like.
 */

export interface PoolRow {
  name: string;
  status: string;
  healthy: boolean;
  size: number;
  allocated: number;
  free: number;
  fragmentation?: string;
  topology?: { data?: VdevRow[]; cache?: VdevRow[]; log?: VdevRow[]; spare?: VdevRow[] };
  scan?: { function?: string; state?: string; percentage?: number; end_time?: { $date: number } } | null;
}
export interface VdevRow {
  type: string;
  status?: string;
  disk?: string | null;
  children?: Array<{ disk?: string | null; status?: string; type?: string }>;
}
export interface AppRow {
  name: string;
  state: string;
  upgrade_available: boolean;
  human_version: string;
  version: string;
  portals?: Record<string, string>;
  active_workloads?: { containers?: number; used_ports?: Array<{ host_ports?: Array<{ host_port: number }> }> };
  metadata?: { icon?: string; title?: string; train?: string; app_version?: string; description?: string };
}
export interface AlertRow {
  uuid: string;
  level: string;
  formatted: string;
  dismissed: boolean;
  datetime: { $date: number };
  klass?: string;
}
export interface DiskRow {
  name: string;
  model: string;
  serial: string;
  size: number;
  type: string;
  rotationrate: number | null;
  pool: string | null;
  imported_zpool?: string | null;
  description?: string;
}

export function summarisePool(p: PoolRow) {
  const disksOf = (v: VdevRow[] = []): string[] =>
    v.flatMap((d) => (d.children?.length ? d.children.map((c) => c.disk ?? "?") : [d.disk ?? "?"]));
  return {
    name: p.name,
    status: p.status,
    healthy: p.healthy,
    size: p.size,
    allocated: p.allocated,
    free: p.free,
    fragmentation: p.fragmentation,
    vdevs: (p.topology?.data ?? []).map((v) => ({
      type: v.type,
      status: v.status,
      disks: v.children?.length
        ? v.children.map((c) => ({ disk: c.disk ?? "?", status: c.status }))
        : [{ disk: v.disk ?? "?", status: v.status }],
    })),
    cache: disksOf(p.topology?.cache),
    log: disksOf(p.topology?.log),
    spare: disksOf(p.topology?.spare),
    scan: p.scan
      ? {
          function: p.scan.function,
          state: p.scan.state,
          percentage: p.scan.percentage,
          endedAt: p.scan.end_time?.$date,
        }
      : null,
  };
}

export const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "parsed" in v) return Number((v as { parsed: unknown }).parsed) || null;
  return null;
};
/**
 * ZFS timestamps, in milliseconds.
 *
 * A parsed `creation` property is not a number — it is `{"$date": 1787569084000}`,
 * already in milliseconds. Treating it as seconds put every snapshot fifty
 * thousand years in the future, which the relative formatter rendered as a
 * blank dash.
 */
export const epochMs = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  if (v && typeof v === "object" && "$date" in v) return Number((v as { $date: unknown }).$date) || null;
  return null;
};

export const sval = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) return String((v as { value: unknown }).value);
  return null;
};

export interface VdevLeaf {
  type?: string;
  status?: string;
  disk?: string | null;
  device?: string | null;
  path?: string;
  children?: VdevLeaf[];
  stats?: {
    read_errors?: number;
    write_errors?: number;
    checksum_errors?: number;
    self_healed?: number;
    size?: number;
    allocated?: number;
    fragmentation?: number;
    ops?: number[];
    bytes?: number[];
  };
}

export interface VdevMember {
  pool: string;
  role: string;
  vdev: string;
  status?: string;
  stats?: VdevLeaf["stats"];
}

/**
 * Find the vdev leaf backed by one device, wherever it sits.
 *
 * Every pool, every role (data, cache, log, spare) and every level of nesting,
 * because a disk in a mirror inside a raidz is two levels down and its error
 * counters are the only place they exist. The leaf names the partition
 * ("sdc1"), so the trailing number is stripped before comparing.
 */
export function vdevMemberOf(pools: PoolRow[], name: string): VdevMember | null {
  let found: VdevMember | null = null;
  for (const p of pools) {
    const topo = (p.topology ?? {}) as Record<string, VdevLeaf[]>;
    for (const [role, vdevs] of Object.entries(topo)) {
      for (const vdev of vdevs ?? []) {
        const walk = (node: VdevLeaf): void => {
          if (node.disk === name || node.device === name || String(node.device ?? "").replace(/\d+$/, "") === name) {
            found = { pool: p.name, role, vdev: vdev.type ?? "stripe", status: node.status, stats: node.stats };
          }
          for (const c of node.children ?? []) walk(c);
        };
        walk(vdev);
      }
    }
  }
  return found;
}

/** pool.scrub and pool.export take the numeric id, not the name shown in the UI. */
export async function poolIdOf(nas: TrueNas, name: string): Promise<number> {
  const rows = await nas.call<Array<{ id: number; name: string }>>("pool.query", [[["name", "=", name]]]);
  if (!rows.length) throw new Error(`There is no pool called "${name}".`);
  return rows[0].id;
}
