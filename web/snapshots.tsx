import { useMemo, useState } from "react";
import { bytes, del, post, put, useResource, when } from "./api";
import { Card, Empty, ErrorBanner, Loading } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";

/* -------------------------------------------------------------------- types */

interface Snapshot {
  name: string;
  dataset: string;
  snapshot: string;
  used: number | null;
  referenced: number | null;
  createdAt: number | null;
  held: boolean;
}

interface Dataset {
  id: string;
  name: string;
  pool: string;
  type: string;
}

interface Task {
  id: number;
  dataset: string;
  recursive: boolean;
  enabled: boolean;
  namingSchema: string;
  lifetimeValue: number;
  lifetimeUnit: string;
  schedule: { minute: string; hour: string; dom: string; month: string; dow: string };
  allowEmpty: boolean;
  state: string | null;
}

/* --------------------------------------------------------------------- page */

export function SnapshotsPage() {
  const [view, setView] = useState<"snapshots" | "schedules">("snapshots");

  return (
    <>
      <div className="seg">
        <button className={view === "snapshots" ? "on" : ""} onClick={() => setView("snapshots")}>Snapshots</button>
        <button className={view === "schedules" ? "on" : ""} onClick={() => setView("schedules")}>Schedules</button>
      </div>
      {view === "snapshots" ? <SnapshotList /> : <ScheduleList />}
    </>
  );
}

