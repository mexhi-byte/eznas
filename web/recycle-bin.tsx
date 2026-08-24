import { useState } from "react";
import { bytes, del, post, put, useResource } from "./api";
import { Empty, ErrorBanner, Loading } from "./components";
import { Modal } from "./ui";

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

  const total = (data?.entries ?? []).reduce((s, e) => s + (e.size ?? 0), 0);

  async function restore(entry: BinEntry) {
    setBusy(entry.path);
    setFailed(null);
    try {
      await put("/api/files/recycle", { path: entry.path });
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
                      <button className="btn" disabled={busy === e.path} onClick={() => void restore(e)}>
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
