/**
 * contracts/v2/api.ts - request/response zod for the v2 routes (TASKS-v2 §5 "New routes"), the additive
 * extensions of v1 route shapes, `QUOTA_BUCKETS` (PLATFORM §10.2), `CHANGEOVER_DEMO_ECHO_SECRET` (§6.2),
 * `ProvenanceStrip` (§7.6), id prefixes and route paths. WP14a; frozen at C2 (D1 13:00); additive only afterwards.
 *
 * Conventions are v1's (contracts/api.ts header): `XRequest`/`XResponse` = `z.infer` of `XRequestSchema`/
 * `XResponseSchema`; errors use the `ApiError` envelope with a v1 `ErrorCode` or a `V2_ERROR_CODES` code.
 * Route owners: WP14b relays, WP17 drafts and sim-calls, WP16 connectors and secrets, WP18 publish/state/analytics.
 */
import { z } from "zod";
import {
  CreateCaseRequestSchema, CreateCaseResponseSchema, StatusResponseSchema, ToolResponseSchema, ToolUiSchema,
} from "../api";
import { FieldStatusSchema, PolicyRecordSchema, StageSchema } from "../case";
import { FallbackKindSchema, ErrorCodeSchema } from "../errors";
import { CallHandoffSchema } from "../scenario";
import { TranscriptionModeSchema } from "../takeover";
import { ExecutionModeSchema } from "../tools";
import { AccountRecordSchema, BlueprintSchema, IdSchema, INDUSTRIES, VA_VOICES } from "./blueprint";
import { CANNED_STATES, CompiledListeningSchema, CONNECTOR_TYPES, LintIssueSchema, UiSpecSchema } from "./relay";

// ============================================================================================ constants

/** Quota bucket names (PLATFORM §10.2). WP12 owns the limits and their config; these are only the names. */
export const QUOTA_BUCKETS = [
  "relay:create", "relay:save", "draft", "sim:dryrun", "sim:generate", "run", "greeting:hear", "conn:test",
  "publish", "pub:run", "secret:put",
] as const;
export const QuotaBucketSchema = z.enum(QUOTA_BUCKETS);
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

/**
 * The FIXED, PUBLISHED demo secret of the built-in HMAC echo `POST /api/connectors/echo` (PLATFORM §6.2).
 * Demo-only by design: it is not a secret. A relay that signs requests to the echo stores this same value.
 */
export const CHANGEOVER_DEMO_ECHO_SECRET = "changeover-demo-echo-not-secret" as const;

/** Header names and formats of connector requests (PLATFORM §6.2, §6.6). */
export const CONNECTOR_HEADERS = {
  timestamp: "X-Changeover-Timestamp",          // unix seconds
  signature: "X-Changeover-Signature",          // "v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>"
  delivery: "X-Changeover-Delivery",            // uuid per request
  pubKey: "X-Changeover-Key",                   // published HTTP tools → our gateway (32 random bytes; stored hashed)
} as const;
export const CONNECTOR_USER_AGENT = "Changeover-Connector/1.0" as const;
export const HMAC_SIGNATURE_VERSION = "v1" as const;
/** Receivers accept a timestamp within ± this many seconds. */
export const HMAC_WINDOW_SEC = 300;

/** Id prefixes (PLATFORM §2.1). A publication id and a share slug share `/api/publications/[x]`: ids start `pub_`. */
export const ID_PREFIXES = {
  relay: "rl_", version: "rv_", publication: "pub_", simCall: "sim_", secret: "sec_", draft: "drf_", workspace: "ws_",
} as const;
/** The public gallery's workspace; a visitor's is `ws_<visitorId>`. */
export const GALLERY_WORKSPACE = "ws_gallery" as const;
export const workspaceOf = (visitorId: string): string => `${ID_PREFIXES.workspace}${visitorId}`;

/** `RELAY_ENGINE` (PLATFORM §4.6): `legacy` = the default and the submission setting. */
export const RELAY_ENGINES = ["legacy", "kernel"] as const;
export type RelayEngineMode = (typeof RELAY_ENGINES)[number];

