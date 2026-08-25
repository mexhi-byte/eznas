import { useEffect, useMemo, useState } from "react";
import { bytes, post, useResource, withConn } from "./api";
import { Card, Empty, ErrorBanner, Loading } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, useSubmit } from "./ui";
import { PermissionsModal } from "./permissions";
import { RecycleBin } from "./recycle-bin";
import { ShareFolder } from "./shares";

/**
 * The file browser.
 *
 * Lifted out of pages3.tsx, which held this alongside Settings, Users and the
 * app catalog — four unrelated pages sharing a file because there was nowhere
 * obvious to put a new one. Nothing here changed in the move except that Entry
 * became exported, since it describes what the API returns and other modules
 * now need to name it.
 */

/* ------------------------------------------------------------------ files */

export interface Entry {
  name: string;
  path: string;
  type: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  isMountpoint: boolean;
  kind: "dir" | "image" | "video" | "audio" | "pdf" | "text" | "other";
}

/** Rename one file or folder in place. */
function RenameEntry({ entry, onClose, onDone }: { entry: Entry; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(entry.name);

  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/files/rename", { path: entry.path, name: name.trim() });
    onDone();
  });

  const unchanged = name.trim() === entry.name;

  return (
    <Modal
      title={`Rename ${entry.type === "DIRECTORY" ? "folder" : "file"}`}
      subtitle={entry.path}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || unchanged} onClick={() => void submit(undefined as void)}>
            {busy ? "Renaming…" : "Rename"}
          </button>
        </>
      }
    >
      <Field label="New name" hint="No slashes — this renames it where it is.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\//g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !unchanged) void submit(undefined as void); }}
          autoFocus
        />
      </Field>
      <p className="modal-text">
        An existing file with that name is never overwritten — the rename fails instead.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

type SortKey = "name" | "size" | "kind";

