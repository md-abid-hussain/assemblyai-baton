import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { EnvError } from "../env";

/**
 * Connector-secret encryption at rest (PLATFORM §6.4): AES-256-GCM, a random 12-byte IV per secret, a 16-byte tag.
 *
 * Keys (a small keyring, so both can coexist during a switch):
 * - version 1: `HKDF-SHA256(ikm = AGENT_TOOL_SECRET, salt = "changeover", info = "connector-secrets/v1")`, 32 bytes.
 *   The Q7 default: no new GUI step. Rotating `AGENT_TOOL_SECRET` makes the old rows undecryptable, which is
 *   acceptable because every secret expires after 7 days anyway (they then read as missing, never as garbage).
 * - version 2: `CONNECTOR_SECRETS_KEY` (32 random bytes, base64) when it is set; new secrets use it.
 *
 * The AAD binds a ciphertext to its workspace and name, so a row copied to another workspace or name fails the
 * GCM check. Key material and plaintexts are never logged or returned.
 */

export const SECRET_HKDF_SALT = "changeover";
export const SECRET_HKDF_INFO = "connector-secrets/v1";
export const KEY_VERSION_DERIVED = 1;
export const KEY_VERSION_EXPLICIT = 2;

export interface SecretKeyring {
  /** The version new secrets are sealed with. */
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function deriveSecretsKey(agentToolSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(agentToolSecret, "utf8"), SECRET_HKDF_SALT, SECRET_HKDF_INFO, 32));
}

/**
 * The keyring from an env-like record (defaults to `process.env`). Throws `EnvError` (names only) when neither
 * `AGENT_TOOL_SECRET` nor `CONNECTOR_SECRETS_KEY` is set, or when `CONNECTOR_SECRETS_KEY` is not 32 base64 bytes.
 */
export function secretKeyringFromEnv(src: Record<string, string | undefined> = process.env): SecretKeyring {
  const keys = new Map<number, Buffer>();
  const ikm = src.AGENT_TOOL_SECRET?.trim();
  if (ikm) keys.set(KEY_VERSION_DERIVED, deriveSecretsKey(ikm));
  const explicit = src.CONNECTOR_SECRETS_KEY?.trim();
  if (explicit) {
    const k = /^[A-Za-z0-9+/_-]+={0,2}$/.test(explicit) ? Buffer.from(explicit, "base64") : Buffer.alloc(0);
    if (k.length !== 32) throw new EnvError([], ["CONNECTOR_SECRETS_KEY (expected 32 bytes, base64)"]);
    keys.set(KEY_VERSION_EXPLICIT, k);
  }
  if (keys.size === 0) throw new EnvError(["AGENT_TOOL_SECRET"], []);
  return { current: keys.has(KEY_VERSION_EXPLICIT) ? KEY_VERSION_EXPLICIT : KEY_VERSION_DERIVED, keys };
}

export function secretAad(workspaceId: string, name: string): Buffer {
  return Buffer.from(`changeover-secret/v1|${workspaceId}|${name}`, "utf8");
}

export function sealSecret(ring: SecretKeyring, plaintext: string, aad: Buffer): SealedSecret {
  const key = ring.keys.get(ring.current);
  if (!key) throw new Error("secret keyring has no current key");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag(), keyVersion: ring.current };
}

/** Decrypt, or null when the key version is gone or the GCM check fails (rotated key, tampered row). */
export function openSecret(ring: SecretKeyring, sealed: SealedSecret, aad: Buffer): string | null {
  const key = ring.keys.get(sealed.keyVersion);
  if (!key || sealed.iv.length !== 12 || sealed.tag.length !== 16) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, sealed.iv);
    d.setAAD(aad);
    d.setAuthTag(sealed.tag);
    return Buffer.concat([d.update(sealed.ciphertext), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