/** `RelayConsole` modes (PLATFORM §7.6). */
export const CONSOLE_MODES = ["flagship", "test", "shared", "published"] as const;
export type ConsoleMode = (typeof CONSOLE_MODES)[number];

/** Route paths (Next.js dirs under src/app/api). The ONE state route is `publicationRunState` (PLATFORM §8.3). */
export const V2_ROUTES = {
  relays: "/api/relays",                                                           // GET list, POST create (WP14b)
  relay: (id: string) => `/api/relays/${id}`,                                      // GET, PUT, DELETE
  relayDraft: (id: string) => `/api/relays/${id}/draft`,                           // PUT
  relayVersions: (id: string) => `/api/relays/${id}/versions`,                     // POST
  relayCompiled: (id: string) => `/api/relays/${id}/compiled`,                     // GET ?version=<versionId>|draft
  relayPublish: (id: string) => `/api/relays/${id}/publish`,                       // POST (WP18)
  relayAnalytics: (id: string) => `/api/relays/${id}/analytics`,                   // GET ?version=all|<n> (WP18)
  drafts: "/api/drafts",                                                           // POST (WP17)
  draft: (id: string) => `/api/drafts/${id}`,                                      // GET (poll 1.5 s)
  simCalls: "/api/sim-calls",                                                      // POST (WP17)
  simCall: (id: string) => `/api/sim-calls/${id}`,                                 // GET (poll)
  simCallFile: (id: string, file: SimCallFile) => `/api/sim-calls/${id}/${file}`,  // GET (immutable)
  connectorsTest: "/api/connectors/test",                                          // POST (WP16)
  connectorsEcho: "/api/connectors/echo",                                          // POST (WP16)
  secrets: "/api/secrets",                                                         // GET, POST, DELETE (WP16)
  pubTool: (pubId: string, tool: string) => `/api/connectors/pub/${pubId}/${tool}`, // POST (WP18 gateway)
  publication: (pubId: string) => `/api/publications/${pubId}`,                    // DELETE (WP18)
  publicationBySlug: (slug: string) => `/api/publications/${slug}`,                // GET (WP18)
  publicationRunState: (pubId: string, takeoverId: string) =>
    `/api/publications/${pubId}/runs/${takeoverId}/state`,                         // GET ?after=<cursor> (WP18; poll 1 s)
} as const;

// ============================================================================================ errors

/** Error codes added by v2 (the v1 `ERROR_CODES` stay valid). HTTP status in `V2_ERROR_STATUS`. */
export const V2_ERROR_CODES = [
  "E_LINT",                    // 422 lint errors block a run or publish
  "E_DRAFT_CONFLICT",          // 409 saveDraft with a stale expectedRev
  "E_READ_ONLY",               // 403 a gallery relay is edited in place (clone it)
  "E_MODERATION_FLAGGED",      // 422 the version's text was flagged (PLATFORM §7.4)
  "E_PUB_IN_USE",              // 409 the publication's single run slot is taken (§8.3)
  "E_NO_ACTIVE_CALL",          // 409 gateway call with no active run
  "E_PUB_KEY",                 // 401 gateway call with a bad X-Changeover-Key
  "E_CONN_HOST_NOT_ALLOWED",   // 403 host not in CONNECTOR_HOST_ALLOWLIST (production)
  "E_CONN_ADDRESS",            // 403 a resolved address is not public unicast (SSRF guard)
  "E_CONN_DNS",                // 502 resolution failed or timed out
  "E_CONN_REDIRECT",           // 502 a 3xx (never followed)
  "E_CONN_ENCODING",           // 502 a compressed body
  "E_CONN_TOO_LARGE",          // 502 body > 8192 bytes
  "E_CONN_TIMEOUT",            // 504 over timeoutMs
  "E_CONN_SECRET_MISSING",     // 422 a needed secret ref is null or expired (lint K2 at runtime)
  "E_ECHO_SIGNATURE",          // 401 the echo got a tampered signature or a stale timestamp
  "E_SECRET_LIMIT",            // 429 more than 10 secrets in a workspace
] as const;
export const V2ErrorCodeSchema = z.enum(V2_ERROR_CODES);
export type V2ErrorCode = z.infer<typeof V2ErrorCodeSchema>;
export const V2_ERROR_STATUS: Readonly<Record<V2ErrorCode, number>> = {
  E_LINT: 422, E_DRAFT_CONFLICT: 409, E_READ_ONLY: 403, E_MODERATION_FLAGGED: 422, E_PUB_IN_USE: 409,
  E_NO_ACTIVE_CALL: 409, E_PUB_KEY: 401, E_CONN_HOST_NOT_ALLOWED: 403, E_CONN_ADDRESS: 403, E_CONN_DNS: 502,
  E_CONN_REDIRECT: 502, E_CONN_ENCODING: 502, E_CONN_TOO_LARGE: 502, E_CONN_TIMEOUT: 504,
  E_CONN_SECRET_MISSING: 422, E_ECHO_SIGNATURE: 401, E_SECRET_LIMIT: 429,
};
/** The v1 `ApiError` envelope, accepting v1 and v2 codes. `lint` rides along with E_LINT. */
export const ApiErrorV2Schema = z.object({
  error: z.object({
    code: z.union([ErrorCodeSchema, V2ErrorCodeSchema]),
    message: z.string(),
    retryAfterMs: z.number().nonnegative().optional(),
    fallback: FallbackKindSchema.optional(),
    lint: z.array(LintIssueSchema).optional(),
  }),
});
export type ApiErrorV2 = z.infer<typeof ApiErrorV2Schema>;

