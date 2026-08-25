import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The key that stored TrueNAS credentials are encrypted with.
 *
 * This used to fall back to a fixed string in the source when SESSION_SECRET
 * was unset. That is protection by obscurity, and it stops being protection at
 * all the moment the source is public: an API key for TrueNAS is equivalent to
 * root on the NAS, and a stored sudo password is exactly what it sounds like,
 * so a connections.json obtained from a backup or a misconfigured share could
 * be decrypted with a constant anyone can read in the repository.
 *
 * So there is no constant to fall back to any more. An operator who sets
 * SESSION_SECRET gets what they set; anyone else gets a random one, generated
 * once and kept, which is as good and requires nothing of them.
 */

/**
 * The old fallback, kept for one purpose: reading data written under it.
 *
 * Removing it outright would leave anyone who ever ran without SESSION_SECRET
 * with a file of credentials nothing can decrypt — their console would come
 * back up unable to reach their NAS, with no way to find out why. It is never
 * used to encrypt.
 */
export const LEGACY_DEV_SECRET = "truenas-ui-development-only";

export interface ResolvedSecret {
  secret: string;
  source: "environment" | "file" | "generated";
}

/** A 32-byte key, which is what aes-256-gcm takes. */
export function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * The secret to use, in order of preference: what the operator set, what was
 * generated last time, or a new one.
 *
 * The generated one is written beside the data it protects with mode 0600. It
 * is deliberately a separate file rather than a line inside connections.json:
 * a key stored in the thing it encrypts protects nothing, and keeping them
 * apart means a copied data file is not also a copied key.
 */
export function resolveSecret(fromEnv: string | undefined, path: string): ResolvedSecret {
  const supplied = fromEnv?.trim();
  if (supplied) return { secret: supplied, source: "environment" };

  if (existsSync(path)) {
    const kept = readFileSync(path, "utf8").trim();
    if (kept) return { secret: kept, source: "file" };
  }

  const made = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${made}\n`, { mode: 0o600 });
  return { secret: made, source: "generated" };
}
