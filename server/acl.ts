/**
 * POSIX ACL shapes, and the three levels the console offers.
 *
 * Shared between the file permissions editor and share creation: setting up a
 * share writes an ACL too, because a share whose folder grants nobody anything
 * appears on the network and then refuses every write.
 */

export interface AclPerms { READ?: boolean; WRITE?: boolean; EXECUTE?: boolean }
export interface AclEntry { tag: string; id: number; who?: string | null; perms: Required<AclPerms>; default: boolean }
export interface AclResult {
  path: string; uid: number; gid: number; acltype: string; trivial: boolean;
  acl: Array<{ tag: string; id: number; who?: string | null; perms?: AclPerms; default?: boolean }>;
}

/**
 * Three levels, because nobody wants to reason about the execute bit.
 *
 * On a directory the execute bit is what allows entering it at all, so "read"
 * without it produces a folder somebody can see and not open — the single most
 * confusing permission state there is. Read therefore always carries execute.
 */
export function levelToPerms(level: string): Required<AclPerms> {
  switch (level) {
    case "none": return { READ: false, WRITE: false, EXECUTE: false };
    case "write": return { READ: true, WRITE: true, EXECUTE: true };
    case "full": return { READ: true, WRITE: true, EXECUTE: true };
    default: return { READ: true, WRITE: false, EXECUTE: true };
  }
}
