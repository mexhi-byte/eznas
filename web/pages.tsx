import { useMemo, useState } from "react";
import { bytes, del, level, post, useResource, when } from "./api";
import { Bar, Card, Empty, ErrorBanner, Icons, Loading, Pill } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";
import { AppConfigModal } from "./app-config";

/* ------------------------------------------------------------------- pools */

export interface PoolSummary {
  name: string;
  status: string;
  healthy: boolean;
  size: number;
  allocated: number;
  free: number;
  fragmentation?: string;
  vdevs: Array<{ type: string; status?: string; disks: Array<{ disk: string; status?: string }> }>;
  cache: string[];
  log: string[];
  spare: string[];
  scan: { function?: string; state?: string; percentage?: number; endedAt?: number } | null;
}

/** A labelled number with a note under it, used all over the pool cards. */
function Glance({ label, value, sub, bad }: { label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={bad ? { color: "var(--bad)" } : undefined}>{value}</span>
      <span className="stat-foot">{sub}</span>
    </div>
  );
}


export function StoragePage() {
  const { data, error, loading, reload } = useResource<PoolSummary[]>("/api/pools", 30_000);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<PoolSummary | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  const addJob = (id: number, label: string) => setJobs((j) => [...j, { id, label }]);

  async function scrub(name: string) {
    const { jobId } = await post<{ jobId: number }>(`/api/pools/${encodeURIComponent(name)}/scrub`);
    addJob(jobId, `Scrubbing ${name}`);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pools</h1>
          <div className="page-sub">How the drives are grouped, and when each group was last checked.</div>
        </div>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setCreating(true)}>
          Create pool
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !data && <Loading rows={3} />}

      <div className="grid" style={{ gap: 14 }}>
        {data?.map((pool) => {
          const pct = pool.size ? (pool.allocated / pool.size) * 100 : 0;
          return (
            <Card key={pool.name}>
              <div className="card-head">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <h2 style={{ fontSize: 16 }}>{pool.name}</h2>
                  <Pill state={pool.status} />
                </div>
                <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                  <span className={`pill ${level(pct) || "mute"}`}>{pct.toFixed(0)}% used</span>
                  <button className="btn" style={{ flex: "none" }} onClick={() => void scrub(pool.name)}>Scrub</button>
                  <button className="btn danger" style={{ flex: "none" }} onClick={() => setExporting(pool)}>Export</button>
                </div>
              </div>

              <Bar pct={pct} />
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, margin: "14px 0 4px" }}>
                <Glance label="Capacity" value={bytes(pool.size)} sub="total" />
                <Glance label="Used" value={bytes(pool.allocated)} sub={`${pct.toFixed(1)}%`} />
                <Glance label="Free" value={bytes(pool.free)} sub="available" />
                <Glance
                  label="Last scrub"
                  value={pool.scan?.endedAt ? when(pool.scan.endedAt) : "never"}
                  sub={pool.scan?.state === "SCANNING" ? `running ${(pool.scan.percentage ?? 0).toFixed(0)}%` : (pool.scan?.state ?? "").toLowerCase() || "—"}
                />
              </div>

              <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <span className="card-title">Layout</span>
                <div className="grid" style={{ gap: 8, marginTop: 10 }}>
                  {pool.vdevs.map((v, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span className="pill info">{v.type.toLowerCase()}</span>
                      {v.disks.map((d) => (
                        <span key={d.disk} className="mono" style={{ fontSize: 12.5, color: d.status === "ONLINE" ? "var(--muted)" : "var(--bad)" }}>
                          {d.disk}
                        </span>
                      ))}
                    </div>
                  ))}
                  {!pool.vdevs.length && <Empty>Layout unavailable.</Empty>}
                  {!!pool.cache.length && <Extra label="cache" disks={pool.cache} />}
                  {!!pool.log.length && <Extra label="log" disks={pool.log} />}
                  {!!pool.spare.length && <Extra label="spare" disks={pool.spare} />}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {creating && (
        <CreatePool onClose={() => setCreating(false)} onStarted={(id, label) => { addJob(id, label); setCreating(false); void reload(); }} />
      )}

      {exporting && (
        <DangerConfirm
          what="pool"
          name={exporting.name}
          verb="Export"
          onCancel={() => setExporting(null)}
          onConfirm={async (confirm) => {
            const { jobId } = await del<{ jobId: number }>(`/api/pools/${encodeURIComponent(exporting.name)}`, { confirm, destroy: false });
            addJob(jobId, `Exporting ${exporting.name}`);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              Exporting detaches the pool but leaves the data on the disks, so it can be imported again. It does not
              erase anything. Shares and apps that depend on it will stop.
            </p>
          }
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress key={j.id} jobId={j.id} label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000)} />
          ))}
        </div>
      )}
    </>
  );
}

