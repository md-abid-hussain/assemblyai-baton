import "server-only";

import type { CallManifestEntry } from "../../core/contracts/scenario";

/**
 * Call-manifest lookup for the platform routes (#5 needs the call's audio format for the streaming params; #5a needs
 * its duration, Express start, handoff line and recorded AI bundle).
 *
 * The manifest is `src/generated/calls.json` (WP9, from G0); WP3 loads it for route #3. A static import of a file
 * that may not exist yet would break `next build`, so the lookup is registered instead.
 * [WIRE-CALLS] G1 (integrator): `registerCallLookup((id) => calls.find((c) => c.callId === id) ?? null)` from the
 * module that imports the generated manifest (e.g. WP3's src/server/data loader), imported once at boot.
 * Until then routes fall back to `null` (defaults below).
 */

export type CallLookup = (callId: string) => CallManifestEntry | null | Promise<CallManifestEntry | null>;

const g = globalThis as typeof globalThis & { __batonCallLookup?: CallLookup | null };

export function registerCallLookup(fn: CallLookup | null): void {
  g.__batonCallLookup = fn;
}

export async function getCallEntry(callId: string | null | undefined): Promise<CallManifestEntry | null> {
  if (!callId || !g.__batonCallLookup) return null;
  try {
    return (await g.__batonCallLookup(callId)) ?? null;
  } catch {
    return null;
  }
}

/** When the manifest is unknown: a 5-minute call. */
export const DEFAULT_CALL_DURATION_MS = 5 * 60_000;
/** Express starts 25 s before the decision point (§5.1.6). */
export const EXPRESS_LEAD_MS = 25_000;
