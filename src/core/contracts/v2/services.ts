/**
 * contracts/v2/services.ts - the v2 seams between work packages (TASKS-v2 §5). TYPES ONLY: no runtime code.
 * WP14a; frozen at C2 (D1 13:00); additive changes only afterwards.
 *
 * The interfaces are TASKS-v2 §5 verbatim, plus (marked "C2 addition") the few seams §5 implies but does not spell
 * out: `RelayRegistry.setVisibility` (backs PUT /api/relays/:id), `RelayToolService`/`RelayToolOutcome` (PLATFORM
 * §6.3, carrying `nextStep` until the §4.7 widening adds it to v1 `ToolOutcome`), and the `SimCallView` /
 * `RelayAnalyticsView` aliases of their route schemas. The route zod lives in ./api.ts; the contracts test pins
 * that every schema's output is assignable to the matching interface here.
 */
import type { z } from "zod";
import type { CaseState, Stage } from "../case";
import type { CallManifestEntry } from "../scenario";
import type { ToolContext, ToolOutcome } from "../services";
import type { CompiledTakeover } from "../takeover";
import type { VaFunctionTool } from "../tools";
import type { TurnInput } from "../turns";
import type { RelayAnalyticsViewSchema, SimCallViewSchema } from "./api";
import type { AccountRecord, Blueprint, SecretRef } from "./blueprint";
import type {
  CompiledListening, CompileTakeoverOptions, DisclosureText, GreetingResult, IntentSpec, LintIssue, UiSpec,
} from "./relay";

export type { LintIssue } from "./relay";
/** GET /api/sim-calls/:id (WP17). */
export type SimCallView = z.infer<typeof SimCallViewSchema>;
/** GET /api/relays/:id/analytics (WP18); Recorded/Simulated split. */
export type RelayAnalyticsView = z.infer<typeof RelayAnalyticsViewSchema>;

export interface RelaySummary { id: string; slug: string; title: string; industry: string; visibility: "private" | "unlisted" | "gallery";
  flagship: boolean; origin: "seed" | "user" | "draft" | "clone"; versionCount: number; lintErrors: number; lastRunAt: string | null; updatedAt: string }
export interface RelayDetail extends RelaySummary { draft: Blueprint; draftRev: number; lint: LintIssue[]; currentVersionId: string | null;
  publication: PublicationView | null; readOnly: boolean; presets: { id: string; label: string; versionId: string }[] }
