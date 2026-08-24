import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP, RFC 6238.
 *
 * Implemented here rather than pulled in: it is forty lines, and an
 * authentication primitive is a poor place to inherit a supply chain.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Check a code, allowing one step either side.
 *
 * The window exists because phone clocks drift and because a code typed at
 * :29 is often submitted at :31. One step each way is the usual compromise
 * between that and handing an attacker extra guesses.
 */
export function verify(secret: string, code: string, window = 1): boolean {
  const cleaned = code.replace(/\D/g, "");
  if (cleaned.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (let drift = -window; drift <= window; drift++) {
    const expected = codeAt(secret, counter + drift);
    // Constant-time even though both are six known-length digits: the habit is
    // cheaper to keep than to remember where it mattered.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans. */
export function provisioningUri(secret: string, label: string, issuer: string): string {
  const l = encodeURIComponent(label);
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${l}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}

/** Single-use codes for when the phone is lost, stored hashed by the caller. */
export function recoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-"),
  );
}
