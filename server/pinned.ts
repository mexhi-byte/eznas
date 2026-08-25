import { connect, type TLSSocket } from "node:tls";
import type { Connection } from "./store.js";

/**
 * A TLS connection to the NAS that is checked before anything is sent down it.
 *
 * The order matters more than it looks. TrueNAS uses a self-signed
 * certificate, so ordinary CA verification cannot pass and the console pins a
 * fingerprint per server instead. But a pin only protects what is sent *after*
 * it is checked, and the obvious place to check — the response callback of an
 * https.request — runs after the request headers and the entire body have
 * already gone out. A machine in the middle would collect the auth token and
 * the file, and only then be told its certificate was wrong.
 *
 * So the socket is opened on its own, verified while it is still idle, and
 * only handed to the HTTP layer once it is known to be the right peer.
 */

const norm = (s: string): string => s.replace(/:/g, "").toLowerCase();

/** Whether a certificate fingerprint is the pinned one. Colons and case vary. */
export function fingerprintMatches(seen: string | undefined, want: string): boolean {
  if (!seen || !want) return false;
  return norm(seen) === norm(want);
}

export function httpBase(conn: Connection): URL {
  return new URL(conn.url.replace(/^ws/, "http").replace(/\/api\/current$/, ""));
}

/**
 * Open a verified connection, or fail having sent nothing.
 *
 * A server with no pin saved connects unverified — that is the documented
 * state of an unpinned server, and refusing here would break every install
 * that has not set one. What must not happen is a pin that is checked too
 * late to mean anything.
 */
export function connectPinned(conn: Connection, timeoutMs = 30_000): Promise<TLSSocket> {
  const base = httpBase(conn);
  const port = Number(base.port || (base.protocol === "https:" ? 443 : 80));

  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect(
      {
        host: base.hostname,
        port,
        servername: base.hostname,
        // Verification is by fingerprint below, not by CA — see the comment at
        // the top of this file. The check is the next thing that happens.
        rejectUnauthorized: false,
      },
      () => {
        clearTimeout(timer);
        if (!conn.fingerprint) {
          resolve(socket);
          return;
        }
        const seen =
          socket.getPeerX509Certificate?.()?.fingerprint256 ??
          socket.getPeerCertificate?.()?.fingerprint256;
        if (!seen) {
          socket.destroy();
          reject(new Error("could not read the NAS certificate to check it against the pin"));
          return;
        }
        if (!fingerprintMatches(seen, conn.fingerprint)) {
          socket.destroy();
          reject(new Error(`the NAS certificate does not match the pin (saw ${norm(seen).slice(0, 16)}…)`));
          return;
        }
        resolve(socket);
      },
    );

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the NAS took too long to answer"));
    }, timeoutMs);

    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not reach the NAS: ${e.message}`));
    });
  });
}
