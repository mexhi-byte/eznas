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
 * A link, only if following it cannot run code.
 *
 * The server already refuses anything but http(s) for these fields, so this is
 * the second of two checks rather than the only one. It is here because the
 * cost is a regex and the failure mode is somebody's session running a chart
 * author's script — and because the next component to render one of these
 * fields may not come through the same mapper.
 */
const safe = (u: string | null | undefined): string | undefined =>
  u && /^https?:\/\/[^/]/i.test(u.trim()) ? u.trim() : undefined;

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
/** What the console already knows about an app it has installed. */
export interface InstalledFacts {
  state: string;
  version: string;
  containers: number;
  ports: number[];
  links: Array<{ port: number; url: string }>;
  updatable: boolean;
}

export function AppDetailsModal({ name, train, local, footer, onClose }: {
  name: string;
  train?: string | null;
  /**
   * Facts from the running app, for one that is installed.
   *
   * An app deployed from a compose file has no catalog entry, so the lookup
   * below finds nothing — which was every app on a server where they were set
   * up that way. Showing an error there is answering "what is this?" with
   * "the catalog has never heard of it", when the console knows perfectly well
   * what is running, on which ports, in how many containers.
   */
  local?: InstalledFacts;
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
      subtitle={[local?.version ?? data?.version, data?.train ?? train].filter(Boolean).join(" · ") || " "}
      onClose={onClose}
      wide
      footer={footer ?? <button className="btn primary" onClick={onClose}>Close</button>}
    >
      {loading && !data && !local && <Loading rows={3} />}

      {/* What is actually running, which the console knows without asking the
          catalog anything. Shown first because for a compose app it is the
          only thing there is to say. */}
      {local && (
        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>State</dt><dd>{local.state.toLowerCase()}</dd>
          <dt>Version</dt><dd className="mono">{local.version}</dd>
          <dt>Containers</dt><dd>{local.containers}</dd>
          {!!local.links.length && (
            <>
              <dt>Reachable at</dt>
              <dd>
                {local.links.map((l) => (
                  <a key={l.port} href={l.url} target="_blank" rel="noreferrer" style={{ display: "block" }}>{l.url}</a>
                ))}
              </dd>
            </>
          )}
          {!local.links.length && !!local.ports.length && (
            <><dt>Ports</dt><dd className="mono">{local.ports.join(", ")}</dd></>
          )}
          {local.updatable && <><dt>Update</dt><dd>one is available</dd></>}
        </dl>
      )}

      {/*
        * A compose app has no catalog entry and never will, so the lookup
        * failing is a fact about how it was installed rather than a failure of
        * this dialog. Only worth an error when there is nothing else to show.
        */}
      {error && !local && <ErrorBanner>{error}</ErrorBanner>}
      {error && local && (
        <p className="modal-text" style={{ color: "var(--muted)" }}>
          This app was not installed from a catalog, so there is no published description for it.
        </p>
      )}

      {data && (
        <>
          {!!data.screenshots.length && (
            <div className="shots">
              <img src={safe(data.screenshots[shot])} alt="" loading="lazy" />
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
            {safe(data.home) && (
              <>
                <dt>Website</dt>
                <dd><a href={safe(data.home)} target="_blank" rel="noreferrer">{data.home}</a></dd>
              </>
            )}
            {!!data.sources.length && (
              <>
                <dt>Source</dt>
                <dd>
                  {data.sources.map((u) => (
                    <a key={u} href={safe(u)} target="_blank" rel="noreferrer" style={{ display: "block" }}>{u}</a>
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
                      {safe(m.url) ? <a href={safe(m.url)} target="_blank" rel="noreferrer">{m.name}</a> : m.name}
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
