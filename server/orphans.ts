/**
 * What deleting a group would leave behind.
 *
 * TrueNAS deletes a group and says nothing about the ACL entries that named
 * it. Every shared folder that granted the group access keeps an entry
 * pointing at a numeric id nobody owns — invisible in any list, and the next
 * group to receive that id inherits access to folders nobody meant to give
 * it. Pure logic over data the route fetches, so the rule can be tested
 * without a NAS.
 */

export interface AclLike {
  acl: Array<{ tag: string; id: number }>;
}

export interface SharePath {
  name: string;
  path: string;
}

/** The shares whose folder ACL grants anything to this group id. */
export function referencedBy(gid: number, acls: Map<string, AclLike>, shares: SharePath[]): SharePath[] {
  const out: SharePath[] = [];
  const seen = new Set<string>();
  for (const share of shares) {
    const acl = acls.get(share.path);
    if (!acl) continue;
    const names = acl.acl.some((e) => e.tag === "GROUP" && e.id === gid);
    if (!names || seen.has(share.path)) continue;
    seen.add(share.path);
    out.push(share);
  }
  return out;
}

/** A sentence for the confirmation dialog, or null when nothing is affected. */
export function orphanWarning(group: string, affected: SharePath[]): string | null {
  if (!affected.length) return null;
  const n = affected.length;
  const list = affected.map((s) => s.name).join(", ");
  return (
    `${group} has access to ${n} shared folder${n === 1 ? "" : "s"}: ${list}. ` +
    `Deleting it leaves ${n === 1 ? "that folder" : "those folders"} granting access to a numeric id that no longer ` +
    `exists — and to whichever group is created with that id next.`
  );
}
