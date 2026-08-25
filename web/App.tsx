import { useEffect, useState, type ReactElement } from "react";
import { del, get, getConnection, post, setConnection, useResource } from "./api";
import { Modal, Tabs } from "./ui";
import { Icons, TAGLINE } from "./components";
import { AppsPage, DatasetsPage, StoragePage } from "./pages";
import { AlertsPage, DisksPage, ServicesPage } from "./pages2";
import { SharesPage } from "./shares";
import { SnapshotsPage } from "./snapshots";
import { HomePage } from "./home";
import { DriveMapPage } from "./drivemap";
import { CatalogPage, SettingsPage, UsersPage, type Conn } from "./pages3";
import { FilesPage } from "./files-page";
import { NetworkPage, TerminalPage } from "./pages4";

/**
 * Named for what people want, not for how TrueNAS is organised.
 *
 * "Storage", "Sharing" and "System" are filing-cabinet labels: correct, and no
 * help at all to someone who came here to put a folder on the network. Each
 * entry is now the thing you would say out loud. The screens behind them are
 * unchanged — only the way in is different.
 */
type PageId = "home" | "drives" | "files" | "apps" | "sharing" | "people" | "advanced" | "settings";

const PAGES: Array<{ id: PageId; label: string; icon: ReactElement }> = [
  { id: "home", label: "Home", icon: Icons.overview },
  { id: "drives", label: "Drive array map", icon: Icons.storage },
  { id: "files", label: "My files", icon: Icons.files },
  { id: "apps", label: "Apps", icon: Icons.apps },
  { id: "sharing", label: "Shared folders", icon: Icons.shares },
  { id: "people", label: "Household accounts", icon: Icons.users },
  { id: "advanced", label: "Advanced", icon: Icons.services },
  { id: "settings", label: "Settings", icon: Icons.settings },
];

const SUBS = {
  drives: [
    { id: "map", label: "Map" },
    { id: "pools", label: "Pools" },
    { id: "datasets", label: "Folders" },
    { id: "snapshots", label: "Snapshots" },
    { id: "disks", label: "Drives" },
  ],
  apps: [
    { id: "installed", label: "Installed" },
    { id: "catalog", label: "Add an app" },
  ],
  sharing: [
    { id: "shares", label: "Shared folders" },
    { id: "services", label: "Services" },
  ],
  advanced: [
    { id: "alerts", label: "Alerts" },
    { id: "network", label: "Network" },
    { id: "terminal", label: "Terminal" },
  ],
} as const;

/** #/page/sub — so a reload, a bookmark and the back button all land right. */
function useHashRoute(): [PageId, string, (p: PageId, sub?: string) => void] {
  const read = (): [PageId, string] => {
    const [raw, s] = window.location.hash.replace(/^#\/?/, "").split("/");
    // Bookmarks written before the sections were renamed still work.
    const p = ({ overview: "home", storage: "drives", system: "people" } as Record<string, string>)[raw] ?? raw;
    const page = (PAGES.some((x) => x.id === p) ? p : "home") as PageId;
    return [page, s ?? ""];
  };
  const [state, setState] = useState<[PageId, string]>(read);
  useEffect(() => {
    const onHash = () => setState(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [
    state[0],
    state[1],
    (p, sub) => {
      window.location.hash = sub ? `/${p}/${sub}` : `/${p}`;
      setState([p, sub ?? ""]);
    },
  ];
}

export interface Me { username: string; role: "admin" | "viewer" }

/** What the running build calls itself, filled in from /api/session. */
interface Build { version: string; channel: string }

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [build, setBuild] = useState<Build | null>(null);

  useEffect(() => {
    void get<{ authenticated: boolean; username: string | null; role: Me["role"] | null; theme?: string; version?: string; channel?: string }>("/api/session")
      .then((s) => {
        setAuthed(s.authenticated);
        if (s.version) setBuild({ version: s.version, channel: s.channel ?? "" });
        if (s.authenticated && s.username && s.role) setMe({ username: s.username, role: s.role });
        // Only when this browser has no preference of its own.
        if (s.theme && !localStorage.getItem("tnui:theme")) document.documentElement.dataset.theme = s.theme;
      })
      .catch(() => setAuthed(false));
    const out = () => { setAuthed(false); setMe(null); };
    window.addEventListener("tnui:signed-out", out);
    return () => window.removeEventListener("tnui:signed-out", out);
  }, []);

  if (authed === null) return <div className="login-wrap" />;
  if (!authed || !me) return <Login build={build} onIn={(who) => { setMe(who); setAuthed(true); }} />;
  return <Shell me={me} build={build} onOut={() => { setAuthed(false); setMe(null); }} />;
}

function Login({ build, onIn }: { build: Build | null; onIn: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ username: string; role: Me["role"] }>(
        "/api/login",
        { username, password, ...(code ? { code } : {}) },
      );
      onIn({ username: r.username, role: r.role });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The password was right and only the second factor is missing, so ask
      // for the code rather than making them retype everything.
      if (/authenticator|code/i.test(message)) setNeedCode(true);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div className="brand-mark"><Logo /></div>
          <div>
            <h1>Storage console</h1>
            <p>Sign in to continue</p>
          </div>
        </div>
        <input
          placeholder="Username"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needCode && (
          <input
            placeholder="Six-digit code"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 12))}
          />
        )}
        {error && <span className="err">{error}</span>}
        <button type="submit" disabled={busy || !username || !password}>{busy ? "Checking…" : "Sign in"}</button>
        <p className="tagline">{TAGLINE}</p>
        {build && <p className="tagline" style={{ marginTop: 2 }}>v{build.version}{build.channel ? ` · ${build.channel}` : ""}</p>}
      </form>
    </div>
  );
}