interface UnusedDisk { name: string; model: string; size: number; serial: string; inUse?: boolean }

function CreatePool({ onClose, onStarted }: { onClose: () => void; onStarted: (jobId: number, label: string) => void }) {
  const { data: disks, reload } = useResource<UnusedDisk[]>("/api/disks", 0);
  const [name, setName] = useState("");
  const [layout, setLayout] = useState("MIRROR");
  const [picked, setPicked] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  const free = (disks ?? []).filter((d) => !d.inUse);

  const { busy, error, submit } = useSubmit(async () => {
    const { jobId } = await post<{ jobId: number }>("/api/pools", { name, layout, disks: picked });
    onStarted(jobId, `Creating ${name}`);
  });

  // Minimum members, so the form cannot ask the NAS for something it will refuse.
  const need: Record<string, number> = { STRIPE: 1, MIRROR: 2, RAIDZ1: 3, RAIDZ2: 4, RAIDZ3: 5 };
  const enough = picked.length >= (need[layout] ?? 1);

  async function rescan() {
    setScanning(true);
    try {
      await post("/api/disks/rescan");
      await reload();
    } finally {
      setScanning(false);
    }
  }

  return (
    <Modal
      title="Create a pool"
      subtitle="Only disks not already in use are listed."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={() => void rescan()} disabled={scanning}>{scanning ? "Scanning…" : "Scan for disks"}</button>
          <button className="btn primary" disabled={busy || !name || !enough} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Create"}
          </button>
        </>
      }
    >
      <Field label="Pool name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="tank2" autoFocus />
      </Field>

      <Field label="Layout" hint={`${layout} needs at least ${need[layout] ?? 1} disk${(need[layout] ?? 1) > 1 ? "s" : ""}.`}>
        <Select value={layout} onChange={(e) => setLayout(e.target.value)}>
          <option value="STRIPE">Stripe — no redundancy, any disk lost loses the pool</option>
          <option value="MIRROR">Mirror — every disk holds a full copy</option>
          <option value="RAIDZ1">RAIDZ1 — survives one disk failure</option>
          <option value="RAIDZ2">RAIDZ2 — survives two</option>
          <option value="RAIDZ3">RAIDZ3 — survives three</option>
        </Select>
      </Field>

      <Field label={`Disks (${picked.length} selected)`}>
        <div className="grid" style={{ gap: 7 }}>
          {free.map((d) => {
            const on = picked.includes(d.name);
            return (
              <label key={d.name} className={`disk-pick ${on ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setPicked((p) => (on ? p.filter((x) => x !== d.name) : [...p, d.name]))}
                />
                <span className="mono" style={{ minWidth: 46 }}>{d.name}</span>
                <span style={{ flex: 1, color: "var(--muted)", fontSize: 12.5 }}>{d.model}</span>
                <span className="num" style={{ fontSize: 12.5 }}>{bytes(d.size)}</span>
              </label>
            );
          })}
          {!free.length && <Empty>Every disk is already in a pool. Use “Scan for disks” after adding one.</Empty>}
        </div>
      </Field>

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

const Extra = ({ label, disks }: { label: string; disks: string[] }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <span className="pill mute">{label}</span>
    <span className="mono" style={{ fontSize: 12.5, color: "var(--muted)" }}>{disks.join(", ")}</span>
  </div>
);

/* ---------------------------------------------------------------- datasets */

interface Dataset {
  id: string;
  name: string;
  pool: string;
  type: string;
  encrypted: boolean;
  used: number | null;
  available: number | null;
  referenced: number | null;
  quota: number | null;
  compression: string | null;
  mountpoint: string;
}

export function DatasetsPage() {
  const { data, error, loading, reload } = useResource<Dataset[]>("/api/datasets", 60_000);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Dataset | null>(null);

  const rows = useMemo(() => {
    const all = data ?? [];
    const needle = filter.trim().toLowerCase();
    const matching = needle ? all.filter((d) => d.name.toLowerCase().includes(needle)) : all;
    // Sorted by name so children sit under their parent, which is what makes
    // the indentation readable as a tree.
    return [...matching].sort((a, b) => a.name.localeCompare(b.name));
  }, [data, filter]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Datasets</h1>
          <div className="page-sub">{data ? `${data.length} datasets and volumes` : " "}</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Input style={{ maxWidth: 220 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setCreating(true)}>
            New dataset
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={5} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="num">Used</th>
                  <th className="num">Available</th>
                  <th className="num">Referenced</th>
                  <th className="num">Quota</th>
                  <th className="num">Compress</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const depth = d.name.split("/").length - 1;
                  const leaf = d.name.split("/").pop();
                  return (
                    <tr key={d.id}>
                      <td>
                        <span className="tree-name">
                          <span className="tree-indent" style={{ width: depth * 14 }} />
                          <span style={{ color: depth ? "var(--text)" : "var(--accent)", fontWeight: depth ? 400 : 600 }}>{leaf}</span>
                          {d.encrypted && <span className="pill mute">encrypted</span>}
                        </span>
                      </td>
                      <td style={{ color: "var(--muted)" }}>{d.type === "VOLUME" ? "zvol" : "dataset"}</td>
                      <td className="num">{bytes(d.used)}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{bytes(d.available)}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{bytes(d.referenced)}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{d.quota ? bytes(d.quota) : "—"}</td>
                      <td className="num" style={{ color: "var(--muted)" }}>{d.compression ?? "—"}</td>
                      <td>
                        {depth > 0 && (
                          <button className="btn danger" style={{ flex: "none", padding: "4px 10px" }} onClick={() => setRemoving(d)}>
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={8}>
                      <Empty>{filter ? "Nothing matches that filter." : "No datasets."}</Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateDataset
          pools={[...new Set((data ?? []).map((d) => d.pool))]}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); void reload(); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="dataset"
          name={removing.id}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            await del(`/api/datasets?id=${encodeURIComponent(removing.id)}`, { confirm, recursive: true });
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              Everything inside it, including its snapshots and any child datasets, goes with it.
            </p>
          }
        />
      )}
    </>
  );
}

function CreateDataset({ pools, onClose, onSaved }: { pools: string[]; onClose: () => void; onSaved: () => void }) {
  const [pool, setPool] = useState(pools[0] ?? "");
  const [name, setName] = useState("");
  const [compression, setCompression] = useState("LZ4");
  const [quotaGb, setQuotaGb] = useState("");
  const [comments, setComments] = useState("");

  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/datasets", {
      name: `${pool}/${name}`,
      type: "FILESYSTEM",
      compression,
      quota: quotaGb ? Number(quotaGb) * 1024 ** 3 : undefined,
      comments: comments || undefined,
    });
    onSaved();
  });

  return (
    <Modal
      title="New dataset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !pool || !name} onClick={() => void submit(undefined as void)}>
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <div className="row">
        <Field label="Pool">
          <Select value={pool} onChange={(e) => setPool(e.target.value)}>
            {pools.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Name" hint="Use a/b to nest.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="media" autoFocus />
        </Field>
      </div>

      <Field label="Compression" hint="LZ4 is the sensible default: it costs almost nothing and usually wins space back.">
        <Select value={compression} onChange={(e) => setCompression(e.target.value)}>
          <option value="LZ4">LZ4</option>
          <option value="ZSTD">ZSTD — smaller, more CPU</option>
          <option value="GZIP">GZIP</option>
          <option value="OFF">Off</option>
        </Select>
      </Field>

      <Field label="Quota in GB (optional)" hint="Blank means it can use whatever the pool has.">
        <Input type="number" min="0" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} placeholder="unlimited" />
      </Field>

      <Field label="Comment (optional)">
        <Input value={comments} onChange={(e) => setComments(e.target.value)} placeholder="What lives here" />
      </Field>

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/* -------------------------------------------------------------------- apps */

interface App {
  name: string;
  state: string;
  version: string;
  updatable: boolean;
  title: string;
  train?: string;
  icon: string | null;
  containers: number;
  ports: number[];
  /** Every published port, addressed — derived when TrueNAS gave no portal. */
  links: Array<{ port: number; url: string }>;
  portals: Record<string, string>;
}

/** The app's own web interface, if it published one. */
const portalOf = (a: App): string | undefined => Object.values(a.portals ?? {})[0];

/**
 * A stable colour for an app with no logo. Hashed from the name, so adding an
 * app does not recolour the ones next to it.
 */
function tint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 34%)`;
}

/**
 * The logo, or a letter.
 *
 * The home page has always degraded to a letter when an icon fails to load;
 * this card did not, so a dead icon url left an empty square here and a
 * perfectly readable tile there for the same app.
 */
function AppIcon({ app }: { app: App }) {
  const [broken, setBroken] = useState(false);
  const shown = app.icon && !broken;
  return (
    <div className="app-icon" style={shown ? undefined : { background: tint(app.name) }}>
      {shown ? (
        <img src={app.icon!} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        app.title.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

export function AppsPage() {
  const { data, error, loading, reload } = useResource<App[]>("/api/apps", 10_000);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<App | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  async function upgrade(name: string) {
    setFailed(null);
    try {
      const { jobId } = await post<{ jobId: number }>(`/api/apps/${encodeURIComponent(name)}/upgrade`);
      setJobs((j) => [...j, { id: jobId, label: `Updating ${name}` }]);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }

  async function act(name: string, action: "start" | "stop" | "restart") {
    setBusy((b) => ({ ...b, [name]: action }));
    setFailed(null);
    try {
      await post(`/api/apps/${encodeURIComponent(name)}/${action}`);
      // The NAS reports the new state only once the container has actually
      // moved, so a poll straight away would show the old one.
      setTimeout(() => void reload(), 1500);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy((b) => ({ ...b, [name]: "" })), 1500);
    }
  }

  const apps = [...(data ?? [])].sort((a, b) => Number(b.state === "RUNNING") - Number(a.state === "RUNNING") || a.name.localeCompare(b.name));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Apps</h1>
          <div className="page-sub">
            {data ? `${data.filter((a) => a.state === "RUNNING").length} running · ${data.filter((a) => a.updatable).length} with updates` : " "}
          </div>
        </div>
        <button className="link-btn" onClick={() => void reload()}>Refresh</button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={4} />}

      <div className="grid cards">
        {apps.map((a) => {
          const running = a.state === "RUNNING";
          const working = !!busy[a.name];
          return (
            <div key={a.name} className="app-card">
              <div className="app-top">
                <AppIcon app={a} />
                <div style={{ minWidth: 0 }}>
                  <div className="app-name">{a.name}</div>
                  <div className="app-meta">{a.version}{a.containers ? ` · ${a.containers} container${a.containers > 1 ? "s" : ""}` : ""}</div>
                </div>
                <span style={{ marginLeft: "auto" }}><Pill state={a.state} /></span>
              </div>

              {(a.updatable || a.ports.length > 0) && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {a.updatable && (
                    <button className="pill warn" style={{ cursor: "pointer" }} onClick={() => void upgrade(a.name)}>
                      update available — install
                    </button>
                  )}
                  {/* A port you can open. Deliberately still a chip and not a
                      button labelled Open: several of these are databases, and
                      a chip promises far less about what is behind it. */}
                  {a.links.slice(0, 4).map((l) => (
                    <a key={l.port} className="pill mute mono port-link" href={l.url}
                       target="_blank" rel="noreferrer" title={`Open ${l.url}`}>:{l.port}</a>
                  ))}
                  {!a.links.length && a.ports.slice(0, 4).map((p) => (
                    <span key={p} className="pill mute mono">:{p}</span>
                  ))}
                </div>
              )}

              <div className="app-actions">
                {portalOf(a) && running && (
                  <a className="btn primary" href={portalOf(a)} target="_blank" rel="noreferrer" style={{ textAlign: "center" }}>
                    Open
                  </a>
                )}
                <button className="btn" onClick={() => setEditing(a.name)}>Settings</button>
                <button className="btn" disabled={working || running} onClick={() => void act(a.name, "start")}>
                  {busy[a.name] === "start" ? "Starting…" : "Start"}
                </button>
                <button className="btn" disabled={working || !running} onClick={() => void act(a.name, "restart")}>
                  {busy[a.name] === "restart" ? "Restarting…" : "Restart"}
                </button>
                <button className="btn danger" disabled={working || !running} onClick={() => void act(a.name, "stop")}>
                  {busy[a.name] === "stop" ? "Stopping…" : "Stop"}
                </button>
                <button className="btn danger" style={{ flex: "none", padding: "6px 9px" }} title="Delete this app" onClick={() => setRemoving(a)}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
        {!loading && !apps.length && <Empty>No apps are installed.</Empty>}
      </div>

      {editing && (
        <AppConfigModal
          name={editing}
          onClose={() => setEditing(null)}
          onSaved={(id, label) => { setJobs((j) => [...j, { id, label }]); setTimeout(() => void reload(), 4000); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="app"
          name={removing.name}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            const { jobId } = await del<{ jobId: number }>(`/api/apps/${encodeURIComponent(removing.name)}`, { confirm });
            setJobs((j) => [...j, { id: jobId, label: `Deleting ${removing.name}` }]);
            setTimeout(() => void reload(), 3000);
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              The app and its containers are removed. Data written into its ix-volumes is kept.
            </p>
          }
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress key={j.id} jobId={j.id} label={j.label}
              onDone={() => { void reload(); setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000); }} />
          ))}
        </div>
      )}
    </>
  );
}

export { Icons };