// ============================================================================================ shared shapes

/** A Voice Agent function tool with a generic name (v1 `VaFunctionToolSchema` pins the six Baton names until §4.7). */
export const VaFunctionToolV2Schema = z.object({
  type: z.literal("function"),
  name: IdSchema,
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  execution_mode: ExecutionModeSchema,
  timeout_seconds: z.number().int().positive(),
});
export type VaFunctionToolV2 = z.infer<typeof VaFunctionToolV2Schema>;

/**
 * The provenance strip (PLATFORM §7.6): one per run, four segments.
 * Human half: recorded role-play · simulated (TTS) · text dry run. Transcription: live AssemblyAI · cached (date).
 * AI half: live Voice Agent · recorded session (date) · none (dry run). Customer in AI half: recorded · synthetic ·
 * you (mic) · none (dry run). `detail` is the one-line detail (sims: "Simulated audio: script by gpt-6-luna, voices
 * by gpt-4o-mini-tts. Fictional people.").
 */
export const ProvenanceStripSchema = z.object({
  humanHalf: z.enum(["recorded", "simulated", "text_dry_run"]),
  transcription: z.object({ kind: z.enum(["live", "cached"]), date: z.string().nullable() }),
  aiHalf: z.object({ kind: z.enum(["live", "recorded", "none"]), date: z.string().nullable() }),
  customerInAiHalf: z.enum(["recorded", "synthetic", "mic", "none"]),
  detail: z.string().nullable(),
});
export type ProvenanceStrip = z.infer<typeof ProvenanceStripSchema>;

// ============================================================================================ v1 route extensions (additive)

/** #3 POST /api/cases + `relayId` (the server snapshots a version) or `relayVersionId` (e.g. a gallery preset). */
export const CreateCaseRequestV2Schema = CreateCaseRequestSchema.extend({
  relayId: z.string().min(1).optional(),
  relayVersionId: z.string().min(1).optional(),
});
export type CreateCaseRequestV2 = z.infer<typeof CreateCaseRequestV2Schema>;

/**
 * #3 response + `relay` (UiSpec), `listening`, `simulated`, `provenance`, and the run's `account`. `policy` is null
 * for non-Baton relays (their account is an `AccountRecord`); Baton cases keep the `PolicyRecord`.
 */
export const CreateCaseResponseV2Schema = CreateCaseResponseSchema.extend({
  policy: PolicyRecordSchema.nullable(),
  account: AccountRecordSchema,
  relay: UiSpecSchema,
  listening: CompiledListeningSchema,
  simulated: z.boolean(),
  provenance: ProvenanceStripSchema,
});
export type CreateCaseResponseV2 = z.infer<typeof CreateCaseResponseV2Schema>;