export function FilesPage() {
  const [path, setPath] = useState("/mnt");
  const { data, error, loading, reload } = useResource<{
    path: string;
    parent: string | null;
    space: { source: string; total: number; free: number } | null;
    canMove: boolean;
    entries: Entry[];
  }>(`/api/files?path=${encodeURIComponent(path)}`, 0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [preview, setPreview] = useState<Entry | null>(null);
  const [gallery, setGallery] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [desc, setDesc] = useState(false);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [permsFor, setPermsFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [showBin, setShowBin] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [permJobs, setPermJobs] = useState<Array<{ id: number; label: string }>>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const canMove = data?.canMove ?? false;

  /**
   * Drop something onto a folder.
   *
   * The dragged paths travel in the drag payload rather than in component
   * state, so a drag that starts in this window and ends somewhere else simply
   * does nothing instead of moving a file on a stale selection.
   */
  async function drop(targetDir: string, ev: React.DragEvent) {
    ev.preventDefault();
    setDragOver(null);
    let from: string[] = [];
    try {
      from = JSON.parse(ev.dataTransfer.getData("application/x-tnui-paths") || "[]");
    } catch {
      return;
    }
    if (!from.length) return;
    setMoving(true);
    setMoveError(null);
    try {
      const r = await post<{ moved: string[]; failed: Array<{ path: string; error: string }> }>(
        "/api/files/move",
        { from, to: targetDir },
      );
      if (r.failed.length) {
        setMoveError(r.failed.map((f) => `${f.path.split("/").pop()}: ${f.error}`).join(" · "));
      }
      await reload();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  }

  const dragProps = (e: Entry) =>
    canMove
      ? {
          draggable: true,
          onDragStart: (ev: React.DragEvent) => {
            ev.dataTransfer.setData("application/x-tnui-paths", JSON.stringify([e.path]));
            ev.dataTransfer.effectAllowed = "move";
          },
        }
      : {};

  const dropProps = (dir: string) =>
    canMove
      ? {
          onDragOver: (ev: React.DragEvent) => {
            if (!ev.dataTransfer.types.includes("application/x-tnui-paths")) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move" as const;
            setDragOver(dir);
          },
          onDragLeave: () => setDragOver((d) => (d === dir ? null : d)),
          onDrop: (ev: React.DragEvent) => void drop(dir, ev),
        }
      : {};

  // Only previewable files take part in next/previous, so arrowing through a
  // photo folder does not stop dead on a stray .txt.
  const viewable = (data?.entries ?? []).filter((e) => e.kind !== "dir" && e.kind !== "other");
  const images = (data?.entries ?? []).filter((e) => e.kind === "image");

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    return parts.map((p, i) => ({ label: p, path: "/" + parts.slice(0, i + 1).join("/") }));
  }, [path]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = (data?.entries ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
    const dir = (e: Entry) => e.type === "DIRECTORY";
    return [...list].sort((a, b) => {
      // Folders stay above files whichever way the sort points — a listing
      // that interleaves them is harder to scan, not more sorted.
      if (dir(a) !== dir(b)) return dir(a) ? -1 : 1;
      const by =
        sort === "size" ? (a.size ?? 0) - (b.size ?? 0)
        : sort === "kind" ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name, undefined, { numeric: true });
      return desc ? -by : by;
    });
  }, [data, filter, sort, desc]);

  const { busy, error: mkErr, submit, setError: setMkErr } = useSubmit(async () => {
    await post("/api/files/mkdir", { path, name: newName.trim() });
    setCreating(false);
    setNewName("");
    await reload();
  });

  const folders = rows.filter((e) => e.type === "DIRECTORY").length;
  const files = rows.length - folders;
  const heading = (key: SortKey, label: string) => (
    <button
      className={`col-head ${sort === key ? "on" : ""}`}
      onClick={() => { if (sort === key) setDesc((d) => !d); else { setSort(key); setDesc(false); } }}
    >
      {label}{sort === key ? (desc ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My files</h1>
          <div className="page-sub">
            {data
              ? `${folders} folder${folders === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}` +
                (data.space ? ` · ${bytes(data.space.free)} free on ${data.space.source}` : "") +
                (data.canMove ? " · drag items onto a folder to move them" : "")
              : " "}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input style={{ maxWidth: 190 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {images.length > 0 && (
            <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setGallery((g) => !g)}>
              {gallery ? "List" : `Gallery (${images.length})`}
            </button>
          )}
          {canMove && path.split("/").filter(Boolean).length >= 2 && (
            <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setShowBin(true)}>
              Recycle bin
            </button>
          )}
          <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => { setMkErr(null); setCreating(true); }}>
            New folder
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {moveError && <ErrorBanner>{moveError}</ErrorBanner>}
      {moving && <div className="job" style={{ marginBottom: 14 }}><span className="job-label">Moving…</span></div>}

      <Card>
        <div className="file-bar">
          <div className="crumbs">
            <button onClick={() => setPath("/mnt")}>mnt</button>
            {crumbs.slice(1).map((c) => (
              <span key={c.path} style={{ display: "contents" }}>
                <span>/</span>
                <button onClick={() => setPath(c.path)}>{c.label}</button>
              </span>
            ))}
          </div>
          {data?.parent && (
            <button
              className={`btn ${dragOver === data.parent ? "drop-on" : ""}`}
              style={{ flex: "none", padding: "4px 12px" }}
              onClick={() => setPath(data.parent!)}
              {...dropProps(data.parent)}
              title={canMove ? "Drop here to move up a level" : undefined}
            >
              ↑ Up
            </button>
          )}
        </div>

        {loading && !data ? (
          <Loading rows={5} />
        ) : gallery ? (
          <div className="gallery">
            {images.map((e) => (
              <button key={e.path} className="thumb" onClick={() => setPreview(e)} title={e.name}>
                {/* Loaded lazily: a folder can hold hundreds of photos and the
                    NAS would otherwise be asked for all of them at once. */}
                <img src={withConn(`/api/files/content?path=${encodeURIComponent(e.path)}`)} alt={e.name} loading="lazy" />
                <span className="thumb-name">{e.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <div className="file-head">
              {heading("name", "Name")}
              {heading("kind", "Kind")}
              {heading("size", "Size")}
              <span>Mode</span>
            </div>

            {rows.map((e) => {
              const dir = e.type === "DIRECTORY";
              const canOpen = !dir && e.kind !== "other";
              return (
                <div
                  key={e.path}
                  className={`file-row ${dir || canOpen ? "dir" : ""} ${dragOver === e.path ? "drop-on" : ""}`}
                  onClick={() => (dir ? setPath(e.path) : canOpen ? setPreview(e) : undefined)}
                  {...dragProps(e)}
                  {...(dir ? dropProps(e.path) : {})}
                >
                  {dir ? <FolderIcon /> : <KindIcon kind={e.kind} />}
                  <span className="fname">{e.name}</span>
                  {e.isMountpoint && <span className="pill info">dataset</span>}
                  <span className="fkind">{dir ? "folder" : e.kind}</span>
                  <span className="fmeta">{dir ? "—" : bytes(e.size)}</span>
                  {dir && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setPermsFor(e.path); }}
                      title="Who can use this folder"
                    >
                      Access
                    </button>
                  )}
                  {dir && e.isMountpoint && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setSharing(e.path); }}
                      title="Put this folder on the network"
                    >
                      Share
                    </button>
                  )}
                  {canMove && (
                    <button
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setRenaming(e); }}
                    >
                      Rename
                    </button>
                  )}
                  {canMove && (
                    <button
                      className="btn danger"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      onClick={(ev) => { ev.stopPropagation(); setDeleting(e); }}
                      title="Move to the recycle bin"
                    >
                      Delete
                    </button>
                  )}
                  {!dir && (
                    <a
                      className="btn"
                      style={{ flex: "none", padding: "3px 9px", fontSize: 12 }}
                      href={withConn(`/api/files/download?path=${encodeURIComponent(e.path)}`)}
                      onClick={(ev) => ev.stopPropagation()}
                      download
                    >
                      Download
                    </a>
                  )}
                  <span className="fmeta mono" style={{ width: 58, textAlign: "right" }}>
                    {(e.mode & 0o777).toString(8).padStart(3, "0")}
                  </span>
                </div>
              );
            })}

            {!rows.length && (
              <Empty>{filter ? "Nothing here matches that." : "This folder is empty."}</Empty>
            )}
          </div>
        )}
      </Card>

      {preview && (
        <Preview
          entry={preview}
          siblings={viewable}
          onClose={() => setPreview(null)}
          onNavigate={setPreview}
        />
      )}

      {sharing && (
        <ShareFolder
          fixedPath={sharing}
          onClose={() => setSharing(null)}
          onDone={(jobId) => { if (jobId) setPermJobs((j) => [...j, { id: jobId, label: "Applying who can use it" }]); }}
        />
      )}

      {showBin && (
        <RecycleBin path={path} onClose={() => setShowBin(false)} onChanged={() => void reload()} />
      )}

      {deleting && (
        <DangerConfirm
          what={deleting.type === "DIRECTORY" ? "folder" : "file"}
          name={deleting.name}
          verb="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await post<{ binned: string[]; failed: Array<{ error: string }> }>(
              "/api/files/recycle",
              { paths: [deleting.path] },
            );
            if (r.failed.length) throw new Error(r.failed[0].error);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              It moves to the recycle bin on this pool, where it keeps taking up the same space until the bin is
              emptied. You can put it back from there.
            </p>
          }
        />
      )}

      {permsFor && (
        <PermissionsModal
          path={permsFor}
          onClose={() => setPermsFor(null)}
          onJob={(id, label) => setPermJobs((j) => [...j, { id, label }])}
        />
      )}

      {!!permJobs.length && (
        <div className="job-tray">
          {permJobs.map((j) => (
            <JobProgress
              key={j.id}
              jobId={j.id}
              label={j.label}
              onDone={() => setTimeout(() => setPermJobs((all) => all.filter((x) => x.id !== j.id)), 6000)}
            />
          ))}
        </div>
      )}

      {renaming && (
        <RenameEntry
          entry={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => { setRenaming(null); void reload(); }}
        />
      )}

      {creating && (
        <Modal
          title="New folder"
          subtitle={`Inside ${path}`}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" disabled={!newName.trim() || busy} onClick={() => void submit(undefined as void)}>
                {busy ? "Creating…" : "Create"}
              </button>
            </>
          }
        >
          <Field label="Name" hint="No slashes — this creates one folder, here.">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value.replace(/\//g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) void submit(undefined as void); }}
              autoFocus
              placeholder="documents"
            />
          </Field>
          {mkErr && <ErrorBanner>{mkErr}</ErrorBanner>}
        </Modal>
      )}
    </>
  );
}

