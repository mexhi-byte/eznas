import { useState } from "react";
import { bytes, post, useResource, when } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";
import { DangerConfirm, JobProgress } from "./ui";
import { DiskHealthModal } from "./disk-health";

/* ------------------------------------------------------------------- disks */

interface Disk {
  name: string;
  model: string;
  serial: string;
  size: number;
  type: string;
  rpm: number | null;
  pool: string | null;
  inUse: boolean;
  tempC: number | null;
}

export function DisksPage() {
  const { data, error, loading, reload } = useResource<Disk[]>("/api/disks", 60_000);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  const [wiping, setWiping] = useState<Disk | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  async function rescan() {
    setScanning(true);
    setFound(null);
    try {
      const r = await post<{ unused: Array<{ name: string }> }>("/api/disks/rescan");
      await reload();
      setFound(r.unused.length ? `${r.unused.length} unused: ${r.unused.map((d) => d.name).join(", ")}` : "No unused disks found.");
    } catch (e) {
      setFound(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  const free = (data ?? []).filter((d) => !d.inUse).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Disks</h1>
          <div className="page-sub">
            {data
              ? `${data.length} attached · ${bytes(data.reduce((s, d) => s + d.size, 0))} raw · ${free} unused — double-click a drive for its health`
              : " "}
          </div>
        </div>
        <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => void rescan()} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan for disks"}
        </button>
      </div>

      {found && <div className="job done" style={{ marginBottom: 14 }}><span className="job-label">{found}</span></div>}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={4} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Model</th>
                  <th>Serial</th>
                  <th>Type</th>
                  <th className="num">Size</th>
                  <th>Pool</th>
                  <th className="num">Temp</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {data?.map((d) => (
                  // Double-click opens the health dialog, which is the fast
                  // path once you know it is there; the Health button is how
                  // anyone finds out, and is the only route from a keyboard.
                  <tr
                    key={d.name}
                    className="clickable"
                    tabIndex={0}
                    onDoubleClick={() => setInspecting(d.name)}
                    onKeyDown={(e) => { if (e.key === "Enter") setInspecting(d.name); }}
                  >
                    <td className="mono" style={{ color: "var(--accent)" }}>{d.name}</td>
                    <td>{d.model || "—"}</td>
                    <td className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{d.serial || "—"}</td>
                    <td style={{ color: "var(--muted)" }}>{d.type}{d.rpm ? ` · ${d.rpm} rpm` : ""}</td>
                    <td className="num">{bytes(d.size)}</td>
                    <td>{d.inUse ? <span className="pill info">{d.pool ?? "in use"}</span> : <span className="pill mute">unassigned</span>}</td>
                    <td className="num" style={{ color: tempColour(d.tempC) }}>{d.tempC === null ? "—" : `${d.tempC}°C`}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn" onClick={() => setInspecting(d.name)}>Health</button>
                        {/* Wiping is offered only for disks no pool is using — the
                            NAS would refuse otherwise, and offering it invites the
                            attempt. */}
                        {!d.inUse && (
                          <button className="btn danger" onClick={() => setWiping(d)}>Wipe</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!data?.length && (
                  <tr><td colSpan={8}><Empty>No disks reported.</Empty></td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inspecting && <DiskHealthModal name={inspecting} onClose={() => setInspecting(null)} />}

      {wiping && (
        <DangerConfirm
          what="disk"
          name={wiping.name}
          verb="Wipe"
          onCancel={() => setWiping(null)}
          onConfirm={async (confirm) => {
            const { jobId } = await post<{ jobId: number }>(`/api/disks/${encodeURIComponent(wiping.name)}/wipe`, { confirm, mode: "QUICK" });
            setJobs((j) => [...j, { id: jobId, label: `Wiping ${wiping.name}` }]);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              {wiping.model} · {bytes(wiping.size)} · serial {wiping.serial || "unknown"}. Everything on it is destroyed.
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

// Spinning rust is happy under about 40°C and worrying past 50.
const tempColour = (t: number | null): string =>
  t === null ? "var(--muted)" : t >= 50 ? "var(--bad)" : t >= 42 ? "var(--warn)" : "var(--ok)";

/* ------------------------------------------------------------------ alerts */

interface Alert {
  uuid: string;
  level: string;
  text: string;
  at: number;
  klass?: string;
}

export function AlertsPage() {
  const { data, error, loading, reload } = useResource<Alert[]>("/api/alerts", 30_000);
  const [busy, setBusy] = useState<string | null>(null);

  async function dismiss(uuid: string) {
    setBusy(uuid);
    try {
      await post(`/api/alerts/${encodeURIComponent(uuid)}/dismiss`);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  const order = ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO"];
  const sorted = [...(data ?? [])].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || b.at - a.at);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <div className="page-sub">{data ? `${data.length} active` : " "}</div>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={3} />
        ) : sorted.length ? (
          <div className="grid" style={{ gap: 0 }}>
            {sorted.map((a) => (
              <div key={a.uuid} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                <Pill state={a.level}>{a.level.toLowerCase()}</Pill>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{a.text}</div>
                  <div className="stat-foot">{when(a.at)}</div>
                </div>
                <button className="btn" style={{ flex: "none", padding: "5px 12px" }} disabled={busy === a.uuid} onClick={() => void dismiss(a.uuid)}>
                  {busy === a.uuid ? "…" : "Dismiss"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty>Nothing to report.</Empty>
        )}
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- services */

interface Service {
  service: string;
  state: string;
  enable: boolean;
}

export function ServicesPage() {
  const { data, error, loading, reload } = useResource<Service[]>("/api/services", 20_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function act(name: string, action: "start" | "stop" | "restart") {
    setBusy(name);
    setFailed(null);
    try {
      await post(`/api/services/${encodeURIComponent(name)}/${action}`);
      setTimeout(() => void reload(), 1200);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy(null), 1200);
    }
  }

  // Running first: an operator opening this page is nearly always looking for
  // something that should be running and is not.
  const rows = [...(data ?? [])].sort(
    (a, b) => Number(b.state === "RUNNING") - Number(a.state === "RUNNING") || a.service.localeCompare(b.service),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Services</h1>
          <div className="page-sub">{data ? `${data.filter((s) => s.state === "RUNNING").length} of ${data.length} running` : " "}</div>
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
                <tr><th>Service</th><th>State</th><th>On boot</th><th style={{ width: 230 }} /></tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const running = s.state === "RUNNING";
                  return (
                    <tr key={s.service}>
                      <td style={{ fontWeight: 600 }}>{s.service}</td>
                      <td><Pill state={s.state}>{s.state.toLowerCase()}</Pill></td>
                      <td style={{ color: s.enable ? "var(--muted)" : "var(--faint)" }}>{s.enable ? "yes" : "no"}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button className="btn" style={{ flex: "none" }} disabled={busy === s.service || running} onClick={() => void act(s.service, "start")}>Start</button>
                          <button className="btn" style={{ flex: "none" }} disabled={busy === s.service || !running} onClick={() => void act(s.service, "restart")}>Restart</button>
                          <button className="btn danger" style={{ flex: "none" }} disabled={busy === s.service || !running} onClick={() => void act(s.service, "stop")}>Stop</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
