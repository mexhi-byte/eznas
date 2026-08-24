import WebSocket from "ws";
import { createHash } from "node:crypto";
import type { PeerCertificate } from "node:tls";

/**
 * A client for the TrueNAS JSON-RPC 2.0 API.
 *
 * Deliberately *not* the REST API at /api/v2.0. That interface is deprecated in
 * 25.04 and removed outright in 25.10 (Goldeye), so a dashboard built on it
 * would stop working the day the NAS is upgraded. /api/current is the
 * replacement and is the only interface that carries push events, which is what
 * makes live statistics possible without polling the box once a second.
 *
 * One socket is shared by every browser session. The NAS counts sessions, and
 * opening one per viewer would both waste them and multiply the realtime
 * subscription by the number of open tabs.
 */

export interface Realtime {
  cpu?: { cpu?: { usage: number; temp: number | null }; [core: string]: unknown };
  memory?: {
    physical_memory_total: number;
    physical_memory_available: number;
    arc_size: number;
  };
  interfaces?: Record<string, { link_state: string; received_bytes_rate: number; sent_bytes_rate: number }>;
  disks?: { read_bytes: number; write_bytes: number; read_ops: number; write_ops: number; busy: number };
  zfs?: Record<string, number>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export interface JobState {
  id: number;
  method: string;
  state: "WAITING" | "RUNNING" | "SUCCESS" | "FAILED" | "ABORTED";
  progress: { percent?: number; description?: string };
  error: string | null;
  result: unknown;
}

export class TrueNas {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private backoff = 1000;
  private closed = false;

  /**
   * Which methods return a job id instead of a result.
   *
   * Taken from the NAS's own method metadata rather than a hand-written list:
   * pool.create, app.upgrade and friends are jobs, and treating one as an
   * ordinary call silently "succeeds" with a job number as its result while the
   * real work fails minutes later, unwatched.
   */
  private jobMethods = new Set<string>();

  /** Latest push from the NAS, served to browsers as-is. */
  realtime: Realtime | null = null;
  /** Set when the socket is authenticated and usable. */
  connected = false;
  lastError: string | null = null;
  /** A failure retrying cannot fix — a wrong key, a wrong certificate. */
  private fatal = false;

  private listeners = new Set<(r: Realtime) => void>();

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    /**
     * Optional SHA-256 fingerprint of the NAS certificate.
     *
     * TrueNAS ships a self-signed certificate, so ordinary verification cannot
     * work. Pinning is the honest alternative: without it this connection
     * carries a full-privilege API key over a link nothing has authenticated.
     */
    private readonly fingerprint?: string,
  ) {
    this.connect();
  }