/** #2 GET /api/status + `nextLiveAt` (the next time-tranche start while live AI calls are paused; WP12). */
export const StatusResponseV2Schema = StatusResponseSchema.extend({ nextLiveAt: z.string().nullable() });
export type StatusResponseV2 = z.infer<typeof StatusResponseV2Schema>;

/**
 * #14 POST /api/tools/[name] response + `nextStep` (PLATFORM §6.3 step 7: the new stage's goal text when the stage
 * changed, else null), generic tool names, and `ui.esignId`.
 */
export const ToolResponseV2Schema = ToolResponseSchema.extend({
  tools: z.array(VaFunctionToolV2Schema).optional(),
  ui: ToolUiSchema.extend({ esignId: z.string().optional() }).optional(),
  nextStep: z.string().nullable(),
});
export type ToolResponseV2 = z.infer<typeof ToolResponseV2Schema>;

// ============================================================================================ relays (WP14b)

export const RELAY_VISIBILITIES = ["private", "unlisted", "gallery"] as const;
export const RELAY_ORIGINS = ["seed", "user", "draft", "clone"] as const;
export const PUBLICATION_STATUSES = ["creating", "live", "deleting", "deleted", "failed"] as const;

export const RelaySummarySchema = z.object({
  id: z.string(), slug: z.string(), title: z.string(), industry: z.string(),
  visibility: z.enum(RELAY_VISIBILITIES), flagship: z.boolean(), origin: z.enum(RELAY_ORIGINS),
  versionCount: z.number().int().nonnegative(), lintErrors: z.number().int().nonnegative(),
  lastRunAt: z.string().nullable(), updatedAt: z.string(),
});

export const PublicationViewSchema = z.object({
  id: z.string(), relayId: z.string(), version: z.number().int(), shareSlug: z.string(), agentId: z.string().nullable(),
  status: z.enum(PUBLICATION_STATUSES), mode: z.enum(["stored_agent", "inline_fallback"]),
  /** The published config with every header value stripped. */
  configRedacted: z.record(z.string(), z.unknown()),
});

export const RelayPresetSchema = z.object({ id: z.string(), label: z.string(), versionId: z.string() });

export const RelayDetailSchema = RelaySummarySchema.extend({
  /** The autosaved draft. Only drafts that pass `BlueprintSchema` are stored (lint may still report errors). */
  draft: BlueprintSchema,
  draftRev: z.number().int().nonnegative(),
  lint: z.array(LintIssueSchema),
  currentVersionId: z.string().nullable(),
  publication: PublicationViewSchema.nullable(),
  /** Gallery relays open read-only ("Clone to edit"). */
  readOnly: z.boolean(),
  /** Try-an-edit presets: seeded variant versions of a gallery relay (PLATFORM §7.5.3). */
  presets: z.array(RelayPresetSchema),
});

/** GET /api/relays */
export const ListRelaysResponseSchema = z.object({
  gallery: z.array(RelaySummarySchema),
  mine: z.array(RelaySummarySchema),
});
export type ListRelaysResponse = z.infer<typeof ListRelaysResponseSchema>;

/** POST /api/relays → RelayDetail. Never blocked by the global cap (PLATFORM §10.2). */
export const CreateRelayRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blank"), industry: z.enum(INDUSTRIES) }),
  z.object({ kind: z.literal("clone"), relayId: z.string().min(1) }),
  z.object({ kind: z.literal("blueprint"), blueprint: z.unknown(), origin: z.enum(["draft", "user"]) }),
]);
export type CreateRelayRequest = z.infer<typeof CreateRelayRequestSchema>;

/** PUT /api/relays/:id → RelayDetail. Only the sharing visibility; everything else lives in the draft. */
export const UpdateRelayRequestSchema = z.object({ visibility: z.enum(["private", "unlisted"]) });
export type UpdateRelayRequest = z.infer<typeof UpdateRelayRequestSchema>;

