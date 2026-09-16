import { bodyOf, confirmed, json, optStr, str } from "../http.js";
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
    const groups = await nas.call<Array<Record<string, unknown>>>("group.query", [[["local", "=", true]]]);
    json(
      res,
      200,
      groups.map((g) => ({
        id: g.id,
        gid: g.gid,
        name: g.group,
        builtin: g.builtin,
        users: (g.users as unknown[])?.length ?? 0,
      })),
    );
    return true;
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