  onRealtime(fn: (r: Realtime) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private connect(): void {
    if (this.closed) return;

    const ws = new WebSocket(this.url, {
      rejectUnauthorized: false,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("upgrade", (res) => {
      if (!this.fingerprint) return;
      // The certificate is only available once the TLS handshake has produced
      // a peer certificate; checking earlier compares against an empty object.
      const socket = res.socket as unknown as { getPeerX509Certificate?: () => { fingerprint256?: string } | undefined; getPeerCertificate?: () => PeerCertificate };
      const x509 = socket.getPeerX509Certificate?.();
      const raw = x509?.fingerprint256 ?? socket.getPeerCertificate?.()?.fingerprint256;
      const seen = (raw ?? "").replace(/:/g, "").toLowerCase();
      const want = this.fingerprint.replace(/:/g, "").toLowerCase();
      if (seen !== want) {
        // Say so loudly. The NAS renews its own certificate, and when it does,
        // a silent reconnect loop looks exactly like the NAS being down —
        // sending whoever debugs it to the wrong machine entirely.
        this.lastError =
          `the NAS certificate does not match TRUENAS_FINGERPRINT. ` +
          `Presented ${seen || "(none)"}, expected ${want}. ` +
          `If the certificate was renewed, update the pin; if it was not, do not trust this connection.`;
        console.error(`[truenas] ${this.lastError}`);
        // Retrying cannot help: the certificate will not change between
        // attempts, so callers should be told now rather than after the wait.
        this.fatal = true;
        ws.terminate();
      }
    });

    ws.on("open", async () => {
      try {
        const ok = await this.rpc("auth.login_with_api_key", [this.apiKey]);
        if (ok !== true) throw new Error("the API key was rejected");
        await this.rpc("core.subscribe", ["reporting.realtime"]);

        // Ready as soon as it can answer. The method catalogue is ~770 entries
        // with full schemas and takes seconds to transfer; leaving it on the
        // critical path made a perfectly good connection report itself as
        // unreachable to anything that asked in the meantime.
        this.connected = true;
        this.lastError = null;
        this.fatal = false;
        this.backoff = 1000;
        console.log("[truenas] connected and subscribed");

        void this.rpc("core.get_methods")
          .then((m) => {
            const methods = m as Record<string, { job?: boolean }>;
            this.jobMethods = new Set(Object.entries(methods).filter(([, x]) => x?.job).map(([name]) => name));
          })
          .catch(() => {
            // Only used to describe a method as long-running; the routes that
            // start jobs already know which ones they are.
          });
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.fatal = /rejected|fingerprint/i.test(this.lastError);
        console.error("[truenas] login failed:", this.lastError);
        ws.close();
      }
    });

    ws.on("message", (raw) => this.dispatch(raw.toString()));

    ws.on("close", () => {
      this.connected = false;
      // Every in-flight call is now unanswerable. Failing them immediately is
      // better than letting each one sit until its own timeout: the caller
      // gets a real error while the reconnect is already under way.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("connection to the NAS dropped"));
        this.pending.delete(id);
      }
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });

    ws.on("error", (e) => {
      // Terminating the socket ourselves raises a generic "closed before the
      // connection was established" here. Letting it through would replace the
      // specific reason — a pin mismatch, a rejected key — with noise.
      if (!this.fatal) this.lastError = e.message;
    });
  }

  private dispatch(text: string): void {
    let msg: { id?: number; result?: unknown; error?: unknown; method?: string; params?: { collection?: string; fields?: Realtime } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { message?: string; data?: { reason?: string } };
        p.reject(new Error(e.data?.reason ?? e.message ?? JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (msg.params?.collection === "reporting.realtime" && msg.params.fields) {
      this.realtime = msg.params.fields;
      for (const fn of this.listeners) fn(msg.params.fields);
    }
  }

  private rpc(method: string, params: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected to the NAS"));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /**
   * Call a method, waiting for the connection rather than failing outright.
   *
   * The budget covers a cold start — TCP, TLS, login — which a request arriving
   * just after a restart has to sit through. A failure the socket already knows
   * about (a rejected key, a bad certificate pin) breaks out immediately
   * instead of burning the whole wait on a connection that will never come up.
   */
  async call<T>(method: string, params: unknown[] = [], budgetMs = 12_000): Promise<T> {
    const deadline = Date.now() + budgetMs;
    while (!this.connected) {
      if (this.closed) throw new Error("this connection has been closed");
      if (this.fatal) throw new Error(this.lastError ?? "the NAS refused this connection");
      if (Date.now() > deadline) throw new Error(this.lastError ?? "the NAS is not reachable");
      await new Promise((r) => setTimeout(r, 200));
    }
    return (await this.rpc(method, params)) as T;
  }

  isJob(method: string): boolean {
    return this.jobMethods.has(method);
  }

  /**
   * Start a long operation and hand back its job id.
   *
   * Deliberately does not wait. Installing an app or creating a pool runs for
   * minutes, and holding an HTTP request open that long means the browser gives
   * up on work that is actually progressing fine — so the caller polls
   * jobStatus() and the UI can show a percentage instead of a spinner.
   */
  async startJob(method: string, params: unknown[] = []): Promise<number> {
    const id = await this.call<number>(method, params);
    if (typeof id !== "number") throw new Error(`${method} did not return a job id`);
    return id;
  }

  async jobStatus(jobId: number): Promise<JobState> {
    const rows = await this.call<Array<Record<string, unknown>>>("core.get_jobs", [[["id", "=", jobId]]]);
    const j = rows[0];
    if (!j) throw new Error(`job ${jobId} is not known to the NAS`);
    const err = j.error as string | null;
    return {
      id: jobId,
      method: String(j.method ?? ""),
      state: String(j.state ?? "WAITING") as JobState["state"],
      progress: (j.progress as JobState["progress"]) ?? {},
      // exc_info carries the useful detail when error is just a class name.
      error: err ? String(err) : null,
      result: j.result ?? null,
    };
  }

  /**
   * Start a job and wait for it to land.
   *
   * The opposite trade-off to startJob, for the short ones. Chowning a folder
   * finishes in well under a second, and a caller that has to run a second job
   * straight afterwards cannot simply fire both: they race on the same path,
   * and a failure in the first is invisible. Anything that might run for
   * minutes should still use startJob and let the browser poll.
   */
  async runJob(method: string, params: unknown[] = [], timeoutMs = 60_000): Promise<JobState> {
    const id = await this.startJob(method, params);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.jobStatus(id);
      if (status.state === "SUCCESS") return status;
      if (status.state === "FAILED" || status.state === "ABORTED") {
        throw new Error(status.error ?? `${method} failed`);
      }
      if (Date.now() > deadline) throw new Error(`${method} did not finish in time`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/** Fingerprint helper for first-time setup, so the pin does not have to be guessed. */
export function fingerprintOf(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}