function SnapshotList() {
  const { data, error, loading, reload } = useResource<Snapshot[]>("/api/snapshots", 60_000);
  const { data: datasets } = useResource<Dataset[]>("/api/datasets", 0);
  const [filter, setFilter] = useState("");
  const [taking, setTaking] = useState(false);
  const [cloning, setCloning] = useState<Snapshot | null>(null);
  const [copying, setCopying] = useState<Snapshot | null>(null);
  const [rolling, setRolling] = useState<Snapshot | null>(null);
  const [removing, setRemoving] = useState<Snapshot | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);
  const [failed, setFailed] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle));
  }, [data, filter]);

  const total = rows.reduce((sum, s) => sum + (s.used ?? 0), 0);

  async function toggleHold(s: Snapshot) {
    setFailed(null);
    try {
      await post(`/api/snapshots/${s.held ? "release" : "hold"}`, { id: s.name });
      await reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Snapshots</h1>
          <div className="page-sub">
            {data ? `${rows.length} snapshot${rows.length === 1 ? "" : "s"} · ${bytes(total)} held on top of live data` : " "}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Input style={{ maxWidth: 220 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setTaking(true)}>
            Take snapshot
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={5} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Snapshot</th>
                  <th className="num">Used</th>
                  <th>Taken</th>
                  <th style={{ width: 300 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.name}>
                    <td className="mono" style={{ fontSize: 12.5 }}>{s.dataset}</td>
                    <td className="mono" style={{ fontSize: 12.5, color: "var(--accent)" }}>
                      {s.snapshot}
                      {s.held && (
                        <span className="pill info" style={{ marginLeft: 8 }} title="Held: ZFS will refuse to delete this snapshot.">
                          held
                        </span>
                      )}
                    </td>
                    <td className="num">{bytes(s.used)}</td>
                    <td style={{ color: "var(--muted)" }}>{when(s.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn" onClick={() => setCloning(s)} title="Mount a writable copy as a new dataset">Clone</button>
                        <button className="btn" onClick={() => setCopying(s)} title="Replicate this dataset's snapshots to another pool">Copy to…</button>
                        <button className="btn" onClick={() => void toggleHold(s)} title="A held snapshot cannot be deleted, by anyone">
                          {s.held ? "Release" : "Hold"}
                        </button>
                        <button className="btn danger" onClick={() => setRolling(s)}>Roll back</button>
                        <button className="btn danger" onClick={() => setRemoving(s)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={5}>
                      <Empty>{filter ? "Nothing matches." : "No snapshots yet. Take one, or set up a schedule."}</Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {taking && (
        <TakeSnapshot
          datasets={datasets ?? []}
          onClose={() => setTaking(false)}
          onSaved={() => { setTaking(false); void reload(); }}
        />
      )}

      {cloning && (
        <CloneSnapshot snap={cloning} onClose={() => setCloning(null)} onSaved={() => { setCloning(null); void reload(); }} />
      )}

      {copying && (
        <CopySnapshots
          snap={copying}
          datasets={datasets ?? []}
          onClose={() => setCopying(null)}
          onStarted={(jobId, label) => { setCopying(null); setJobs((j) => [...j, { id: jobId, label }]); }}
        />
      )}

      {rolling && <RollBack snap={rolling} onClose={() => setRolling(null)} onDone={() => void reload()} />}

      {removing && (
        <DangerConfirm
          what="snapshot"
          name={removing.name}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            await del(`/api/snapshots?id=${encodeURIComponent(removing.name)}`, { confirm });
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              The live dataset is not touched. What goes is the ability to get back to how it looked{" "}
              {removing.createdAt ? when(removing.createdAt) : "when this was taken"}.
            </p>
          }
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => { void reload(); setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 8000); }}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ take snapshot */

/** "manual-2026-08-24_14-05", matching what the server would pick on its own. */
function suggestedName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `manual-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function TakeSnapshot({ datasets, onClose, onSaved }: { datasets: Dataset[]; onClose: () => void; onSaved: () => void }) {
  const [dataset, setDataset] = useState(datasets[0]?.id ?? "");
  const [name, setName] = useState(suggestedName);
  const [recursive, setRecursive] = useState(false);

  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/snapshots", { dataset, name, recursive });
    onSaved();
  });

  const children = datasets.filter((d) => d.id.startsWith(`${dataset}/`)).length;

  return (
    <Modal
      title="Take a snapshot"
      subtitle="A frozen view of a dataset, taken now. It costs nothing until the data changes."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !dataset || !name.trim()} onClick={() => void submit(undefined as void)}>
            {busy ? "Taking…" : "Take snapshot"}
          </button>
        </>
      }
    >
      <Field label="Dataset" hint="The snapshot is stored inside this dataset and moves with it.">
        <Select value={dataset} onChange={(e) => setDataset(e.target.value)}>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>{d.id}{d.type === "VOLUME" ? " (zvol)" : ""}</option>
          ))}
        </Select>
      </Field>

      <Field label="Name" hint="Anything you will still recognise in three months.">
        <Input value={name} onChange={(e) => setName(e.target.value.replace(/[@/\s]/g, "-"))} autoFocus />
      </Field>

      {children > 0 && (
        <Toggle
          checked={recursive}
          onChange={setRecursive}
          label={`Include the ${children} dataset${children === 1 ? "" : "s"} underneath it`}
        />
      )}

      <p className="modal-text" style={{ marginTop: 14 }}>
        Snapshots live on the same pool as their dataset, so they survive a mistake but not a dead pool. To keep a copy
        somewhere else, use <strong>Copy to…</strong> on the snapshot once it exists.
      </p>

      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/* -------------------------------------------------------------------- clone */

function CloneSnapshot({ snap, onClose, onSaved }: { snap: Snapshot; onClose: () => void; onSaved: () => void }) {
  const [target, setTarget] = useState(`${snap.dataset}-${snap.snapshot}`.replace(/[^A-Za-z0-9._:/-]/g, "-"));

  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/snapshots/clone", { id: snap.name, target });
    onSaved();
  });

  return (
    <Modal
      title="Clone to a new dataset"
      subtitle="The snapshot becomes a writable dataset. Nothing about the original changes."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !target.trim()} onClick={() => void submit(undefined as void)}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </>
      }
    >
      <p className="modal-text">
        From <strong className="mono">{snap.name}</strong>
      </p>
      <Field label="New dataset" hint="Full path, for example tank/restore-2026-08-24.">
        <Input value={target} onChange={(e) => setTarget(e.target.value)} autoFocus />
      </Field>
      <p className="modal-text" style={{ marginTop: 12 }}>
        This is the safe way to look inside a snapshot: browse the clone, take what you need, then delete it. The clone
        shares blocks with the snapshot, so it starts out costing nothing — and it pins that snapshot until it is gone.
      </p>
      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/* --------------------------------------------------------- copy to elsewhere */

function CopySnapshots({ snap, datasets, onClose, onStarted }: {
  snap: Snapshot;
  datasets: Dataset[];
  onClose: () => void;
  onStarted: (jobId: number, label: string) => void;
}) {
  const pools = [...new Set(datasets.map((d) => d.pool))];
  const otherPool = pools.find((p) => p !== snap.dataset.split("/")[0]) ?? pools[0] ?? "";
  const [pool, setPool] = useState(otherPool);
  const [name, setName] = useState(snap.dataset.replace(/\//g, "-"));
  const [recursive, setRecursive] = useState(false);

  const target = `${pool}/${name}`.replace(/\/+$/, "");
  const samePool = pool === snap.dataset.split("/")[0];

  const { busy, error, submit } = useSubmit(async () => {
    const { jobId } = await post<{ jobId: number }>("/api/snapshots/copy", {
      source: snap.dataset,
      target,
      recursive,
    });
    onStarted(jobId, `Copying ${snap.dataset} → ${target}`);
  });

  return (
    <Modal
      title="Copy snapshots somewhere else"
      subtitle="A ZFS send/receive on this machine, from one pool to another."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !pool || !name.trim()} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Copy"}
          </button>
        </>
      }
    >
      <p className="modal-text">
        Every snapshot of <strong className="mono">{snap.dataset}</strong> is copied, along with the data behind them.
      </p>

      <div className="row">
        <Field label="Destination pool">
          <Select value={pool} onChange={(e) => setPool(e.target.value)}>
            {pools.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Dataset there" hint="Created if it does not exist.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>

      <Toggle checked={recursive} onChange={setRecursive} label="Include datasets underneath it" />

      <p className="modal-text" style={{ marginTop: 12 }}>
        Copying to <strong className="mono">{target}</strong>.
        {samePool
          ? " Both sides are on the same pool, which protects against a mistake but not against losing the pool."
          : " A second pool means the snapshots outlive the first one."}
      </p>

      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/* ----------------------------------------------------------------- rollback */

function RollBack({ snap, onClose, onDone }: { snap: Snapshot; onClose: () => void; onDone: () => void }) {
  const [force, setForce] = useState(false);
  const [newer, setNewer] = useState(false);
  const [clones, setClones] = useState(false);

  return (
    <DangerConfirm
      what="to snapshot"
      name={snap.name}
      verb="Roll back"
      onCancel={onClose}
      onConfirm={async (confirm) => {
        await post("/api/snapshots/rollback", { id: snap.name, confirm, force, newer, clones });
        onDone();
      }}
      extra={
        <>
          <p className="modal-text" style={{ marginTop: 12 }}>
            <strong className="mono">{snap.dataset}</strong> goes back to how it looked{" "}
            {snap.createdAt ? when(snap.createdAt) : "when this snapshot was taken"}. Every change made since is
            discarded.
          </p>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            <Toggle checked={force} onChange={setForce} label="Unmount the dataset if something is using it" />
            <Toggle checked={newer} onChange={setNewer} label="Destroy snapshots taken after this one" />
            <Toggle checked={clones} onChange={setClones} label="Destroy clones that depend on those snapshots" />
          </div>
          {!newer && (
            <p className="modal-text" style={{ marginTop: 10, color: "var(--muted)" }}>
              Without the second option ZFS refuses the rollback if any newer snapshot exists — which is usually the
              answer you want the first time.
            </p>
          )}
        </>
      }
    />
  );
}

/* ---------------------------------------------------------------- schedules */

const UNITS = ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;

const PRESETS: Array<{ id: string; label: string; schedule: Task["schedule"] }> = [
  { id: "hourly", label: "Every hour", schedule: { minute: "00", hour: "*", dom: "*", month: "*", dow: "*" } },
  { id: "daily", label: "Every day at 02:00", schedule: { minute: "00", hour: "2", dom: "*", month: "*", dow: "*" } },
  { id: "weekly", label: "Every Sunday at 03:00", schedule: { minute: "00", hour: "3", dom: "*", month: "*", dow: "0" } },
  { id: "monthly", label: "First of the month at 03:00", schedule: { minute: "00", hour: "3", dom: "1", month: "*", dow: "*" } },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Turn the five cron fields back into something readable at a glance. */
function describe(s: Task["schedule"] | undefined): string {
  if (!s) return "—";
  const { minute, hour, dom, month, dow } = s;
  const at = `${hour === "*" ? "" : `${hour.padStart(2, "0")}:`}${minute.padStart(2, "0")}`;
  if (hour === "*") return `every hour at :${minute.padStart(2, "0")}`;
  if (dow !== "*" && /^[0-6]$/.test(dow)) return `every ${DAYS[Number(dow)]} at ${at}`;
  if (dom !== "*" && month === "*") return `day ${dom} of each month at ${at}`;
  if (dom === "*" && month === "*") return `every day at ${at}`;
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
}

function ScheduleList() {
  const { data, error, loading, reload } = useResource<Task[]>("/api/snapshot-tasks", 60_000);
  const { data: datasets } = useResource<Dataset[]>("/api/datasets", 0);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [removing, setRemoving] = useState<Task | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function runNow(t: Task) {
    setBusy(t.id);
    setFailed(null);
    try {
      await post(`/api/snapshot-tasks/${t.id}/run`);
      setNote(`Ran the schedule for ${t.dataset}.`);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Snapshot schedules</h1>
          <div className="page-sub">
            {data ? `${data.length} schedule${data.length === 1 ? "" : "s"} · the NAS takes these and expires them on its own` : " "}
          </div>
        </div>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditing("new")}>
          New schedule
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {note && <div className="job done" style={{ marginBottom: 14 }}><span className="job-label">{note}</span></div>}

      <Card>
        {loading && !data ? (
          <Loading rows={3} />
        ) : data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>When</th>
                  <th>Keep for</th>
                  <th>Names</th>
                  <th>State</th>
                  <th style={{ width: 210 }} />
                </tr>
              </thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {t.dataset}
                      {t.recursive && <span className="pill mute" style={{ marginLeft: 8 }}>+ children</span>}
                    </td>
                    <td style={{ color: "var(--muted)" }}>{describe(t.schedule)}</td>
                    <td>{t.lifetimeValue} {t.lifetimeUnit.toLowerCase()}{t.lifetimeValue === 1 ? "" : "s"}</td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{t.namingSchema}</td>
                    <td>
                      <span className={`pill ${t.enabled ? "ok" : "mute"}`}>{t.enabled ? "enabled" : "paused"}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="btn" disabled={busy === t.id} onClick={() => void runNow(t)}>
                          {busy === t.id ? "…" : "Run now"}
                        </button>
                        <button className="btn" onClick={() => setEditing(t)}>Edit</button>
                        <button className="btn danger" onClick={() => setRemoving(t)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No schedules. One hourly schedule with a week of retention is what most homelabs actually want.
          </Empty>
        )}
      </Card>

      {editing && (
        <EditSchedule
          task={editing === "new" ? null : editing}
          datasets={datasets ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="schedule"
          name={removing.dataset}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/snapshot-tasks?id=${removing.id}`);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              Snapshots already taken stay where they are — but nothing expires them any more, so they will sit there
              until you delete them.
            </p>
          }
        />
      )}
    </>
  );
}

