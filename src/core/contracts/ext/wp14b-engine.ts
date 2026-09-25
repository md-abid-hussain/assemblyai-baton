/**
 * contracts/ext/wp14b-engine.ts - additive WP14b types for the server engine (TASKS-v2 §2 rule 3, WP14b·2): the kernel
 * compiler port behind `RelayEngineFactory`, the sim-call port `CallCatalog` consumes (a structural subset of WP17's
 * `SimCallStore`/`SimCallResolution`, so WP17's store is assignable as it is), the run-moderation policy result, and
 * the server's default provenance strip. Pure: types and constants only.
 */
import type { CallManifestEntry } from "../scenario";
import type { AccountRecord, Blueprint } from "../v2/blueprint";
import type { CompiledRelay } from "../v2/services";

// ============================================================================================ kernel compiler port

/** What the registry knows about a version when it is compiled (WP14a's `CompileRelayOptions`, minus nothing). */
export interface RelayCompileOptions {
  /** null for the legacy Baton engine (`forVersion(null)`) and for unsaved drafts. */
  versionId: string | null;
  relayId: string | null;
  hash: string;
  /** Only the seeded flagship relay (Baton) is exempt from the kernel safety block (PLATFORM §4.4). */
  flagship: boolean;
}

/** WP14a's `compileRelay(bp, opts)`; `KernelRelay` is assignable to `CompiledRelay`. */
export type RelayCompiler = (bp: Blueprint, opts: RelayCompileOptions) => CompiledRelay;

/** `RelayEngineFactory.forVersion` LRU size (TASKS-v2 §5). */
export const ENGINE_CACHE_SIZE = 50;

// ============================================================================================ sims (WP17 port subset)

/** WP17's `SimRelayRef`: the relay identity a sim carries. */
export interface SimRelayRefLite {
  slug: string;
  title: string;
  blueprintHash: string | null;
}

/** The fields of WP17's `SimCallResolution` the catalog reads. */
export interface SimCallResolutionLite {
  entry: CallManifestEntry;
  simulated: true;
  /** DB sims: the row's version. Gallery sims: null (resolved from `relay.slug` + `relay.blueprintHash`). */
  relayVersionId: string | null;
  relay: SimRelayRefLite;
  sampleIndex: number;
  gallery: boolean;
}

/** WP17's `SimCallStore.resolveCall` (DB rows first, then `src/generated/sim-calls.json`). */
export interface SimCallResolver {
  resolveCall(callId: string): Promise<SimCallResolutionLite | null>;
}

/** `CallCatalog.resolve` result plus the sim's identity (extra keys; the v2 `CallCatalog` shape is a subset). */
export interface CatalogCall {
  entry: CallManifestEntry;
  simulated: boolean;
  relayVersionId: string | null;
  account: AccountRecord | null;
  /** Sims only: `sim_calls.id` (= `entry.callId`) and the blueprint sample the script was written for. */
  simCallId: string | null;
  sampleIndex: number | null;
}

// ============================================================================================ moderation policy

/** Why a moderation check is made (PLATFORM §7.4): Test runs fail open for gallery-derived relays; Publish fails closed. */
export type ModerationPurpose = "test" | "publish";

export interface RunModeration {
  flagged: boolean;
  categories: string[];
  /**
   * `stored`: the version's cached result; `openai`: checked now and stored; `gallery_text`: every line of its text is
   * already in a seeded gallery version (stored as `source: "seed"`, no call); `fail_open`: the endpoint was unavailable
   * and the Test run of a gallery-derived relay went ahead (nothing stored, so the next run checks again).
   */
  via: "stored" | "openai" | "gallery_text" | "fail_open";
}

// ============================================================================================ provenance defaults

/** PLATFORM §7.5 step 6: the sim detail line. */
export const SIM_PROVENANCE_DETAIL = "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people." as const;