export interface RelayRegistry {                                                     // WP14b
  listGallery(): Promise<RelaySummary[]>; listMine(ws: string): Promise<RelaySummary[]>;
  get(id: string, ws: string): Promise<RelayDetail | null>;
  create(ws: string, from: { kind: "blank"; industry: string } | { kind: "clone"; relayId: string }
                          | { kind: "blueprint"; blueprint: unknown; origin: "draft" | "user" }): Promise<RelayDetail>;   // never blocked by the global cap (P§10.2)
  saveDraft(id: string, ws: string, blueprint: unknown, expectedRev: number): Promise<{ rev: number; lint: LintIssue[] } | { conflict: true; rev: number }>;
  snapshotVersion(id: string): Promise<{ versionId: string; version: number; hash: string; created: boolean }>;   // content-addressed
  getVersion(versionId: string): Promise<{ relayId: string; version: number; blueprint: Blueprint; hash: string } | null>;
  moderate(versionId: string): Promise<{ flagged: boolean; categories: string[] }>;   // once per version (P§7.4)
  remove(id: string, ws: string): Promise<void>;
  seedGallery(): Promise<{ upserted: string[] }>;                                    // idempotent; at start-up; incl. preset versions
  /** C2 addition: PUT /api/relays/:id. Gallery relays are read-only (E_READ_ONLY). */
  setVisibility(id: string, ws: string, visibility: "private" | "unlisted"): Promise<RelayDetail>;
}
export interface CompiledRelay {                                                     // WP14a kernel output
  versionId: string | null; hash: string; blueprint: Blueprint | null; spec: IntentSpec; ui: UiSpec;
  listening(account: AccountRecord): CompiledListening;
  extractor: { prompt: string; format: { name: string; strict: true; schema: Record<string, unknown> }; versionId: string;
               buildInput(i: { callDate: string; account: AccountRecord; state: Pick<CaseState, "fields">;
                               recent: readonly Pick<TurnInput, "turnId" | "channel" | "text">[];
                               newTurns: readonly Pick<TurnInput, "turnId" | "channel" | "text">[] }): string };
  greeting(snapshot: Pick<CaseState, "fields">, account: AccountRecord): GreetingResult;
  prompt(snapshot: Pick<CaseState, "fields">, account: AccountRecord, stage: Stage, opts: { deployId: string }): string;   // + safety block (P§4.4)
  tools(stage: Stage): VaFunctionTool[];
  disclosure(id: string, ctx: { snapshot: Pick<CaseState, "fields">; account: AccountRecord; opts: { taxSuffix: boolean } }): DisclosureText;
  values(ctx: { snapshot: Pick<CaseState, "fields">; account: AccountRecord }): Record<string, string | null>;
  nextStage(current: Stage | null, s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment"> & { connectorsSucceeded: string[] }): Stage;
  takeover(snapshot: CaseState, account: AccountRecord, opts: CompileTakeoverOptions): CompiledTakeover;  // runs validateFirstUpdate
}
export interface RelayEngineFactory { forVersion(versionId: string | null): Promise<CompiledRelay> }   // null → legacy Baton; LRU 50
export interface CallCatalog {                                                        // WP14b (generated calls) + WP17 (sims)
  resolve(callId: string): Promise<(CallManifestEntry & { simulated: boolean; relayVersionId: string | null; account: AccountRecord | null }) | null> }
export interface ConnectorCtx { mode: "test" | "live" | "published" | "console"; caseId: string | null; takeoverId: string | null;
  workspaceId: string;   // the RELAY OWNER's workspace (never the visitor's on published runs)
  origin: string; publicationId: string | null }
export interface ConnectorOutcome { status: "ok" | "error" | "blocked" | "timeout" | "refused"; succeeded: boolean;
  result: Record<string, unknown>;   // connector data under `data` (P§6.2)
  ui?: { sms?: string; link?: string; paymentId?: string; esignId?: string } }
export interface ConnectorRuntime { execute(i: { compiled: CompiledRelay; connectorId: string; args: Record<string, unknown>; ctx: ConnectorCtx }): Promise<ConnectorOutcome> }   // WP16
export interface SecretStore { put(ws: string, name: string, value: string): Promise<{ id: string; name: string; createdAt: string; expiresAt: string }>;
  list(ws: string): Promise<{ id: string; name: string; createdAt: string; expiresAt: string }[]>; remove(ws: string, id: string): Promise<void>;
  resolve(ws: string, ref: SecretRef): Promise<string> }                                // server-only; never serialized
export interface DeskInput { industry: string; businessName: string | null; repHandles: string; aiFinishes: string[]; verbatim: string | null;
  payment: string | null; tone: string | null; voice: string | null }
export interface DraftView { draftId: string; status: "queued" | "running" | "ok" | "invalid" | "failed"; step: string | null;
  relayId: string | null; notes: string[]; lint: LintIssue[]; usd: number; repairs: number }
export interface Drafter {                                                             // WP17; async (P§7.4)
  start(i: DeskInput, who: { ws: string; visitorId: string; ipKey: string }): Promise<DraftView>;
  get(draftId: string, ws: string): Promise<DraftView | null> }
export interface SimCallService { request(i: { relayId: string; sampleIndex: number; kind: "audio" | "text_dry_run"; ws: string; visitorId: string; ipKey: string }):
  Promise<{ simCallId: string; status: "ready" | "generating"; etaSec: number }>; get(simCallId: string): Promise<SimCallView | null> }   // WP17
export interface PublicationView { id: string; relayId: string; version: number; shareSlug: string; agentId: string | null;
  status: "creating" | "live" | "deleting" | "deleted" | "failed"; mode: "stored_agent" | "inline_fallback"; configRedacted: Record<string, unknown> }
export interface Publisher { publish(relayId: string, ws: string): Promise<PublicationView>; unpublish(pubId: string, ws: string): Promise<void>;
  bySlug(slug: string): Promise<PublicationView | null>; acquireRun(pubId: string, takeoverId: string): Promise<boolean>;
  heartbeat(pubId: string, takeoverId: string): Promise<void>; release(pubId: string, takeoverId: string): Promise<void> }   // WP18
export interface RelayAnalytics { forRelay(relayId: string, version: number | "all"): Promise<RelayAnalyticsView> }            // WP18; Recorded/Simulated split

// ---------- C2 addition: the generic tool service (PLATFORM §6.3; WP16) ----------

/** v1 `ToolOutcome` + `nextStep` (the new stage's goal text when the stage changed, else null) + `ui.esignId`. */
export interface RelayToolOutcome extends ToolOutcome {
  nextStep: string | null;
  ui?: NonNullable<ToolOutcome["ui"]> & { esignId?: string };
}
/**
 * v1 `ToolContext` for any run. `callId` (the Voice Agent call_id) is null on the published gateway, which dedupes
 * on `(takeoverId, tool, argsHash)` within 30 s instead (PLATFORM §6.3 step 5).
 */
export interface RelayToolContext extends Omit<ToolContext, "callId"> {
  callId: string | null;
  mode: "test" | "live" | "published";
  publicationId: string | null;
}
/**
 * `/api/tools/[name]` and the published gateway: stage gate (fail-closed `not_available`), `validateToolArgs`,
 * dispatch (built-in handler or `ConnectorRuntime`), idempotency, `nextStage` from the exits.
 */
export interface RelayToolService { handle(name: string, args: unknown, ctx: RelayToolContext): Promise<RelayToolOutcome> }
