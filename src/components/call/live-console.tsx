"use client";
/**
 * LiveConsole: `/call/[callId]` for a real Baton run — `RelayConsole` in `mode="flagship"`.
 *
 * Everything the page needs is in RelayConsole now (PLATFORM §7.6): the orchestrator over the real WP4 / WP5 / WP5b /
 * WP6 controllers, the MockPhone mount, Express as the default start, and the run's provenance strip. This wrapper
 * keeps the flagship's own entry point (and its props) stable for `/call` and its tests.
 */
import type { CallManifestEntry } from "@/core/contracts/scenario";

import { RelayConsole } from "./relay-console";

export function LiveConsole({
  callId,
  call,
  autoStart = null,
  callProvenance = null,
}: {
  callId: string;
  call: CallManifestEntry | null;
  autoStart?: "express" | null;
  /** `src/generated/call-provenance.json` for this call, read on the server by the page. */
  callProvenance?: { humanHalf: "recorded" | "simulated"; detail: string } | null;
}) {
  return <RelayConsole callId={callId} relayVersionId={null} mode="flagship" call={call} autoStart={autoStart} callProvenance={callProvenance} />;
}
