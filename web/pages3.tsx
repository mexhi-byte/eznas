import { useEffect, useMemo, useState } from "react";
import { bytes, del, get, getConnection, post, put, setConnection, useResource, withConn } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill, TAGLINE } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";
import { AppearanceTab, ConsoleUpdateTab, EmailTab, NotificationsTab, SecurityTab, UpdatesTab, type WatchConfig, type Webhook } from "./settings-tabs";
import { ConsoleUsersTab } from "./console-users";
import { PermissionsModal } from "./permissions";
import { RecycleBin } from "./recycle-bin";
import { ShareFolder } from "./shares";

/* --------------------------------------------------------------- settings */

export interface Conn {
  id: string;
  name: string;
  url: string;
  fingerprint: string | null;
  hasKey: boolean;
  isDefault: boolean;
  connected: boolean;
  error: string | null;
  hasSudo: boolean;
}

function ServersTab() {
  const { data, error, loading, reload } = useResource<Conn[]>("/api/connections", 15_000);
  const [editing, setEditing] = useState<Conn | "new" | null>(null);
  const [removing, setRemoving] = useState<Conn | null>(null);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <span className="card-title">Which TrueNAS machines this console can manage.</span>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditing("new")}>
          Add a server
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !data && <Loading rows={2} />}

      <div className="grid" style={{ gap: 12 }}>
        {data?.map((c) => (
          <Card key={c.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <strong style={{ fontSize: 15 }}>{c.name}</strong>
                  {c.isDefault && <span className="pill info">default</span>}
                  <Pill state={c.connected ? "ONLINE" : "OFFLINE"}>{c.connected ? "connected" : "not connected"}</Pill>
                </div>
                <div className="stat-foot mono" style={{ marginTop: 4 }}>{c.url}</div>
                {c.error && <div className="stat-foot" style={{ color: "var(--bad)", marginTop: 4 }}>{c.error}</div>}
                <div className="stat-foot" style={{ marginTop: 4 }}>
                  {c.fingerprint ? `certificate pinned · ${c.fingerprint.slice(0, 16)}…` : "certificate not pinned"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 7 }}>
                {getConnection() !== c.id && (
                  <button className="btn" style={{ flex: "none" }} onClick={() => { setConnection(c.id); window.location.reload(); }}>
                    Use
                  </button>
                )}
                <button className="btn" style={{ flex: "none" }} onClick={() => setEditing(c)}>Edit</button>
                <button className="btn danger" style={{ flex: "none" }} onClick={() => setRemoving(c)}>Remove</button>
              </div>
            </div>
          </Card>
        ))}
        {!loading && !data?.length && (
          <Card><Empty>No servers yet. Add one to get started.</Empty></Card>
        )}
      </div>

      {editing && (
        <ConnectionForm
          conn={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="server"
          name={removing.name}
          verb="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/connections/${removing.id}`);
            if (getConnection() === removing.id) setConnection(null);
            await reload();
          }}
          extra={<p className="modal-text" style={{ marginTop: 10 }}>This only forgets the connection here. Nothing on the NAS changes.</p>}
        />
      )}
    </>
  );
}

