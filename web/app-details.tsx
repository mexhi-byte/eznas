import { useState } from "react";
import { useResource } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Modal } from "./ui";

export interface AppDetail {
  name: string;
  title: string;
  train: string | null;
  description: string | null;
  icon: string | null;
  version: string | null;
  categories: string[];
  home: string | null;
  sources: string[];
  screenshots: string[];
  maintainers: Array<{ name: string; url: string | null }>;
  versionCount: number;
  lastUpdated: string | null;
  installed: boolean;
}

/**
 * What an app is, before deciding to install it — or after, to remember why.
 *
 * The catalog card has room for a title and two lines of description, which is
 * enough to recognise an app you already know and not enough to choose between
 * two you do not. This is the rest of it: what it does, who publishes it,
 * where the source lives, and what it looks like.
 *
 * Deliberately not the catalog's `app_readme`. That is HTML written by a third
 * party, and rendering it would mean trusting whoever wrote the chart with
 * markup inside the console.
 */
export function AppDetailsModal({ name, train, footer, onClose }: {
  name: string;
  train?: string | null;
  /** The action this dialog leads to, if any — Install, or Open. */
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const { data, error, loading } = useResource<AppDetail>(
    `/api/catalog/app?name=${encodeURIComponent(name)}${train ? `&train=${encodeURIComponent(train)}` : ""}`,
    0,
  );
  const [shot, setShot] = useState(0);

  return (
    <Modal
      title={data?.title ?? name}
      subtitle={[data?.version, data?.train].filter(Boolean).join(" · ") || " "}
      onClose={onClose}
      wide
      footer={footer ?? <button className="btn primary" onClick={onClose}>Close</button>}
    >
      {loading && !data && <Loading rows={3} />}
      {/* An app the catalog has never heard of is the common case for a
          compose app, so it is stated as a fact rather than as a failure. */}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {data && (
        <>
          {!!data.screenshots.length && (
            <div className="shots">
              <img src={data.screenshots[shot]} alt="" loading="lazy" />
              {data.screenshots.length > 1 && (
                <div className="shot-dots">
                  {data.screenshots.map((s, i) => (
                    <button
                      key={s}
                      className={`shot-dot ${i === shot ? "on" : ""}`}
                      onClick={() => setShot(i)}
                      aria-label={`Screenshot ${i + 1}`}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {data.description && <p className="modal-text">{data.description}</p>}

          {!!data.categories.length && (
            <div className="chip-row" style={{ marginBottom: 12 }}>
              {data.categories.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          )}

          <dl className="kv">
            {data.version && <><dt>Version</dt><dd className="mono">{data.version}</dd></>}
            {data.versionCount > 1 && (
              <>
                <dt>Older versions</dt>
                {/* Worth knowing before installing: an app with one published
                    version has nothing to roll back to if an update breaks it. */}
                <dd>{data.versionCount - 1} to roll back to</dd>
              </>
            )}
            {data.lastUpdated && <><dt>Updated</dt><dd>{data.lastUpdated}</dd></>}
            {data.home && (
              <>
                <dt>Website</dt>
                <dd><a href={data.home} target="_blank" rel="noreferrer">{data.home}</a></dd>
              </>
            )}
            {!!data.sources.length && (
              <>
                <dt>Source</dt>
                <dd>
                  {data.sources.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer" style={{ display: "block" }}>{u}</a>
                  ))}
                </dd>
              </>
            )}
            {!!data.maintainers.length && (
              <>
                <dt>Maintained by</dt>
                <dd>
                  {data.maintainers.map((m) => (
                    <span key={m.name} style={{ display: "block" }}>
                      {m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.name}</a> : m.name}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </>
      )}
    </Modal>
  );
}
