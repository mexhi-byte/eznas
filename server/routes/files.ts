import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";
import type { TrueNas } from "../truenas.js";
import * as store from "../store.js";
import * as files from "../files.js";
import * as exec from "../nas-exec.js";
import { uploadTo } from "../upload.js";
import { searchFiles } from "../search.js";
import { bodyOf, confirmed, json, optStr, str, underMnt } from "../http.js";
import { levelToPerms, type AclEntry, type AclResult } from "../acl.js";
import { restoreTarget } from "../restore-target.js";

/**
 * Everything under /api/files.
 *
 * Lifted out of index.ts, which was a single if-chain 2500 lines long. The
 * recycle-bin helpers came with it: they are used by nothing else, and a
 * helper that outlives its only caller in a shared file is how that file grew
 * in the first place.
 */

export interface FileRouteContext {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  nas: TrueNas;
}

/** True if this request was one of ours. */
export async function handleFileRoutes(ctx: FileRouteContext): Promise<boolean> {
  const { path, method, url, req, res, nas } = ctx;

    if (path === "/api/files") {
      // Confined to /mnt: everything a storage console has business showing is
      // under it, and letting the path float free would turn a read-only browser
      // into a way to page through /etc.
      const target = underMnt(url.searchParams.get("path") || "/mnt");
      const [entries, space] = await Promise.all([
        nas.call<Array<Record<string, unknown>>>("filesystem.listdir", [target]),
        // Which dataset this folder actually sits on, and how full it is. "/mnt"
        // itself is not a filesystem, so it has none.
        nas
          .call<Record<string, unknown>>("filesystem.statfs", [target])
          .then((s) => ({
            source: s.source as string,
            total: Number(s.total_bytes ?? 0),
            free: Number(s.avail_bytes ?? 0),
          }))
          .catch(() => null),
      ]);
      json(res, 200, {
        path: target,
        parent: target === "/mnt" ? null : target.split("/").slice(0, -1).join("/") || "/mnt",
        space,
        // Moving needs a shell, which needs the account password. Without it the
        // browser should not offer drag-and-drop at all rather than let every
        // drop fail.
        canMove: !!store.sudoPasswordFor(store.get(url.searchParams.get("c"))!),
        entries: entries
          .map((e) => ({
            name: e.name, path: e.path, type: e.type, size: e.size,
            mode: e.mode, uid: e.uid, gid: e.gid, isMountpoint: e.is_mountpoint,
            /*
             * The bin is a folder, and hiding it made it one you had to know
             * about. It is marked as its own kind rather than dropped, so the
             * browser can put it where a deleted-items folder belongs — in the
             * listing, named, and opening into the view built for it rather
             * than into a tree of timestamped mirror directories.
             */
            kind: e.name === ".recycle"
              ? "bin"
              : e.type === "DIRECTORY" ? "dir" : files.kindOf(String(e.name)),
          }))
          .sort((a, b) => (a.type === b.type ? String(a.name).localeCompare(String(b.name)) : a.type === "DIRECTORY" ? -1 : 1)),
      });
      return true;
    }

    /**
     * File contents.
     *
     * Split in two because the NAS's download URLs cannot serve a byte range:
     * media is cached locally and served with ranges so seeking works, while
     * images and documents stream straight through.
     */
    if (path === "/api/files/content" || path === "/api/files/download") {
      const raw = url.searchParams.get("path");
      if (!raw) throw new Error("Which file?");
      const target = underMnt(raw);

      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");

      const stat = await nas.call<Record<string, unknown>>("filesystem.stat", [target]);
      if (String(stat.type) !== "FILE") throw new Error("That is not a file.");
      // And where it really lands: a symlink inside /mnt pointing at /etc would
      // otherwise pass every check above.
      const real = typeof stat.realpath === "string" ? posix.normalize(stat.realpath) : target;
      if (real !== "/mnt" && !real.startsWith("/mnt/")) {
        throw new Error("That file resolves to somewhere outside /mnt.");
      }
      const size = Number(stat.size ?? 0);
      const kind = files.kindOf(target);
      const wantsDownload = path === "/api/files/download";

      if (!wantsDownload && (kind === "video" || kind === "audio")) {
        await files.streamMedia(nas, conn, target, size, req.headers.range, res);
        return true;
      }

      if (!wantsDownload && size > files.MAX_INLINE) {
        throw new Error(`This file is ${(size / 1024 ** 2).toFixed(0)} MB, too large to open in the browser. Download it instead.`);
      }

      await files.streamThrough(nas, conn, target, res, { download: wantsDownload });
      return true;
    }

    if (path === "/api/files/cache") {
      if (method === "GET") {
        json(res, 200, files.cacheStats());
        return true;
      }
      if (method === "DELETE") {
        files.clearCache();
        json(res, 200, { ok: true });
        return true;
      }
    }

    /**
     * Who can get at a folder.
     *
     * ZFS on this NAS uses POSIX draft ACLs, which are three fixed entries —
     * owner, owning group, everyone else — plus a named entry per extra user or
     * group, and a MASK that caps what any of the named ones actually get. The
     * mask is the part that surprises people: an entry granting write is
     * silently reduced to read if the mask says read, so it is always recomputed
     * here rather than left to whatever was there before.
     */
    if (path === "/api/files/permissions") {
      if (method === "GET") {
        const target = underMnt(url.searchParams.get("path") || "/mnt");
        const [acl, stat, users, groups] = await Promise.all([
          nas.call<AclResult>("filesystem.getacl", [target]),
          nas.call<Record<string, unknown>>("filesystem.stat", [target]),
          nas.call<Array<Record<string, unknown>>>("user.query", [[["builtin", "=", false]]]),
          nas.call<Array<Record<string, unknown>>>("group.query", [[["builtin", "=", false]]]),
        ]);
        json(res, 200, {
          path: target,
          acltype: acl.acltype,
          trivial: acl.trivial,
          owner: { uid: acl.uid, name: stat.user ?? null },
          group: { gid: acl.gid, name: stat.group ?? null },
          mode: Number(stat.mode ?? 0) & 0o777,
          isDirectory: stat.type === "DIRECTORY",
          entries: (acl.acl ?? []).map((e) => ({
            tag: e.tag, id: e.id, who: e.who ?? null, isDefault: e.default === true,
            perms: { read: !!e.perms?.READ, write: !!e.perms?.WRITE, execute: !!e.perms?.EXECUTE },
          })),
          users: users.map((u) => ({ uid: u.uid, username: u.username, full: u.full_name })),
          groups: groups.map((g) => ({ gid: g.gid, group: g.group })),
        });
        return true;
      }

      if (method === "PUT") {
        const b = await bodyOf(req);
        const target = underMnt(str(b, "path"));
        const conn = store.get(url.searchParams.get("c"));
        if (!conn) throw new Error("No TrueNAS server is configured.");

        const acl = await nas.call<AclResult>("filesystem.getacl", [target]);
        if (acl.acltype !== "POSIX1E") {
          throw new Error(`This folder uses ${acl.acltype} permissions, which this console cannot edit yet.`);
        }

        const owner = (b.owner ?? {}) as { uid?: unknown; gid?: unknown };
        const recursive = b.recursive === true;
        const inherit = b.inherit !== false;

        // Owner first, with chown, and waited for.
        //
        // Not setperm: that refuses a payload carrying only uid and gid —
        // "must either explicitly specify permissions or contain the stripacl
        // option" — and both of those escapes are wrong here. A mode would
        // collapse the ACL down to three entries and stripacl would delete it
        // outright, which is the opposite of what this endpoint is for.
        //
        // Waited for, because setacl runs next against the same path. Fired
        // together they raced, and the folder silently kept its old owner.
        const uid = owner.uid === undefined || owner.uid === null ? undefined : Number(owner.uid);
        const gid = owner.gid === undefined || owner.gid === null ? undefined : Number(owner.gid);
        if (uid !== undefined || gid !== undefined) {
          await nas.runJob("filesystem.chown", [{
            path: target,
            ...(uid !== undefined ? { uid } : {}),
            ...(gid !== undefined ? { gid } : {}),
            options: { recursive, traverse: false },
          }]);
        }

        const grants = Array.isArray(b.access) ? (b.access as Array<Record<string, unknown>>) : [];
        const named = grants.map((g) => ({
          tag: g.kind === "group" ? "GROUP" : "USER",
          id: Number(g.id),
          perms: levelToPerms(String(g.level ?? "read")),
          default: false,
        }));

        const base = {
          ownerPerms: levelToPerms(String((b.ownerLevel as string) ?? "full")),
          groupPerms: levelToPerms(String((b.groupLevel as string) ?? "read")),
          otherPerms: levelToPerms(String((b.otherLevel as string) ?? "none")),
        };

        // The mask has to be at least as permissive as the most permissive named
        // entry, or that entry does nothing.
        const mask = named.reduce(
          (acc, e) => ({ READ: acc.READ || e.perms.READ, WRITE: acc.WRITE || e.perms.WRITE, EXECUTE: acc.EXECUTE || e.perms.EXECUTE }),
          { ...base.groupPerms },
        );

        const dacl: AclEntry[] = [
          { tag: "USER_OBJ", id: -1, perms: base.ownerPerms, default: false },
          { tag: "GROUP_OBJ", id: -1, perms: base.groupPerms, default: false },
          ...named,
          ...(named.length ? [{ tag: "MASK", id: -1, perms: mask, default: false } as AclEntry] : []),
          { tag: "OTHER", id: -1, perms: base.otherPerms, default: false },
        ];

        // Default entries are what a directory hands to things created inside it
        // later. Without them, granting somebody write and then having them find
        // every new file unreadable is the next question.
        if (inherit && b.isDirectory !== false) {
          for (const e of [...dacl]) dacl.push({ ...e, default: true });
        }

        json(res, 200, {
          jobId: await nas.startJob("filesystem.setacl", [{
            path: target,
            dacl,
            acltype: "POSIX1E",
            options: { recursive, traverse: false },
          }]),
        });
        return true;
      }
    }

    /**
     * The recycle bin.
     *
     * TrueNAS has no delete in its API at all, so this console could not offer
     * one — and the first thing that would have been built on a shell rm is the
     * one operation with no undo whatsoever. Deleting therefore moves the item
     * into a bin at the root of its own dataset instead.
     *
     * Per dataset rather than one global bin, because a move between datasets is
     * a copy of every byte: binning a 40 GB video has to be instant, and it has
     * to stay on the pool whose space it is already using.
     */
    if (path === "/api/files/recycle") {
      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");

      if (method === "GET") {
        const bin = binFor(underMnt(url.searchParams.get("path") || "/mnt"));
        if (!bin) {
          json(res, 200, { bin: null, entries: [] });
          return true;
        }
        const entries = await nas
          .call<Array<Record<string, unknown>>>("filesystem.listdir", [bin])
          .catch(() => [] as Array<Record<string, unknown>>);
        json(res, 200, {
          bin,
          entries: await binContents(nas, bin, bin, entries),
        });
        return true;
      }

      // Delete: move each item into its dataset's bin, mirroring where it was.
      if (method === "POST") {
        const b = await bodyOf(req);
        const items = Array.isArray(b.paths) ? (b.paths as unknown[]).map(String) : [];
        if (!items.length) throw new Error("Nothing to delete.");

        const binned: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const raw of items) {
          const from = exec.safePath(underMnt(raw));
          const bin = binFor(from);
          if (!bin) {
            failed.push({ path: from, error: "A pool root cannot be deleted." });
            continue;
          }
          if (from.includes("/.recycle/") || from.endsWith("/.recycle")) {
            failed.push({ path: from, error: "That is already in the bin." });
            continue;
          }
          const to = `${bin}${from.slice(bin.length - "/.recycle".length)}`;
          try {
            exec.orThrow(await exec.run(conn, exec.recycleCommand(from, to)), `Could not delete ${from}`);
            binned.push(from);
          } catch (e) {
            failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
          }
        }
        json(res, 200, { binned, failed });
        return true;
      }

      /*
       * Restore: the same move backwards — to where the item came from, or to
       * wherever was asked for instead.
       *
       * The default is still the original location, because that is what "put
       * back" means. The alternatives exist because the original folder may be
       * gone, its name may since have been taken, or the reason for going into
       * the bin in the first place may have been that it was in the wrong place.
       */
      if (method === "PUT") {
        const b = await bodyOf(req);
        const from = exec.safePath(underMnt(str(b, "path")));
        const bin = binFor(from);
        if (!bin) throw new Error("That is not in a recycle bin.");
        const target = restoreTarget({
          from,
          bin,
          toDir: optStr(b, "toDir") ?? null,
          name: optStr(b, "name") ?? null,
        });
        // Re-checked after resolution: the pieces were validated separately,
        // and it is the joined path that actually gets written.
        const to = exec.safePath(underMnt(target.path));
        const result = await exec.run(conn, exec.recycleCommand(from, to));
        exec.orThrow(result, `Could not restore ${from}`);
        /*
         * Where it actually landed, which is not always where it was sent.
         *
         * The move script appends a timestamp rather than overwriting when
         * something is already there, so reporting the requested path would
         * name a file that may not be the one just written — and the browser
         * would send the operator to the wrong place.
         */
        const landed = await nas
          .call("filesystem.stat", [to])
          .then(() => to)
          .catch(() => null);
        json(res, 200, { ok: true, path: landed ?? to, movedAside: landed === null });
        return true;
      }

      // Empty: the one genuinely destructive operation, named to confirm.
      if (method === "DELETE") {
        const b = await bodyOf(req);
        const bin = binFor(underMnt(str(b, "path")));
        if (!bin) throw new Error("There is no bin for that path.");
        confirmed(b, bin);
        exec.orThrow(await exec.run(conn, exec.emptyBinCommand(bin)), "Could not empty the bin");
        json(res, 200, { ok: true });
        return true;
      }
    }

    /**
     * Receiving a file.
     *
     * The body is the file itself, streamed straight through to the NAS — the
     * multipart envelope is added on the far side, so nothing is buffered here
     * and a file larger than this console's memory is not a special case.
     *
     * The folder and the name travel in the query rather than in a form,
     * because reading a multipart form to find out where to send a multipart
     * form means holding the whole upload first.
     */
    /**
     * Searching for a file by name.
     *
     * Server-Sent Events rather than one JSON reply, so a hit shows the moment
     * it is found and Stop actually stops. The console already speaks SSE for
     * the live figures on Home, so this is a pattern the front end has.
     */
    if (path === "/api/files/search") {
      const root = underMnt(url.searchParams.get("root") ?? "/mnt");
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length < 2) {
        json(res, 400, { error: "Search for at least two characters." });
        return true;
      }
      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Without this a reverse proxy buffers the whole stream and delivers
        // every result at the end, which is the one thing this must not do.
        "x-accel-buffering": "no",
      });

      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // A browser that navigated away is not owed the rest of the search, and
      // writing to a closed response throws.
      let stopped = false;
      req.on("close", () => { stopped = true; });

      const limits = { maxResults: 500, maxMs: 60_000 };
      let count = 0;
      try {
        for await (const hit of searchFiles(nas, conn, root, query, limits)) {
          if (stopped) break;
          send("hit", hit);
          count += 1;
        }
        if (!stopped) send("done", { count, truncated: count >= limits.maxResults });
      } catch (e) {
        if (!stopped) send("failed", { error: e instanceof Error ? e.message : String(e) });
      }
      res.end();
      return true;
    }

    if (path === "/api/files/upload" && method === "POST") {
      const dir = underMnt(url.searchParams.get("path") ?? "");
      const name = url.searchParams.get("name") ?? "";
      const size = Number(req.headers["content-length"] ?? 0);
      if (!Number.isFinite(size) || size <= 0) {
        json(res, 400, { error: "The upload did not say how large it is." });
        return true;
      }
      // Normalising collapses any ".." the name carries; underMnt then decides
      // whether the result is allowed. Both are needed — the first makes the
      // path canonical, the second is the check.
      const target = underMnt(posix.normalize(`${dir}/${name}`));
      // And the folder must still be the one that was asked for: a name of
      // "../elsewhere/x" normalises to a valid path under /mnt, which underMnt
      // would accept while writing somewhere nobody chose.
      if (posix.dirname(target) !== dir) {
        json(res, 400, { error: "That file name cannot be used." });
        return true;
      }
      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");
      await uploadTo(nas, conn, target, req, size);
      json(res, 200, { path: target });
      return true;
    }

    if (path === "/api/files/mkdir" && method === "POST") {
      const b = await bodyOf(req);
      // Parent and name kept apart so a name can never widen the target: sending
      // "../../etc/x" as the name would otherwise climb out of the folder the
      // person is looking at, and underMnt alone would still allow it as long as
      // the result landed somewhere under /mnt.
      const parent = underMnt(str(b, "path"));
      const name = str(b, "name");
      if (name.includes("/") || name === "." || name === "..") {
        throw new Error("A folder name cannot contain a slash.");
      }
      const target = underMnt(`${parent}/${name}`);
      json(res, 200, await nas.call("filesystem.mkdir", [{ path: target }]));
      return true;
    }

    /**
     * Moving and renaming.
     *
     * Both are the same shell mv; they are separate routes because the mistakes
     * they can make are different. Rename takes a bare name and builds the
     * destination itself, so a name can never redirect the operation elsewhere.
     * Move takes a destination folder and appends each source's own basename.
     *
     * -n means an existing file at the destination is never overwritten: mv would
     * otherwise silently replace it, and there is no undo here.
     */
    if (path === "/api/files/rename" && method === "POST") {
      const b = await bodyOf(req);
      const from = exec.safePath(underMnt(str(b, "path")));
      const name = str(b, "name");
      if (name.includes("/") || name === "." || name === "..") throw new Error("A name cannot contain a slash.");
      if (from === "/mnt") throw new Error("/mnt itself cannot be renamed.");
      const to = exec.safePath(underMnt(`${from.split("/").slice(0, -1).join("/")}/${name}`));
      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");
      const result = await exec.run(conn, exec.moveCommand(from, to));
      exec.orThrow(result, `Could not rename ${from}`);
      json(res, 200, { ok: true, path: to });
      return true;
    }

    if (path === "/api/files/move" && method === "POST") {
      const b = await bodyOf(req);
      const to = exec.safePath(underMnt(str(b, "to")));
      const sources = Array.isArray(b.from) ? (b.from as unknown[]).map(String) : [];
      if (!sources.length) throw new Error("Nothing to move.");
      if (sources.length > 100) throw new Error("Too many items in one move.");

      const conn = store.get(url.searchParams.get("c"));
      if (!conn) throw new Error("No TrueNAS server is configured.");

      const moved: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const raw of sources) {
        const from = exec.safePath(underMnt(raw));
        const base = from.split("/").pop() ?? "";
        // A folder cannot be moved into itself or into its own child: mv would
        // either refuse or, for the second case, quietly build a loop.
        if (to === from || to.startsWith(`${from}/`)) {
          failed.push({ path: from, error: "A folder cannot be moved inside itself." });
          continue;
        }
        if (to === from.split("/").slice(0, -1).join("/")) {
          failed.push({ path: from, error: "It is already there." });
          continue;
        }
        try {
          const result = await exec.run(conn, exec.moveCommand(from, `${to}/${base}`));
          exec.orThrow(result, `Could not move ${base}`);
          moved.push(from);
        } catch (e) {
          failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
        }
      }
      json(res, 200, { moved, failed });
      return true;
    }

  return false;
}