/** PUT /api/relays/:id/draft. A body that fails `BlueprintSchema` is not stored: 422 E_LINT with `SCHEMA`/`X3` issues. */
export const SaveDraftRequestSchema = z.object({ blueprint: z.unknown(), expectedRev: z.number().int().nonnegative() });
export type SaveDraftRequest = z.infer<typeof SaveDraftRequestSchema>;
/** 200 `{rev, lint}`, or 409 `{conflict: true, rev}` (the current rev; reload and merge). */
export const SaveDraftResponseSchema = z.union([
  z.object({ rev: z.number().int().nonnegative(), lint: z.array(LintIssueSchema) }),
  z.object({ conflict: z.literal(true), rev: z.number().int().nonnegative() }),
]);
export type SaveDraftResponse = z.infer<typeof SaveDraftResponseSchema>;

/** POST /api/relays/:id/versions: content-addressed snapshot of the draft. */
export const CreateVersionResponseSchema = z.object({
  versionId: z.string(), version: z.number().int().positive(), hash: z.string(), created: z.boolean(),
});
export type CreateVersionResponse = z.infer<typeof CreateVersionResponseSchema>;

/**
 * GET /api/relays/:id/compiled?version=<versionId>|draft: the server's authoritative compile (PLATFORM §7.3).
 * The client compares `hash` with its own compile; a mismatch shows a banner.
 */
export const CompiledRelayViewSchema = z.object({
  relayId: z.string(),
  versionId: z.string().nullable(),
  hash: z.string(),
  kernelVersion: z.string(),
  lint: z.array(LintIssueSchema),
  ui: UiSpecSchema,
  listening: CompiledListeningSchema,
  greetings: z.array(z.object({
    state: z.enum(CANNED_STATES), sampleIndex: z.number().int().nonnegative(), text: z.string(),
    wordCount: z.number().int().nonnegative(), estSeconds: z.number().nonnegative(),
  })),
  prompts: z.array(z.object({ stage: StageSchema, chars: z.number().int().nonnegative(), text: z.string() })),
  tools: z.array(z.object({ stage: StageSchema, tools: z.array(VaFunctionToolV2Schema) })),
  extractor: z.object({
    versionId: z.string(), prompt: z.string(), formatName: z.string(),
    schema: z.record(z.string(), z.unknown()), strictOk: z.boolean(),
  }),
  firstUpdate: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
});
export type CompiledRelayView = z.infer<typeof CompiledRelayViewSchema>;

// ============================================================================================ drafts (WP17; async)

export const DRAFT_STATUSES = ["queued", "running", "ok", "invalid", "failed"] as const;
/** The wizard's "What should the AI finish?" checklist (PLATFORM §7.4 step 2). */
export const AI_FINISHES = ["confirm_details", "read_disclosure", "take_payment", "esign", "send_confirmation", "lookup"] as const;

export const DeskInputSchema = z.object({
  industry: z.string().min(2).max(40),
  businessName: z.string().min(1).max(80).nullable(),
  repHandles: z.string().min(1).max(600),
  aiFinishes: z.array(z.enum(AI_FINISHES)).min(1).max(AI_FINISHES.length),
  verbatim: z.string().max(800).nullable(),
  payment: z.string().max(200).nullable(),
  tone: z.string().max(200).nullable(),
  voice: z.enum(VA_VOICES).nullable(),
});

export const DraftViewSchema = z.object({
  draftId: z.string(),
  status: z.enum(DRAFT_STATUSES),
  /** The pipeline step running or last finished (e.g. "quota", "drafting", "repair 1", "creating"). */
  step: z.string().nullable(),
  relayId: z.string().nullable(),
  /** "Assumptions I made: …" */
  notes: z.array(z.string()),
  lint: z.array(LintIssueSchema),
  usd: z.number().nonnegative(),
  repairs: z.number().int().nonnegative(),
});

/** POST /api/drafts → 202 DraftView (`status:"queued"`) at once; GET /api/drafts/:id → DraftView (poll 1.5 s). */
export const CreateDraftRequestSchema = DeskInputSchema;

// ============================================================================================ simulated calls (WP17)

export const SIM_CALL_KINDS = ["audio", "text_dry_run"] as const;
export const SimCallKindSchema = z.enum(SIM_CALL_KINDS);
export type SimCallKind = z.infer<typeof SimCallKindSchema>;
export const SIM_CALL_FILES = ["rep.ulaw", "customer.ulaw", "peaks.json"] as const;
export type SimCallFile = (typeof SIM_CALL_FILES)[number];
export const SIM_TURN_TAGS = ["greet", "ask", "answer", "readback", "confirm", "advice", "handoff", "accept", "other"] as const;

