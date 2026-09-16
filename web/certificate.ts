/** What the server saw when it looked at a NAS's certificate. */
export interface SeenCertificate {
  fingerprint: string;
  subject: string | null;
  issuer: string | null;
  validTo: string | null;
  selfSigned: boolean;
}

/** Colon-separated pairs, upper-case: the shape TrueNAS's own UI prints, so the two can be compared by eye. */
export const prettyFingerprint = (hex: string): string =>
  hex
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase()
    .replace(/(..)(?=.)/g, "$1:");

/** One line a person can read: who it is for and how long it is good. */
export function describeCertificate(c: SeenCertificate): string {
  const who = c.subject ? `for ${c.subject}` : "with no name in it";
  const by = c.selfSigned ? "self-signed" : c.issuer ? `signed by ${c.issuer}` : "signed by an unknown issuer";
  const until = c.validTo ? `, valid until ${new Date(c.validTo).toLocaleDateString()}` : "";
  return `A ${by} certificate ${who}${until}.`;
}