/**
 * The viewer.
 *
 * One component for every type because the surrounding behaviour — arrow keys,
 * next/previous, escape, download — should not change depending on what is
 * being looked at.
 */
function Preview({ entry, siblings, onClose, onNavigate }: {
  entry: Entry;
  siblings: Entry[];
  onClose: () => void;
  onNavigate: (e: Entry) => void;
}) {
  const idx = siblings.findIndex((s) => s.path === entry.path);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && prev) onNavigate(prev);
      if (e.key === "ArrowRight" && next) onNavigate(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose, onNavigate]);

  const src = withConn(`/api/files/content?path=${encodeURIComponent(entry.path)}`);
  const dl = withConn(`/api/files/download?path=${encodeURIComponent(entry.path)}`);

  return (
    <div className="viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-bar">
        <div style={{ minWidth: 0 }}>
          <div className="viewer-name">{entry.name}</div>
          <div className="viewer-meta">
            {bytes(entry.size)}
            {idx >= 0 && siblings.length > 1 ? ` · ${idx + 1} of ${siblings.length}` : ""}
          </div>
        </div>
        <a className="btn" style={{ flex: "none" }} href={dl} download>Download</a>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="viewer-body" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {prev && <button className="viewer-nav left" onClick={() => onNavigate(prev)} aria-label="Previous">‹</button>}
        <PreviewBody entry={entry} src={src} />
        {next && <button className="viewer-nav right" onClick={() => onNavigate(next)} aria-label="Next">›</button>}
      </div>
    </div>
  );
}