/** The luna `sim_script` strict-schema output, stored as `sim_calls.script` (PLATFORM §7.5 step 1). */
export const SimScriptSchema = z.object({
  turns: z.array(z.object({
    speaker: z.enum(["rep", "customer"]), text: z.string(), tag: z.enum(SIM_TURN_TAGS),
  })).min(8).max(14),
  left_for_ai: z.array(IdSchema).min(1).max(3),
  ai_half_answers: z.array(z.object({ field: IdSchema, spoken: z.string() })),
  consent_phrase: z.string(),
  closing_phrase: z.string(),
});
export type SimScript = z.infer<typeof SimScriptSchema>;

/** POST /api/sim-calls. `kind` defaults to "audio" (quota `sim:generate`); "text_dry_run" uses `sim:dryrun`. */
export const CreateSimCallRequestSchema = z.object({
  relayId: z.string().min(1),
  sampleIndex: z.number().int().min(0).max(4),
  kind: SimCallKindSchema.default("audio"),
});
export type CreateSimCallRequest = z.infer<typeof CreateSimCallRequestSchema>;
export const CreateSimCallResponseSchema = z.object({
  simCallId: z.string(), status: z.enum(["ready", "generating"]), etaSec: z.number().nonnegative(),
});
export type CreateSimCallResponse = z.infer<typeof CreateSimCallResponseSchema>;

/** TEXT DRY RUN result (PLATFORM §7.5.2): the case card at the pass, the greeting, and the next ask per stage. */
export const TextDryRunResultSchema = z.object({
  fields: z.array(z.object({
    id: z.string(), label: z.string(), status: FieldStatusSchema, value: z.string().nullable(),
    display: z.string().nullable(), quote: z.string().nullable(), turnId: z.string().nullable(),
  })),
  greeting: z.object({ text: z.string(), wordCount: z.number().int().nonnegative() }),
  steps: z.array(z.object({ stage: StageSchema, label: z.string(), ask: z.string() })),
  extractorVersionId: z.string(),
});
export type TextDryRunResult = z.infer<typeof TextDryRunResultSchema>;

/** GET /api/sim-calls/:id. An audio sim's id is also its `callId` (CallCatalog, `/call/[callId]`). */
export const SimCallViewSchema = z.object({
  id: z.string(),
  kind: SimCallKindSchema,
  status: z.enum(["generating", "ready", "failed"]),
  relayId: z.string(),
  relayVersionId: z.string(),
  sampleIndex: z.number().int().nonnegative(),
  gallery: z.boolean(),
  callId: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  handoff: CallHandoffSchema.nullable(),
  script: SimScriptSchema.nullable(),
  dryRun: TextDryRunResultSchema.nullable(),
  usd: z.number().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

// ============================================================================================ connectors, secrets (WP16)

export const CONNECTOR_OUTCOME_STATUSES = ["ok", "error", "blocked", "timeout", "refused"] as const;
export const CONNECTOR_MODES = ["test", "live", "published", "console"] as const;

/** The JSON body of an `http_action` POST (PLATFORM §6.2; ≤ 8 KiB). GET sends the args as query params instead. */
export const ConnectorRequestBodySchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  run: z.object({
    relay: z.string(), version: z.number().int(), case: z.string().nullable(), mode: z.enum(CONNECTOR_MODES),
  }),
});
export type ConnectorRequestBody = z.infer<typeof ConnectorRequestBodySchema>;