function EditSchedule({ task, datasets, onClose, onSaved }: {
  task: Task | null;
  datasets: Dataset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [dataset, setDataset] = useState(task?.dataset ?? datasets[0]?.id ?? "");
  const [recursive, setRecursive] = useState(task?.recursive ?? false);
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [namingSchema, setNamingSchema] = useState(task?.namingSchema ?? "auto-%Y-%m-%d_%H-%M");
  const [lifetimeValue, setLifetimeValue] = useState(String(task?.lifetimeValue ?? 2));
  const [lifetimeUnit, setLifetimeUnit] = useState(task?.lifetimeUnit ?? "WEEK");
  const [preset, setPreset] = useState(() => {
    if (!task) return "daily";
    const match = PRESETS.find((p) => JSON.stringify(p.schedule) === JSON.stringify(task.schedule));
    return match?.id ?? "custom";
  });
  const [cron, setCron] = useState<Task["schedule"]>(
    task?.schedule ?? PRESETS[1].schedule,
  );

  const schedule = preset === "custom" ? cron : PRESETS.find((p) => p.id === preset)!.schedule;

  const { busy, error, submit } = useSubmit(async () => {
    const body = { dataset, recursive, enabled, namingSchema, lifetimeValue: Number(lifetimeValue), lifetimeUnit, schedule };
    if (task) await put(`/api/snapshot-tasks?id=${task.id}`, body);
    else await post("/api/snapshot-tasks", body);
    onSaved();
  });

  return (
    <Modal
      title={task ? "Edit schedule" : "New snapshot schedule"}
      subtitle="The NAS takes these by itself and deletes them when they expire."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !dataset} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : task ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <Field label="Dataset" hint="Snapshots are kept inside this dataset, on its own pool.">
        <Select value={dataset} onChange={(e) => setDataset(e.target.value)} disabled={!!task}>
          {datasets.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
        </Select>
      </Field>

      <Field label="How often">
        <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">Custom…</option>
        </Select>
      </Field>

      {preset === "custom" && (
        <div className="row">
          {(["minute", "hour", "dom", "month", "dow"] as const).map((k) => (
            <Field key={k} label={k === "dom" ? "day" : k === "dow" ? "weekday" : k}>
              <Input value={cron[k]} onChange={(e) => setCron({ ...cron, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}

      <div className="row">
        <Field label="Keep each snapshot for" hint="Older ones are deleted by the NAS.">
          <Input type="number" min={1} value={lifetimeValue} onChange={(e) => setLifetimeValue(e.target.value)} />
        </Field>
        <Field label="&nbsp;">
          <Select value={lifetimeUnit} onChange={(e) => setLifetimeUnit(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}s</option>)}
          </Select>
        </Field>
      </div>

      <Field label="Naming" hint="strftime, so every run gets its own name. Retention only touches names matching this.">
        <Input value={namingSchema} onChange={(e) => setNamingSchema(e.target.value)} />
      </Field>

      <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
        <Toggle checked={recursive} onChange={setRecursive} label="Include datasets underneath it" />
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
      </div>

      <p className="modal-text" style={{ marginTop: 14 }}>
        {describe(schedule)}, keeping {lifetimeValue} {lifetimeUnit.toLowerCase()}
        {Number(lifetimeValue) === 1 ? "" : "s"} of history.
      </p>

      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}
