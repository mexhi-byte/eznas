import { useState } from "react";
import { bytes, duration, post, put, rate, useRealtime, useResource, when } from "./api";
import { Empty, ErrorBanner, Loading, Sparkline } from "./components";
import { Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";

/* --------------------------------------------------------------------- data */

interface Overview {
  system: { version: string; hostname: string; uptime: number | string; cores: number; model: string; memoryBytes: number; loadavg: number[] };
  pools: Array<{
    name: string; status: string; healthy: boolean; size: number; allocated: number; free: number;
    scan: { function?: string; state?: string; percentage?: number } | null;
    vdevs: Array<{ type: string; disks: Array<{ disk: string; status?: string }> }>;
  }>;
  apps: { total: number; running: number; stopped: number; updatable: number };
  alerts: { total: number; critical: number; warning: number };
  disks: number;
}

interface App {
  name: string; title: string; state: string; icon: string | null; custom?: boolean;
  updatable: boolean; portals: Record<string, string>;
}

interface Alert { uuid: string; level: string; text: string; at: number }

interface Names { server: string; pools: Record<string, { label?: string; icon?: string }> }

interface UpdateInfo {
  currentVersion: string;
  available: { status?: string; changes?: Array<{ new?: { version?: string } }>; error?: string } | null;
}

export type Go = (page: string, sub?: string) => void;

/* --------------------------------------------------------------------- page */

/**
 * The home screen.
 *
 * Written for whoever pays the electricity bill rather than for whoever
 * configured the pool: what is on the box, whether it is happy, and the three
 * things people actually come here to do. Every number underneath is the same
 * one the NAS reports — it is the framing that changes, not the data.
 */
export function HomePage({ go }: { go: Go }) {
  const { data, error, loading } = useResource<Overview>("/api/overview", 15_000);
  const { data: apps } = useResource<App[]>("/api/apps", 30_000);
  const { data: alerts } = useResource<Alert[]>("/api/alerts", 30_000);
  const { data: settings, reload: reloadSettings } = useResource<{ names: Names }>("/api/settings", 0);
  const { now, live, history } = useRealtime();

  const [renaming, setRenaming] = useState<string | "server" | null>(null);
  const [action, setAction] = useState<"share" | "scan" | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  const names = settings?.names ?? { server: "", pools: {} };
  const serverName = names.server || data?.system.hostname || "My home server";

  // Boot pool excluded: it is the NAS's own root filesystem, it is never where
  // anyone's files are, and counting it makes the household total wrong.
  const pools = (data?.pools ?? []).filter((p) => p.name !== "boot-pool");
  const size = pools.reduce((s, p) => s + p.size, 0);
  const used = pools.reduce((s, p) => s + p.allocated, 0);
  const usedPct = size ? (used / size) * 100 : 0;
  const allHealthy = pools.every((p) => p.healthy);
  const critical = alerts?.filter((a) => ["CRITICAL", "ERROR", "ALERT", "EMERGENCY"].includes(a.level)) ?? [];

  const cpu = now?.cpu?.cpu?.usage ?? 0;
  const mem = now?.memory;
  const memPct = mem ? ((mem.physical_memory_total - mem.physical_memory_available) / mem.physical_memory_total) * 100 : 0;
  const nics = Object.values(now?.interfaces ?? {});
  const rx = nics.reduce((s, n) => s + n.received_bytes_rate, 0);
  const tx = nics.reduce((s, n) => s + n.sent_bytes_rate, 0);

  return (
    <>
      <div className="hero">
        <div className="hero-title">
          <span className={`hero-dot ${allHealthy && !critical.length ? "ok" : critical.length ? "bad" : "warn"}`} />
          <button className="hero-name" onClick={() => setRenaming("server")} title="Give this server a name">
            {serverName}
          </button>
          <span className={`pill ${live ? "ok" : "mute"}`}>
            <i className={`dot ${live ? "live" : ""}`} />
            {live ? "live" : "reconnecting"}
          </span>
        </div>
        <div className="hero-right">
          <div className="hero-stat">
            <b>{usedPct.toFixed(0)}%</b>
            <span>of {bytes(size)} used</span>
          </div>
        </div>
        <div className="hero-sub">
          {data ? (
            <>
              {allHealthy ? "Everything is healthy" : "A pool needs attention"} ·{" "}
              <button className="inline-link" onClick={() => go("drives", "map")}>
                {data.disks} drives
              </button>{" "}
              · up {duration(data.system.uptime)} · TrueNAS {data.system.version}
            </>
          ) : (
            "Reading the server…"
          )}
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <UpdateBanner onStarted={(id, label) => setJobs((j) => [...j, { id, label }])} />

      <Section title="What would you like to do?">
        <div className="launchers">
          <Launcher emoji="📁" title="Create a share" sub="Put a folder on the network" onClick={() => setAction("share")} />
          <Launcher emoji="🐳" title="Install an app" sub="Plex, Nextcloud, and the rest" onClick={() => go("apps", "catalog")} />
          <Launcher emoji="🛡️" title="Check the drives" sub="Verify every byte on a pool" onClick={() => setAction("scan")} />
        </div>
      </Section>

      <Section title="Your storage" hint="Click a pool to browse its files">
        {loading && !data ? (
          <Loading rows={2} />
        ) : pools.length ? (
          <div className="pool-cards">
            {pools.map((p) => (
              <PoolCard
                key={p.name}
                pool={p}
                nick={names.pools[p.name]}
                onOpen={() => go("files")}
                onRename={() => setRenaming(p.name)}
              />
            ))}
          </div>
        ) : (
          <Empty>No pools yet. Build one under Drive array map → Pools.</Empty>
        )}
      </Section>

      <Section title="How the server is feeling">
        <div className="health-cards">
          <HealthCard
            label="Processor"
            metric="cpu"
            value={`${cpu.toFixed(0)}%`}
            verdict={cpuVerdict(cpu)}
            points={history.cpu}
            color="var(--accent)"
            foot={data ? `${data.system.cores} cores` : ""}
          />
          <HealthCard
            label="Memory"
            metric="memory"
            value={`${memPct.toFixed(0)}%`}
            verdict={memVerdict(memPct, mem?.arc_size ?? 0, mem?.physical_memory_total ?? 1)}
            points={history.mem}
            color="var(--ok)"
            foot={mem ? `${bytes(mem.arc_size)} of it is file cache` : ""}
          />
          <HealthCard
            label="Network"
            metric="network"
            unit="rate"
            value={rate(rx + tx)}
            verdict={rx + tx > 1024 ** 2 ? "Moving data right now." : "Quiet."}
            points={history.rx}
            color="#8b7bf5"
            foot={`${rate(rx)} in · ${rate(tx)} out`}
          />
        </div>
      </Section>

      <Section
        title="Your apps"
        hint={apps ? `${apps.filter((a) => a.state === "RUNNING").length} of ${apps.length} running` : undefined}
      >
        {apps ? (
          <div className="app-tiles">
            {apps.map((a) => <AppTile key={a.name} app={a} />)}
            <button className="app-tile add" onClick={() => go("apps", "catalog")}>
              <span className="tile-icon">＋</span>
              <span className="tile-name">Install an app</span>
            </button>
          </div>
        ) : (
          <Loading rows={2} />
        )}
      </Section>

      {!!alerts?.length && (
        <Section title="Worth a look" hint={`${alerts.length} from the NAS`} onMore={() => go("advanced", "alerts")}>
          <div className="notice-list">
            {[...alerts]
              .sort((a, b) => Number(critical.includes(b)) - Number(critical.includes(a)) || b.at - a.at)
              .slice(0, 6)
              .map((a) => (
                <div key={a.uuid} className={`notice ${critical.includes(a) ? "bad" : ""}`}>
                  <span>{critical.includes(a) ? "🔴" : "🟡"}</span>
                  <div>
                    <div>{a.text}</div>
                    <div className="stat-foot">{when(a.at)}</div>
                  </div>
                </div>
              ))}
          </div>
        </Section>
      )}

      {renaming && (
        <RenameThing
          what={renaming}
          current={renaming === "server" ? { label: names.server } : names.pools[renaming] ?? {}}
          onClose={() => setRenaming(null)}
          onSaved={() => { setRenaming(null); void reloadSettings(); }}
        />
      )}

      {action === "share" && <CreateShare onClose={() => setAction(null)} />}
      {action === "scan" && (
        <RunScan
          pools={pools.map((p) => ({ name: p.name, label: names.pools[p.name]?.label }))}
          onClose={() => setAction(null)}
          onStarted={(id, label) => { setAction(null); setJobs((j) => [...j, { id, label }]); }}
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 8000)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- pieces */

function Section({ title, hint, onMore, children }: {
  title: string; hint?: string; onMore?: () => void; children: React.ReactNode;
}) {
  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2>{title}</h2>
        {hint && <span>{hint}</span>}
        {onMore && <button className="link-btn inline" onClick={onMore}>Manage</button>}
      </div>
      {children}
    </section>
  );
}

function Launcher({ emoji, title, sub, onClick }: { emoji: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button className="launcher" onClick={onClick}>
      <span className="launcher-emoji">{emoji}</span>
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </button>
  );
}

const POOL_EMOJI = ["💾", "🎬", "📸", "🏦", "📦", "🗄️", "🎵", "🧾", "🖥️", "🧪"];

function PoolCard({ pool, nick, onOpen, onRename }: {
  pool: Overview["pools"][number];
  nick?: { label?: string; icon?: string };
  onOpen: () => void;
  onRename: () => void;
}) {
  const pct = pool.size ? (pool.allocated / pool.size) * 100 : 0;
  const state = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
  const disks = pool.vdevs.reduce((n, v) => n + v.disks.length, 0);
  const scanning = pool.scan?.state === "SCANNING";

  return (
    <div className={`pool-card ${pool.healthy ? "" : "unhealthy"}`}>
      <button className="pool-open" onClick={onOpen}>
        <div className="pool-top">
          <span className="pool-emoji">{nick?.icon ?? "💾"}</span>
          <div style={{ minWidth: 0 }}>
            <div className="pool-label">{nick?.label ?? pool.name}</div>
            <div className="pool-sub">
              {nick?.label ? `${pool.name} · ` : ""}
              {disks} drive{disks === 1 ? "" : "s"}
              {pool.healthy ? "" : ` · ${pool.status.toLowerCase()}`}
            </div>
          </div>
        </div>

        <div className={`fat-bar ${state}`}>
          <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        </div>

        <div className="pool-foot">
          <b>{bytes(pool.free)} free</b>
          <span>{pct.toFixed(0)}% used of {bytes(pool.size)}</span>
        </div>

        {scanning && (
          <div className="pool-scan">
            Checking the drives — {(pool.scan?.percentage ?? 0).toFixed(0)}% through
          </div>
        )}
      </button>
      <button className="pool-rename" onClick={onRename} title="Rename this pool for the household">✎</button>
    </div>
  );
}

const cpuVerdict = (pct: number): string =>
  pct < 20 ? "Idling." : pct < 60 ? "Comfortable." : pct < 85 ? "Working hard." : "Flat out.";

/**
 * ZFS deliberately fills memory with cache and hands it back on demand, so a
 * high number here is the file cache doing its job — the reading that panics
 * people on every other machine they own.
 */
const memVerdict = (pct: number, arc: number, total: number): string => {
  const cacheShare = total ? arc / total : 0;
  if (cacheShare > 0.25) return "Mostly file cache, which is exactly right.";
  return pct > 90 ? "Genuinely full." : "Plenty spare.";
};

interface History {
  series: string[];
  points: Array<{ t: number; v: number[] }>;
  summary: { min: number; max: number; mean: number; from: number; to: number } | null;
}

/**
 * One live figure, with the option of seeing the last day instead.
 *
 * The live line answers "what is it doing now", which is no use for something
 * that went wrong while everybody was asleep. Switching to 24 hours reads the
 * history TrueNAS already keeps, so a container that leaked memory overnight
 * shows up as a shape rather than having to be caught in the act.
 */
function HealthCard({ label, metric, value, verdict, points, color, foot, unit }: {
  label: string; metric: string; value: string; verdict: string;
  points: number[]; color: string; foot: string; unit?: string;
}) {
  const [range, setRange] = useState<"live" | "day">("live");
  // Only fetched once the toggle is used: three history calls on every home
  // screen load would be three seconds of NAS work nobody asked for.
  const { data, loading } = useResource<History>(
    range === "day" ? `/api/history?metric=${metric}&unit=DAY` : "",
    0,
  );

  const historic = (data?.points ?? []).map((p) => p.v[0] ?? 0);
  const summary = data?.summary;

  return (
    <div className="health-card">
      <div className="health-card-top">
        <span>{label}</span>
        <b>{range === "live" ? value : summary ? `${fmt(summary.mean, unit)} avg` : "…"}</b>
      </div>

      {range === "live" ? (
        <Sparkline points={points} max={metric === "network" ? undefined : 100} color={color} />
      ) : loading && !data ? (
        <div className="spark-placeholder">reading the last day…</div>
      ) : historic.length ? (
        <Sparkline points={historic} max={metric === "network" ? undefined : 100} color={color} />
      ) : (
        <div className="spark-placeholder">no history kept for this yet</div>
      )}

      <div className="health-verdict">
        {range === "live"
          ? verdict
          : summary
            ? `Between ${fmt(summary.min, unit)} and ${fmt(summary.max, unit)} over the day.`
            : "Nothing recorded."}
      </div>

      <div className="card-foot-row">
        <span className="stat-foot">{range === "live" ? foot : "last 24 hours"}</span>
        <button className="range-toggle" onClick={() => setRange(range === "live" ? "day" : "live")}>
          {range === "live" ? "24 hours" : "Live"}
        </button>
      </div>
    </div>
  );
}

/** Percentages to one place; throughput back to human units. */
const fmt = (n: number, unit?: string): string =>
  unit === "rate" ? rate(n * 1024) : `${n.toFixed(0)}%`;

/**
 * A stable colour for an app with no logo.
 *
 * Hashed from the name rather than the index, so adding an app does not
 * recolour the ones next to it. Kept dark and desaturated: these sit behind a
 * white letter in every theme, and a bright tile shouts louder than an app
 * deserves to.
 */
function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 34%)`;
}

function AppTile({ app }: { app: App }) {
  const portal = Object.values(app.portals ?? {})[0];
  const running = app.state === "RUNNING";
  const [broken, setBroken] = useState(false);

  const body = (
    <>
      <span
        className="tile-icon"
        // A custom app has no logo to show, so it gets a letter — and a colour
        // of its own, because fifteen grey letters are only marginally easier
        // to tell apart than fifteen identical ones. Derived from the name, so
        // an app keeps its colour between visits and between machines.
        style={app.icon && !broken ? undefined : { background: tint(app.name) }}
      >
        {app.icon && !broken ? (
          <img src={app.icon} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          app.title.slice(0, 1).toUpperCase()
        )}
        <i className={`tile-dot ${running ? "on" : ""}`} title={app.state.toLowerCase()} />
      </span>
      <span className="tile-name">{app.title}</span>
      {app.updatable && <span className="tile-badge">update</span>}
    </>
  );

  // An app with a web interface is something to open; one without is only
  // something to look at, so it does not pretend to be a link.
  return portal && running ? (
    <a className="app-tile" href={portal} target="_blank" rel="noreferrer" title={`Open ${app.title}`}>{body}</a>
  ) : (
    <div className="app-tile" title={running ? "No web interface" : `${app.title} is ${app.state.toLowerCase()}`}>{body}</div>
  );
}

/* ------------------------------------------------------------------ updates */

function UpdateBanner({ onStarted }: { onStarted: (jobId: number, label: string) => void }) {
  const { data } = useResource<UpdateInfo>("/api/update", 0);
  const [asking, setAsking] = useState(false);

  const version = data?.available?.changes?.[0]?.new?.version;
  if (data?.available?.status !== "AVAILABLE" || !version) return null;

  return (
    <>
      <div className="update-banner">
        <div>
          <b>A new version of TrueNAS is ready</b>
          <span>{data.currentVersion} → {version}</span>
        </div>
        <button className="btn primary big" onClick={() => setAsking(true)}>Update the server now</button>
      </div>
      {asking && <ConfirmUpdate version={version} onClose={() => setAsking(false)} onStarted={onStarted} />}
    </>
  );
}

function ConfirmUpdate({ version, onClose, onStarted }: {
  version: string;
  onClose: () => void;
  onStarted: (jobId: number, label: string) => void;
}) {
  const [reboot, setReboot] = useState(true);

  const { busy, error, submit } = useSubmit(async () => {
    // Download first and apply second, because the download is the long part
    // and a failure there should not have touched the running system.
    const dl = await post<{ jobId: number }>("/api/update/download");
    onStarted(dl.jobId, `Downloading ${version}`);
    onClose();
  });

  return (
    <Modal
      title={`Update to ${version}`}
      subtitle="Downloaded first, installed second."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Not now</button>
          <button className="btn primary" disabled={busy} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Start the download"}
          </button>
        </>
      }
    >
      <p className="modal-text">
        The download runs in the background and changes nothing while it does. When it finishes, install it from
        Settings → Updates{reboot ? " — the server reboots, so anything streaming from it will stop for a few minutes." : "."}
      </p>
      <Toggle checked={reboot} onChange={setReboot} label="Reboot when it installs (recommended)" />
      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ renaming */

function RenameThing({ what, current, onClose, onSaved }: {
  what: string;
  current: { label?: string; icon?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(current.label ?? "");
  const [icon, setIcon] = useState(current.icon ?? "💾");
  const isServer = what === "server";

  const { busy, error, submit } = useSubmit(async () => {
    await put("/api/settings", isServer ? { names: { server: label } } : { names: { pools: { [what]: { label, icon } } } });
    onSaved();
  });

  return (
    <Modal
      title={isServer ? "Name this server" : `Rename ${what}`}
      subtitle="Only here. The NAS keeps its real name, and so does the pool."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label={isServer ? "Name" : "What you call it"} hint={isServer ? "" : "Leave empty to go back to the pool's real name."}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={isServer ? "My home server" : "Main media pool"} autoFocus />
      </Field>

      {!isServer && (
        <Field label="Icon">
          <div className="emoji-row">
            {POOL_EMOJI.map((e) => (
              <button key={e} className={`emoji ${icon === e ? "on" : ""}`} onClick={() => setIcon(e)}>{e}</button>
            ))}
          </div>
        </Field>
      )}

      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/* -------------------------------------------------------------- quick actions */

function CreateShare({ onClose }: { onClose: () => void }) {
  const { data: datasets } = useResource<Array<{ id: string; mountpoint: string; type: string }>>("/api/datasets", 0);
  const usable = (datasets ?? []).filter((d) => d.type !== "VOLUME" && d.mountpoint);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const chosen = path || usable[0]?.mountpoint || "";

  const { busy, error, submit } = useSubmit(async () => {
    const r = await post<{ startedService: boolean }>("/api/shares/smb", {
      name: name || chosen.split("/").pop(),
      path: chosen,
      readOnly,
    });
    setDone(
      r.startedService
        ? "Share created, and Windows file sharing was switched on for you."
        : "Share created.",
    );
  });

  return (
    <Modal
      title="Share a folder on the network"
      subtitle="Windows, macOS and Linux all see it as a normal network folder."
      onClose={onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary" disabled={busy || !chosen} onClick={() => void submit(undefined as void)}>
              {busy ? "Creating…" : "Create the share"}
            </button>
          </>
        )
      }
    >
      {done ? (
        <>
          <p className="modal-text">{done}</p>
          <p className="modal-text">
            On Windows it is <strong className="mono">\\{location.hostname}\{name || chosen.split("/").pop()}</strong>; on a
            Mac, Go → Connect to Server.
          </p>
        </>
      ) : (
        <>
          <Field label="Folder" hint="Only datasets can be shared — each one is its own filesystem.">
            <Select value={chosen} onChange={(e) => setPath(e.target.value)}>
              {usable.map((d) => <option key={d.id} value={d.mountpoint}>{d.id}</option>)}
            </Select>
          </Field>

          <Field label="Name on the network" hint="What it will be called when someone browses to this server.">
            <Input
              value={name}
              placeholder={chosen.split("/").pop() ?? ""}
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 _-]/g, ""))}
            />
          </Field>

          <Toggle checked={readOnly} onChange={setReadOnly} label="Read-only — people can look but not change anything" />

          <p className="modal-text" style={{ marginTop: 12 }}>
            Who can open it is decided by the accounts on this server. Add people under Household accounts.
          </p>

          {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
        </>
      )}
    </Modal>
  );
}

function RunScan({ pools, onClose, onStarted }: {
  pools: Array<{ name: string; label?: string }>;
  onClose: () => void;
  onStarted: (jobId: number, label: string) => void;
}) {
  const [pool, setPool] = useState(pools[0]?.name ?? "");

  const { busy, error, submit } = useSubmit(async () => {
    const { jobId } = await post<{ jobId: number }>(`/api/pools/${encodeURIComponent(pool)}/scrub`);
    onStarted(jobId, `Checking ${pools.find((p) => p.name === pool)?.label ?? pool}`);
  });

  return (
    <Modal
      title="Check the drives"
      subtitle="ZFS reads every byte it stored and repairs anything that came back wrong."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !pool} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Start the check"}
          </button>
        </>
      }
    >
      <Field label="Which pool">
        <Select value={pool} onChange={(e) => setPool(e.target.value)}>
          {pools.map((p) => <option key={p.name} value={p.name}>{p.label ? `${p.label} (${p.name})` : p.name}</option>)}
        </Select>
      </Field>
      <p className="modal-text" style={{ marginTop: 12 }}>
        It runs in the background and is safe to leave. On a full pool of spinning disks it takes hours and everything
        else on the server will feel slower while it does. Once a month is plenty.
      </p>
      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}
