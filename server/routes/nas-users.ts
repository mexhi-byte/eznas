import { bodyOf, confirmed, json, optStr, str } from "../http.js";
import { orphanWarning, referencedBy, type AclLike } from "../orphans.js";
import type { TrueNas } from "../truenas.js";
import type { NasRouteContext } from "./context.js";

/**
 * The NAS's own users and groups — the household's accounts — as distinct
 * from the console's sign-ins, which live in routes/console.ts.
 */

export async function handleNasUserRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas } = ctx;

  /* --- users and groups --- */
  if (path === "/api/users") {
    if (method === "GET") {
      const showBuiltin = url.searchParams.get("builtin") === "1";
      const users = await nas.call<Array<Record<string, unknown>>>("user.query", [[["local", "=", true]]]);
      json(
        res,
        200,
        users
          .filter((u) => showBuiltin || !u.builtin)
          .map((u) => ({
            id: u.id,
            uid: u.uid,
            username: u.username,
            fullName: u.full_name,
            email: u.email,
            shell: u.shell,
            home: u.home,
            locked: u.locked,
            builtin: u.builtin,
            smb: u.smb,
            sudo: (u.sudo_commands as string[])?.length > 0,
            groups: u.groups,
          })),
      );
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = {
        username: str(b, "username"),
        full_name: optStr(b, "fullName") ?? str(b, "username"),
        // A new account gets its own group unless one was named, which is the
        // behaviour people expect from useradd and avoids everyone sharing one.
        group_create: !b.group,
        home_create: b.homeCreate === true,
        smb: b.smb !== false,
      };
      if (b.group) payload.group = Number(b.group);
      if (optStr(b, "password")) payload.password = optStr(b, "password");
      else payload.password_disabled = true;
      if (optStr(b, "email")) payload.email = optStr(b, "email");
      if (optStr(b, "shell")) payload.shell = optStr(b, "shell");
      if (optStr(b, "sshpubkey")) payload.sshpubkey = optStr(b, "sshpubkey");
      json(res, 200, safeUser(await nas.call("user.create", [payload])));
      return true;
    }
  }

  const userMatch = /^\/api\/users\/(\d+)$/.exec(path);
  if (userMatch) {
    const id = Number(userMatch[1]);
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "fullName")) patch.full_name = optStr(b, "fullName");
      if (optStr(b, "email")) patch.email = optStr(b, "email");
      if (optStr(b, "shell")) patch.shell = optStr(b, "shell");
      if (optStr(b, "password")) patch.password = optStr(b, "password");
      if (typeof b.locked === "boolean") patch.locked = b.locked;
      if (typeof b.smb === "boolean") patch.smb = b.smb;
      json(res, 200, safeUser(await nas.call("user.update", [id, patch])));
      return true;
    }
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const users = await nas.call<Array<Record<string, unknown>>>("user.query", [[["id", "=", id]]]);
      const username = String(users[0]?.username ?? "");
      confirmed(b, username);
      json(res, 200, await nas.call("user.delete", [id, { delete_group: b.deleteGroup === true }]));
      return true;
    }
  }

  if (path === "/api/groups") {
    if (method === "GET") {
      const groups = await nas.call<Array<Record<string, unknown>>>("group.query", [[["local", "=", true]]]);
      json(
        res,
        200,
        groups.map((g) => ({
          id: g.id,
          gid: g.gid,
          name: g.group,
          builtin: g.builtin,
          smb: g.smb,
          users: (g.users as unknown[])?.length ?? 0,
          // The member ids themselves, so the editor can show who is in it
          // rather than only how many.
          members: Array.isArray(g.users) ? (g.users as number[]) : [],
        })),
      );
      return true;
    }
    if (method === "POST") {
      const b = await bodyOf(req);
      const payload: Record<string, unknown> = {
        name: groupName(str(b, "name")),
        smb: b.smb !== false,
        users: memberIds(b.members),
      };
      json(res, 200, { id: await nas.call<number>("group.create", [payload]) });
      return true;
    }
  }

  const groupOrphans = /^\/api\/groups\/(\d+)\/orphans$/.exec(path);
  if (groupOrphans && method === "GET") {
    json(res, 200, await orphansOf(nas, Number(groupOrphans[1])));
    return true;
  }

  const groupMatch = /^\/api\/groups\/(\d+)$/.exec(path);
  if (groupMatch) {
    const id = Number(groupMatch[1]);
    if (method === "PUT") {
      const b = await bodyOf(req);
      const patch: Record<string, unknown> = {};
      if (optStr(b, "name")) patch.name = groupName(str(b, "name"));
      if (b.members !== undefined) patch.users = memberIds(b.members);
      if (typeof b.smb === "boolean") patch.smb = b.smb;
      json(res, 200, { id: await nas.call<number>("group.update", [id, patch]) });
      return true;
    }
    if (method === "DELETE") {
      const b = await bodyOf(req);
      const [group] = await nas.call<Array<Record<string, unknown>>>("group.query", [[["id", "=", id]]]);
      if (!group) throw new Error("There is no such group.");
      if (group.builtin === true) throw new Error(`${String(group.group)} is built in and cannot be deleted.`);
      // The name typed back, like every other deletion. The warning about
      // orphaned folders was shown before this point; the route's job is only
      // to make sure the name was meant.
      confirmed(b, String(group.group));
      await nas.call("group.delete", [id, { delete_users: false }]);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (path === "/api/shells") {
    json(res, 200, await nas.call("user.shell_choices").catch(() => ({})));
    return true;
  }

  return false;
}

/**
 * Strip the secrets TrueNAS hands back.
 *
 * user.create and user.update echo the whole record, which includes the unix
 * and SMB password hashes and — for a create — the plaintext password that was
 * just submitted. None of it is needed to render a user list, and sending it to
 * the browser would put password hashes in devtools, logs and any proxy in
 * between.
 */
function safeUser(u: unknown): unknown {
  if (!u || typeof u !== "object") return u;
  const { unixhash, smbhash, password, password_history, sid, api_keys, ...rest } = u as Record<string, unknown>;
  return rest;
}

/** A group name TrueNAS will accept, checked here so the error is a sentence rather than a schema dump. */
function groupName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(name)) {
    throw new Error("A group name is letters, numbers, dashes and underscores, starting with a letter, up to 32 long.");
  }
  return name;
}