/** POST /api/connectors/test (quota `conn:test`; `mode:"console"`, no case). */
export const ConnectorTestRequestSchema = z.object({
  relayId: z.string().min(1),
  connectorId: IdSchema,
  args: z.record(z.string(), z.unknown()),
});
export type ConnectorTestRequest = z.infer<typeof ConnectorTestRequestSchema>;
export const ConnectorTestResponseSchema = z.object({
  connectorType: z.enum(CONNECTOR_TYPES),
  status: z.enum(CONNECTOR_OUTCOME_STATUSES),
  errorCode: z.string().nullable(),
  ms: z.number().nonnegative(),
  /** The redacted request line and headers; secret values shown as "‹secret:name›". Null for dry-run connectors. */
  request: z.object({
    method: z.enum(["GET", "POST"]), url: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
  }).nullable(),
  signature: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  reqBytes: z.number().int().nonnegative(),
  resBytes: z.number().int().nonnegative(),
  /** Exactly what the agent would see (`{data:{…}, http_status}` for http/lookup). */
  agentResult: z.record(z.string(), z.unknown()),
  /** The raw response, redacted, ≤ 8 KiB (≤ 2 KiB on the public deployment). */
  raw: z.string().nullable(),
  /** payment_link, confirmation, esign_mock: a dry-run render only (no checkout is created). */
  dryRun: z.object({ text: z.string() }).nullable(),
});
export type ConnectorTestResponse = z.infer<typeof ConnectorTestResponseSchema>;

/** POST /api/connectors/echo → 200 (unsigned or valid), 401 E_ECHO_SIGNATURE (tampered or stale). */
export const EchoResponseSchema = z.object({
  ok: z.literal(true),
  signature: z.enum(["absent", "valid"]),
  method: z.enum(["GET", "POST"]),
  query: z.record(z.string(), z.string()),
  body: z.unknown(),
  /** Received request headers, lowercased, with no secret values. */
  headers: z.record(z.string(), z.string()),
  receivedAt: z.string(),
});
export type EchoResponse = z.infer<typeof EchoResponseSchema>;

export const SecretMetaSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.string(), expiresAt: z.string() });
export type SecretMeta = z.infer<typeof SecretMetaSchema>;
/** POST /api/secrets → SecretMeta. The value is never returned by any route, log, error, export or config. */
export const PutSecretRequestSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  value: z.string().min(1).max(1024),
});
export type PutSecretRequest = z.infer<typeof PutSecretRequestSchema>;
/** GET /api/secrets (names only). */
export const ListSecretsResponseSchema = z.object({ secrets: z.array(SecretMetaSchema) });
export type ListSecretsResponse = z.infer<typeof ListSecretsResponseSchema>;
/** DELETE /api/secrets → OkResponse. */
export const DeleteSecretRequestSchema = z.object({ id: z.string().regex(/^sec_[a-z0-9]{16}$/) });
export type DeleteSecretRequest = z.infer<typeof DeleteSecretRequestSchema>;

// ============================================================================================ publish, gateway, state (WP18)

/** POST /api/relays/:id/publish. */
export const PublishResponseSchema = z.object({
  shareUrl: z.string(),
  agentId: z.string().nullable(),
  version: z.number().int(),
  configRedacted: z.record(z.string(), z.unknown()),
  publication: PublicationViewSchema,
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

/** GET /api/publications/:slug (the `/a/[shareSlug]` page data). The mic is never enabled there. */
export const PublicationPageViewSchema = z.object({
  publication: PublicationViewSchema,
  relay: z.object({
    id: z.string(), slug: z.string(), title: z.string(), tagline: z.string(), industry: z.string(),
    flagship: z.boolean(), gallery: z.boolean(),
  }),
  /** "User-made relay · fictional business" on every non-gallery publication; null for gallery ones. */
  banner: z.string().nullable(),
  ui: UiSpecSchema,
  /** Simulated calls the visitor can run the agent against. */
  calls: z.array(z.object({ callId: z.string(), title: z.string(), durationMs: z.number().nonnegative().nullable() })),
  inUse: z.boolean(),
});
export type PublicationPageView = z.infer<typeof PublicationPageViewSchema>;

/**
 * POST /api/connectors/pub/:pubId/:tool (header `X-Changeover-Key`): the body is the tool args; the response body
 * is the tool result JSON the agent reads, plus `next_step` (the new stage's goal text) when the stage changed.
 * With no active run: `{status:"no_active_call"}`.
 */
export const PubToolResponseSchema = z.looseObject({ next_step: z.string().optional() });
export type PubToolResponse = z.infer<typeof PubToolResponseSchema>;

/** One UI event of a published run (tool calls the gateway handled), for the console timeline and MockPhone. */
export const PublishedRunEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  tool: z.string(),
  status: z.string(),
  stage: StageSchema.nullable(),
  ui: z.object({
    sms: z.string().optional(), link: z.string().optional(), paymentId: z.string().optional(), esignId: z.string().optional(),
  }).nullable(),
});
export type PublishedRunEvent = z.infer<typeof PublishedRunEventSchema>;