/**
 * The recycle bin belonging to a path, or null if it has none.
 *
 * One per pool, at its root. /mnt itself and a bare pool root have no bin —
 * there is nowhere above them to put one, and "delete the pool" is not a file
 * operation.
 */
function binFor(path: string): string | null {
  const parts = path.split("/").filter(Boolean); // ["mnt", "tank", ...]
  if (parts[0] !== "mnt" || parts.length < 3) return null;
  return `/mnt/${parts[1]}/.recycle`;
}

/**
 * Everything in a bin, flattened.
 *
 * The bin mirrors the original folder structure, so a plain listing of its top
 * level would show a folder called "photos" rather than the file that was
 * deleted out of it. Walking it gives back the actual items, each still
 * knowing where it came from.
 */
async function binContents(
  nas: TrueNas,
  bin: string,
  dir: string,
  entries: Array<Record<string, unknown>>,
  depth = 0,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const full = String(e.path);
    const original = `${bin.slice(0, -"/.recycle".length)}${full.slice(bin.length)}`.replace(/\.\d{8}-\d{6}$/, "");
    // A deleted folder is one item, not a tree to walk into: restoring it puts
    // the whole thing back. Only mirror directories are descended, and only so
    // far — a deep tree of them is still just structure.
    const mirrorOnly = e.type === "DIRECTORY" && depth < 6 && (await isMirror(nas, full));
    if (mirrorOnly) {
      const kids = await nas.call<Array<Record<string, unknown>>>("filesystem.listdir", [full]).catch(() => []);
      out.push(...(await binContents(nas, bin, full, kids, depth + 1)));
      continue;
    }
    out.push({
      name: e.name,
      path: full,
      type: e.type,
      size: e.size,
      original,
      from: original.split("/").slice(0, -1).join("/"),
    });
  }
  return out;
}

/**
 * A directory the bin created to mirror the original path, rather than one
 * somebody deleted. The difference: a mirror only ever contains the things
 * that were binned out of it, and a folder that was itself deleted is restored
 * whole. There is no flag for this, so the test is whether the same folder
 * still exists outside the bin — if it does, this copy is structure.
 */
async function isMirror(nas: TrueNas, dir: string): Promise<boolean> {
  const bin = "/.recycle";
  const idx = dir.indexOf(bin);
  if (idx === -1) return false;
  const outside = dir.slice(0, idx) + dir.slice(idx + bin.length);
  return await nas.call("filesystem.stat", [outside]).then(() => true).catch(() => false);
}