/** Member ids as the NAS wants them: numbers, no duplicates, nothing that is not a number. */
function memberIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/**
 * Which shared folders grant this group access — what deleting it orphans.
 *
 * Every SMB and NFS share's folder has its ACL read. One that cannot be read
 * is skipped rather than reported, because "we could not check" is not the
 * same warning as "this will break" and should not wear its clothes.
 */
async function orphansOf(nas: TrueNas, id: number) {
  const [group] = await nas.call<Array<{ gid: number; group: string }>>("group.query", [[["id", "=", id]]]);
  if (!group) throw new Error("There is no such group.");
  const [smb, nfs] = await Promise.all([
    nas.call<Array<{ name?: string; path: string }>>("sharing.smb.query").catch(() => []),
    nas.call<Array<{ comment?: string; path: string }>>("sharing.nfs.query").catch(() => []),
  ]);
  const shares = [
    ...smb.map((s) => ({ name: s.name ?? s.path, path: s.path })),
    ...nfs.map((s) => ({ name: s.comment || s.path, path: s.path })),
  ];
  const acls = new Map<string, AclLike>();
  await Promise.all(
    [...new Set(shares.map((s) => s.path))].map(async (p) => {
      const acl = await nas.call<AclLike>("filesystem.getacl", [p, false]).catch(() => null);
      if (acl) acls.set(p, acl);
    }),
  );
  const affected = referencedBy(group.gid, acls, shares);
  return { group: group.group, gid: group.gid, affected, warning: orphanWarning(group.group, affected) };
}