function Shell({ me, build, onOut }: { me: Me; build: Build | null; onOut: () => void }) {
  const [page, sub, go] = useHashRoute();
  const [menu, setMenu] = useState(false);
  const { data: alerts } = useResource<Array<unknown>>("/api/alerts", 60_000);
  const { data: events, reload: reloadEvents } = useResource<Notice[]>("/api/events", 20_000);
  const { data: conns } = useResource<Conn[]>("/api/connections", 60_000);
  const { data: health } = useResource<{ connected: boolean; error: string | null }>("/api/health", 15_000);
  const [showNotifs, setShowNotifs] = useState(false);

  const unseen = (events ?? []).filter((e) => !e.seen).length;
  const alertCount = alerts?.length ?? 0;
  const active = conns?.find((c) => c.id === getConnection()) ?? conns?.find((c) => c.isDefault) ?? conns?.[0];

  /*
   * The tabs this account may actually reach.
   *
   * Terminal is a root shell on the NAS, so the server refuses the WebSocket
   * upgrade for anyone who is not an admin. Leaving the tab visible would give
   * a viewer a terminal that connects, says "session ended" and never explains
   * why — so the tab is dropped from the list rather than shown and blocked.
   * Dropping it here also handles the bookmarked #/advanced/terminal, because
   * subOf falls back to the first tab whenever the requested one is not listed.
   */
  const tabsFor = (group: keyof typeof SUBS): ReadonlyArray<{ id: string; label: string }> =>
    group === "advanced" && me.role !== "admin"
      ? SUBS.advanced.filter((t) => t.id !== "terminal")
      : SUBS[group];

  const subOf = (group: keyof typeof SUBS): string => {
    const list = tabsFor(group);
    return list.some((t) => t.id === sub) ? sub : list[0].id;
  };

  return (
    <div className="app">
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Logo /></div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">Storage console</div>
            <div className="brand-host">{active ? active.name : "no server yet"}</div>
          </div>
        </div>

        {(conns?.length ?? 0) > 1 && (
          <select
            className="picker"
            value={active?.id ?? ""}
            onChange={(e) => { setConnection(e.target.value); window.location.reload(); }}
          >
            {conns!.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.connected ? "" : " (offline)"}</option>
            ))}
          </select>
        )}

        <nav className="nav">
          {PAGES.map((p) => (
            <a
              key={p.id}
              href={`#/${p.id}`}
              className={page === p.id ? "active" : ""}
              onClick={() => { go(p.id); setMenu(false); }}
            >
              {p.icon}
              {p.label}
            </a>
          ))}
        </nav>

        <div className="sidebar-foot">
          {health && !health.connected && (
            <span className="pill bad" title={health.error ?? ""}>NAS unreachable</span>
          )}
          {active && (
            <a
              className="link-btn"
              href={active.url.replace(/^wss?:/, "https:").replace(/\/api\/current$/, "")}
              target="_blank"
              rel="noreferrer"
              style={{ textAlign: "center" }}
            >
              Open TrueNAS ↗
            </a>
          )}
          <div className="whoami">
            <span>{me.username}</span>
            {me.role === "viewer" && <span className="pill mute">view only</span>}
          </div>
          {build && (
            <a
              className="build-badge"
              href={`#/settings`}
              onClick={() => go("settings")}
              title="What is running, and whether there is anything newer"
            >
              v{build.version}{build.channel ? ` · ${build.channel}` : ""}
            </a>
          )}
          <button className="link-btn" onClick={async () => { await post("/api/logout"); onOut(); }}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setMenu(true)} aria-label="Menu">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <button
            className="menu-btn bell"
            onClick={() => { setShowNotifs(true); void post("/api/events").then(() => reloadEvents()); }}
            aria-label="Notifications"
            title="Alerts and disk notifications"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a6 6 0 0 0-6 6c0 4-2 5-2 7h16c0-2-2-3-2-7a6 6 0 0 0-6-6z" />
              <path d="M10 20a2 2 0 0 0 4 0" />
            </svg>
            {unseen + alertCount > 0 && <span className="bell-dot">{unseen + alertCount}</span>}
          </button>
        </div>

        {page === "home" && <HomePage go={(p, sub) => go(p as PageId, sub)} />}
        {page === "files" && <FilesPage />}
        {page === "people" && <UsersPage />}
        {page === "settings" && <SettingsPage me={me} />}

        {page === "drives" && (
          <>
            <Tabs tabs={SUBS.drives} active={subOf("drives") as "map"} onChange={(id) => go("drives", id)} />
            {subOf("drives") === "map" && <DriveMapPage />}
            {subOf("drives") === "pools" && <StoragePage />}
            {subOf("drives") === "datasets" && <DatasetsPage />}
            {subOf("drives") === "snapshots" && <SnapshotsPage />}
            {subOf("drives") === "disks" && <DisksPage />}
          </>
        )}

        {page === "apps" && (
          <>
            <Tabs tabs={SUBS.apps} active={subOf("apps") as "installed"} onChange={(id) => go("apps", id)} />
            {subOf("apps") === "installed" && <AppsPage />}
            {subOf("apps") === "catalog" && <CatalogPage />}
          </>
        )}

        {page === "sharing" && (
          <>
            <Tabs tabs={SUBS.sharing} active={subOf("sharing") as "shares"} onChange={(id) => go("sharing", id)} />
            {subOf("sharing") === "shares" && <SharesPage />}
            {subOf("sharing") === "services" && <ServicesPage />}
          </>
        )}

        {page === "advanced" && (
          <>
            <Tabs tabs={tabsFor("advanced") as ReadonlyArray<{ id: "alerts"; label: string }>} active={subOf("advanced") as "alerts"} onChange={(id) => go("advanced", id)} />
            {subOf("advanced") === "alerts" && <AlertsPage />}
            {subOf("advanced") === "network" && <NetworkPage />}
            {subOf("advanced") === "terminal" && me.role === "admin" && <TerminalPage />}
          </>
        )}
      </main>

      {showNotifs && (
        <Notifications
          events={events ?? []}
          onClose={() => setShowNotifs(false)}
          onCleared={() => void reloadEvents()}
        />
      )}
    </div>
  );
}

