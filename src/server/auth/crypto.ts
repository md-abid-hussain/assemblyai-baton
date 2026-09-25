import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Small crypto helpers for the auth primitives (DESIGN §4.3). `src/proxy.ts` uses these too: the proxy runs on the
 * Node.js runtime in Next 16 and its bundling layer ("middleware") resolves `server-only` to the empty module.
 */

/** HMAC-SHA256 as base64url (no padding). */
export function hmacB64url(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the comparison time does not depend on where
 * the strings differ or on their lengths.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
