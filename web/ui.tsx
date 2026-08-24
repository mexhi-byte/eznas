import { useEffect, useState, type ReactNode } from "react";
import { watchJob, type Job } from "./api";

export function Modal({ title, subtitle, onClose, children, footer, wide }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Prevent the page behind from scrolling under the dialog.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { maxWidth: 760 } : undefined} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input" {...props}>{children}</select>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Confirmation for something that cannot be undone.
 *
 * The operator types the name. A yes/no dialog is muscle memory by the third
 * time and stops being a decision; typing "tank14" is not something anyone does
 * while thinking about something else.
 */
export function DangerConfirm({ what, name, verb, onCancel, onConfirm, extra }: {
  what: string;
  name: string;
  verb: string;
  onCancel: () => void;
  onConfirm: (confirm: string) => Promise<void>;
  extra?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed);
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${verb} ${what}`}
      subtitle="This cannot be undone."
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn danger-solid" disabled={typed !== name || busy} onClick={() => void go()}>
            {busy ? "Working…" : verb}
          </button>
        </>
      }
    >
      <p className="modal-text">
        Type <strong className="mono">{name}</strong> to confirm.
      </p>
      <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoFocus />
      {extra}
      {error && <div className="error-banner" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
    </Modal>
  );
}

/** Follows a NAS job and reports where it got to. */
export function JobProgress({ jobId, label, onDone }: { jobId: number; label: string; onDone?: (j: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    const stop = watchJob(jobId, (j) => {
      setJob(j);
      if (["SUCCESS", "FAILED", "ABORTED"].includes(j.state)) onDone?.(j);
    });
    return stop;
    // onDone deliberately excluded: callers pass inline closures, and including
    // it would restart the poll on every render.
  }, [jobId]);

  if (!job) return <div className="job"><span className="job-label">{label}</span><span className="job-state">starting…</span></div>;

  const pct = job.progress?.percent ?? 0;
  const done = job.state === "SUCCESS";
  const failed = job.state === "FAILED" || job.state === "ABORTED";

  return (
    <div className={`job ${failed ? "failed" : done ? "done" : ""}`}>
      <div className="job-top">
        <span className="job-label">{label}</span>
        <span className="job-state">
          {done ? "done" : failed ? "failed" : `${pct.toFixed(0)}%`}
        </span>
      </div>
      {!done && !failed && (
        <div className="bar"><i style={{ width: `${Math.max(3, pct)}%` }} /></div>
      )}
      {job.progress?.description && !done && !failed && <div className="job-desc">{job.progress.description}</div>}
      {failed && <div className="job-desc job-error">{job.error ?? "The NAS did not say why."}</div>}
    </div>
  );
}

/** A tiny helper for forms that submit once and report their own failure. */
export function useSubmit<T>(fn: (v: T) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value: T): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn(value);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, submit, setError };
}

/**
 * Sub-navigation within a page.
 *
 * The sidebar used to carry every screen, which made the first decision on
 * arrival a choice between thirteen things. Related screens now sit behind one
 * sidebar entry and switch here instead.
 */
export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: ReadonlyArray<{ id: T; label: string; badge?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${active === t.id ? "on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
