import { useMemo, useState } from "react";
import { put, useResource } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Field, Input, Modal, Select, Toggle } from "./ui";

/* -------------------------------------------------------------------- types */

interface Credential { path: string; key: string; value: string; secret: boolean }

/** One question from a catalog app's schema. The shape is recursive. */
interface Question {
  variable: string;
  label?: string;
  description?: string;
  group?: string;
  schema: QSchema;
}
interface QSchema {
  type: string;
  default?: unknown;
  required?: boolean;
  private?: boolean;
  enum?: Array<{ value: string; description?: string }>;
  attrs?: Question[];
  items?: Question[];
  min?: number;
  max?: number;
  hidden?: boolean;
  editable?: boolean;
}

interface AppConfig {
  name: string;
  title: string;
  version: string;
  custom: boolean;
  portals: Record<string, string>;
  values: Record<string, unknown>;
  schema: Question[] | null;
  credentials: Credential[];
}

/* ------------------------------------------------------------------- modal */

type Tab = "settings" | "credentials";

export function AppConfigModal({ name, onClose, onSaved }: {
  name: string;
  onClose: () => void;
  onSaved: (jobId: number, label: string) => void;
}) {
  const { data, error, loading } = useResource<AppConfig>(`/api/apps/${encodeURIComponent(name)}/config`, 0);
  const [tab, setTab] = useState<Tab>("settings");
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const values = draft ?? data?.values ?? {};
  const portal = Object.values(data?.portals ?? {})[0];

  async function save() {
    setBusy(true);
    setFailed(null);
    try {
      let payload: unknown = values;
      if (raw !== null) {
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          setRawError(e instanceof Error ? e.message : "That is not valid JSON.");
          setBusy(false);
          return;
        }
      }
      const { jobId } = await put<{ jobId: number }>(`/api/apps/${encodeURIComponent(name)}/config`, { values: payload });
      onSaved(jobId, `Updating ${name}`);
      onClose();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const dirty = draft !== null || raw !== null;

  return (
    <Modal
      title={data?.title ?? name}
      subtitle={data ? `${data.version} · ${data.custom ? "custom app" : "from the catalog"}` : "Reading the app…"}
      onClose={onClose}
      wide
      footer={
        <>
          {portal && (
            <a className="btn" href={portal} target="_blank" rel="noreferrer" style={{ flex: "none", marginRight: "auto", textAlign: "center" }}>
              Open {data?.title ?? name} ↗
            </a>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save and redeploy"}
          </button>
        </>
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={4} />}

      {data && (
        <>
          <div className="seg" style={{ marginBottom: 16 }}>
            <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
            <button className={tab === "credentials" ? "on" : ""} onClick={() => setTab("credentials")}>
              Passwords{data.credentials.length ? ` (${data.credentials.length})` : ""}
            </button>
          </div>

          {tab === "settings" ? (
            data.schema ? (
              <QuestionList
                questions={data.schema}
                values={values as Record<string, unknown>}
                onChange={(next) => setDraft(next)}
              />
            ) : (
              <ComposeEditor
                initial={data.values}
                text={raw}
                error={rawError}
                onChange={(t) => { setRaw(t); setRawError(null); }}
              />
            )
          ) : (
            <Credentials list={data.credentials} />
          )}

          {dirty && (
            <p className="modal-text" style={{ marginTop: 16, color: "var(--warn)" }}>
              Saving restarts the app's containers. Anything using it right now will drop for a few seconds.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------- schema-driven form */

/**
 * A catalog app's settings, rendered from the schema the app ships.
 *
 * The schema nests: a dict of dicts of leaves, sometimes lists of dicts. This
 * walks it rather than hard-coding any app, so an app the console has never
 * seen still gets a real form instead of a JSON blob.
 */
function QuestionList({ questions, values, onChange }: {
  questions: Question[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Question[]>();
    for (const q of questions) {
      if (q.schema?.hidden) continue;
      const g = q.group || "Settings";
      map.set(g, [...(map.get(g) ?? []), q]);
    }
    return [...map.entries()];
  }, [questions]);

  const setAt = (pathParts: string[], value: unknown) => {
    // Cloned down the path so React sees a new object at every level it needs
    // to re-render, without mutating the loaded config.
    const next = structuredClone(values);
    let node = next as Record<string, unknown>;
    for (const p of pathParts.slice(0, -1)) {
      if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
      node = node[p] as Record<string, unknown>;
    }
    node[pathParts[pathParts.length - 1]] = value;
    onChange(next);
  };

  const readAt = (pathParts: string[]): unknown =>
    pathParts.reduce<unknown>((acc, p) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[p] : undefined), values);

  return (
    <>
      {groups.map(([group, qs]) => (
        <div key={group} className="dh-section">
          <h3>{group}</h3>
          {qs.map((q) => <QuestionNode key={q.variable} q={q} path={[q.variable]} read={readAt} write={setAt} />)}
        </div>
      ))}
    </>
  );
}

function QuestionNode({ q, path, read, write }: {
  q: Question;
  path: string[];
  read: (p: string[]) => unknown;
  write: (p: string[], v: unknown) => void;
}) {
  const s = q.schema ?? { type: "string" };
  if (s.hidden) return null;
  const label = q.label || q.variable;
  const current = read(path);

  if (s.type === "dict") {
    return (
      <div className="q-dict">
        <div className="q-dict-label">{label}</div>
        {(s.attrs ?? []).map((a) => (
          <QuestionNode key={a.variable} q={a} path={[...path, a.variable]} read={read} write={write} />
        ))}
      </div>
    );
  }

  // Lists hold whole sub-objects (extra mounts, extra environment variables).
  // Editing those in place needs its own editor; showing what is there and
  // saying so is more honest than a control that quietly drops entries.
  if (s.type === "list") {
    const items = Array.isArray(current) ? current : [];
    return (
      <Field label={label} hint={strip(q.description)}>
        <div className="q-list">
          {items.length ? (
            items.map((it, i) => <div key={i} className="mono">{JSON.stringify(it)}</div>)
          ) : (
            <span style={{ color: "var(--faint)" }}>empty</span>
          )}
          <span className="q-list-note">Lists are edited in the NAS's own app interface.</span>
        </div>
      </Field>
    );
  }

  if (s.type === "boolean") {
    return (
      <div style={{ margin: "10px 0" }}>
        <Toggle checked={current === true} onChange={(v) => write(path, v)} label={label} />
        {q.description && <div className="field-hint" style={{ marginTop: 3 }}>{strip(q.description)}</div>}
      </div>
    );
  }

  if (s.enum?.length) {
    return (
      <Field label={label} hint={strip(q.description)}>
        <Select value={String(current ?? s.default ?? "")} onChange={(e) => write(path, e.target.value)}>
          {s.enum.map((o) => (
            <option key={o.value} value={o.value}>{o.description || o.value || "None"}</option>
          ))}
        </Select>
      </Field>
    );
  }

  if (s.type === "int") {
    return (
      <Field label={label} hint={strip(q.description)}>
        <Input
          type="number"
          min={s.min}
          max={s.max}
          value={current === undefined || current === null ? "" : String(current)}
          onChange={(e) => write(path, e.target.value === "" ? null : Number(e.target.value))}
        />
      </Field>
    );
  }

  return (
    <Field label={label} hint={strip(q.description)}>
      <Input
        type={s.private ? "password" : "text"}
        value={current === undefined || current === null ? "" : String(current)}
        onChange={(e) => write(path, e.target.value)}
      />
    </Field>
  );
}

/** Schema descriptions are written in HTML, and it shows if it is not removed. */
const strip = (html?: string): string | undefined =>
  html ? html.replace(/<\/?[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220) : undefined;

/* ---------------------------------------------------------- compose editing */

function ComposeEditor({ initial, text, error, onChange }: {
  initial: Record<string, unknown>;
  text: string | null;
  error: string | null;
  onChange: (t: string) => void;
}) {
  const shown = text ?? JSON.stringify(initial, null, 2);

  return (
    <>
      <p className="modal-text" style={{ marginTop: 0 }}>
        This app was installed from a compose file rather than the catalog, so its settings are the file itself —
        images, ports, volumes and environment. Edit it here and the app is redeployed with what you save.
      </p>
      <textarea
        className="code-area"
        spellCheck={false}
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        rows={20}
      />
      {error && <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>Not valid JSON — {error}</div>}
    </>
  );
}

/* ---------------------------------------------------------------- passwords */

function Credentials({ list }: { list: Credential[] }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(c: Credential) {
    try {
      await navigator.clipboard.writeText(c.value);
      setCopied(c.path);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard is blocked outside a secure context; revealing it is the
      // fallback, since the value is right there to select by hand.
      setShown((s) => ({ ...s, [c.path]: true }));
    }
  }

  if (!list.length) {
    return (
      <p className="modal-text">
        This app's settings hold no passwords. Either it does not need one, or it keeps its accounts in its own
        database — check inside the app itself.
      </p>
    );
  }

  return (
    <>
      <p className="modal-text" style={{ marginTop: 0 }}>
        Found in this app's own configuration. These are the values it was installed with — the ones an app shows once
        at install and never again.
      </p>
      <div className="cred-list">
        {list.map((c) => (
          <div key={c.path} className="cred">
            <div style={{ minWidth: 0 }}>
              <div className="cred-key">
                {c.key}
                {c.secret && <span className="pill warn" style={{ marginLeft: 8 }}>secret</span>}
              </div>
              <div className="cred-path mono">{c.path}</div>
            </div>
            <div className="cred-value mono">
              {!c.secret || shown[c.path] ? c.value : "•".repeat(Math.min(20, c.value.length))}
            </div>
            <div className="row-actions">
              {c.secret && (
                <button className="btn" onClick={() => setShown((s) => ({ ...s, [c.path]: !s[c.path] }))}>
                  {shown[c.path] ? "Hide" : "Show"}
                </button>
              )}
              <button className="btn" onClick={() => void copy(c)}>{copied === c.path ? "Copied" : "Copy"}</button>
            </div>
          </div>
        ))}
      </div>
      <p className="modal-text">
        Changing one here only changes what the app is started with. An app that already wrote the password into its own
        database — Nextcloud, Authentik — keeps the old one until you change it inside the app.
      </p>
    </>
  );
}