function PreviewBody({ entry, src }: { entry: Entry; src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (entry.kind !== "text") return;
    let alive = true;
    fetch(src, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Could not read it (${r.status}).`);
        return r.text();
      })
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [entry.path, entry.kind, src]);

  if (entry.kind === "image") {
    return <img className="viewer-img" src={src} alt={entry.name} onError={() => setError("This image could not be decoded by the browser.")} />;
  }

  if (entry.kind === "video") {
    // key on the path so switching files reloads the element rather than
    // leaving the previous video playing underneath.
    return (
      <div className="viewer-media">
        <video key={entry.path} className="viewer-video" src={src} controls autoPlay playsInline />
        <p className="viewer-note">
          The file is copied to the console once so that seeking works, since the NAS's own download links cannot
          serve a byte range. Formats the browser cannot decode — MKV with certain codecs, for instance — will show
          controls but no picture; download those instead.
        </p>
      </div>
    );
  }

  if (entry.kind === "audio") {
    return (
      <div className="viewer-media">
        <audio key={entry.path} src={src} controls autoPlay style={{ width: "min(560px, 90vw)" }} />
      </div>
    );
  }

  if (entry.kind === "pdf") {
    return <iframe className="viewer-doc" src={src} title={entry.name} />;
  }

  if (entry.kind === "text") {
    if (error) return <div className="error-banner" style={{ maxWidth: 600 }}>{error}</div>;
    if (text === null) return <div className="viewer-note">Loading…</div>;
    return <pre className="viewer-text">{text}</pre>;
  }

  return <div className="viewer-note">There is no preview for this kind of file. Download it to open it.</div>;
}

function KindIcon({ kind }: { kind: Entry["kind"] }) {
  if (kind === "image") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="m4 17 5-5 4 4 3-2 4 4" />
    </svg>
  );
  if (kind === "video") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9.5 5 2.5-5 2.5z" />
    </svg>
  );
  if (kind === "audio") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M9 18V6l10-2v12" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="16" r="2" />
    </svg>
  );
  if (kind === "pdf") return (
    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" /><path d="M14 3v4h4" /><path d="M9 13h6M9 16.5h4" />
    </svg>
  );
  return <FileIcon />;
}

const FolderIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M3 6h6l2 2h10v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);
const FileIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
    <path d="M14 3v4h4" />
  </svg>
);
