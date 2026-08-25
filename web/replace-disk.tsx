import { useState } from "react";
import { bytes, post, useResource } from "./api";
import { ErrorBanner, Loading } from "./components";
import { JobProgress, Modal, Select } from "./ui";

interface Faulted {
  guid: string | null;
  device: string | null;
  status: string;
  role: string;
  vdev: string;
  model: string | null;
  serial: string | null;
  size: number | null;
}

interface Spare { name: string; model: string; serial: string; size: number; type: string }

interface Identify { pool: string; status: string; faulted: Faulted[]; spare: Spare[] }

type Step = "identify" | "offline" | "swap" | "replace" | "running";

/**
 * Replacing a failed drive without a checklist.
 *
 * The native flow spreads this over four screens, and the step that goes wrong
 * is choosing which disk: the dead member is named by a ZFS guid and the new
 * one by a device name, and nothing on screen connects either to the drive you
 * can physically see. Offlining the wrong one, in a pool that is already
 * degraded, is how a recoverable failure becomes a lost pool.
 *
 * So this leads with the serial number to look for, and never asks anybody to
 * retype an identifier it already knows.
 */
export function ReplaceDiskWizard({ pool, onClose, onJob }: {
  pool: string;
  onClose: () => void;
  onJob: (jobId: number, label: string) => void;
}) {
  const { data, error, loading, reload } = useResource<Identify>(
    `/api/pools/${encodeURIComponent(pool)}/replace/identify`,
    0,
  );
  const [step, setStep] = useState<Step>("identify");
  const [target, setTarget] = useState<Faulted | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [spare, setSpare] = useState<Spare[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [job, setJob] = useState<number | null>(null);

  const faulted = data?.faulted ?? [];
  const picked = target ?? faulted[0] ?? null;

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setFailed(null);
    try {
      return await fn();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function offline() {
    if (!picked?.guid) return;
    const r = await act(() =>
      post(`/api/pools/${encodeURIComponent(pool)}/replace/offline`, { label: picked.guid, confirm: picked.guid }),
    );
    if (r) setStep("swap");
  }

  async function scan() {
    const r = await act(() => post<{ spare: Spare[] }>(`/api/pools/${encodeURIComponent(pool)}/replace/scan`));
    if (r) {
      setSpare(r.spare);
      setChosen(r.spare[0]?.name ?? "");
      setStep("replace");
    }
  }

  async function replace() {
    if (!picked?.guid || !chosen) return;
    const r = await act(() =>
      post<{ jobId: number }>(`/api/pools/${encodeURIComponent(pool)}/replace/replace`, {
        label: picked.guid, disk: chosen, confirm: chosen,
      }),
    );
    if (r) {
      setJob(r.jobId);
      setStep("running");
      onJob(r.jobId, `Rebuilding ${pool} onto ${chosen}`);
    }
  }

  const titles: Record<Step, string> = {
    identify: "Which drive failed",
    offline: "Take it out of the pool",
    swap: "Swap the drive",
    replace: "Rebuild onto the new drive",
    running: "Rebuilding",
  };

  return (
    <Modal
      title={titles[step]}
      subtitle={`${pool}${data ? ` · ${data.status.toLowerCase()}` : ""}`}
      onClose={onClose}
      wide
      footer={
        step === "identify" ? (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn danger-solid" disabled={!picked?.guid || busy} onClick={() => void offline()}>
              {busy ? "Working…" : "Take this drive offline"}
            </button>
          </>
        ) : step === "swap" ? (
          <>
            <button className="btn" onClick={onClose}>Finish later</button>
            <button className="btn primary" disabled={busy} onClick={() => void scan()}>
              {busy ? "Scanning…" : "I have swapped it — scan"}
            </button>
          </>
        ) : step === "replace" ? (
          <>
            <button className="btn" onClick={() => setStep("swap")}>Back</button>
            <button className="btn primary" disabled={!chosen || busy} onClick={() => void replace()}>
              {busy ? "Starting…" : "Start rebuilding"}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose}>Close</button>
        )
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={3} />}

      <ol className="wizard-steps">
        {(["identify", "swap", "replace"] as const).map((s, i) => (
          <li key={s} className={step === s || (step === "running" && s === "replace") ? "on" : ""}>
            <span>{i + 1}</span>
            {s === "identify" ? "Find it" : s === "swap" ? "Swap it" : "Rebuild"}
          </li>
        ))}
      </ol>

      {step === "identify" && data && (
        faulted.length === 0 ? (
          <p className="modal-text">
            Every drive in {pool} is reporting as online, so there is nothing to replace. If you are replacing a drive
            that is failing but has not been marked faulted yet, do it from the NAS's own interface — this wizard
            deliberately only touches members ZFS has already given up on.
          </p>
        ) : (
          <>
            <p className="modal-text" style={{ marginTop: 0 }}>
              {faulted.length === 1 ? "This member has failed." : "Choose the member to replace."}
            </p>

            {faulted.length > 1 && (
              <Select
                value={picked?.guid ?? ""}
                onChange={(e) => setTarget(faulted.find((f) => f.guid === e.target.value) ?? null)}
              >
                {faulted.map((f) => (
                  <option key={f.guid} value={f.guid ?? ""}>
                    {f.device ?? "missing device"} — {f.status.toLowerCase()}
                  </option>
                ))}
              </Select>
            )}

            {picked && (
              <div className="failed-disk">
                <div className="failed-disk-head">
                  <span className="pill bad">{picked.status.toLowerCase()}</span>
                  <strong>{picked.device ?? "no longer visible"}</strong>
                </div>
                <div className="kv" style={{ marginTop: 12 }}>
                  <div><span>Serial to look for</span><b className="mono">{picked.serial ?? "unknown"}</b></div>
                  <div><span>Model</span><b>{picked.model ?? "unknown"}</b></div>
                  <div><span>Size</span><b>{picked.size ? bytes(picked.size) : "unknown"}</b></div>
                  <div><span>In</span><b>{picked.vdev.toLowerCase()} ({picked.role})</b></div>
                </div>
                {!picked.serial && (
                  <p className="modal-text" style={{ color: "var(--warn)" }}>
                    The NAS can no longer read this drive, so it cannot tell you the serial. Match it by which bay is
                    empty in the map, or by the serials of the drives that <em>are</em> still reporting.
                  </p>
                )}
              </div>
            )}

            <p className="modal-text">
              Taking it offline tells ZFS to stop using it, so it can be unplugged safely. The pool keeps running on
              the remaining members, with no redundancy left until the rebuild finishes.
            </p>
          </>
        )
      )}

      {step === "swap" && (
        <>
          <p className="modal-text" style={{ marginTop: 0 }}>
            <strong>{picked?.device ?? "The drive"}</strong> is offline and safe to remove.
          </p>
          <ol className="plain-steps">
            <li>Find the drive with serial <strong className="mono">{picked?.serial ?? "unknown"}</strong> and pull it.</li>
            <li>Put the new drive in the same bay. It should be at least {picked?.size ? bytes(picked.size) : "the same size"}.</li>
            <li>Come back here and scan.</li>
          </ol>
          <p className="modal-text">
            There is no rush — the pool is running degraded and will wait. Closing this window does not undo anything.
          </p>
        </>
      )}

      {step === "replace" && (
        <>
          {spare.length === 0 ? (
            <>
              <p className="modal-text" style={{ marginTop: 0, color: "var(--warn)" }}>
                No unused drive was found. If you have just plugged one in, give it a few seconds and scan again — and
                check that it is not still carrying an old pool, which would make the NAS treat it as in use.
              </p>
              <button className="btn" style={{ flex: "none" }} disabled={busy} onClick={() => void scan()}>Scan again</button>
            </>
          ) : (
            <>
              <p className="modal-text" style={{ marginTop: 0 }}>
                Found {spare.length} unused drive{spare.length === 1 ? "" : "s"}. The one you pick is written over
                completely.
              </p>
              <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                {spare.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name} — {d.model || "unknown"} · {bytes(d.size)} · serial {d.serial || "unknown"}
                  </option>
                ))}
              </Select>
              {picked?.size && spare.find((d) => d.name === chosen) && spare.find((d) => d.name === chosen)!.size < picked.size && (
                <p className="modal-text" style={{ color: "var(--bad)" }}>
                  That drive is smaller than the one it replaces. ZFS will refuse.
                </p>
              )}
              <p className="modal-text">
                Rebuilding copies everything the failed drive held back onto the new one from the other members. It
                takes hours on a full pool and the pool stays usable throughout, just slower.
              </p>
            </>
          )}
        </>
      )}

      {step === "running" && job && (
        <>
          <JobProgress jobId={job} label={`Rebuilding onto ${chosen}`} />
          <p className="modal-text">
            You can close this. The rebuild carries on, and the drive array map shows its progress.
          </p>
        </>
      )}
    </Modal>
  );
}