/**
 * THE ONE STATE ROUTE (PLATFORM §8.3): GET /api/publications/:pubId/runs/:takeoverId/state?after=<cursor>, polled
 * every 1 s by the published-run client. On a `stageSeq` change the client sends
 * `session.update{system_prompt, input:{transcription_mode}}`, NEVER `tools` (that would replace the stored HTTP tools).
 */
export const PublishedRunStateSchema = z.object({
  publicationId: z.string(),
  takeoverId: z.string(),
  stage: StageSchema.nullable(),
  /** Increments on every stage change. */
  stageSeq: z.number().int().nonnegative(),
  systemPrompt: z.string().nullable(),
  transcriptionMode: TranscriptionModeSchema.nullable(),
  nextStep: z.string().nullable(),
  /** Events with `seq > after`, in order. */
  events: z.array(PublishedRunEventSchema),
  /** Pass back as `after`. */
  cursor: z.number().int().nonnegative(),
  ended: z.boolean(),
  activeUntil: z.string().nullable(),
});
export type PublishedRunState = z.infer<typeof PublishedRunStateSchema>;

// ============================================================================================ analytics (WP18)

/** The 8 stat tiles (PLATFORM §9; Runs and Connector health are shown separately). */
export const ANALYTICS_TILES = [
  "finished_by_ai", "re_asked", "disclosure_verbatim", "hand_backs", "ai_minutes", "latency_p50",
  "fields_inherited", "paid_verified",
] as const;
export const RUN_SOURCES = ["recorded", "simulated", "text_dry_run", "published"] as const;

/** One number with its n and provenance. `k` = distinct recorded takes ("n runs over k distinct recorded takes"). */
export const AnalyticsCellSchema = z.object({
  value: z.number().nullable(),
  n: z.number().int().nonnegative(),
  k: z.number().int().nonnegative().nullable(),
  provisional: z.boolean(),
});
export type AnalyticsCell = z.infer<typeof AnalyticsCellSchema>;

const TilesSchema = z.array(z.object({
  id: z.enum(ANALYTICS_TILES), label: z.string(),
  /** Two columns, never one blended number. */
  recorded: AnalyticsCellSchema, simulated: AnalyticsCellSchema,
}));

/** GET /api/relays/:id/analytics?version=all|<n>. */
export const RelayAnalyticsViewSchema = z.object({
  relayId: z.string(),
  version: z.union([z.number().int().positive(), z.literal("all")]),
  generatedAt: z.string(),
  runs: z.object({
    recorded: z.number().int().nonnegative(), simulated: z.number().int().nonnegative(),
    textDryRun: z.number().int().nonnegative(), published: z.number().int().nonnegative(),
  }),
  tiles: TilesSchema,
  handBackReasons: z.array(z.object({ reason: z.string(), recorded: z.number().int().nonnegative(), simulated: z.number().int().nonnegative() })),
  connectorHealth: z.array(z.object({
    connectorId: z.string(), calls: z.number().int().nonnegative(), errorPct: z.number().nullable(), p50Ms: z.number().nullable(),
  })),
  runsTable: z.array(z.object({
    caseId: z.string(), takeoverId: z.string().nullable(), version: z.number().int(), source: z.enum(RUN_SOURCES),
    startedAt: z.string(), finishedByAi: z.boolean().nullable(), reAsked: z.number().int().nullable(),
    provisional: z.boolean(), provenance: ProvenanceStripSchema,
  })),
  /** Per-version comparison, at most 3 versions. */
  versions: z.array(z.object({ version: z.number().int().positive(), runs: z.number().int().nonnegative(), tiles: TilesSchema })).max(3),
});
