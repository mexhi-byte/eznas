import { useState } from "react";
import { post, useResource, when } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";

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
              <div
                key={a.uuid}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  padding: "12px 0",
                  borderTop: "1px solid var(--line)",
                }}
              >
                <Pill state={a.level}>{a.level.toLowerCase()}</Pill>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{a.text}</div>
                  <div className="stat-foot">{when(a.at)}</div>
                </div>
                <button
                  className="btn"
                  style={{ flex: "none", padding: "5px 12px" }}
                  disabled={busy === a.uuid}
                  onClick={() => void dismiss(a.uuid)}
                >
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
          <div className="page-sub">
            {data ? `${data.filter((s) => s.state === "RUNNING").length} of ${data.length} running` : " "}
          </div>
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
                  <th>Service</th>
                  <th>State</th>
                  <th>On boot</th>
                  <th style={{ width: 230 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const running = s.state === "RUNNING";
                  return (
                    <tr key={s.service}>
                      <td style={{ fontWeight: 600 }}>{s.service}</td>
                      <td>
                        <Pill state={s.state}>{s.state.toLowerCase()}</Pill>
                      </td>
                      <td style={{ color: s.enable ? "var(--muted)" : "var(--faint)" }}>{s.enable ? "yes" : "no"}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            className="btn"
                            style={{ flex: "none" }}
                            disabled={busy === s.service || running}
                            onClick={() => void act(s.service, "start")}
                          >
                            Start
                          </button>
                          <button
                            className="btn"
                            style={{ flex: "none" }}
                            disabled={busy === s.service || !running}
                            onClick={() => void act(s.service, "restart")}
                          >
                            Restart
                          </button>
                          <button
                            className="btn danger"
                            style={{ flex: "none" }}
                            disabled={busy === s.service || !running}
                            onClick={() => void act(s.service, "stop")}
                          >
                            Stop
                          </button>
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
