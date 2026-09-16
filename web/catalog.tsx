import { useState } from "react";
import { post, useResource } from "./api";
import { Empty, ErrorBanner, Loading } from "./components";
import { AppDetailsModal } from "./app-details";
import { QuestionList } from "./app-config";
import { defaultsFor, hasVisibleQuestions, type Question } from "./app-schema";
import { Field, Input, JobProgress, Modal, useSubmit } from "./ui";

/* ---------------------------------------------------------------- catalog */

interface CatalogApp {
  name: string;
  title: string;
  categories: string[];
  latest_version: string;
  train: string;
  description?: string;
  installed?: boolean;
}

export function CatalogPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const { data, error, loading } = useResource<{ categories: string[]; total: number; apps: CatalogApp[] }>(
    `/api/catalog?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`,
    0,
  );
  const [installing, setInstalling] = useState<CatalogApp | null>(null);
  const [detailing, setDetailing] = useState<CatalogApp | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>App catalog</h1>
          <div className="page-sub">{data ? `${data.total} apps available` : " "}</div>
        </div>
        <Input style={{ maxWidth: 240 }} placeholder="Search apps…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!!data?.categories.length && (
        <div className="chip-row" style={{ marginBottom: 16 }}>
          <button className={`chip ${!category ? "on" : ""}`} onClick={() => setCategory("")}>
            all
          </button>
          {data.categories.slice(0, 14).map((c) => (
            <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      )}

      {loading && !data && <Loading rows={4} />}

      <div className="grid cards">
        {data?.apps.map((a) => (
          <div
            key={`${a.train}/${a.name}`}
            className="cat-card"
            /* Double-click opens the details, as asked. A card that only
               responds to a gesture nobody can see is a card with a secret, so
               there is a visible Details link as well. */
            onDoubleClick={() => setDetailing(a)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="app-icon">{a.title.slice(0, 2).toUpperCase()}</div>
              <div style={{ minWidth: 0 }}>
                <div className="app-name">{a.title}</div>
                <div className="app-meta">
                  {a.latest_version} · {a.train}
                </div>
              </div>
            </div>
            {a.description && <div className="cat-desc">{a.description}</div>}
            <div className="cat-actions">
              <button className="btn" onClick={() => setDetailing(a)}>
                Details
              </button>
              <button className="btn primary" onClick={() => setInstalling(a)}>
                Install
              </button>
            </div>
          </div>
        ))}
        {!loading && !data?.apps.length && <Empty>Nothing matches that search.</Empty>}
      </div>

      {detailing && (
        <AppDetailsModal
          name={detailing.name}
          train={detailing.train}
          onClose={() => setDetailing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDetailing(null)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const a = detailing;
                  setDetailing(null);
                  setInstalling(a);
                }}
              >
                Install
              </button>
            </>
          }
        />
      )}

      {installing && (
        <InstallForm
          app={installing}
          onClose={() => setInstalling(null)}
          onStarted={(jobId, label) => {
            setJobs((j) => [...j, { id: jobId, label }]);
            setInstalling(null);
          }}
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function InstallForm({
  app,
  onClose,
  onStarted,
}: {
  app: CatalogApp;
  onClose: () => void;
  onStarted: (jobId: number, label: string) => void;
}) {
  const [name, setName] = useState(app.name);
  /*
   * The app's own questions, answered before it is installed. The console
   * used to install with defaults and send people to TrueNAS to set storage
   * paths and ports afterwards — to the interface this one exists to replace.
   * The same form the config dialog renders after install is rendered here
   * first, starting from the schema's defaults.
   */
  const { data: schema, error: schemaError } = useResource<{ version: string; questions: Question[] | null }>(
    `/api/catalog/app/schema?name=${encodeURIComponent(app.name)}&train=${encodeURIComponent(app.train)}`,
    0,
  );
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const values = draft ?? (schema ? defaultsFor(schema.questions) : {});
  const asksSomething = hasVisibleQuestions(schema?.questions);

  const { busy, error, submit } = useSubmit(async () => {
    const { jobId } = await post<{ jobId: number }>("/api/apps", {
      appName: name,
      catalogApp: app.name,
      train: app.train,
      values,
    });
    onStarted(jobId, `Installing ${name}`);
  });

  return (
    <Modal
      title={`Install ${app.title}`}
      subtitle={`${schema?.version ?? app.latest_version} from the ${app.train} train`}
      onClose={onClose}
      wide={asksSomething}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name} onClick={() => void submit(undefined as void)}>
            {busy ? "Starting…" : "Install"}
          </button>
        </>
      }
    >
      <Field
        label="Name for this instance"
        hint="Lower-case letters, numbers and dashes. This is how it appears under Apps."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
          autoFocus
        />
      </Field>
      {schema === null && !schemaError && <Loading rows={3} />}
      {schemaError && (
        <p className="modal-text" style={{ color: "var(--warn)" }}>
          The app's settings could not be read ({schemaError}), so it will be installed with its defaults. They can be
          changed afterwards from the app's Configure button.
        </p>
      )}
      {schema && asksSomething && (
        <>
          <QuestionList questions={schema.questions!} values={values} onChange={setDraft} />
          <p className="modal-text">
            Everything above starts at the app's own defaults. Storage paths and ports are the ones worth a look;
            anything can be changed later from the app's Configure button.
          </p>
        </>
      )}
      {schema && !asksSomething && (
        <p className="modal-text">This app has no settings to choose at install. It can be configured afterwards.</p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