function ConnectionForm({ conn, onClose, onSaved }: { conn: Conn | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(conn?.name ?? "");
  const [url, setUrl] = useState(conn?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [fingerprint, setFingerprint] = useState(conn?.fingerprint ?? "");
  const [sudoPassword, setSudoPassword] = useState("");
  const [tested, setTested] = useState<{ ok: boolean; error?: string; version?: string; hostname?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const { busy, error, submit } = useSubmit(async () => {
    const payload = { name, url, apiKey, fingerprint: fingerprint || null, sudoPassword: sudoPassword || undefined };
    if (conn) await put(`/api/connections/${conn.id}`, payload);
    else await post("/api/connections", payload);
    onSaved();
  });

  async function test() {
    setTesting(true);
    setTested(null);
    try {
      setTested(await post("/api/connections/test", { url, apiKey, fingerprint: fingerprint || null }));
    } catch (e) {
      setTested({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      title={conn ? `Edit ${conn.name}` : "Add a TrueNAS server"}
      subtitle="The API key is stored encrypted and never sent back to the browser."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={() => void test()} disabled={testing || !url || (!apiKey && !conn)}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button className="btn primary" disabled={busy || !name || !url || (!conn && !apiKey)} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main NAS" autoFocus />
      </Field>

      <Field label="Address" hint="An address is enough — 192.168.1.10. https:// and /api/current are added for you.">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.10" />
      </Field>

      <Field
        label={conn ? "API key (leave blank to keep the current one)" : "API key"}
        hint="TrueNAS → Credentials → Local Users → API keys. The key inherits that user's privileges."
      >
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={conn ? "unchanged" : "1-…"} />
      </Field>

      <Field
        label="Certificate fingerprint (optional)"
        hint="SHA-256, hex. TrueNAS uses a self-signed certificate, so pinning is the only way this connection can be authenticated. Without it the key travels over a link nothing has verified."
      >
        <Input value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} placeholder="ec0d17f7…" />
      </Field>

      <Field
        label={conn?.hasSudo ? "Account password (saved — type a new one to replace it)" : "Account password (optional)"}
        hint="Only needed to move, rename or reorganise files. TrueNAS has no API for those, so they run as a shell command, and that shell cannot write into a pool without this. Stored encrypted, never sent back to the browser. Leave empty and the file browser stays read-only."
      >
        <Input
          type="password"
          value={sudoPassword}
          onChange={(e) => setSudoPassword(e.target.value)}
          placeholder={conn?.hasSudo ? "saved" : "not saved"}
        />
      </Field>

      {tested && (
        <div className={tested.ok ? "job done" : "error-banner"} style={{ marginBottom: 0 }}>
          {tested.ok ? `Reached ${tested.hostname} running TrueNAS ${tested.version}.` : tested.error}
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

type TabId = "servers" | "people" | "appearance" | "security" | "notifications" | "email" | "updates" | "console-update" | "about";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "servers", label: "Servers" },
  { id: "people", label: "Console users" },
  { id: "appearance", label: "Appearance" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "email", label: "Email" },
  { id: "updates", label: "NAS updates" },
  { id: "console-update", label: "App updates" },
  { id: "about", label: "About" },
];

export interface ConsoleSettings {
  theme: string;
  mfa: { enabled: boolean; recoveryRemaining: number };
  notify: {
    watchDisks: boolean; email: boolean; recipients: string[];
    watch: WatchConfig; emailLevel: "info" | "warn" | "bad";
    webhooks: Webhook[]; greetName: string;
  };
}

export function SettingsPage({ me }: { me: { username: string; role: "admin" | "viewer" } }) {
  const [tab, setTab] = useState<TabId>("servers");
  const { data, reload } = useResource<ConsoleSettings>("/api/settings", 0);

  async function applyTheme(theme: string) {
    // Applied to the document first so the choice is felt immediately; the
    // round trip only decides what a fresh browser gets.
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tnui:theme", theme);
    await put("/api/settings", { theme });
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-sub">This console, and the NAS behind it.</div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "servers" && <ServersTab />}
      {tab === "people" && <ConsoleUsersTab meUsername={me.username} />}
      {tab === "appearance" && (
        <AppearanceTab
          theme={document.documentElement.dataset.theme ?? data?.theme ?? "midnight"}
          onTheme={(t) => void applyTheme(t)}
        />
      )}
      {tab === "security" && <SecurityTab me={me} />}
      {tab === "notifications" && data && <NotificationsTab notify={data.notify} onSaved={() => void reload()} />}
      {tab === "email" && <EmailTab />}
      {tab === "updates" && <UpdatesTab />}
      {tab === "console-update" && <ConsoleUpdateTab />}
      {tab === "about" && <AboutTab />}
    </>
  );
}

function AboutTab() {
  const { data } = useResource<{ connected: boolean; error: string | null }>("/api/health", 30_000);

  return (
    <div className="grid two">
      <Card title="This console">
        <p className="modal-text" style={{ fontSize: 14.5, marginTop: 0 }}>{TAGLINE}</p>
        <p className="modal-text">
          Everything here speaks the JSON-RPC API on <span className="mono">wss://…/api/current</span> — the same
          interface the NAS's own interface uses, and the only one that survives the removal of the REST API. The live
          numbers on Overview are a subscription, not a poll: the NAS pushes them about once a second.
        </p>
        <div className="kv" style={{ marginTop: 12 }}>
          <div><span>NAS connection</span><b>{data ? (data.connected ? "connected" : "unreachable") : "…"}</b></div>
          <div><span>Transport</span><b>JSON-RPC 2.0 over WebSocket</b></div>
        </div>
        {data && !data.connected && data.error && (
          <p className="modal-text" style={{ color: "var(--bad)" }}>{data.error}</p>
        )}
      </Card>

      <Card title="Built for homelabs">
        <p className="modal-text" style={{ marginTop: 0 }}>
          The screens here are the ones a homelab actually opens: pools and their disks, datasets, snapshots and the
          schedules that expire them, files, apps, shares, users, the network, and a terminal. Anything rarer is a click
          away in the NAS's own interface, linked at the bottom of the sidebar.
        </p>
        <p className="modal-text">
          Destructive actions ask you to type the name of what you are about to lose, and the API enforces that too, so
          a mis-aimed script fails instead of succeeding on the wrong pool.
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ users */

interface User {
  id: number;
  uid: number;
  username: string;
  fullName: string;
  email: string | null;
  shell: string;
  home: string;
  locked: boolean;
  builtin: boolean;
  smb: boolean;
  sudo: boolean;
}

export function UsersPage() {
  const [showBuiltin, setShowBuiltin] = useState(false);
  const { data, error, loading, reload } = useResource<User[]>(`/api/users?builtin=${showBuiltin ? 1 : 0}`, 30_000);
  const { data: groups } = useResource<Array<{ id: number; gid: number; name: string; builtin: boolean }>>("/api/groups", 0);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="page-sub">{data ? `${data.length} accounts` : " "}</div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Toggle checked={showBuiltin} onChange={setShowBuiltin} label="Show built-in" />
          <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditing("new")}>
            Add user
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={4} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th><th>Name</th><th className="num">UID</th>
                  <th>Shell</th><th>Flags</th><th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {data?.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.username}</td>
                    <td style={{ color: "var(--muted)" }}>{u.fullName || "—"}</td>
                    <td className="num">{u.uid}</td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{u.shell?.split("/").pop()}</td>
                    <td>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {u.builtin && <span className="pill mute">built-in</span>}
                        {u.locked && <span className="pill bad">locked</span>}
                        {u.smb && <span className="pill info">SMB</span>}
                        {u.sudo && <span className="pill warn">sudo</span>}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button className="btn" style={{ flex: "none" }} onClick={() => setEditing(u)}>Edit</button>
                        <button className="btn danger" style={{ flex: "none" }} disabled={u.builtin} onClick={() => setRemoving(u)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data?.length && <tr><td colSpan={6}><Empty>No accounts.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <UserForm
          user={editing === "new" ? null : editing}
          groups={groups ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="user"
          name={removing.username}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            await del(`/api/users/${removing.id}`, { confirm, deleteGroup: true });
            await reload();
          }}
        />
      )}
    </>
  );
}

function UserForm({ user, groups, onClose, onSaved }: {
  user: User | null;
  groups: Array<{ id: number; gid: number; name: string; builtin: boolean }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [group, setGroup] = useState("");
  const [smb, setSmb] = useState(user?.smb ?? true);
  const [locked, setLocked] = useState(user?.locked ?? false);
  const [homeCreate, setHomeCreate] = useState(false);

  const { busy, error, submit } = useSubmit(async () => {
    if (user) {
      await put(`/api/users/${user.id}`, { fullName, email, password: password || undefined, smb, locked });
    } else {
      await post("/api/users", {
        username, fullName, email: email || undefined, password: password || undefined,
        group: group || undefined, smb, homeCreate,
      });
    }
    onSaved();
  });

  return (
    <Modal
      title={user ? `Edit ${user.username}` : "Add a user"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || (!user && !username)} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : user ? "Save" : "Create"}
          </button>
        </>
      }
    >
      {!user && (
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="jsmith" />
        </Field>
      )}

      <Field label="Full name">
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" />
      </Field>

      <Field label="Email">
        <Input type="email" value={email ?? ""} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
      </Field>

      <Field
        label={user ? "New password (blank to leave unchanged)" : "Password"}
        hint={user ? undefined : "Leave blank to create the account with password login disabled — useful for key-only or SMB-only accounts."}
      >
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>

      {!user && (
        <Field label="Primary group" hint="Blank creates a group named after the user, which is what you usually want.">
          <Select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Create a new group</option>
            {groups.filter((g) => !g.builtin).map((g) => (
              <option key={g.id} value={g.id}>{g.name} ({g.gid})</option>
            ))}
          </Select>
        </Field>
      )}

      <Toggle checked={smb} onChange={setSmb} label="Allow SMB access" />
      {!user && <Toggle checked={homeCreate} onChange={setHomeCreate} label="Create a home directory" />}
      {user && <Toggle checked={locked} onChange={setLocked} label="Locked" />}

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ files */

interface Entry {
  name: string;
  path: string;
  type: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  isMountpoint: boolean;
  kind: "dir" | "image" | "video" | "audio" | "pdf" | "text" | "other";
}

/** Rename one file or folder in place. */
function RenameEntry({ entry, onClose, onDone }: { entry: Entry; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(entry.name);

  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/files/rename", { path: entry.path, name: name.trim() });
    onDone();
  });

  const unchanged = name.trim() === entry.name;

  return (
    <Modal
      title={`Rename ${entry.type === "DIRECTORY" ? "folder" : "file"}`}
      subtitle={entry.path}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || unchanged} onClick={() => void submit(undefined as void)}>
            {busy ? "Renaming…" : "Rename"}
          </button>
        </>
      }
    >
      <Field label="New name" hint="No slashes — this renames it where it is.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\//g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !unchanged) void submit(undefined as void); }}
          autoFocus
        />
      </Field>
      <p className="modal-text">
        An existing file with that name is never overwritten — the rename fails instead.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

type SortKey = "name" | "size" | "kind";

export function FilesPage() {
  const [path, setPath] = useState("/mnt");
  const { data, error, loading, reload } = useResource<{
    path: string;
    parent: string | null;
    space: { source: string; total: number; free: number } | null;
    canMove: boolean;
    entries: Entry[];
  }>(`/api/files?path=${encodeURIComponent(path)}`, 0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [preview, setPreview] = useState<Entry | null>(null);
  const [gallery, setGallery] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [desc, setDesc] = useState(false);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [permsFor, setPermsFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [showBin, setShowBin] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [permJobs, setPermJobs] = useState<Array<{ id: number; label: string }>>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const canMove = data?.canMove ?? false;

  /**
   * Drop something onto a folder.
   *
   * The dragged paths travel in the drag payload rather than in component
   * state, so a drag that starts in this window and ends somewhere else simply
   * does nothing instead of moving a file on a stale selection.
   */
  async function drop(targetDir: string, ev: React.DragEvent) {
    ev.preventDefault();
    setDragOver(null);
    let from: string[] = [];
    try {
      from = JSON.parse(ev.dataTransfer.getData("application/x-tnui-paths") || "[]");
    } catch {
      return;
    }
    if (!from.length) return;
    setMoving(true);
    setMoveError(null);
    try {
      const r = await post<{ moved: string[]; failed: Array<{ path: string; error: string }> }>(
        "/api/files/move",
        { from, to: targetDir },
      );
      if (r.failed.length) {
        setMoveError(r.failed.map((f) => `${f.path.split("/").pop()}: ${f.error}`).join(" · "));
      }
      await reload();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  }

  const dragProps = (e: Entry) =>
    canMove
      ? {
          draggable: true,
          onDragStart: (ev: React.DragEvent) => {
            ev.dataTransfer.setData("application/x-tnui-paths", JSON.stringify([e.path]));
            ev.dataTransfer.effectAllowed = "move";
          },
        }
      : {};

  const dropProps = (dir: string) =>
    canMove
      ? {
          onDragOver: (ev: React.DragEvent) => {
            if (!ev.dataTransfer.types.includes("application/x-tnui-paths")) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move" as const;
            setDragOver(dir);
          },
          onDragLeave: () => setDragOver((d) => (d === dir ? null : d)),
          onDrop: (ev: React.DragEvent) => void drop(dir, ev),
        }
      : {};

  // Only previewable files take part in next/previous, so arrowing through a
  // photo folder does not stop dead on a stray .txt.
  const viewable = (data?.entries ?? []).filter((e) => e.kind !== "dir" && e.kind !== "other");
  const images = (data?.entries ?? []).filter((e) => e.kind === "image");

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    return parts.map((p, i) => ({ label: p, path: "/" + parts.slice(0, i + 1).join("/") }));
  }, [path]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = (data?.entries ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
    const dir = (e: Entry) => e.type === "DIRECTORY";
    return [...list].sort((a, b) => {
      // Folders stay above files whichever way the sort points — a listing
      // that interleaves them is harder to scan, not more sorted.
      if (dir(a) !== dir(b)) return dir(a) ? -1 : 1;
      const by =
        sort === "size" ? (a.size ?? 0) - (b.size ?? 0)
        : sort === "kind" ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name, undefined, { numeric: true });
      return desc ? -by : by;
    });
  }, [data, filter, sort, desc]);

  const { busy, error: mkErr, submit, setError: setMkErr } = useSubmit(async () => {
    await post("/api/files/mkdir", { path, name: newName.trim() });
    setCreating(false);
    setNewName("");
    await reload();
  });

  const folders = rows.filter((e) => e.type === "DIRECTORY").length;
  const files = rows.length - folders;
  const heading = (key: SortKey, label: string) => (
    <button
      className={`col-head ${sort === key ? "on" : ""}`}
      onClick={() => { if (sort === key) setDesc((d) => !d); else { setSort(key); setDesc(false); } }}
    >
      {label}{sort === key ? (desc ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My files</h1>
          <div className="page-sub">
            {data
              ? `${folders} folder${folders === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}` +
                (data.space ? ` · ${bytes(data.space.free)} free on ${data.space.source}` : "") +
                (data.canMove ? " · drag items onto a folder to move them" : "")
              : " "}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input style={{ maxWidth: 190 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {images.length > 0 && (
            <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setGallery((g) => !g)}>
              {gallery ? "List" : `Gallery (${images.length})`}
            </button>
          )}
          {canMove && path.split("/").filter(Boolean).length >= 2 && (
            <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setShowBin(true)}>
              Recycle bin
            </button>
          )}
          <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => { setMkErr(null); setCreating(true); }}>
            New folder
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {moveError && <ErrorBanner>{moveError}</ErrorBanner>}
      {moving && <div className="job" style={{ marginBottom: 14 }}><span className="job-label">Moving…</span></div>}

      <Card>
        <div className="file-bar">
          <div className="crumbs">
            <button onClick={() => setPath("/mnt")}>mnt</button>
            {crumbs.slice(1).map((c) => (
              <span key={c.path} style={{ display: "contents" }}>
                <span>/</span>
                <button onClick={() => setPath(c.path)}>{c.label}</button>
              </span>
            ))}
          </div>
          {data?.parent && (
            <button
              className={`btn ${dragOver === data.parent ? "drop-on" : ""}`}
              style={{ flex: "none", padding: "4px 12px" }}
              onClick={() => setPath(data.parent!)}
              {...dropProps(data.parent)}
              title={canMove ? "Drop here to move up a level" : undefined}
            >
              ↑ Up
            </button>
          )}
        </div>

        {loading && !data ? (
          <Loading rows={5} />
        ) : gallery ? (
          <div className="gallery">
            {images.map((e) => (
              <button key={e.path} className="thumb" onClick={() => setPreview(e)} title={e.name}>
                {/* Loaded lazily: a folder can hold hundreds of photos and the
                    NAS would otherwise be asked for all of them at once. */}
                <img src={withConn(`/api/files/content?path=${encodeURIComponent(e.path)}`)} alt={e.name} loading="lazy" />
                <span className="thumb-name">{e.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <div className="file-head">
              {heading("name", "Name")}
              {heading("kind", "Kind")}
              {heading("size", "Size")}
              <span>Mode</span>
            </div>

            {rows.map((e) => {
              const dir = e.type === "DIRECTORY";
              const canOpen = !dir && e.kind !== "other";
              return (
                <div
                  key={e.path}
                  className={`file-row ${dir || canOpen ? "dir" : ""} ${dragOver === e.path ? "drop-on" : ""}`}
                  onClick={() => (dir ? setPath(e.path) : canOpen ? setPreview(e) : undefined)}
                  {...dragProps(e)}
                  {...(dir ? dropProps(e.path) : {})}
                >
                  {dir ? <FolderIcon /> : <KindIcon kind={e.kind} />}
                  <span className="fname">{e.name}</span>
                  {e.isMountpoint && <span className="pill info">dataset</span>}
                  <span className="fkind">{dir ? "folder" : e.kind}</span>
                  <span className="fmeta">{dir ? "—" : bytes(e.size)}</span>
                  {dir && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setPermsFor(e.path); }}
                      title="Who can use this folder"
                    >
                      Access
                    </button>
                  )}
                  {dir && e.isMountpoint && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setSharing(e.path); }}
                      title="Put this folder on the network"
                    >
                      Share
                    </button>
                  )}
                  {canMove && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setRenaming(e); }}
                    >
                      Rename
                    </button>
                  )}
                  {canMove && (
                    <button
                      className="btn danger"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setDeleting(e); }}
                      title="Move to the recycle bin"
                    >
                      Delete
                    </button>
                  )}
                  {!dir && (
                    <a
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      href={withConn(`/api/files/download?path=${encodeURIComponent(e.path)}`)}
                      onClick={(ev) => ev.stopPropagation()}
                      download
                    >
                      Download
                    </a>
                  )}
                  <span className="fmeta mono" style={{ width: 58, textAlign: "right" }}>
                    {(e.mode & 0o777).toString(8).padStart(3, "0")}
                  </span>
                </div>
              );
            })}

            {!rows.length && (
              <Empty>{filter ? "Nothing here matches that." : "This folder is empty."}</Empty>
            )}
          </div>
        )}
      </Card>

      {preview && (
        <Preview
          entry={preview}
          siblings={viewable}
          onClose={() => setPreview(null)}
          onNavigate={setPreview}
        />
      )}

      {sharing && (
        <ShareFolder
          fixedPath={sharing}
          onClose={() => setSharing(null)}
          onDone={(jobId) => { if (jobId) setPermJobs((j) => [...j, { id: jobId, label: "Applying who can use it" }]); }}
        />
      )}

      {showBin && (
        <RecycleBin path={path} onClose={() => setShowBin(false)} onChanged={() => void reload()} />
      )}

      {deleting && (
        <DangerConfirm
          what={deleting.type === "DIRECTORY" ? "folder" : "file"}
          name={deleting.name}
          verb="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await post<{ binned: string[]; failed: Array<{ error: string }> }>(
              "/api/files/recycle",
              { paths: [deleting.path] },
            );
            if (r.failed.length) throw new Error(r.failed[0].error);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              It moves to the recycle bin on this pool, where it keeps taking up the same space until the bin is
              emptied. You can put it back from there.
            </p>
          }
        />
      )}

      {permsFor && (
        <PermissionsModal
          path={permsFor}
          onClose={() => setPermsFor(null)}
          onJob={(id, label) => setPermJobs((j) => [...j, { id, label }])}
        />
      )}

      {!!permJobs.length && (
        <div className="job-tray">
          {permJobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => setTimeout(() => setPermJobs((all) => all.filter((x) => x.id !== j.id)), 6000)}
            />
          ))}
        </div>
      )}

      {renaming && (
        <RenameEntry
          entry={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => { setRenaming(null); void reload(); }}
        />
      )}

      {creating && (
        <Modal
          title="New folder"
          subtitle={`Inside ${path}`}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" disabled={!newName.trim() || busy} onClick={() => void submit(undefined as void)}>
                {busy ? "Creating…" : "Create"}
              </button>
            </>
          }
        >
          <Field label="Name" hint="No slashes — this creates one folder, here.">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value.replace(/\//g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) void submit(undefined as void); }}
              autoFocus
              placeholder="documents"
            />
          </Field>
          {mkErr && <ErrorBanner>{mkErr}</ErrorBanner>}
        </Modal>
      )}
    </>
  );
}

