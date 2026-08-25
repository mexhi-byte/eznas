import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrueNas } from "../truenas.js";
import { bodyOf, confirmed, json, optStr, str, underMnt } from "../http.js";
import { levelToPerms, type AclEntry } from "../acl.js";
import { nfsPayload } from "../nfs.js";

/**
 * Everything under /api/shares that creates or changes one.
 *
 * Lifted out of index.ts for the same reason the file routes were: the
 * if-chain there had grown past the point where anyone could see the shape of
 * it. The read route (`case "/api/shares"`) stays behind in the switch — it
 * reads SMB and NFS together and moving it means restructuring the switch.
 */

export interface ShareRouteContext {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  nas: TrueNas;
}

/** True if this request was one of ours. */
export async function handleShareRoutes(ctx: ShareRouteContext): Promise<boolean> {
  const { path, method, req, res, nas } = ctx;

  /* --- shares --- */

  /**
   * One share, with the permissions that make it work.
   *
   * Creating an SMB share and setting who can reach it are two unrelated calls
   * on the NAS, and doing only the first is the classic homelab dead end: the
   * folder appears on the network and then refuses everybody, because the
   * share is not what grants access — the filesystem ACL is. This does both,
   * in the order that leaves nothing half-done.
   */
  const shareMatch = /^\/api\/shares\/smb\/(\d+)$/.exec(path);
  if (shareMatch) {
    const id = Number(shareMatch[1]);
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "name")) patch.name = optStr(b, "name");
      if (optStr(b, "comment") !== undefined) patch.comment = optStr(b, "comment") ?? "";
      if (b.enabled !== undefined) patch.enabled = b.enabled === true;
      if (b.readOnly !== undefined) {
        patch.ro = b.readOnly === true;
        // The purpose preset overwrites individual flags, so read-only only
        // survives when the share carries no preset.
        if (b.readOnly === true) patch.purpose = "NO_PRESET";
      }
      json(res, 200, await nas.call("sharing.smb.update", [id, patch]));
      return true;
    }
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const [existing] = await nas.call<Array<{ name: string }>>("sharing.smb.query", [[["id", "=", id]]]);
      if (!existing) throw new Error("There is no such share.");
      confirmed(b, existing.name);
      await nas.call("sharing.smb.delete", [id]);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (path === "/api/shares/smb" && method === "POST") {
    const b = await bodyOf(req);
    const target = underMnt(str(b, "path"));
    // The purpose presets overwrite individual flags — asking for DEFAULT_SHARE
    // and read-only produced a writable share, silently. NO_PRESET is the only
    // way the ro flag survives the create.
    const readOnly = b.readOnly === true;
    const share = await nas.call<Record<string, unknown>>("sharing.smb.create", [{
      name: str(b, "name"),
      path: target,
      purpose: optStr(b, "purpose") ?? (readOnly ? "NO_PRESET" : "DEFAULT_SHARE"),
      comment: optStr(b, "comment") ?? "",
      ro: readOnly,
      browsable: true,
      enabled: true,
    }]);
    if (readOnly && share.ro !== true) {
      throw new Error("The NAS created the share but would not make it read-only. Check it under Shared folders.");
    }
    // A share nobody can reach is not a share. SMB is off by default on a
    // fresh install, and the failure it produces — the folder simply not
    // appearing on the network — gives no clue why.
    const [cifs] = await nas.call<Array<{ state: string }>>("service.query", [[["service", "=", "cifs"]]]);
    let started = false;
    if (cifs?.state !== "RUNNING" && b.startService !== false) {
      await nas.call("service.update", [{ service: "cifs" }, { enable: true }]).catch(() => nas.call("service.update", ["cifs", { enable: true }]));
      await nas.call("service.start", ["cifs"]);
      started = true;
    }

    /*
     * Now make it actually reachable.
     *
     * A share is only a name pointing at a folder; whether anyone can open it
     * is decided by the folder's ACL. Every dataset here starts owned by root
     * with everybody-else set to read-only, so a freshly shared folder is
     * visible on the network and refuses every write — which reads as "SMB is
     * broken" rather than "nobody has been given access".
     */
    const grants = Array.isArray(b.access) ? (b.access as Array<Record<string, unknown>>) : [];
    let permissions: number | null = null;
    if (grants.length) {
      const named = grants.map((g) => ({
        tag: g.kind === "group" ? "GROUP" : "USER",
        id: Number(g.id),
        perms: levelToPerms(String(g.level ?? "read")),
        default: false,
      }));
      const mask = named.reduce(
        (acc, e) => ({ READ: acc.READ || e.perms.READ, WRITE: acc.WRITE || e.perms.WRITE, EXECUTE: acc.EXECUTE || e.perms.EXECUTE }),
        { READ: true, WRITE: false, EXECUTE: true },
      );
      const dacl: AclEntry[] = [
        { tag: "USER_OBJ", id: -1, perms: levelToPerms("full"), default: false },
        { tag: "GROUP_OBJ", id: -1, perms: levelToPerms("read"), default: false },
        ...named,
        { tag: "MASK", id: -1, perms: mask, default: false },
        // Everybody else gets nothing: naming who may use a share and leaving
        // it open to all is worse than not asking at all.
        { tag: "OTHER", id: -1, perms: levelToPerms("none"), default: false },
      ];
      for (const e of [...dacl]) dacl.push({ ...e, default: true });
      permissions = await nas.startJob("filesystem.setacl", [{
        path: target, dacl, acltype: "POSIX1E", options: { recursive: b.recursive === true, traverse: false },
      }]);
    }

    json(res, 200, { share, startedService: started, permissionsJobId: permissions });
    return true;
  }

  if (path === "/api/shares/nfs" && method === "POST") {
    const b = await bodyOf(req);
    const target = underMnt(str(b, "path"));

    // Built and validated before anything is created, so a bad machine list
    // cannot leave a half-made export behind or start a service for nothing.
    const payload = nfsPayload({
      path: target,
      networks: Array.isArray(b.networks) ? (b.networks as unknown[]).map(String) : [],
      hosts: Array.isArray(b.hosts) ? (b.hosts as unknown[]).map(String) : [],
      readOnly: b.readOnly === true,
      comment: optStr(b, "comment") ?? "",
      maproot: b.maproot === true,
    });

    const share = await nas.call<Record<string, unknown>>("sharing.nfs.create", [payload]);

    /*
     * An export nobody can reach is not an export.
     *
     * The NFS service is off on a fresh install, and the failure it produces is
     * a mount that hangs and then times out — which reads as a network problem
     * rather than as a service that was never started.
     */
    const [nfs] = await nas.call<Array<{ state: string }>>("service.query", [[["service", "=", "nfs"]]]);
    let started = false;
    if (nfs?.state !== "RUNNING" && b.startService !== false) {
      await nas.call("service.update", [{ service: "nfs" }, { enable: true }])
        .catch(() => nas.call("service.update", ["nfs", { enable: true }]));
      await nas.call("service.start", ["nfs"]);
      started = true;
    }

    /*
     * And now make it writable, if it is meant to be.
     *
     * Without maproot, an NFS client writes as whatever uid it claims, and the
     * folder's own POSIX permissions decide the rest. A dataset starts owned by
     * root with group and other read-only, so a read-write export that nobody
     * adjusted is a folder that mounts and then refuses every write.
     */
    let permissions: number | null = null;
    const groupId = typeof b.group === "number" ? b.group : null;
    if (!payload.ro && groupId !== null) {
      permissions = await nas.startJob("filesystem.setperm", [{
        path: target,
        gid: groupId,
        mode: "775",
        options: { recursive: b.recursive === true, traverse: false },
      }]);
    }

    json(res, 200, { share, startedService: started, permissionsJobId: permissions });
    return true;
  }

  /*
   * Removing an export.
   *
   * Named to confirm, like every other destructive action here: the path is
   * what the operator sees in the list, so the path is what they type. The
   * folder and everything in it is untouched — only the export goes.
   */
  const nfsMatch = /^\/api\/shares\/nfs\/(\d+)$/.exec(path);
  if (nfsMatch && method === "DELETE") {
    const id = Number(nfsMatch[1]);
    const b = await bodyOf(req);
    const [existing] = await nas.call<Array<{ path: string }>>("sharing.nfs.query", [[["id", "=", id]]]);
    if (!existing) throw new Error("There is no such export.");
    confirmed(b, existing.path);
    await nas.call("sharing.nfs.delete", [id]);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
