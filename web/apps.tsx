import { useState } from "react";
import { del, post, useResource } from "./api";
import { Empty, ErrorBanner, Icons, Loading, Pill } from "./components";
import { AppDetailsModal } from "./app-details";
import { DangerConfirm, JobProgress } from "./ui";
import { AppConfigModal } from "./app-config";
import { AppConsoleModal } from "./app-console";

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

export function AppsPage({ admin = true }: { admin?: boolean }) {
  const { data, error, loading, reload } = useResource<App[]>("/api/apps", 10_000);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<App | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [detailing, setDetailing] = useState<App | null>(null);
  const [consoleOf, setConsoleOf] = useState<{ app: string; mode: "logs" | "exec" } | null>(null);
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

  const apps = [...(data ?? [])].sort(
    (a, b) => Number(b.state === "RUNNING") - Number(a.state === "RUNNING") || a.name.localeCompare(b.name),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Apps</h1>
          <div className="page-sub">
            {data
              ? `${data.filter((a) => a.state === "RUNNING").length} running · ${data.filter((a) => a.updatable).length} with updates`
              : " "}
          </div>
        </div>
        <button className="link-btn" onClick={() => void reload()}>
          Refresh
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={4} />}

      <div className="grid cards">
        {apps.map((a) => {
          const running = a.state === "RUNNING";
          const working = !!busy[a.name];
          return (
            <div
              key={a.name}
              className="app-card"
              /* The card carries a name, a version and a state. Double-click
                 for the rest — what the app is, who publishes it, where its
                 source lives. */
              onDoubleClick={() => setDetailing(a)}
              title="Double-click for details"
            >
              <div className="app-top">
                <AppIcon app={a} />
                <div style={{ minWidth: 0 }}>
                  <div className="app-name">{a.name}</div>
                  <div className="app-meta">
                    {a.version}
                    {a.containers ? ` · ${a.containers} container${a.containers > 1 ? "s" : ""}` : ""}
                  </div>
                </div>
                <span style={{ marginLeft: "auto" }}>
                  <Pill state={a.state} />
                </span>
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
                    <a
                      key={l.port}
                      className="pill mute mono port-link"
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open ${l.url}`}
                    >
                      :{l.port}
                    </a>
                  ))}
                  {!a.links.length &&
                    a.ports.slice(0, 4).map((p) => (
                      <span key={p} className="pill mute mono">
                        :{p}
                      </span>
                    ))}
                </div>
              )}

              {/*
               * Only the actions that apply.
               *
               * This was seven controls in a row that could not wrap, so they
               * overlapped each other and the ones underneath could not be
               * clicked. Start and Stop are mutually exclusive — one of them
               * was always present only to be greyed out — and Restart means
               * nothing for an app that is not running, so each card now
               * carries at most five.
               */}
              <div className="app-actions">
                {portalOf(a) && running && (
                  <a className="btn primary" href={portalOf(a)} target="_blank" rel="noreferrer">
                    Open
                  </a>
                )}
                <button className="btn" onClick={() => setDetailing(a)}>
                  Details
                </button>
                <button className="btn" onClick={() => setEditing(a.name)}>
                  Settings
                </button>
                {admin && running && (
                  <>
                    <button className="btn" onClick={() => setConsoleOf({ app: a.name, mode: "logs" })}>
                      Logs
                    </button>
                    <button className="btn" onClick={() => setConsoleOf({ app: a.name, mode: "exec" })}>
                      Shell
                    </button>
                  </>
                )}
                {running ? (
                  <>
                    <button className="btn" disabled={working} onClick={() => void act(a.name, "restart")}>
                      {busy[a.name] === "restart" ? "Restarting…" : "Restart"}
                    </button>
                    <button className="btn danger" disabled={working} onClick={() => void act(a.name, "stop")}>
                      {busy[a.name] === "stop" ? "Stopping…" : "Stop"}
                    </button>
                  </>
                ) : (
                  <button className="btn" disabled={working} onClick={() => void act(a.name, "start")}>
                    {busy[a.name] === "start" ? "Starting…" : "Start"}
                  </button>
                )}
                <button className="btn danger app-remove" title={`Delete ${a.name}`} onClick={() => setRemoving(a)}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
        {!loading && !apps.length && <Empty>No apps are installed.</Empty>}
      </div>

      {detailing && (
        <AppDetailsModal
          name={detailing.name}
          train={detailing.train}
          local={{
            state: detailing.state,
            version: detailing.version,
            containers: detailing.containers,
            ports: detailing.ports,
            links: detailing.links,
            updatable: detailing.updatable,
          }}
          onClose={() => setDetailing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDetailing(null)}>
                Close
              </button>
              {portalOf(detailing) && detailing.state === "RUNNING" && (
                <a className="btn primary" href={portalOf(detailing)} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
            </>
          }
        />
      )}

      {consoleOf && <AppConsoleModal app={consoleOf.app} mode={consoleOf.mode} onClose={() => setConsoleOf(null)} />}

      {editing && (
        <AppConfigModal
          name={editing}
          onClose={() => setEditing(null)}
          onSaved={(id, label) => {
            setJobs((j) => [...j, { id, label }]);
            setTimeout(() => void reload(), 4000);
          }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="app"
          name={removing.name}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            const { jobId } = await del<{ jobId: number }>(`/api/apps/${encodeURIComponent(removing.name)}`, {
              confirm,
            });
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
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => {
                void reload();
                setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

export { Icons };
