/**
 * Exporting a folder to Unix machines.
 *
 * SMB asks which people may use a share; NFS, without Kerberos, cannot answer
 * that question at all. It authenticates the machine — an address or a subnet —
 * and then trusts whatever user id that machine claims. So the access list here
 * is a list of machines, and it is not optional: TrueNAS will happily create an
 * export with no restriction, which is an export to every device on the network.
 */

export interface NfsInput {
  path: string;
  networks: string[];
  hosts: string[];
  readOnly: boolean;
  comment: string;
  maproot: boolean;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const m = IPV4.exec(value);
  // Each octet must be written the way it reads. "010" is 8, not 10, to
  // anything parsing with inet_aton, so an address that survives here means
  // the same subnet to the NAS as it did to the person who typed it.
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}

/** An address with a prefix length: 192.168.1.0/24, fd00::/64. */
export function isNetwork(value: string): boolean {
  const at = value.lastIndexOf("/");
  if (at <= 0) return false;
  const addr = value.slice(0, at);
  const prefix = value.slice(at + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (isIpv4(addr)) return bits <= 32;
  // IPv6, loosely: hex groups and at most one "::". Anything this lets through
  // the NAS rejects itself, with its own message.
  if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(":")) return bits <= 128;
  return false;
}

/** A single machine: an address, or a name the NAS can resolve. */
export function isHost(value: string): boolean {
  if (!value || /[\s/]/.test(value)) return false;
  if (isIpv4(value)) return true;
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(":")) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(value);
}

const clean = (list: string[]): string[] => list.map((s) => s.trim()).filter(Boolean);

export function nfsPayload(input: NfsInput): Record<string, unknown> {
  const networks = clean(input.networks);
  const hosts = clean(input.hosts);

  if (!networks.length && !hosts.length) {
    throw new Error(
      "Say which machines may mount this. An export with no restriction is open to every device on the network.",
    );
  }
  for (const n of networks) {
    if (!isNetwork(n)) {
      throw new Error(`"${n}" is not a network. Use an address and a prefix, like 192.168.1.0/24.`);
    }
  }
  for (const h of hosts) {
    if (!isHost(h)) throw new Error(`"${h}" is not a machine address or name.`);
  }

  const payload: Record<string, unknown> = {
    path: input.path,
    networks,
    hosts,
    ro: input.readOnly,
    comment: input.comment,
    enabled: true,
  };

  /*
   * Root squashing, left on unless someone turns it off on purpose.
   *
   * maproot_user: "root" means anyone with root on any allowed machine writes
   * as root here. It is the advice in every forum thread about NFS permissions
   * because it makes the symptom go away, and it is why an NFS export is so
   * often the least protected thing on a NAS.
   */
  if (input.maproot) {
    payload.maproot_user = "root";
    payload.maproot_group = "root";
  }

  return payload;
}