/**
 * The viewer.
 *
 * One component for every type because the surrounding behaviour — arrow keys,
 * next/previous, escape, download — should not change depending on what is
 * being looked at.
 */
function Preview({ entry, siblings, onClose, onNavigate }: {
  entry: Entry;
  siblings: Entry[];
  onClose: () => void;
  onNavigate: (e: Entry) => void;
}) {
  const idx = siblings.findIndex((s) => s.path === entry.path);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && prev) onNavigate(prev);
      if (e.key === "ArrowRight" && next) onNavigate(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose, onNavigate]);

  const src = withConn(`/api/files/content?path=${encodeURIComponent(entry.path)}`);
  const dl = withConn(`/api/files/download?path=${encodeURIComponent(entry.path)}`);

  return (
    <div className="viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-bar">
        <div style={{ minWidth: 0 }}>
          <div className="viewer-name">{entry.name}</div>
          <div className="viewer-meta">
            {bytes(entry.size)}
            {idx >= 0 && siblings.length > 1 ? ` · ${idx + 1} of ${siblings.length}` : ""}
          </div>
        </div>
        <a className="btn" style={{ flex: "none" }} href={dl} download>Download</a>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="viewer-body" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {prev && <button className="viewer-nav left" onClick={() => onNavigate(prev)} aria-label="Previous">‹</button>}
        <PreviewBody entry={entry} src={src} />
        {next && <button className="viewer-nav right" onClick={() => onNavigate(next)} aria-label="Next">›</button>}
      </div>
    </div>
  );
}

