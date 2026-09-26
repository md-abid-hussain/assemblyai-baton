import "server-only";

/**
 * server/publish/keys.ts - the publication key (PLATFORM §6.6, §8.1 step 3).
 *
 * Every published HTTP tool carries `X-Changeover-Key: <32 random bytes, hex>`. We store ONLY `sha256(key)` in
 * `relay_publications.key_hash`: the value lives in the stored agent (where `GET /v1/agents/{id}` omits it, C21) and
 * in nothing of ours. The key is never logged, never returned by a route and never part of `configRedacted`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes as 64 hex characters. */
export const newPublicationKey = (): string => randomBytes(32).toString("hex");

export const hashPublicationKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/**
 * Constant-time compare of `sha256(presented)` against the stored hash. Hashing first makes the comparison
 * fixed-length, so a wrong-length header cannot be distinguished by timing either.
 */
export function publicationKeyMatches(presented: string | null | undefined, keyHash: string): boolean {
  if (!presented || !keyHash) return false;
  const a = Buffer.from(hashPublicationKey(presented), "hex");
  const b = Buffer.from(keyHash, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** A short, URL-safe share slug: `<relay slug>-<6 chars>` (`/a/<slug>`), stable across republishes. */
export function shareSlugFor(relaySlug: string, rand: string): string {
  const base = relaySlug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "relay";
  return `${base}-${rand}`;
}
