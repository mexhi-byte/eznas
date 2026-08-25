import { useState } from "react";
import { bytes, useResource } from "./api";
import { Empty, ErrorBanner, Loading } from "./components";
import { DiskHealthModal } from "./disk-health";
import { ReplaceDiskWizard } from "./replace-disk";
import { JobProgress } from "./ui";
import type { PoolSummary } from "./pages";

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

/**
 * The drives, drawn.
 *
 * "4 attached disks" is a true sentence that answers nothing. What people want
 * to know is which physical drive is in which pool, how they are grouped, and
 * which one is the problem — all of which is shape, not a number. Every tile is
 * a real device and opens its health.
 */
export function DriveMapPage() {
  const { data: pools, error, loading } = useResource<PoolSummary[]>("/api/pools", 30_000);
  const { data: disks } = useResource<Disk[]>("/api/disks", 30_000);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [replacingIn, setReplacingIn] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  const byName = new Map((disks ?? []).map((d) => [d.name, d]));
  const claimed = new Set(
    (pools ?? []).flatMap((p) => [
      ...p.vdevs.flatMap((v) => v.disks.map((d) => d.disk)),
      ...p.cache, ...p.log, ...p.spare,
    ]),
  );
  const spare = (disks ?? []).filter((d) => !claimed.has(d.name) && !d.inUse);
  // pool.query does not return boot-pool, so the drive TrueNAS itself lives on
  // belongs to no vdev here. It still exists, and a map that quietly leaves out
  // a physical drive is worse than no map.
  const system = (disks ?? []).filter((d) => !claimed.has(d.name) && d.inUse);
  const total = (disks ?? []).reduce((s, d) => s + d.size, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Drive array map</h1>
          <div className="page-sub">
            {disks
              ? `${disks.length} drives · ${bytes(total)} of raw capacity · click any drive for its health`
              : " "}
          </div>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !pools && <Loading rows={3} />}

      {pools?.map((pool) => {
        const pct = pool.size ? (pool.allocated / pool.size) * 100 : 0;
        return (
          <section key={pool.name} className="map-pool">
            <div className="map-pool-head">
              <div>
                <h2>{pool.name}</h2>
                <span className={`pill ${pool.healthy ? "ok" : "bad"}`}>{pool.status.toLowerCase()}</span>
              </div>
              <span className="map-cap">
                {bytes(pool.free)} free of {bytes(pool.size)} · {pct.toFixed(0)}% used
              </span>
            </div>
            <div className={`fat-bar ${pct >= 90 ? "bad" : pct >= 75 ? "warn" : ""}`}>
              <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
            </div>

            {!pool.healthy && (
              <div className="degraded-banner">
                <div>
                  <b>This pool has a failed drive</b>
                  <span>Replacing it is a guided, three-step job.</span>
                </div>
                <button className="btn primary" onClick={() => setReplacingIn(pool.name)}>
                  Guide me through replacing it
                </button>
              </div>
            )}

            <div className="vdevs">
              {pool.vdevs.map((v, i) => (
                <VdevGroup
                  key={i}
                  label={v.type.toLowerCase()}
                  hint={explainVdev(v.type, v.disks.length)}
                  disks={v.disks.map((d) => ({ ...byName.get(d.disk), name: d.disk, status: d.status }))}
                  onPick={setInspecting}
                />
              ))}
              {!!pool.cache.length && (
                <VdevGroup label="cache" hint="Read cache. Losing it costs speed, never data."
                  disks={pool.cache.map((n) => ({ ...byName.get(n), name: n }))} onPick={setInspecting} />
              )}
              {!!pool.log.length && (
                <VdevGroup label="log" hint="Write log for synchronous writes."
                  disks={pool.log.map((n) => ({ ...byName.get(n), name: n }))} onPick={setInspecting} />
              )}
              {!!pool.spare.length && (
                <VdevGroup label="spare" hint="Idle, ready to take over from a failed drive."
                  disks={pool.spare.map((n) => ({ ...byName.get(n), name: n }))} onPick={setInspecting} />
              )}
              {!pool.vdevs.length && <Empty>The NAS did not report a layout for this pool.</Empty>}
            </div>
          </section>
        );
      })}

      {!!system.length && (
        <section className="map-pool">
          <div className="map-pool-head">
            <div><h2>The server itself</h2></div>
            <span className="map-cap">not part of your storage</span>
          </div>
          <div className="vdevs">
            <VdevGroup
              label="boot"
              hint="TrueNAS lives here. Your files do not."
              disks={system}
              onPick={setInspecting}
            />
          </div>
        </section>
      )}

      <section className="map-pool">
        <div className="map-pool-head">
          <div><h2>Not in any pool</h2></div>
          <span className="map-cap">{spare.length ? `${spare.length} free to use` : "none"}</span>
        </div>
        <div className="vdevs">
          {spare.length ? (
            <VdevGroup
              label="unused"
              hint="Available to build a new pool or extend an existing one."
              disks={spare}
              onPick={setInspecting}
            />
          ) : (
            <Empty>Every attached drive is in use.</Empty>
          )}
        </div>
      </section>

      <div className="map-legend">
        <span><i className="swatch ok" /> healthy</span>
        <span><i className="swatch warn" /> degraded</span>
        <span><i className="swatch bad" /> faulted or missing</span>
        <span><i className="swatch mute" /> unused</span>
      </div>

      {inspecting && <DiskHealthModal name={inspecting} onClose={() => setInspecting(null)} />}

      {replacingIn && (
        <ReplaceDiskWizard
          pool={replacingIn}
          onClose={() => setReplacingIn(null)}
          onJob={(id, label) => setJobs((j) => [...j, { id, label }])}
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress key={j.id} jobId={j.id} label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 8000)} />
          ))}
        </div>
      )}
    </>
  );
}

