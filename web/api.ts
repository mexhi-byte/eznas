import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {}

/**
 * Which NAS the console is pointed at.
 *
 * Module-level rather than React context because every fetch needs it,
 * including ones fired from event handlers outside the tree.
 */
let connectionId: string | null = localStorage.getItem("tnui:connection");

export const getConnection = (): string | null => connectionId;
export function setConnection(id: string | null): void {
  connectionId = id;
  if (id) localStorage.setItem("tnui:connection", id);
  else localStorage.removeItem("tnui:connection");
}

/** Append the chosen server to any API path, preserving existing query. */
export function withConn(path: string): string {
  if (!connectionId || path.startsWith("/api/connections")) return path;
  return path + (path.includes("?") ? "&" : "?") + `c=${encodeURIComponent(connectionId)}`;
}

async function request<T>(rawPath: string, init?: RequestInit): Promise<T> {
  const path = withConn(rawPath);
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    // A session that expired while a tab sat open should return the operator to
    // the password prompt, not paint every panel with an error.
    window.dispatchEvent(new Event("tnui:signed-out"));
    throw new ApiError("Not signed in.");
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`);
  return body as T;
}

export const get = <T,>(path: string) => request<T>(path);

const withBody = (method: string) => <T,>(path: string, body?: unknown) =>
  request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const post = withBody("POST");
export const put = withBody("PUT");
export const del = withBody("DELETE");

export interface Job {
  id: number;
  method: string;
  state: "WAITING" | "RUNNING" | "SUCCESS" | "FAILED" | "ABORTED";
  progress: { percent?: number; description?: string };
  error: string | null;
}

/**
 * Follow a long operation to its end.
 *
 * Installing an app or building a pool takes minutes, so the request that
 * starts one returns only an id. Polling here means the button can show real
 * progress and, more importantly, report the NAS's own failure text instead of
 * appearing to have worked.
 */
export function watchJob(jobId: number, onUpdate: (j: Job) => void): () => void {
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const j = await get<Job>(`/api/jobs/${jobId}`);
        onUpdate(j);
        if (["SUCCESS", "FAILED", "ABORTED"].includes(j.state)) return;
      } catch {
        // A transient failure while the NAS is busy is not the job failing.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => { stop = true; };
}

/**
 * Load a resource and keep it fresh.
 *
 * Refreshes are silent: replacing the panel with a spinner every few seconds
 * makes a dashboard unreadable, so only the very first load shows one.
 */
export function useResource<T>(path: string, intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    // An empty path means "not wanted yet" — cards that can show history only
    // fetch it once somebody asks for it.
    if (!path) {
      setLoading(false);
      return;
    }
    try {
      const next = await get<T>(path);
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void reload();
    if (!intervalMs) return () => { alive.current = false; };
    const t = setInterval(() => void reload(), intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}

export interface Realtime {
  cpu?: { cpu?: { usage: number; temp: number | null } } & Record<string, { usage: number; temp: number | null } | undefined>;
  memory?: { physical_memory_total: number; physical_memory_available: number; arc_size: number };
  interfaces?: Record<string, { link_state: string; received_bytes_rate: number; sent_bytes_rate: number }>;
  disks?: { read_bytes: number; write_bytes: number; read_ops: number; write_ops: number; busy: number };
}

const HISTORY = 60;

/**
 * The live feed, plus a minute of history for the sparklines.
 *
 * History is kept here rather than in each chart so that moving between pages
 * does not reset the graphs to a single point.
 */
export function useRealtime() {
  const [now, setNow] = useState<Realtime | null>(null);
  const [live, setLive] = useState(false);
  const history = useRef<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>({
    cpu: [], mem: [], rx: [], tx: [],
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      source = new EventSource(withConn("/api/stream"));
      source.onopen = () => setLive(true);
      source.onmessage = (ev) => {
        const r: Realtime = JSON.parse(ev.data);
        setNow(r);
        const h = history.current;
        const push = (arr: number[], v: number) => {
          arr.push(v);
          if (arr.length > HISTORY) arr.shift();
        };
        push(h.cpu, r.cpu?.cpu?.usage ?? 0);
        const m = r.memory;
        push(h.mem, m ? ((m.physical_memory_total - m.physical_memory_available) / m.physical_memory_total) * 100 : 0);
        const nics = Object.values(r.interfaces ?? {});
        push(h.rx, nics.reduce((s, n) => s + n.received_bytes_rate, 0));
        push(h.tx, nics.reduce((s, n) => s + n.sent_bytes_rate, 0));
      };
      source.onerror = () => {
        setLive(false);
        source?.close();
        // EventSource retries on its own, but not after the server closes the
        // stream cleanly on restart — so the reconnect is explicit.
        retry = setTimeout(open, 3000);
      };
    };

    open();
    return () => {
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);

  return { now, live, history: history.current };
}

/* ------------------------------------------------------------ formatting */

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function rate(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond) return "0 B/s";
  return `${bytes(bytesPerSecond, 1)}/s`;
}

export function duration(seconds: number | string | null | undefined): string {
  if (typeof seconds === "string") return seconds.split(".")[0];
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function when(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Capacity colouring, shared so every bar in the UI agrees on what "full" means. */
export function level(pct: number): "" | "warn" | "bad" {
  if (pct >= 90) return "bad";
  if (pct >= 75) return "warn";
  return "";
}

/* -------------------------------------------------------------- uploading */

export interface UploadHandle {
  promise: Promise<void>;
  abort: () => void;
}

/**
 * Send one file, with progress.
 *
 * XMLHttpRequest rather than fetch, for one reason: fetch cannot report upload
 * progress at all. A bar built on it would advance on a timer and tell the
 * operator something the browser does not actually know — which is worse than
 * no bar, because it looks like information.
 *
 * The file is sent as the raw body. The console's server wraps it in the
 * multipart form the NAS wants; wrapping it here too would nest one multipart
 * body inside another and store the inner headers as file content.
 *
 * The XHR is injectable so this can be tested without a DOM.
 */
export function uploadFile(
  dir: string,
  file: File,
  onProgress: (sent: number, total: number) => void,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): UploadHandle {
  const xhr = xhrFactory();
  const query = `path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`;
  xhr.open("POST", withConn(`/api/files/upload?${query}`));
  xhr.setRequestHeader("content-type", "application/octet-stream");

  const promise = new Promise<void>((resolve, reject) => {
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText || "{}") as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // A proxy's HTML error page, not the console's JSON. The status is all
        // there is to say.
      }
      reject(new ApiError(message));
    };
    xhr.onerror = () => reject(new ApiError("The connection to the console dropped."));
    xhr.onabort = () => reject(new ApiError("Upload cancelled."));
  });

  // Sent only once the handlers are attached: an XHR that finished in between
  // would fire into nothing and the promise would never settle.
  xhr.send(file);

  return { promise, abort: () => xhr.abort() };
}

/* -------------------------------------------------------------- searching */

export interface SearchHit { path: string; name: string; dir: string }

export interface SearchHandlers {
  hit: (h: SearchHit) => void;
  done: (r: { count: number; truncated: boolean }) => void;
  failed: (message: string) => void;
}

/**
 * Start a search. Returns the function that stops it.
 *
 * EventSource, like the live figures on Home: the server sends hits as it
 * finds them, so a result near the top of the tree appears at once instead of
 * after the whole pool has been walked.
 */
export function searchFiles(root: string, query: string, on: SearchHandlers): () => void {
  const url = withConn(
    `/api/files/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`,
  );
  const source = new EventSource(url);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("hit", (e) => on.hit(JSON.parse((e as MessageEvent).data) as SearchHit));
  source.addEventListener("done", (e) => {
    on.done(JSON.parse((e as MessageEvent).data) as { count: number; truncated: boolean });
    // The server has said its piece. Without closing, EventSource sees the
    // stream end, decides it dropped, and reconnects — running the whole
    // search a second time.
    close();
  });
  source.addEventListener("failed", (e) => {
    on.failed((JSON.parse((e as MessageEvent).data) as { error: string }).error);
    close();
  });
  source.onerror = () => {
    // Fires on a clean close too, so it must not report a failure after done
    // has already been delivered.
    if (closed) return;
    on.failed("The search connection dropped.");
    close();
  };

  return close;
}
