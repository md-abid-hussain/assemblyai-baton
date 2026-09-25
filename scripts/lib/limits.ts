/**
 * limits.ts - `getLimitsAuthority()` for Node scripts and live tests (DESIGN §2.3, TASKS §0.5).
 *
 *   LIMITS_AUTHORITY_URL unset            → the laptop file guard (scripts/lib/local-open-guard.ts)
 *   LIMITS_ROLE=remote + URL + KEY        → WP2's RemoteLimitsAuthority against the Zerops app (scripts/lib/remote.ts, G1)
 *
 * The repo `.env` is loaded first (shell values win), so a URL set only in `.env` is honoured.
 * Tests and harnesses can inject an authority with `setLimitsAuthority()`.
 */
import type { GetLimitsAuthority, LimitsAuthority } from "../../src/core/contracts/services";
import { loadEnv } from "./load-env";
import { getLocalOpenGuard } from "./local-open-guard";
import { createRemoteLimitsAuthority } from "./remote";

let injected: LimitsAuthority | null = null;

/** Override the authority for this process (tests, fake-upstream harnesses). Pass null to restore. */
export function setLimitsAuthority(a: LimitsAuthority | null): void {
  injected = a;
}

/**
 * Remote client factory: WP2's `RemoteLimitsAuthority` with the split-budget fallback (`./remote`, registered at
 * G1). `registerRemoteAuthorityFactory` stays as a seam for harnesses that need a different client.
 */
let remoteFactory: (url: string, key: string) => LimitsAuthority = createRemoteLimitsAuthority;
let remoteCache: { url: string; key: string; authority: LimitsAuthority } | null = null;
export function registerRemoteAuthorityFactory(f: (url: string, key: string) => LimitsAuthority): void {
  remoteFactory = f;
  remoteCache = null;
}

export const getLimitsAuthority: GetLimitsAuthority = () => {
  if (injected) return injected;
  loadEnv();
  const url = process.env.LIMITS_AUTHORITY_URL?.trim();
  if (!url) return getLocalOpenGuard();
  const key = process.env.LIMITS_AUTHORITY_KEY?.trim();
  if (!key) throw new Error("[limits] LIMITS_AUTHORITY_URL is set but LIMITS_AUTHORITY_KEY is missing (value never printed)");
  if (remoteCache?.url !== url || remoteCache.key !== key) remoteCache = { url, key, authority: remoteFactory(url, key) };
  return remoteCache.authority;
};