/** What this vdev shape actually buys you, in one line. */
function explainVdev(type: string, members: number): string {
  const t = type.toUpperCase();
  if (t === "MIRROR") return `${members} copies of everything. Survives ${members - 1} drive${members === 2 ? "" : "s"} failing.`;
  if (t === "RAIDZ1") return "Survives one drive failing.";
  if (t === "RAIDZ2") return "Survives two drives failing.";
  if (t === "RAIDZ3") return "Survives three drives failing.";
  if (t === "DISK" || t === "STRIPE") return "No redundancy — if this drive dies the pool dies with it.";
  return "";
}

type Tile = Partial<Disk> & { name: string; status?: string };

function VdevGroup({ label, hint, disks, onPick }: {
  label: string;
  hint: string;
  disks: Tile[];
  onPick: (name: string) => void;
}) {
  return (
    <div className="vdev">
      <div className="vdev-head">
        <span className="pill info">{label}</span>
        <span>{hint}</span>
      </div>
      <div className="drive-row">
        {disks.map((d) => <DriveTile key={d.name} disk={d} onPick={onPick} />)}
      </div>
    </div>
  );
}

function DriveTile({ disk, onPick }: { disk: Tile; onPick: (name: string) => void }) {
  // A drive listed in the pool layout but absent from disk.details is one the
  // NAS can no longer see — exactly the case worth shouting about.
  const missing = disk.size === undefined;
  const state = missing || disk.status === "FAULTED" || disk.status === "UNAVAIL"
    ? "bad"
    : disk.status && disk.status !== "ONLINE"
      ? "warn"
      : disk.inUse === false
        ? "mute"
        : "ok";

  return (
    <button className={`drive ${state}`} onClick={() => onPick(disk.name)} title={`${disk.model ?? ""} ${disk.serial ?? ""}`.trim()}>
      <span className="drive-glyph">{disk.type === "SSD" ? "▪" : "◍"}</span>
      <span className="drive-name mono">{disk.name}</span>
      <span className="drive-size">{missing ? "missing" : bytes(disk.size)}</span>
      <span className="drive-foot">
        {disk.tempC != null ? `${disk.tempC}°C` : disk.status ? disk.status.toLowerCase() : " "}
      </span>
    </button>
  );
}
