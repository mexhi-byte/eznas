import { useState } from "react";
import { bytes, post, useResource } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Modal, Select } from "./ui";

interface Health {
  name: string;
  identity: {
    identifier: string | null; model: string | null; serial: string | null; size: number | null;
    type: string | null; rpm: number | null; bus: string | null; subsystem: string | null;
    description: string | null; lunid: string | null; sectorSize: number | null;
    transferMode: string | null; standby: string | null; powerManagement: string | null;
    smartEnabled: boolean; duplicateSerial: string[];
  };
  tempC: number | null;
  /** Why there is no reading, when there is none. */
  tempNote: string | null;
  inUse: boolean;
  pool: string | null;
  exportedPool: string | null;
  partitions: Array<{ name?: unknown; size?: unknown; type?: unknown }>;
  zfs: {
    pool: string; role: string; vdev: string; status: string | null;
    readErrors: number; writeErrors: number; checksumErrors: number; selfHealed: number;
    size: number | null; allocated: number | null; fragmentation: number | null;
    readBytes: number | null; writeBytes: number | null;
  } | null;
  smart: { supported: boolean; reason: string | null; attributes: Array<Record<string, unknown>> };
  tests: Array<{ num?: unknown; type?: unknown; status?: unknown; remaining?: unknown; lifetime?: unknown; description?: unknown }>;
  runningTest: unknown;
  health: { level: "ok" | "warn" | "bad"; reasons: string[] };
}

const TEST_KINDS = [
  { id: "SHORT", label: "Short — a couple of minutes" },
  { id: "LONG", label: "Long — hours, reads the whole surface" },
  { id: "CONVEYANCE", label: "Conveyance — damage in transit" },
  { id: "OFFLINE", label: "Offline — vendor's own routine" },
];

/**
 * Everything about one drive, opened by double-clicking its row.
 *
 * Health first and in words, because the counters underneath only mean
 * something to someone who already knows what a normal one looks like.
 */
