import { connect } from "node:tls";

/**
 * What certificate a NAS presents, so the console can offer to pin it.
 *
 * TrueNAS ships a self-signed certificate, which means ordinary verification
 * is impossible and pinning is the only way this connection can ever be
 * authenticated. The pin used to be a hex string the operator had to find and
 * paste by hand, and so in practice nobody set one: every API key travelled
 * over a link nothing had checked. Trust-on-first-use is the fix — look once,
 * show what was seen, remember it — and this is the "look once".
 *
 * A plain TLS connection rather than the WebSocket client, because that
 * client needs an API key to be useful and this has to work before the
 * operator has one.
 */

export interface SeenCertificate {
  /** SHA-256 over the DER certificate, lower-case hex, no colons. */
  fingerprint: string;
  /** Who the certificate says it is for — "truenas.local", or nothing useful. */
  subject: string | null;
  /** Who signed it. For TrueNAS's own certificate this is TrueNAS itself. */
  issuer: string | null;
  /** ISO date the certificate stops being valid. */
  validTo: string | null;
  /** True when the issuer is the subject, which is what "self-signed" means. */
  selfSigned: boolean;
}

/** Host and port of a NAS URL as the console stores it: wss://host[:port]/api/current. */
export function hostPortOf(url: string): { host: string; port: number } {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  return { host: u.hostname, port: u.port ? Number(u.port) : secure ? 443 : 80 };
}

/** "AB:CD:..." or "abcd..." to the one shape the console compares. */
export const normaliseFingerprint = (raw: string): string => raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();

/** Pairs, for a person reading it off one screen and comparing with another. */
export const prettyFingerprint = (hex: string): string =>
  normaliseFingerprint(hex)
    .toUpperCase()
    .replace(/(..)(?=.)/g, "$1:");

export async function probeCertificate(url: string, timeoutMs = 5_000): Promise<SeenCertificate> {
  const { host, port } = hostPortOf(url);
  return await new Promise<SeenCertificate>((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    socket.on("timeout", () => fail(new Error(`${host}:${port} did not answer within ${timeoutMs / 1000} seconds.`)));
    socket.on("error", (e) => fail(new Error(`Could not reach ${host}:${port}: ${e.message}`)));
    socket.on("secureConnect", () => {
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert) {
        reject(new Error(`${host}:${port} answered but presented no certificate.`));
        return;
      }
      const cn = (dn: string | undefined) => dn?.match(/(?:^|\n)CN=([^\n]+)/)?.[1] ?? null;
      const subject = cn(cert.subject);
      const issuer = cn(cert.issuer);
      resolve({
        fingerprint: normaliseFingerprint(cert.fingerprint256),
        subject,
        issuer,
        validTo: cert.validTo ? new Date(cert.validTo).toISOString() : null,
        selfSigned: cert.subject === cert.issuer,
      });
    });
  });
}
