import { useState } from "react";
import { del, get, getConnection, post, put, setConnection, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill, TAGLINE } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";
import { AppearanceTab, ConsoleUpdateTab, EmailTab, NotificationsTab, SecurityTab, UpdatesTab, type WatchConfig, type Webhook } from "./settings-tabs";
import { ConsoleUsersTab } from "./console-users";

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
