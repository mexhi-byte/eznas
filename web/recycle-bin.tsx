import { useState } from "react";
import { bytes, del, post, put, useResource } from "./api";
import { Empty, ErrorBanner, Loading } from "./components";
import { Field, Input, Modal, Select } from "./ui";

interface BinEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  /** Where it will go back to. */
  original: string;
  from: string;
}

/**
 * What has been deleted from this pool, and how to undo it.
 *
 * The bin lives at the root of the pool the item came from, because moving a
 * file between pools copies every byte of it — a bin somewhere else would make
 * deleting a large file take minutes and briefly need the space twice.
 */
export function RecycleBin({ path, onClose, onChanged }: {
  path: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useResource<{ bin: string | null; entries: BinEntry[] }>(
    `/api/files/recycle?path=${encodeURIComponent(path)}`,
    0,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState<BinEntry | null>(null);

  const total = (data?.entries ?? []).reduce((s, e) => s + (e.size ?? 0), 0);

  async function restore(entry: BinEntry, where?: { toDir?: string; name?: string }) {
    setBusy(entry.path);
    setFailed(null);
    try {
      await put("/api/files/recycle", { path: entry.path, ...where });
      setRestoring(null);
      await reload();
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function empty() {
    setBusy("empty");
    setFailed(null);
    try {
      await del("/api/files/recycle", { path, confirm: data?.bin });
      setEmptying(false);
      setConfirmText("");
      await reload();
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Recycle bin"
      subtitle={data?.bin ? `${data.bin} · ${bytes(total)} still taking up space` : "Nothing deleted from this pool yet."}
      onClose={onClose}
      wide
      footer={
        <>
          {!!data?.entries.length && (
            <button
              className="btn danger"
              style={{ marginRight: "auto", flex: "none" }}
              onClick={() => setEmptying(true)}
              disabled={!!busy}
            >
              Empty the bin
            </button>
          )}
          <button className="btn primary" onClick={onClose}>Close</button>
        </>
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={3} />}

      {data && !data.entries.length && (
        <Empty>The bin is empty. Deleted files land here and stay until you empty it.</Empty>
      )}

      {!!data?.entries.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Came from</th><th className="num">Size</th><th style={{ width: 110 }} /></tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.path}>
                  <td>
                    {e.name}
                    {e.type === "DIRECTORY" && <span className="pill mute" style={{ marginLeft: 8 }}>folder</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{e.from}</td>
                  <td className="num">{e.type === "DIRECTORY" ? "—" : bytes(e.size)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn" disabled={busy === e.path} onClick={() => setRestoring(e)}>
                        {busy === e.path ? "…" : "Put back"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="modal-text">
        Items in the bin still use the pool's space. Emptying it is the only step here that cannot be undone.
      </p>

      {restoring && (
        <RestoreTo
          entry={restoring}
          busy={busy === restoring.path}
          onCancel={() => setRestoring(null)}
          onRestore={(where) => void restore(restoring, where)}
        />
      )}

      {emptying && (
        <Modal
          title="Empty the bin"
          subtitle="This cannot be undone."
          onClose={() => setEmptying(false)}
          footer={
            <>
              <button className="btn" onClick={() => setEmptying(false)}>Cancel</button>
              <button
                className="btn danger-solid"
                disabled={confirmText !== data?.bin || busy === "empty"}
                onClick={() => void empty()}
              >
                {busy === "empty" ? "Emptying…" : "Empty"}
              </button>
            </>
          }
        >
          <p className="modal-text">
            {data?.entries.length} item{data?.entries.length === 1 ? "" : "s"} — {bytes(total)} — are destroyed for
            good. Type <strong className="mono">{data?.bin}</strong> to confirm.
          </p>
          <input
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={data?.bin ?? ""}
            autoFocus
          />
        </Modal>
      )}
    </Modal>
  );
}

/**
 * Where to put it back.
 *
 * "Put back" used to mean exactly one thing, which is the right default and a
 * poor rule: the folder it came from may be gone, its name may since have been
 * taken by something else, and the reason it was deleted may have been that it
 * was in the wrong place to begin with.
 *
 * The original location stays the first option and the preselected one, so the
 * common case is still one click.
 */
function RestoreTo({ entry, busy, onCancel, onRestore }: {
  entry: BinEntry;
  busy: boolean;
  onCancel: () => void;
  onRestore: (where?: { toDir?: string; name?: string }) => void;
}) {
  type Choice = "original" | "rename" | "elsewhere";
  const [choice, setChoice] = useState<Choice>("original");
  const cut = entry.original.lastIndexOf("/");
  const originalDir = entry.original.slice(0, cut);
  const originalName = entry.original.slice(cut + 1);
  const [name, setName] = useState(originalName);
  const [dir, setDir] = useState(originalDir);

  const ready =
    choice === "original" ||
    (choice === "rename" && !!name.trim()) ||
    (choice === "elsewhere" && dir.trim().startsWith("/mnt/"));

  return (
    <Modal
      title={`Put back ${entry.name}`}
      subtitle={entry.type === "DIRECTORY" ? "A folder, and everything in it." : undefined}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !ready}
            onClick={() =>
              onRestore(
                choice === "original" ? undefined
                  : choice === "rename" ? { name: name.trim() }
                  : { toDir: dir.trim() },
              )
            }
          >
            {busy ? "Putting back…" : "Put it back"}
          </button>
        </>
      }
    >
      <Field label="Where">
        <Select value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
          <option value="original">Back where it came from</option>
          <option value="rename">Back where it came from, under a new name</option>
          <option value="elsewhere">Into a different folder</option>
        </Select>
      </Field>

      {choice === "original" && (
        <p className="modal-text">
          It goes back to <strong className="mono">{entry.original}</strong>.{" "}
          {/* The move script never overwrites — it dates the newcomer instead.
              Saying so is kinder than letting somebody find a surprise. */}
          If something with that name is already there, this one is put beside it with the date added rather than
          replacing it.
        </p>
      )}

      {choice === "rename" && (
        <Field label="New name" hint={`It still goes into ${originalDir}.`}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      )}

      {choice === "elsewhere" && (
        <Field label="Folder" hint="A full path under /mnt — for example /mnt/tank/sorted.">
          <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/mnt/tank/somewhere" autoFocus />
          {!dir.trim().startsWith("/mnt/") && (
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              Has to be a full path starting with /mnt/.
            </p>
          )}
          <p className="modal-text">
            The folder has to exist already. It keeps the name <strong className="mono">{originalName}</strong>.
          </p>
        </Field>
      )}
    </Modal>
  );
}
