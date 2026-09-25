import "server-only";

import { BatonError } from "../../core/contracts/errors";
import {
  SIM_PROVENANCE_DETAIL, type CatalogCall, type KernelBinding, type RunModeration,
} from "../../core/contracts/ext/wp14b-engine";
import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { AccountRecord, CompiledListening, CompiledRelay, ProvenanceStrip, RelayEngineFactory, UiSpec } from "../../core/contracts/v2";
import { log } from "../log";
import { RelayError } from "../relays/http";
import type { PgRelayRegistry, RunVersion } from "../relays/registry";

/**
 * The relay half of `POST /api/cases` (TASKS-v2 WP14b T2, PLATFORM §7.4–§7.6): which version runs, may it run, what
 * it compiles to, which account it speaks to, and the v2 response fields. Workspace-scoped through a `ws` parameter
 * (today `ws_<visitorId>`; an org workspace later), never a global.
 */
export interface RelayRunDeps {
  registry: Pick<PgRelayRegistry, "resolveRun" | "moderateForRun" | "canSeeVersion">;
  engine: RelayEngineFactory;
  catalog: { resolve(callId: string): Promise<CatalogCall | null> };
  binding: () => KernelBinding | null;
  /** The gallery seed (once per process) before a gallery relay or preset is resolved. */
  ensureSeeded?: () => Promise<unknown>;
}

export interface PreparedRelayRun {
  run: RunVersion;
  compiled: CompiledRelay;
  /** The call the run plays (recorded or simulated), when the request named one. */
  call: CatalogCall | null;
  moderation: RunModeration;
  binding: KernelBinding;
}

const runLog = log.child({ component: "relay-run" });

/**
 * 1. the version: `relayVersionId` (e.g. a gallery preset, any version `ws` can see) or `relayId` (the owner's draft is
 *    snapshotted; a reader runs the current version); 404 across workspaces, 422 E_LINT on lint errors;
 * 2. the call, through the `CallCatalog`: a DB sim of a relay `ws` cannot see is a 404 like an unknown call;
 * 3. moderation before the version's first run (`purpose: "test"`): flagged → 422 E_MODERATION_FLAGGED with the
 *    categories; the endpoint down → fail open only for gallery-derived relays, else 503;
 * 4. the compile, through the `RelayEngineFactory` LRU (503 E_MAINTENANCE until the kernel is bound).
 */
export async function prepareRelayRun(
  d: RelayRunDeps,
  i: { ws: string; relayId?: string | undefined; relayVersionId?: string | undefined; callId?: string | undefined },
): Promise<PreparedRelayRun> {
  await d.ensureSeeded?.();
  const run = await d.registry.resolveRun(i.ws, { relayId: i.relayId, relayVersionId: i.relayVersionId });
  let call: CatalogCall | null = null;
  if (i.callId) {
    call = await d.catalog.resolve(i.callId);
    if (call?.simulated && !call.gallerySim && (!call.relayVersionId || !(await d.registry.canSeeVersion(i.ws, call.relayVersionId)))) call = null;
    if (!call) throw new BatonError("E_NOT_FOUND", "Unknown call.");
  }
  const moderation = await d.registry.moderateForRun(run.versionId, "test");
  if (moderation.flagged) {
    runLog.warn("run blocked by moderation", { versionId: run.versionId, categories: moderation.categories });
    throw new RelayError("E_MODERATION_FLAGGED", "This relay's text was flagged by moderation, so it cannot run. Edit the flagged text and try again.", {
      body: { categories: moderation.categories },
    });
  }
  const binding = d.binding();
  if (!binding) throw new BatonError("E_MAINTENANCE", "Relay runs are not available on this server yet. Baton still runs.");
  const compiled = await d.engine.forVersion(run.versionId);
  return { run, compiled, call, moderation, binding };
}

/** The plain `CallManifestEntry` of a catalog call (the v1 response's `call`, without the catalog's extra keys). */
export function manifestEntryOf(c: CatalogCall): CallManifestEntry {
  const { simulated: _s, relayVersionId: _v, account: _a, simCallId: _c, sampleIndex: _i, gallerySim: _g, ...entry } = c;
  return entry;
}

/**
 * The account a run speaks to: the RUN version's sample at the sim's index (a preset that edits sample data, e.g.
 * "Deposit $75", runs on the base relay's sim with its own numbers), else sample 0.
 */
export function runAccount(run: Pick<RunVersion, "blueprint">, call: Pick<CatalogCall, "sampleIndex"> | null): AccountRecord {
  const samples = run.blueprint.context.samples;
  return (call?.sampleIndex != null ? samples[call.sampleIndex] : undefined) ?? (samples[0] as AccountRecord);
}

/**
 * The server's default provenance strip at case creation (PLATFORM §7.6). Recorded takes: recorded role-play, live
 * transcription, live Voice Agent, recorded customer. Sims: simulated human half, synthetic customer and the §7.5
 * detail line. The console updates the segments it alone knows (a cached replay, a recorded AI session, the mic).
 */
export function runProvenance(simulated: boolean): ProvenanceStrip {
  return {
    humanHalf: simulated ? "simulated" : "recorded",
    transcription: { kind: "live", date: null },
    aiHalf: { kind: "live", date: null },
    customerInAiHalf: simulated ? "synthetic" : "recorded",
    detail: simulated ? SIM_PROVENANCE_DETAIL : null,
  };
}

/** The v2 fields of `CreateCaseResponseV2` for a compiled relay, an account and the run's call kind. */
export function relayRunFields(compiled: CompiledRelay, account: AccountRecord, simulated: boolean): {
  account: AccountRecord; relay: UiSpec; listening: CompiledListening; simulated: boolean; provenance: ProvenanceStrip;
} {
  return {
    account,
    relay: { ...compiled.ui, relay: { ...compiled.ui.relay, simulated } },
    listening: compiled.listening(account),
    simulated,
    provenance: runProvenance(simulated),
  };
}