export function DiskHealthModal({ name, onClose }: { name: string; onClose: () => void }) {
  const { data, error, loading, reload } = useResource<Health>(`/api/disks/${encodeURIComponent(name)}/health`, 30_000);
  const [kind, setKind] = useState("SHORT");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function runTest() {
    setBusy(true);
    setFailed(null);
    setNote(null);
    try {
      await post(`/api/disks/${encodeURIComponent(name)}/smart-test`, { type: kind });
      setNote(`${kind.toLowerCase()} test started. It runs on the drive itself — this window can be closed.`);
      setTimeout(() => void reload(), 2000);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const id = data?.identity;

  return (
    <Modal
      title={name}
      subtitle={id ? `${id.model || "unknown model"} · ${bytes(id.size)}` : "Reading the drive…"}
      onClose={onClose}
      wide
      footer={<button className="btn primary" onClick={onClose}>Close</button>}
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !data && <Loading rows={4} />}

      {data && (
        <>
          <div className={`health ${data.health.level}`}>
            <span className={`pill ${data.health.level === "ok" ? "ok" : data.health.level === "warn" ? "warn" : "bad"}`}>
              {data.health.level === "ok" ? "healthy" : data.health.level === "warn" ? "watch" : "attention"}
            </span>
            <ul>
              {data.health.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

          <Section title="Drive">
            <KV
              rows={[
                ["Serial", id!.serial || "—", true],
                ["Model", id!.model || "—"],
                ["Size", bytes(id!.size)],
                ["Type", `${id!.type ?? "—"}${id!.rpm ? ` · ${id!.rpm} rpm` : ""}`],
                ["Bus", `${id!.bus ?? "—"}${id!.subsystem ? ` (${id!.subsystem})` : ""}`],
                ["Sector size", id!.sectorSize ? `${id!.sectorSize} B` : "—"],
                ["Temperature", data.tempC === null ? "not reported" : `${data.tempC}°C`],
                ["Standby", id!.standby ?? "—"],
                ["SMART", id!.smartEnabled ? "enabled" : "disabled"],
              ]}
            />
            {/* Why there is no reading, in the same place the drive's other
                facts are — "not reported" on its own invites a hunt for a
                setting that would fix it, and on a virtual disk there is none. */}
            {data.tempC === null && data.tempNote && (
              <p className="modal-text" style={{ color: "var(--muted)" }}>{data.tempNote}</p>
            )}
            {id!.duplicateSerial.length > 0 && (
              <p className="modal-text" style={{ color: "var(--warn)" }}>
                Another drive reports the same serial ({id!.duplicateSerial.join(", ")}). Identifying this one by serial
                is not reliable.
              </p>
            )}
          </Section>

          <Section title="In ZFS">
            {data.zfs ? (
              <>
                <KV
                  rows={[
                    ["Pool", data.zfs.pool, true],
                    ["Role", data.zfs.role === "data" ? `${data.zfs.vdev} data vdev` : `${data.zfs.role} (${data.zfs.vdev})`],
                    ["State", data.zfs.status ?? "—"],
                    ["Read errors", String(data.zfs.readErrors)],
                    ["Write errors", String(data.zfs.writeErrors)],
                    ["Checksum errors", String(data.zfs.checksumErrors)],
                    ["Repaired", bytes(data.zfs.selfHealed)],
                    ["Allocated", `${bytes(data.zfs.allocated)}${data.zfs.size ? ` of ${bytes(data.zfs.size)}` : ""}`],
                    ["Fragmentation", data.zfs.fragmentation === null ? "—" : `${data.zfs.fragmentation}%`],
                    ["Read since import", bytes(data.zfs.readBytes)],
                    ["Written since import", bytes(data.zfs.writeBytes)],
                  ]}
                />
                <p className="modal-text">
                  Counters reset when the pool is imported, so a fresh boot always reads clean. Checksum errors are the
                  ones to care about: they mean the drive returned data that was wrong rather than admitting it failed.
                </p>
              </>
            ) : (
              <p className="modal-text">
                {data.pool === "boot-pool"
                  ? "This is the drive TrueNAS itself boots from. It is not part of your storage, and its layout is not reported here."
                  : data.pool
                  ? `Reported as part of ${data.pool}, but no vdev on this NAS claims it.`
                  : data.exportedPool
                    ? `Holds an exported pool called ${data.exportedPool}. Importing that pool would put this drive back to work.`
                    : "Not part of any pool. It can be added to one, or wiped."}
              </p>
            )}
          </Section>

          <Section title="SMART">
            {data.smart.supported ? (
              data.smart.attributes.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>#</th><th>Attribute</th><th className="num">Value</th><th className="num">Worst</th><th className="num">Threshold</th><th className="num">Raw</th></tr>
                    </thead>
                    <tbody>
                      {data.smart.attributes.map((a, i) => {
                        const value = pick(a, "value");
                        const thresh = pick(a, "thresh", "threshold");
                        const failing = value !== null && thresh !== null && Number(value) <= Number(thresh);
                        return (
                          <tr key={String(pick(a, "id") ?? i)}>
                            <td style={{ color: "var(--muted)" }}>{String(pick(a, "id") ?? "—")}</td>
                            <td>{String(pick(a, "name", "attribute_name") ?? "—")}</td>
                            <td className="num" style={{ color: failing ? "var(--bad)" : undefined }}>{String(value ?? "—")}</td>
                            <td className="num" style={{ color: "var(--muted)" }}>{String(pick(a, "worst") ?? "—")}</td>
                            <td className="num" style={{ color: "var(--muted)" }}>{String(thresh ?? "—")}</td>
                            <td className="num mono" style={{ fontSize: 12 }}>{String(pick(a, "raw", "raw_value") ?? "—")}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="modal-text">The drive reports SMART but returned no attributes.</p>
              )
            ) : (
              <p className="modal-text">
                {data.smart.reason ?? "This device does not report SMART data."} Virtual disks usually do not — the
                health above is then based on what ZFS has seen, which for a virtual disk is the more meaningful signal
                anyway.
              </p>
            )}
          </Section>

          <Section title="Self-tests">
            {data.tests.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>#</th><th>Type</th><th>Result</th><th className="num">Powered hours</th></tr></thead>
                  <tbody>
                    {data.tests.map((t, i) => (
                      <tr key={String(t.num ?? i)}>
                        <td style={{ color: "var(--muted)" }}>{String(t.num ?? "—")}</td>
                        <td>{String(t.type ?? t.description ?? "—")}</td>
                        <td>{String(t.status ?? "—")}</td>
                        <td className="num" style={{ color: "var(--muted)" }}>{String(t.lifetime ?? "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="modal-text">No self-test has been run on this drive.</p>
            )}

            <div className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!data.identity.smartEnabled}>
                {TEST_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </Select>
              <button className="btn" style={{ flex: "none" }} disabled={busy} onClick={() => void runTest()}>
                {busy ? "Starting…" : "Run test"}
              </button>
            </div>
            {note && <p className="modal-text" style={{ color: "var(--ok)" }}>{note}</p>}
            {failed && <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>{failed}</div>}
            <p className="modal-text">
              A test runs inside the drive's own firmware, so the pool stays up. A long test on a full-size disk takes
              hours and slows it down while it runs.
            </p>
          </Section>
        </>
      )}
    </Modal>
  );
}

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dh-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function KV({ rows }: { rows: Array<[string, string, boolean?]> }) {
  return (
    <div className="kv">
      {rows.map(([k, v, strong]) => (
        <div key={k}>
          <span>{k}</span>
          <b className={strong ? "mono" : undefined}>{v}</b>
        </div>
      ))}
    </div>
  );
}