interface Notice {
  id: string; at: number; level: "info" | "warn" | "bad";
  category: string; key: string; title: string; detail: string;
  server: string; seen: boolean;
}

function Notifications({ events, onClose, onCleared }: { events: Notice[]; onClose: () => void; onCleared: () => void }) {
  const [checking, setChecking] = useState(false);

  const when = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };

  // Worst first, then newest: somebody opening this wants the problem, not the
  // most recent thing that happened to be logged.
  const rank = { bad: 0, warn: 1, info: 2 } as Record<string, number>;
  const sorted = [...events].sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || b.at - a.at);

  return (
    <Modal
      title="Notifications"
      subtitle="Raised by this console, watching things TrueNAS does not alert on."
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn"
            style={{ marginRight: "auto", flex: "none" }}
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try { await post("/api/events/check"); onCleared(); } finally { setChecking(false); }
            }}
          >
            {checking ? "Checking…" : "Check now"}
          </button>
          <button className="btn" onClick={async () => { await del("/api/events"); onCleared(); onClose(); }}>Clear all</button>
          <button className="btn primary" onClick={onClose}>Close</button>
        </>
      }
    >
      {sorted.length === 0 ? (
        <p className="modal-text">
          Nothing to report. Pools, space, temperatures, drive errors, apps and scrubs are checked every minute.
        </p>
      ) : (
        <div className="notice-list">
          {sorted.map((e) => (
            <div key={e.id} className={`notice ${e.level === "bad" ? "bad" : ""}`}>
              <span>{e.level === "bad" ? "🔴" : e.level === "warn" ? "🟡" : "🔵"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                <div style={{ color: "var(--muted)", marginTop: 2 }}>{e.detail}</div>
                <div className="stat-foot">
                  {e.category}
                  {e.server ? ` · ${e.server}` : ""} · {when(e.at)}
                  {!e.seen && " · new"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const Logo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
);