function PreviewBody({ entry, src }: { entry: Entry; src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (entry.kind !== "text") return;
    let alive = true;
    fetch(src, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Could not read it (${r.status}).`);
        return r.text();
      })
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [entry.path, entry.kind, src]);

  if (entry.kind === "image") {
    return <img className="viewer-img" src={src} alt={entry.name} onError={() => setError("This image could not be decoded by the browser.")} />;
  }

  if (entry.kind === "video") {
    // key on the path so switching files reloads the element rather than
    // leaving the previous video playing underneath.
    return (
      <div className="viewer-media">
        <video key={entry.path} className="viewer-video" src={src} controls autoPlay playsInline />
        <p className="viewer-note">
          The file is copied to the console once so that seeking works, since the NAS's own download links cannot
          serve a byte range. Formats the browser cannot decode — MKV with certain codecs, for instance — will show
          controls but no picture; download those instead.
        </p>
      </div>
    );
  }

  if (entry.kind === "audio") {
    return (
      <div className="viewer-media">
        <audio key={entry.path} src={src} controls autoPlay style={{ width: "min(560px, 90vw)" }} />
      </div>
    );
  }

  if (entry.kind === "pdf") {
    return <iframe className="viewer-doc" src={src} title={entry.name} />;
  }

  if (entry.kind === "text") {
    if (error) return <div className="error-banner" style={{ maxWidth: 600 }}>{error}</div>;
    if (text === null) return <div className="viewer-note">Loading…</div>;
    return <pre className="viewer-text">{text}</pre>;
  }

  return <div className="viewer-note">There is no preview for this kind of file. Download it to open it.</div>;
}

function KindIcon({ kind }: { kind: Entry["kind"] }) {
  if (kind === "image") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="m4 17 5-5 4 4 3-2 4 4" />
    </svg>
  );
  if (kind === "video") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9.5 5 2.5-5 2.5z" />
    </svg>
  );
  if (kind === "audio") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M9 18V6l10-2v12" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="16" r="2" />
    </svg>
  );
  if (kind === "pdf") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" /><path d="M14 3v4h4" /><path d="M9 13h6M9 16.5h4" />
    </svg>
  );
  return <FileIcon />;
}

const FolderIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M3 6h6l2 2h10v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);
const FileIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
    <path d="M14 3v4h4" />
  </svg>
);

/* ---------------------------------------------------------------- catalog */

interface CatalogApp {
  name: string;
  title: string;
  categories: string[];
  latest_version: string;
  train: string;
  description?: string;
  installed?: boolean;
}

export function CatalogPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const { data, error, loading } = useResource<{ categories: string[]; total: number; apps: CatalogApp[] }>(
    `/api/catalog?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`,
    0,
  );
  const [installing, setInstalling] = useState<CatalogApp | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>App catalog</h1>
          <div className="page-sub">{data ? `${data.total} apps available` : " "}</div>
        </div>
        <Input
          style={{ maxWidth: 240 }}
          placeholder="Search apps…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!!data?.categories.length && (
        <div className="chip-row" style={{ marginBottom: 16 }}>
          <button className={`chip ${!category ? "on" : ""}`} onClick={() => setCategory("")}>all</button>
          {data.categories.slice(0, 14).map((c) => (
            <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading && !data && <Loading rows={4} />}

      <div className="grid cards">
        {data?.apps.map((a) => (
          <div key={`${a.train}/${a.name}`} className="cat-card">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="app-icon">{a.title.slice(0, 2).toUpperCase()}</div>
              <div style={{ minWidth: 0 }}>
                <div className="app-name">{a.title}</div>
                <div className="app-meta">{a.latest_version} · {a.train}</div>
              </div>
            </div>
            {a.description && <div className="cat-desc">{a.description}</div>}
            <button className="btn primary" style={{ marginTop: "auto" }} onClick={() => setInstalling(a)}>
              Install
            </button>
          </div>
        ))}
        {!loading && !data?.apps.length && <Empty>Nothing matches that search.</Empty>}
      </div>

      {installing && (
        <InstallForm
          app={installing}
          onClose={() => setInstalling(null)}
          onStarted={(jobId, label) => {
            setJobs((j) => [...j, { id: jobId, label }]);
            setInstalling(null);
          }}
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function InstallForm({ app, onClose, onStarted }: {
  app: CatalogApp;
  onClose: () => void;
  onStarted: (jobId: number, label: string) => void;
}) {
  const [name, setName] = useState(app.name);
  const { busy, error, submit } = useSubmit(async () => {
    const { jobId } = await post<{ jobId: number }>("/api/apps", {
      appName: name,
      catalogApp: app.name,
      train: app.train,
    });
    onStarted(jobId, `Installing ${name}`);
  });

  return (
    <Modal
      title={`Install ${app.title}`}
      subtitle={`${app.latest_version} from the ${app.train} train`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !name} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Install"}
          </button>
        </>
      }
    >
      <Field label="Name for this instance" hint="Lower-case letters, numbers and dashes. This is how it appears under Apps.">
        <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} autoFocus />
      </Field>
      <p className="modal-text">
        The app is installed with its default configuration. Anything it needs beyond that — storage paths, ports,
        credentials — is edited in the TrueNAS app settings afterwards.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
