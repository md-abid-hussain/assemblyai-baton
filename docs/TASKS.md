# Baton: work packages for parallel coding agents (v1.1)

This file companions `docs/DESIGN.md` (v1.1), which is the spec. Section references (§) point there. v1.1 applies three adversarial reviews; DESIGN **Appendix D** lists every decision.

**Deadline:** lablab closes **2026-09-30 20:30 IST**. Our target: **submit by 10:00 IST on Sep 30** (hard internal limit 12:00). Deploy freeze 08:00 IST, Sep 30.

**What changed from v1.0 (short):**
- Wave 0 starts **tonight** (D0) and is split into WP0a (contracts) and WP0b (scaffold, DB, deploy), so Wave 1 starts D1 09:00 on frozen contracts.
- WP5, WP7 and WP9 are split (WP5/WP5b, WP7/WP7b, WP9/WP9b). **WP13 Pitch pack** is new and owns every submission asset.
- Gates: **vertical slice D2 14:00**, **full judge path on Zerops D3 16:00**, rough video D3 19:00, final video D4 19:00, D5 is buffer.
- One **limits authority** for the whole AssemblyAI account (DESIGN §2.3). Every script and test goes through it.
- Git: per-WP **worktrees and local commits**; an integrator merges at 8 gates; only the user pushes.
- An explicit **cut list** (§6), and a trimmed live-spend budget (§7).

---

## 0. Ground rules for every agent

1. **Worktree and branch.** Each WP works in its own git worktree on its own branch:
   `git worktree add ../baton-wt/<wp> -b wp/<wp> main` (e.g. `wp/wp4`).
   - Commit **locally** on your branch whenever a unit of work is green (small, descriptive commits, e.g. `wp4: per-channel feeder with FrameBatcher`). Commit messages end with the attribution lines from the session's system reminder, if there are any.
   - **Never push, never merge into `main`, never rebase `main`.** The integrator (the user, or the WP12 agent when the user delegates it) merges `wp/*` into `main` with `--no-ff` at each gate (§4), runs `npm run typecheck && npm test`, deploys, and the **user** pushes.
   - After each gate, merge `main` into your branch before continuing.
   - This workflow needs the user's go-ahead (DESIGN App. C Q8). Until then, agents work in worktrees without committing, and the integrator commits per WP at the gate.
2. **Own only your files.** The ownership map in §3.0 is disjoint by construction. Never edit a file owned by another WP.
   - To ask for a change in someone else's file, write `docs/notes/requests/<from>-to-<to>.md`. The owner answers at the next gate.
   - A missing type goes in a new file `src/core/contracts/ext/<wp>-<topic>.ts` (additive only).
   - A missing npm dependency: WP0b pre-installs everything in DESIGN §3.3. Anything else is a request to the integrator.
3. **Contracts are law.** `src/core/contracts/**` (WP0a) holds DESIGN §4.1 and the service interfaces in §2 below. They freeze at gate G0 (D1 08:00). Code against the interfaces and inject dependencies, so you can stub what isn't built yet.
4. **Secrets.** Never print, log or write the values in `.env`. Never paste a key into a file, a test snapshot or a note.
5. **The free tier is one shared account.** Every live AssemblyAI open or mint goes through the limits authority (DESIGN §2.3):
   - before the Zerops app is deployed: `scripts/lib/local-open-guard.ts` (a file lock shared by every agent on this laptop);
   - after T-D1-8: `LIMITS_ROLE=remote` + `LIMITS_AUTHORITY_URL` (the Zerops app).
   - Use only `scripts/lib/aai-open.ts` (Node) or the client managers (browser). The boundaries test fails any direct `StreamingSession.connect`, `connectNode(`, `mintStreamingToken(` or `.mintToken(` elsewhere.
   - Live tests run only with `RUN_LIVE=1`, serially, with `BATON_DEPLOY_ID=dev-<wp>`, inside the WP's live budget (§7).
6. **Definition of done** for every WP:
   - `npm run typecheck` is clean and `npm test` passes;
   - the WP's acceptance tests pass;
   - `docs/notes/<wp>.md` records decisions, Day-1 test results, measured numbers and known gaps.
7. **Stack.** TypeScript **6.0.3** for the app (D10), ESM, strict, `noUncheckedIndexedAccess`. Next.js 16 App Router. Route handlers use `runtime="nodejs"`.
8. **Clean up after live tests:** stored agents, test checkouts, open sessions. Always send `Terminate` / `session.end`.

---

## 1. Waves and dependency graph

```
Wave 0 (D0 21:00 → D1 08:00)   WP0a contracts + promoted core      WP0b scaffold + DB + deploy skeleton + file guard
                                   └──────────────── G0: contracts frozen, merged, pushed ───────────────┘
Wave 1 (D1 09:00 → D3 16:00)
   core/server:  WP1 case engine · WP2 platform + limits authority · WP3 cases + extraction · WP8 async verification
   realtime:     WP4 audio + STT replay ──► WP5 takeover protocol ◄──► WP5b Voice Agent client + Day-1 VA tests
   product:      WP6 tools + payments + MockPhone · WP7 call console · WP7b landing/about/status
   data:         WP9 takes → assets, labels, STT + extraction caches (D1–D2)
   pitch:        WP13 pitch pack (D1 → D5)
                 G2 (D2 14:00) vertical slice · G3 (D3 16:00) full judge path on Zerops
Wave 2 (D2 09:00 → D4 20:00)   WP9b sweep + spot-checks + K reports · WP10 evals/explorer/promote · WP11 customer input,
                               TTS, tail pack, recorded bundles · WP12 integration, e2e, deploy, K4, matrix, runbook
```

**Critical path:** WP0a → WP1 + WP4 → WP3 → WP5 + WP5b → WP7 (orchestrator) → WP6 (pay stage) → G3 → video.
**Evidence path:** recordings (D1) → WP9 labels + caches (D1–D2) → WP9b sweep (D2 20:00 pilot) → WP10 pages (D4) → video evidence beat (D4 19:00).

| Wave | Packages | Start | Must finish |
|---|---|---|---|
| 0 | WP0a, WP0b | **D0 (Thu Sep 24) 21:00** | D1 08:00 (G0) |
| 1 | WP1, WP2, WP3, WP4, WP5, WP5b, WP6, WP7, WP7b, WP8, WP9, WP13 | D1 09:00 | Slice by D2 14:00 (G2); full path by D3 16:00 (G3) |
| 2 | WP9b, WP10, WP11, WP12 | D2 09:00 (WP12 scaffolding from D1 PM; WP10's T-D1-11 at D2 09:00) | D4 20:00 (feature freeze) |

**Staffing priority** if fewer agents are available (≥6 recommended): WP0a, WP0b → WP1, WP4, WP5b, WP3, WP5, WP2, WP7, WP6, WP9, WP13 → WP8, WP11, WP9b, WP12, WP10, WP7b. With 6 agents, pair up: {WP1, WP3}, {WP4}, {WP5, WP5b}, {WP2, WP8}, {WP7, WP7b}, {WP6}; then WP9/WP9b/WP10/WP11/WP12/WP13 as agents free up (WP9 and WP13 have no code dependencies and should start D1).

---

## 2. Wave-0 contracts package (WP0a writes these; frozen at G0)

DESIGN §4.1 defines the data types (`CaseState`, `TurnInput`, `FactEvent`, `BatonEvent`, `RunPlan`, `CompiledTakeover`, `TranscriptionMode`, `DrainReport`, `SweepPoint`, …) and §4.4 the route request/response shapes (zod in `contracts/api.ts`). The interfaces below go in `src/core/contracts/services.ts` (types only). They are the seams between packages.

```ts
// ---------- limits authority (DESIGN §2.3; implemented by WP2 [db, remote] and WP0b [file guard]) ----------
export type OpenSource = "judge" | "script" | "synthetic" | "test" | "mirror";
export type SlotResult = { status: "granted"; grantId: string } | { status: "queued"; ticket: string; position: number; etaMs: number }
  | { status: "denied"; code: "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_QUEUE_TIMEOUT" | "E_RATE_LIMITED" | "E_AAI_BALANCE"; message: string };
export interface LimitsAuthority {
  sttAcquire(req: { n: 1 | 2; visitorId: string; ipKey: string; ticket?: string; runId?: string; reconnect?: boolean;
                    source: OpenSource; deployId: string }): Promise<SlotResult>;            // ETA > 15 s ⇒ denied(E_QUEUE_TIMEOUT)
  sttCancel(ticket: string): Promise<void>;
  vaHold(req: { runId: string; visitorId: string; ipKey: string; expiresAt: string; estUsd: number; deployId: string }):
    Promise<{ ok: true; holdId: string } | { ok: false; code: "E_VA_CAPACITY" | "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_AAI_BALANCE"; message: string }>;
  vaAcquire(req: { holdId?: string; takeoverId?: string; attempt: 0 | 1; capMs: number; source: OpenSource; deployId: string }):
    Promise<{ ok: true; liveSessionId: string } | { ok: false; code: "E_VA_CAPACITY" | "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_AAI_BALANCE"; message: string }>;
  release(liveSessionIdOrHoldId: string, reason: string): Promise<void>;
  heartbeat(liveSessionId: string): Promise<void>;
  report(r: SessionReport): Promise<void>;                                                   // opened/closed, billed seconds
  ledger: SpendLedger;
  flags(): Promise<AppFlags>;
}
export type GetLimitsAuthority = () => LimitsAuthority;   // by LIMITS_ROLE: "authority" → db; "remote" → HTTP; unset URL → file guard

// ---------- server (implemented in src/server/**) ----------
export interface RateLimiter { hit(bucket: string, key: string, limit: number, windowSec: number, cost?: number): Promise<{ ok: boolean; retryAfterSec: number }> }
export interface SpendLedger {
  reserve(e: { provider: "aai_stt" | "aai_va" | "aai_async" | "openai" | "polar"; action: string; refId: string; estUsd: number; env: string }):
    Promise<{ ok: true; id: string } | { ok: false; code: "E_BUDGET" }>;
  settle(id: string, actualUsd: number): Promise<void>; release(id: string): Promise<void>;
  summary(): Promise<{ sinceEpochUsd: number; todayUsd: Record<string, number>; dailyCapUsd: number; judgingBudgetUsd: number; pctToday: number;
                       byEnv: Record<string, number> }>;
}
export interface AppFlags { mode: "live" | "replay_only" | "maintenance"; reason: string | null; notice: string | null;
  paymentsModeOverride: "polar" | "mock" | null; aaiBalanceUsd: number | null }
export interface FlagStore { get(): Promise<AppFlags>; set(patch: Partial<AppFlags>, reason: string): Promise<void> }
export interface RunService { start(i: StartRunRequest & { visitorId: string; ipKey: string }): Promise<RunPlan>; release(runId: string): Promise<void> }
export type JobKind = "verify_takeover" | "purge" | "va_audit" | "budget_guard";
export interface JobRunner {
  register(kind: JobKind, step: (job: { id: string; refId: string; state: unknown; attempts: number }) => Promise<{ state: unknown; next: "done" | "failed" | { afterMs: number } }>): void;
  enqueue(kind: JobKind, refId: string, opts?: { runAfterMs?: number; state?: unknown }): Promise<string>;
  advance(jobId: string): Promise<"pending" | "running" | "done" | "failed">; tick(): Promise<number>;
}
export interface CaseRepository {
  create(input: { mode: "watch" | "live" | "spot" | "synthetic"; callId: string | null; scenarioId: string; visitorId: string; ipKey: string; prefillUntilMs?: number }): Promise<{ caseId: string; state: CaseState; policy: PolicyRecord }>;
  load(caseId: string): Promise<{ state: CaseState; version: number; policy: PolicyRecord; status: string; tArmMs: number | null; scenarioId: string; callId: string | null; runPlan: RunPlan | null } | null>;
  insertTurn(t: TurnInput): Promise<"inserted" | "duplicate">;
  applyEvents(caseId: string, expectedVersion: number, events: Omit<FactEvent, "seq">[]): Promise<{ state: CaseState; version: number }>;  // short tx + advisory lock; re-derives if newer events landed
  recompute(caseId: string, ctx?: { tArmMs?: number }): Promise<CaseState>;
  freezeSnapshot(caseId: string, takeoverId: string, drain: DrainReport): Promise<CaseState>;   // used by WP5 compile
  setRunPlan(caseId: string, plan: RunPlan): Promise<void>;
}
export interface Extractor { extractTurn(input: ExtractTurnInput): Promise<ExtractTurnOutput> }   // never called inside a DB transaction
export interface Verifier { verifyCase(input: { caseId: string; policy: PolicyRecord; callDate: string; turns: TurnInput[] }): Promise<VerifierResult & { ms: number; usd: number }> }
export interface ToolContext { caseId: string; takeoverId: string; callId: string; visitorId: string; origin: string }
export interface ToolOutcome { result: Record<string, unknown>; stage?: Stage; systemPrompt?: string; tools?: VaFunctionTool[];
  transcriptionMode?: TranscriptionMode; ui?: { sms?: string; link?: string; paymentId?: string; conflict?: ConflictCard } }
export interface ToolService { handle<N extends ToolName>(name: N, args: ToolArgs[N], ctx: ToolContext): Promise<ToolOutcome> }
export interface PaymentProvider { kind: "polar" | "mock";
  createCheckout(i: { paymentId: string; caseId: string; takeoverId: string; scenarioId: string; amountCents: number; policy: PolicyRecord; origin: string }):
    Promise<{ checkoutId: string | null; url: string | null; embed: { url: string; origin: string } | null; totalAmountCents: number | null; taxAmountCents: number | null }>;
  getStatus(checkoutId: string): Promise<{ status: PaymentStatus; totalAmountCents: number | null }> }
export interface TakeoverService {
  arm(i: ArmRequest & { visitorId: string }): Promise<ArmResponse>;
  compile(takeoverId: string, drain: DrainReport): Promise<CompiledTakeover>;       // runs validateFirstUpdate before returning
  recordEvents(takeoverId: string, e: TakeoverEventsRequest): Promise<void>;          // heartbeat → LimitsAuthority.heartbeat
  end(takeoverId: string, e: EndTakeoverRequest): Promise<{ verificationJobId: string | null }>;
}
export type EnqueueVerification = (takeoverId: string, vaSessionId: string | null) => Promise<string | null>;   // WP8

// ---------- pure core helpers other WPs call (implemented by WP1 in src/core/compiler/**) ----------
export type ValidateFirstUpdate = (msg: { type: "session.update"; session: Record<string, unknown> }, opts: { keytermsEnabled: boolean }) => void; // throws E_VA_CONFIG
export type InputModeFor = (next: { kind: "confirm" | "ask" | "disclosure" | "consent" | "none"; field: FieldId | null }) => InputModePlan;
export type VaSessionCapMs = (snapshot: CaseState, env: { baseMs: number; perFieldMs: number; maxMs: number }) => number;

// ---------- client (implemented in src/client/**) ----------
export interface EventSink { emit(ev: BatonEvent): void }
export interface CallTick { callMs: number; playing: boolean; rep: Uint8Array; customer: Uint8Array }   // source-format bytes since the last tick
export interface CallPlayback { start(fromMs: number): void; stop(fadeMs?: number): void; dispose(): void; readonly callMs: number;
  onTick(cb: (t: CallTick) => void): () => void; onEnded(cb: () => void): () => void; duck(level: number): void;
  channelEnergyDb(ch: Channel, windowMs: number): number; playSpan(ch: Channel | "both", fromMs: number, toMs: number): Promise<void>;
  playHandoffClip(h: NonNullable<CallManifestEntry["handoff"]>): Promise<{ endCtxMs: number }> }   // rep line + 300 ms + customer acceptance
export interface VaOutputPlayer { push(b64Pcm24k: string, replyId: string, audible: boolean): void; flush(): void; holdUntil(ctxTimeMs: number): void;
  onFirstAudiblePlayed(cb: (replyId: string, ctxTimeMs: number) => void): () => void; setVolume(v: number): void; readonly underruns: number }
export interface PacedFeeder { start(send: (frame24k: Uint8Array) => void): void; stop(): void; enqueueClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }>;
  setMicSource(src: MicSource | null): void; clear(): void }
export interface MicSource { onFrame(cb: (pcm: Int16Array) => void): () => void; stop(): Promise<void>; energyDb(): number }
export interface AudioEngine { readonly ctx: AudioContext; unlockSync(): void;   // MUST be called synchronously inside the click handler (resume + iOS audioSession "playback")
  nowMs(): number; setAudioSession(kind: "playback" | "play-and-record"): void;
  loadCall(entry: CallManifestEntry, assets: CreateCaseResponse["assets"], onProgress?: (p: number) => void): Promise<CallPlayback>;
  createVaOutput(): VaOutputPlayer; createFeeder(): PacedFeeder; openMic(targetRate: 16000 | 24000): Promise<MicSource>;
  playPcm24k(pcm: Int16Array, opts?: { volume?: number }): Promise<void> }
export interface PageLifecycle { onPause(cb: (reason: "ios_background" | "audio_interrupted") => void): () => void;
  onResume(cb: () => void): () => void; readonly isIOS: boolean }                       // WP4, src/client/platform/lifecycle.ts
export interface SttChannelManager {
  open(p: { caseId: string; caseToken: string; runId: string; call: CallManifestEntry; policy: PolicyRecord; startOffsetMs: number;
            ctxCarry: "none" | "last_rep_turn"; seedAgentContext?: string }): Promise<"live" | "queued" | "denied">;
  feed(t: CallTick): void; hasOpenPartial(ch: Channel): boolean; forceEndpoint(ch: Channel): void; pause(): Promise<void>; resume(): Promise<void>;
  terminateAll(): Promise<{ channel: Channel; billedSeconds: number | null }[]>; readonly status: Record<Channel, "idle" | "queued" | "open" | "closed" | "cached" | "paused"> }
export interface CaseSync { enqueue(turn: TurnInput): void; drain(timeoutMs: number): Promise<Pick<DrainReport, "completedTurnIds" | "pendingTurnIds" | "waitedMs">>;
  readonly state: CaseState | null; onState(cb: (s: CaseState) => void): () => void }
export interface LatencyHud { mark(name: "arm" | "repLineStart" | "repLineEnd" | "updateSent" | "sessionReady" | "eos" | "replyStarted" | "firstAudiblePlayed", ctxMs: number, replyId?: string): void;
  summary(): Partial<Record<HudMetric, { last: number; p50: number; p90: number; n: number }>>; setSessionIds(ids: { rep?: string; customer?: string; va?: string }): void }
export interface TakeoverController { arm(source: "manual" | "auto_handoff"): Promise<void>; readonly phase: TakeoverPhase; abort(reason: string): void;
  readonly manualPassAllowed: boolean }                                                   // false when RunPlan.aiHalf === "recorded"
export interface VoiceAgentController {
  connect(token: string): Promise<void>; start(c: CompiledTakeover, opts: { holdAudioUntilCtxMs: number }): Promise<{ sessionId: string }>;
  applyStage(r: Pick<ToolOutcome, "systemPrompt" | "tools" | "stage" | "transcriptionMode">): void; say(instructions: string): void;   // reply.create
  setPayingState(phone: PhoneState): void;                                                 // drives the progress-aware hold (DESIGN §5.8)
  end(reason: string): Promise<void>; readonly sessionId: string | null }
export type PhoneState = "idle" | "sms-received" | "esign" | "signed" | "checkout-loading" | "checkout-open" | "processing" | "simulating"
  | "autopilot-countdown" | "paid" | "failed" | "expired" | "timeout";
export interface MockPhoneProps { events: BatonEvent[]; paymentId: string | null; takeoverToken: string; variant: "docked" | "floating";
  readOnly: boolean; autopilot: boolean; onState(s: PhoneState): void }                  // WP6 component; WP7 mounts it
export interface CustomerInput { mode: "autopilot" | "chips" | "typed" | "mic"; suggestions(): Suggestion[]; play(s: Suggestion): Promise<void>;
  sendTyped(text: string): Promise<void>; enableMic(): Promise<boolean>; setAutopilot(on: boolean): void }
export interface Suggestion { id: string; text: string; audioUrl: string | null; voice: "recorded" | "synthetic";
  kind: "confirm" | "answer" | "consent" | "handback" | "repeat" | "close" | "try" | "other" }
export interface ReplayPlayer { load(bundleUrl: string): Promise<void>; play(sink: EventSink): Promise<void>; stop(): void }
export interface BatonStore { dispatch(ev: BatonEvent): void; getState(): BatonUiState; subscribe(cb: () => void): () => void }   // BatonUiState: WP7
```

---

## 3. Work packages

### 3.0 Ownership map (disjoint; a path not listed belongs to the integrator)

| WP | Owns |
|---|---|
| WP0a | `src/core/contracts/**` (not `ext/`), `src/core/intents/add-driver.fields.ts`, `src/core/aai/{streaming,voice-agent}.ts`, `src/core/audio/**`, `src/server/aai/{va-node,async}.ts`, `src/server/openai/client.ts`, `tests/unit/{contracts,core/audio}/**`, `tests/unit/core/fields-parity.test.ts` |
| WP0b | root configs (`package.json`, lockfile, `next.config.mjs`, `tsconfig.json`, `postcss.config.mjs`, `components.json`, `drizzle.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.env.example`, `.deployignore`), `src/server/{env,log}.ts`, `src/server/db/**`, `src/lib/**`, `src/app/{layout.tsx,globals.css}`, `src/components/ui/**`, `src/app/api/health/**`, `src/instrumentation.ts`, `src/app/dev/csp/**`, `drizzle/**`, `scripts/{migrate.ts,cron.ts,assemble-bundle.mjs,gen-secrets.ts}`, `scripts/lib/**`, `tests/unit/boundaries.test.ts`, `zerops.yml`, `zerops-project-import.yml`, `vercel.json`, `.github/workflows/**` (deploy files, workflows and `drizzle/**` move to WP12 at D2 09:00) |
| WP1 | `src/core/intents/add-driver.ts`, `src/core/case/**`, `src/core/compiler/**`, `src/core/qa/**`, `src/core/evidence/**`, `tests/unit/core/{intents,case,compiler,qa,evidence}/**` |
| WP2 | `src/proxy.ts`, `src/server/{auth,limits,registry,health,runs}/**`, `src/server/flags.ts`, `src/server/aai/tokens.ts`, `src/server/jobs/{runner,purge,budget-guard}.ts`, `src/app/api/{stt,va,runs,sessions,status,internal,admin}/**`, `tests/unit/server/{auth,limits,jobs,registry,runs}/**`, `tests/integration/tokens.test.ts` |
| WP3 | `src/server/cases/**`, `src/server/openai/{extractor,verifier}.ts`, `src/server/data/**`, `src/app/api/{cases,extract}/**`, `tests/unit/server/cases/**`, `tests/integration/extractor.test.ts`, `tests/fixtures/extract/**` |
| WP4 | `src/client/{audio,stt,case,platform}/**`, `src/client/replay/cached-replay.ts`, `src/core/aai/stt-params.ts`, `src/app/dev/audio/**`, `scripts/day1/stt-*.ts`, `public/fixtures/**`, `tests/unit/client/{audio,stt,case,platform}/**` |
| WP5 | `src/core/protocol/takeover-machine.ts`, `src/client/takeover/**`, `src/server/takeovers/**`, `src/app/api/takeovers/**`, `tests/unit/core/protocol/**`, `tests/unit/server/takeovers/**` |
| WP5b | `src/client/{va,hud}/**`, `scripts/day1/va-*.ts`, `scripts/day1/fixtures/**`, `tests/unit/client/{va,hud}/**`, `tests/integration/{va-core,va-retry}.test.ts` |
| WP6 | `src/server/{tools,rating,payments,polar}/**`, `src/app/api/{tools,payments}/**`, `src/app/api/webhooks/polar/**`, `src/app/pay/**`, `src/client/tools/**`, `src/components/phone/**`, `scripts/polar/**`, `scripts/day1/polar-*.ts`, `tests/unit/server/{tools,payments,polar}/**`, `tests/integration/polar.test.ts` |
| WP7 | `src/app/call/**`, `src/app/dev/ui/**`, `src/components/{call,case,qa,hud,common,layout}/**`, `src/client/{store,fixtures,session}/**`, `tests/unit/ui/**` |
| WP7b | `src/app/page.tsx`, `src/app/{about,status}/**`, `src/components/{landing,about,status}/**`, `tests/unit/ui-static/**` |
| WP8 | `src/server/jobs/{verify-takeover,va-audit}.ts`, `src/server/aai/va-rest.ts`, `src/server/qa/**`, `src/app/api/webhooks/assemblyai/**`, `src/app/api/{verifications,va-sessions}/**`, `scripts/day1/session-delete.ts`, `tests/unit/server/verify/**`, `tests/integration/async-verify.test.ts` |
| WP9 | `scripts/calls/**`, `scripts/eval/{label-ground-truth,review-labels,cache-stt,extract,verify-cache}.ts`, `src/core/scenario/**`, `src/generated/**` (from G0), `data/{labels,cache,golden}/**`, `public/calls/**`, `public/data/cached-turns/**`, `tests/unit/core/scenario/**` |
| WP9b | `src/core/protocol/simulate.ts`, `src/core/eval/**`, `scripts/eval/{sweep,live-spotcheck,k1,k2,report}.ts`, `data/evals/**`, `public/data/{explorer,evals}/**`, `tests/unit/core/{eval,simulate}/**` |
| WP10 | `src/app/{evals,explorer}/**`, `src/components/{evals,explorer,promote}/**`, `src/server/promote/**`, `src/app/api/{evals,promote,agent-tools}/**`, `scripts/day1/promote-probe.ts`, `tests/unit/server/promote/**` |
| WP11 | `src/client/customer/**`, `src/client/replay/recorded-session.ts`, `src/server/openai/tts.ts`, `src/app/api/tts/**`, `scripts/tts/**`, `public/tts/**`, `public/replays/**`, `tests/unit/client/customer/**` |
| WP12 | `tests/e2e/**`, `tests/integration/harness/**`, `scripts/loadtest.ts`, `docs/RUNBOOK.md`, `docs/notes/{deploy,browser-matrix}.md`; from D2 09:00 the deploy files, `.github/workflows/**` and additive `drizzle/**` migrations; the integration merges when delegated |
| WP13 | `README.md`, `docs/pitch/**`, `public/cover.png`, `src/content/**` (typed copy and numbers that WP7b renders on `/about`) |

Not owned by any WP (read-only for all): `data/scenarios/**`, `data/calls/**`, `tools/recording-kit/**` (the recording-kit agent), `spikes/**` (frozen), `research/**`, `docs/{DESIGN,TASKS,recording-day,role-cards}*` (the planner).

---

### WP0a: Contracts and promoted core (Wave 0, tonight; 5 h)

**Goal:** every type and interface other WPs code against, plus the promoted, browser-safe AssemblyAI and audio code.

**Provides:**
- `src/core/contracts/{case,turns,scenario,run,events,errors,tools,takeover,extract,eval,api,services}.ts` exactly per DESIGN §4.1, §4.4 (zod schemas with `Schema` suffix) and §2 above.
- `src/core/intents/add-driver.fields.ts` (FieldId lists, REQUIRED, REP_ONLY, AI_SETTABLE, ADVICE_DOMAIN).
- Promoted modules per DESIGN §3.2 (fixes 5.3-1…5.3-5): `StreamingSession`, `FrameBatcher`, `TurnTracker`, `buildStreamingUrl`, `mintStreamingToken` (server use), `VoiceAgentSession`, `ToolDispatcher`, `ReplyTracker`, `RealtimeAudioFeeder`, `AssemblyAIAsyncClient`, `extractStructured`, `openSpeechPcmStream`, the audio codecs.

**Acceptance:**
1. `npm run typecheck && npm test` passes: zod round-trips for every API schema; the fields-parity test (kit `FACT_FIELDS`, `REQUIRED_FIELDS` and enums equal ours); the ported audio self-tests (19/19 equivalent).
2. `src/core/**` imports nothing from `node:*`, DOM or `process.env`.

### WP0b: Scaffold, DB, file guard, deploy skeleton (Wave 0, tonight; 5 h)

**Goal:** a compiling, deployable, empty app, and a safe way for every agent to open live sessions before the authority exists.

**Provides:**
- Next 16 app with every dependency in DESIGN §3.3 pre-installed; shadcn base components; `env()` (zod, lazy, never prints values); `log` with redaction; `getDb()` (pool 15, `connectionTimeoutMillis: 3000`, `statement_timeout 5000`).
- The full schema of DESIGN §4.2 in **one** initial migration; `migrate.mjs`; `cron.mjs`; `assemble-bundle.mjs`.
- `scripts/gen-secrets.ts` (`npm run secrets:init`): appends any missing secret name from DESIGN §3.4 to `.env` with a random value, **never printing it**.
- `scripts/lib/local-open-guard.ts` (file-lock `LimitsAuthority` for this laptop: 4 STT opens/60 s, 1 VA session) and `scripts/lib/aai-open.ts` (`openStreaming()`, `openVoiceAgentNode()`: acquire through `getLimitsAuthority()`, connect, report, always close).
- `tests/unit/boundaries.test.ts` (DESIGN §3.1, including the direct-open ban).
- `zerops.yml`, `zerops-project-import.yml` (DESIGN §10.1), `vercel.json`, `.github/workflows/monitor.yml` (DESIGN §7.7; enabled once `APP_URL` exists).

**Acceptance:**
1. `npm ci && npm run typecheck && npm test && npm run build` → `bundle/server.js`; `node bundle/migrate.mjs` creates all tables on a fresh Postgres 17 and is a no-op the second time.
2. `GET /api/health` → `{ok:true, db:true}` locally.
3. **T-D1-8** (as soon as the user has run `zcli login`): deployed with `zcli push`, green `/api/health` on the `*.zerops.app` subdomain. **T-D1-10:** CSP header present and a blob-URL AudioWorklet loads with no violations (`src/app/dev/csp`).
4. `npx license-checker --summary` shows only MIT/Apache/BSD/ISC-compatible licences.

---

### WP1: Case engine core, pure (Wave 1; 12 h)

**Goal:** everything deterministic about facts, statuses, greetings, prompts, stages, first-update validation, disclosures, QA and evidence, fully unit-tested.

**Consumes:** DESIGN §4.1 types; `add-driver.fields.ts`.

**Provides:**

| Area | Exports |
|---|---|
| Normalizing | `normalizeField(field, raw, ctx)`, `compatible`, `mergeValues`, `resolveRelativeDate(words, callDate)` (shared with the `confirm_effective_date` handler) |
| Applying extraction | `applyExtraction(raw, turns, ctx) → Omit<FactEvent,"seq">[]` (§5.3 post-processing and evidence alignment) |
| Deriving state | `deriveCaseState(policy, events, ctx)`, `deriveV1(...)` |
| Greeting and prompt | `compileGreeting`, `compileGreetingV1`, `compilePrompt(state, policy, stage, {deployId})` (TODAY line and deploy marker, §5.7), `PROMPT_VERSION` (marker excluded) |
| Stages, tools, first update | `TOOL_SCHEMAS`, `toolsForStage`, `initialStage`, `nextStage`, `inputModeFor` (§5.9.1), `vaSessionCapMs` (§5.9.5), `buildFirstUpdate(compiled)`, `validateFirstUpdate(msg, opts)` (§5.9.1 whitelist) |
| Disclosures | `disclosureText(kind, ctx, {taxSuffix})` → `{text, criticalTokens}`, spoken formats |
| Suggested replies | `suggestReplies(ctx)` incl. the loop-breaker sentence and the "Try this" chip (texts only; audio is WP11) |
| QA | `computeQa`, `verbatimSimilarity`, `isRequest`, `targetedFields` |
| Evidence | `clipWindow` |
| Extractor artefacts | `EXTRACTOR_PROMPT_V3`, `EXTRACTOR_PROMPT_V1`, `ADD_DRIVER_PATCH_FORMAT` |

**Acceptance:**
- every DESIGN §9.1 case for normalizers, status rules, greeting, prompt, stage tools, **first update**, **input mode**, **dynamic cap**, re-ask, verbatim, evidence;
- a property test: for 500 random states the greeting asserts only VERIFIED values plus at most one PENDING confirm value;
- `validateFirstUpdate(buildFirstUpdate(compile(s)))` passes for the s01, s02 and s05 fixture states in both initial stages, and the output equals WP5b's T-D1-0 fixtures byte-for-byte (shape);
- scenario fixtures s01/s02/s05 give `expectedAtHandoff` statuses; greeting snapshots committed;
- ≥90% line coverage on `src/core/case` and `src/core/compiler`.
- **Early deliverable (D1 13:00):** `tool-schemas.ts`, `stages.ts`, `first-update.ts` and `greeting.ts` merged into WP1's branch first, so WP5/WP5b can import them at the D1 20:00 gate.

### WP2: Platform and the limits authority (Wave 1; 12 h)

**Goal:** the free-tier guardrails for the whole account, and the shared server plumbing.

**Consumes:** `LimitsAuthority`, `RateLimiter`, `SpendLedger`, `FlagStore`, `RunService`, `JobRunner`; `getDb`, `env`, `mintStreamingToken`, `VoiceAgentRest.mintToken`; WP4's `buildSttParams` (import; local golden defaults until it lands); WP1's `vaSessionCapMs`.

**Provides:**
- Auth: `requireVisitor` (cookie, or the signed `x-baton-visitor` fallback), `issueCaseToken`, `requireCase`, `ipKeyOf(req)`.
- `DbLimitsAuthority` (broker with the ETA > 15 s rule, ticket expiry, per-ipKey ticket cap; VA registry with holds, heartbeats and staleness; ledger with epoch semantics and the dynamic daily cap; flags) and `RemoteLimitsAuthority` (HTTP client of route #28), `getLimitsAuthority()`.
- Routes (DESIGN §4.4): #2 status, #5 STT token, **#5a runs**, **#5b run release**, #6, #7 report, #10 VA token (takeover-keyed, `attempt`), #26 cron, #27 admin (incl. `aaiBalanceUsd`), **#28 limits**.
- Background: F5 sweeper (15 s), F7 synthetic checks, **F8 budget guard**, the purge job (`registerPurgeStep` hook for WP8), `startInprocWorker()` (2 s tick).

**Acceptance:**
1. 10 parallel `sttAcquire({n:2})` against real Postgres never grant more than 4 opens per rolling 60 s; FIFO; ETA > 15 s → `denied(E_QUEUE_TIMEOUT)`; a ticket not polled for 3 intervals expires; a third ticket from one ipKey is refused.
2. The same test through `RemoteLimitsAuthority` against the route handlers gives the same results.
3. Ledger: pre-epoch spend never counts; the dynamic cap formula (DESIGN §7.2) with a fake clock; over-cap → `E_BUDGET` + `replay_only` (`budget_daily`), restored after 00:00 UTC; `aaiBalanceUsd` below the reserve → `replay_only` (`aai_balance`).
4. `POST /api/runs` returns `aiHalf:"live"` with a hold, or `aiHalf:"recorded"` with a plain reason when the budget or VA slots are exhausted; a hold expires and is released by the sweeper.
5. `/api/va/token`: `attempt:0` refused after 30 s or when `retries=1`; `attempt:1` allowed once within 30 s of `last_failure_at`, releases the failed slot first, sets `retries=1` atomically. A missing heartbeat for 30 s frees a slot.
6. Case token with the wrong `vid` → 403; expired → 401. A cookie-less client works through the header.
7. Synthetic `light` passes against real APIs; `full` passes once (`RUN_LIVE=1`, ≈$0.01). Any mint error mentioning credit/balance maps to `E_AAI_BALANCE`.

### WP3: Cases and extraction (Wave 1; 8 h)

**Goal:** create cases, ingest turns, run the luna patcher outside any transaction, derive deterministically, run the sol verifier in the background, freeze snapshots.

**Consumes:** `CaseRepository`, `Extractor`, `Verifier`, route shapes #3, #4, #8; WP1 `applyExtraction`, `deriveCaseState`, `EXTRACTOR_PROMPT_V3`, `ADD_DRIVER_PATCH_FORMAT`; WP2 `requireVisitor`, `requireCase`, `RateLimiter`, `getLimitsAuthority().ledger`; WP0a `extractStructured`.

**Provides:** routes #3, #4, #8; F1 exactly as DESIGN §4.5 (no transaction across the LLM call; version check); §5.3 budgets (≈8 s timeout at 1000 tokens, newest-turn retry, ≤3 turns per batch); F2 (≥15 s cadence, ≤8 runs, **no overlapping runs**, downgrade-only); prefill; cached events for `stt_cache`; `freezeSnapshot`; `skipped:"after_takeover"`.

**Acceptance:**
1. Extractor integration (`RUN_LIVE=1`): the 12-turn fixture → ≥9/10 labelled events correct. **Measure p50/p95 `extractMs` from the Zerops host** on D1 by posting the fixture turns to the deployed `/api/extract`, and record them in `docs/notes/wp3.md` for WP9b and the `DRAIN_MAX_MS` check.
2. 20 turns posted in random order at 10/s → final state equal to sequential application; no duplicate `seq`; no pool exhaustion with 3 concurrent cases and payment polling (pool 15).
3. The verifier never upgrades; runs never overlap.
4. Prefill makes 0 OpenAI calls and equals the live-replayed state.
5. A turn after the freeze returns `skipped` and never alters `takeovers.snapshot`.

### WP4: Browser audio engine, per-channel STT replay, case sync, cached replay, page lifecycle (Wave 1; 14 h)

**Goal:** a real recorded call plays and streams through two live U3.5 Pro sessions in sync, survives background tabs, pauses cleanly on iOS, and feeds `/api/extract` in order.

**Consumes:** `AudioEngine`, `CallPlayback`, `CallTick`, `VaOutputPlayer`, `PacedFeeder`, `MicSource`, `PageLifecycle`, `SttChannelManager`, `CaseSync`, `EventSink`, `CallManifestEntry`, `CreateCaseResponse`, `RunPlan`; WP0a promoted clients and codecs; routes #5, #7 (WP2), #8 (WP3) (fetch fakes until they land).

**Provides:** DESIGN §5.1 (incl. the handoff clip with the acceptance span, Express snapping and `agent_context` seeding, 10 s token use, the production-warn `Begin` check, 3006-inactivity handling), §5.2, the §5.9.2 feeder, the §5.9.3 output player (adaptive jitter, underrun count, `bufferedAmount` badge signal), `playSpan`/`duck`, `unlockSync` with the iOS audio session (DESIGN §7.6), `PageLifecycle`, `buildSttParams` with per-channel Hinglish params and the URL snapshot test.

**Acceptance:**
1. `/dev/audio` replays s01's chosen take (or `spikes/fixtures/dialog_stereo_16k.wav` until takes exist) through 2 live sessions: finals on the correct channel; no 3007; feed offset <50 ms over 3 min; `Begin` checks pass.
2. Background tab for 60 s: frames keep pace (±2%), finals keep arriving (desktop).
3. **T-D1-7** incl. an iPhone with the silent switch on (audible), recorded in `docs/notes/wp4.md`.
4. **T-D1-6** (v1.1 grid, 16 sessions + 1 Hinglish run) with `TUNING_8K` chosen.
5. `CaseSync.drain(2000)` correct under a slow extract stub. Cached replay emits finals at `recvMs` ±50 ms with the mode label.
6. iOS: hiding the tab pauses STT cleanly (no 3006 surprise); resume reconnects via the offset path.

### WP5: Takeover protocol, server routes and controller (Wave 1; 10 h)

**Goal:** a click at any second (or auto-baton) freezes the right snapshot and hands a compiled, validated config to the VA client; recorded-AI runs never arm manually.

**Consumes:** `TakeoverController`, `TakeoverService`, `CompiledTakeover`, `DrainReport`, `RunPlan`, routes #9, #11–#13; WP1 compile functions, `validateFirstUpdate`, `vaSessionCapMs`, `inputModeFor`; WP3 `freezeSnapshot`; WP2 `issueCaseToken`, `getLimitsAuthority().heartbeat`; WP4 `CallPlayback`, `SttChannelManager`, `CaseSync`; WP5b `VoiceAgentController`; WP11 `ReplayPlayer` (recorded half); WP8 `EnqueueVerification` (stub until it ships).

**Provides:** the pure reducer (DESIGN §5.5, incl. rules 6–8), `TakeoverController` (manual + auto-baton, the handoff clip, recorded-AI path, hold release), `TakeoverService` (arm, compile with `validateFirstUpdate`, events incl. heartbeat and failure, end, `leadMs`).

**Acceptance:**
1. Machine unit tests: every transition and timeout (fake clock); ForceEndpoint only after `SEAL_TAIL_MS`; retry at most once with `attempt:1`; `pagehide` from every state releases the run; auto-baton; recorded runs never arm manually.
2. `/compile` returns a config that passes `validateFirstUpdate` for s01, s02, s05 at 3 pass points each.
3. The **G2 vertical slice** (with WP4, WP5b, WP3, WP1): `/dev/audio` or `/call/<s01>` → Pass → greeting audible, with the correct snapshot.

### WP5b: Voice Agent client, HUD, Day-1 VA tests (Wave 1; 12 h)

**Goal:** the AI half: first update, progressive tools, the progress-aware hold, dynamic cap, captions, barge-in, HUD, retry, clean shutdown.

**Consumes:** `VoiceAgentController`, `LatencyHud`, `PhoneState`, `ToolOutcome`; WP0a `VoiceAgentSession`, `ToolDispatcher`, `ReplyTracker`; WP4 `VaOutputPlayer`, `PacedFeeder`, `PageLifecycle`; WP6 `callTool()`, `awaitPaymentResolution()`; WP1 `validateFirstUpdate`.

**Provides:** DESIGN §5.9 (first message with the whitelist; input-mode switching; stage ordering; §5.8 hold protocol steps 1–8; dynamic cap with the wrap-up paused in `paying`; iOS hidden → `session.end` after 10 s), §5.10 (HUD incl. session ids and dead-air-first display; captions; barge-in), heartbeats.

**Day-1 tests (in this order, D1):** **T-D1-0 at 09:30** using hand-written fixtures `scripts/day1/fixtures/first-update-{confirm,disclose}.json` built verbatim from DESIGN §5.6/§5.8/§5.9.1 (re-run with WP1's compiler output at the D1 20:00 gate); then T-D1-1…T-D1-5. Results and the chosen fallbacks (`VA_KEYTERMS`, `PAY_TOOL_MODE`, WS pre-open, input-mode mutability) go in `docs/notes/wp5b.md`.

**Acceptance:**
1. T-D1-0 … T-D1-5 executed and recorded.
2. Integration (`RUN_LIVE=1`, Node): a compiled s02 snapshot → greeting verbatim; the PENDING date confirmed via `confirm_effective_date`; stage change to `disclose` accepted with §5.9.4 ordering; `session.end`. The VA-retry integration test (DESIGN §9.2) passes.
3. **K2** (§6): 10 manual takeovers of s01 from India, plus **one early pass at t≈20 s that completes a real Polar payment and a confirmation** (with WP6/WP7 on D3).
4. A barge-in flushes playback within one frame; interrupted captions are truncated. The wrap-up never fires in `paying`/`closing`.

### WP6: Tools, rating, disclosures, payments (Polar + mock + simulate), MockPhone (Wave 1; 14 h)

**Goal:** tool handlers that gate the flow, and a fail-closed pay step that never dead-ends and never navigates.

**Consumes:** `ToolService`, `ToolContext`, `ToolOutcome`, `PaymentProvider`, `PaymentStatus`, `MockPhoneProps`, `PhoneState`, routes #14–#18; WP1 `deriveCaseState`, `normalizeField`, `resolveRelativeDate`, `disclosureText`, `toolsForStage`, `compilePrompt`, `nextStage`, `inputModeFor`; WP2 `requireCase`, `RateLimiter`; `@polar-sh/sdk` 0.49.0, `standardwebhooks` 1.1.1, `@polar-sh/checkout` 0.4.1.

**Provides:** DESIGN §5.8 handlers (server-side date resolution; Polar total in results; `hand_back_to_rep` interactive), §5.12 end to end (setup script with demo customers; ad-hoc tax-inclusive price; `customerId`; `allowDiscountCodes:false`; validated `embedOrigin`; the amount check; `preventDefault` on `success`; overlay closing; the visible new-tab link; `/pay/done`), route #17 **simulate**, `MockPhone` (docked/floating, card copied and shown before the overlay, autopilot countdown, read-only mode), `callTool()`, `awaitPaymentResolution()`.

**Acceptance:**
1. Webhook verification: both schemes verify; tampered → 403; replayed `webhook-id` → no-op 202.
2. Fail-closed: `send_confirmation` before `succeeded` → `payment_not_confirmed`; a client "success" never flips state; `total_amount ≠ amount_cents` → `failed(amount_mismatch)`; simulate works from every non-terminal state and in `PAYMENTS_MODE=polar`.
3. **T-D1-9** (DESIGN App. B) in full, incl. "embed success does not navigate" and the funnel timed 5× (numbers to WP13).
4. Handlers: `get_disclosure` refuses before ready; the `update_case_field` conflict flow; `confirm_effective_date` range check and word resolution; `send_esign_and_pay_link` requires consent.
5. The full flow works with `PAYMENTS_MODE=mock`; a late webhook after `timeout` reaches `succeeded`.

### WP7: Call console, QA card, store, orchestrator (Wave 1; 16 h)

**Goal:** S2 and S3 driven only by `BatonEvent`s, with the run plan, narrator strip, floating phone and recorded-AI read-only mode.

**Consumes:** `BatonEvent`, `BatonStore`, `EventSink`, `RunPlan`, `CaseState`, `QaResult`, `HudMetric`, `TakeoverPhase`, `StatusResponse`, `CreateCaseResponse`; controllers from WP4/WP5/WP5b/WP11; `MockPhone` (WP6). Fixture event logs until they land.

**Provides:** DESIGN §1.4 S2 (top bar with call date and plain-words notices, narrator strip, the Pass button with the live estimate and `manualPassAllowed`, `paused` state, the floating phone container, read-only recorded mode, the "Try this" chip rendering) and S3 (`details[]` expanders); the page orchestrator (`src/client/session`: `/api/cases` → `/api/runs` → STT or cached → takeover → end; `unlockSync` in the click handler; hold release on end/pagehide); mobile tabs; a11y.

**Acceptance:**
1. `/dev/ui?fixture=s01-full` renders shadowing → takeover → pay → QA verified at 1440, 1366×768 (phone visible without scrolling), 1024 and 390 px.
2. Every S2 state (incl. `queued` ≤15 s, `paused`, recorded-AI) is reachable by a fixture and has copy.
3. Evidence chips call `playSpan` with `clipWindow` values and duck the call.
4. Lighthouse a11y ≥ 90 on `/call`; no component imports `src/server/**`.

### WP7b: Landing, about, status (Wave 1; 6 h)

**Goal:** S1, `/about` (the architecture beat of the video) and `/status`.

**Consumes:** `StatusResponse`; `src/content/**` (WP13: copy, numbers, ROI inputs with sources); `calls.json` (`featured`, `picker`).

**Provides:** S1 (hero, CTA, curated picker, status pill, idle prefetch of the default call's assets), `/about` (the §2.1 diagram as SVG, "why both APIs", honest limits, `#roi` slider with the break-even formula and sourced inputs, `#qa` methodology), `/status`.

**Acceptance:** renders from `/api/status` and `src/content`; Lighthouse a11y ≥ 90 on `/`; the default CTA resolves to the `featured` call.

### WP8: Async verification, VA audit, QA service (Wave 1; 6 h)

**Goal:** "✓ Verified from recording", plus the 3-minute VA audit.

**Consumes:** `JobRunner`, `LimitsAuthority` (WP2); `computeQa`, `QaResult` (WP1); `AssemblyAIAsyncClient`, `verifyWebhookHeader` (WP0a).

**Provides:** F3 S1–S4 (webhook and poll; ≤3 async jobs; retry without `keyterms_prompt` on 400), **F6** (marker-based, paginated, every 3 min from the ticker while `mode=live`), `va-rest.ts` (`getSession`, `listSessions`, `createAgent`, `deleteAgent`, `deleteSession`), the purge step, routes #19–#21, **T-D1-0b** (`scripts/day1/session-delete.ts`). Ship an `enqueueVerification` stub in the first hour.

**Acceptance:**
1. Integration: a real ≈60 s VA session → artifacts → multichannel transcript → `QaResult` matching a hand count; webhook and poll-only paths both work.
2. F6: a synthetic marker-bearing session unknown to the registry flips `replay_only`; `dev-*` and `vercel-mirror` sessions are ignored; `has_more` pagination followed.
3. Three consecutive failures → `failed` and the UI keeps provisional numbers; the audio route 302s for the owner and 403s for others; the ledger settles actual durations.

### WP9: Takes → assets, labels, STT and extraction caches (Wave 1, D1–D2; 10 h)

**Goal:** turn recorded takes into Watch-mode assets and cached, reviewed eval inputs.

**Consumes (read-only):** `data/scenarios/*.json`, `data/calls/{manifest.json,raw/*.json,split/*.wav}`. Types `Scenario`, `CallManifestEntry`, `CallLabels`, `SttCacheRecord`, `SttVariant`. WP1 `normalizeField`, extractor prompts; WP3 `Extractor`, `Verifier` (Node); `scripts/lib/aai-open.ts` (WP0b).

**Provides:**
- `npm run calls:build` → `src/generated/{scenarios,calls}.json` (with `featured`, `picker`, content-hashed asset names, `handoff.acceptStartMs`, `recordedAiBundle`, `customerTailPack`), `public/calls/<base>/…` (publishable takes only), `public/data/cached-turns/*.json`.
- Excludes takes with `twilio.recording_channels !== 2` from every per-channel variant.
- Labels (`label-ground-truth.ts`, `review-labels.ts`) incl. `acceptStartMs`; STT caches (`pc_ctx` + `pc_noctx` on all kept takes; `mono_diar` on the 5 pilot takes); extraction caches v1/v2/v3 (+ verifier caches).

**Acceptance:**
1. `calls:build` is idempotent, only reads kit files, emits only publishable audio, and exactly one `featured` entry (a unit test asserts it exists, is publishable and has assets).
2. `normalizeScenario` on all 22 kit scenarios round-trips `truth` through `normalizeField`; sidecar overrides apply.
3. **By D2 12:00:** labels reviewed (by the user, ≈30 min) for 5 pilot takes; `pc_ctx`/`pc_noctx` caches and v2/v3 extraction caches for them (hand-off to WP9b).
4. **By D3 18:00:** every kept take cached and extracted.

### WP9b: Sweep, spot-checks, K reports (Wave 2, D2–D4; 10 h)

**Goal:** honest, reproducible K1/K3 numbers, curves and the iteration log.

**Consumes:** WP9 caches and labels; WP1 `deriveCaseState`, `deriveV1`, `compileGreeting(V1)`; WP5 `TakeoverService.compile` and WP8 `enqueueVerification` (spot-checks); WP3 measured `extractMs` distribution.

**Provides:** `simulate.ts` (DESIGN §6.5 incl. verifier start + latency), `sweep.ts`, `k1.ts` (entity matching on normalized values, so Devanagari vs Latin script never counts as a miss), `k2.ts`, `report.ts`; `public/data/explorer/<callId>/<version>.<variant>.json`; `public/data/evals/summary.json`; `data/evals/{iterations,spotchecks}.json`; 5 live spot-checks (DESIGN §6.7); the **measured admin-tail share** from the declined calls s03/s14/s17 for WP13's ROI slide.

**Acceptance:**
1. **D2 20:00:** K1 and K3 pilot reports (5 takes).
2. Determinism: a re-run over the same caches is byte-identical.
3. **D4 12:00:** all takes, versions and ablations swept; spot-checks run; provenance badge on every number.

### WP10: Evals page, Takeover Explorer, Promote (Wave 2; 8 h)

**Goal:** the evidence and business beats of the video.

**Consumes:** `SweepPoint`, `EvalSummaryResponse`, `PromoteRequest`/`PromoteResponse`; `public/data/*` (WP9b); WP8 `va-rest`; WP6 `ToolService` (for `lookup_policy`); WP1 `compilePrompt`, `TOOL_SCHEMAS`.

**Provides:** DESIGN §1.3 P3 (lazy per-file loading), §6.6, §5.14 (v1.1 scope: real `POST /v1/agents`, upsert, evidence card, minimal `/api/agent-tools`), **T-D1-11 on D2 09:00** (`scripts/day1/promote-probe.ts`), and one promoted agent before the D3 video.

**Acceptance:**
1. `/explorer/<s01 base>`: dragging changes the greeting, snapshot and metrics; the EVAL DATA label everywhere; static JSON only.
2. `/evals` renders every section from `summary.json`, a badge on every number.
3. Promote: first click 201; unchanged config → `created:false`; changed config → new agent, old deleted (204). T-D1-11 recorded in `docs/notes/wp10.md`.

### WP11: Customer input, TTS, tail pack, recorded AI bundles (Wave 2, from D2; 12 h)

**Goal:** the AI half works with no mic, sounds like the same people where possible, and every VA failure or budget day has a labelled recorded fallback.

**Consumes:** `CustomerInput`, `Suggestion`, `PacedFeeder`, `MicSource`, `AudioEngine`, `ReplayPlayer`, `EventSink`; WP1 `suggestReplies`; WP0a `openSpeechPcmStream`; WP2 `RateLimiter`, ledger.

**Provides:** DESIGN §5.15 (600 ms autopilot, stall timer, luna classifier fallback, loop breaker, recorded-voice-first, the autopilot TTS bucket), `generate-chips.ts` (every template × every published scenario), **`cut-tailpack.ts`** (§11.6), `ReplayPlayer` + recorder (`?record=1`), and on D4 the bundles of DESIGN §7.5 (one per picker-"main" call from the same take + one s01 mid-call bundle).

**Acceptance:**
1. A mic-blocked s01 run completes on autopilot only (incl. the simulate countdown) and reaches "verified".
2. A normal autopilot run makes **zero** live TTS calls; a typed reply reaches the feeder in ≤1.5 s p50.
3. The tail pack (if recorded) yields labelled clips for every line; hand-back plays Daniel's recorded "I'm back".
4. A bundle plays with the `RECORDED AI SESSION` label, switches the case card to the bundle's state, and shows that run's verified QA.

### WP12: Integration, e2e, deploy, load test, matrix, runbook (Wave 2; 12 h; scaffolding from D1 PM)

**Goal:** it works when a judge clicks it in October.

**Consumes:** everything through public routes and pages; `E2E_FAKE_UPSTREAM=1` factories from WP4/WP5b with replay fakes from WP11 bundles.

**Provides:** DESIGN §9.3 specs 1–4 (incl. no-navigation, replay-only, early pass, floating phone); §9.5 K4 (5 min + 3 concurrent VA sessions); §10 production deploy with the user; the GitHub monitor enabled; the browser matrix with the adversarial rows of DESIGN §7.6 on D4 and D5; `docs/RUNBOOK.md` (kill switch, the daily balance step, residual token risk, key rotation, rollback = `zcli push` of the previous tag); the integration merges at gates when delegated; the Vercel mirror dry run only if the lablab field demands it (§10.4, ≤1 h).

**Acceptance:**
1. Spec 1 green in fake-upstream mode on chromium and webkit; specs 3 and 4 green.
2. Spec 2 (live) passes on the Zerops URL on D3, D4 and D5.
3. K4 passes (or `VA_MAX_CONCURRENT` set to the observed limit).
4. `/status` shows a light check <1 h and a full check <6 h old; the monitor workflow is green.
5. Matrix run twice with no open blocker.

### WP13: Pitch pack (Wave 1 → D5; 10 h agent + the user's recording time)

**Goal:** every lablab deliverable in DESIGN §11, on time, with sourced numbers.

**Consumes:** DESIGN §11; `research/08`, `11 §2.1`, `13 §4`, `14 A.6` (read-only, for numbers and competition); WP9b's measured numbers; WP6's funnel timing; WP5b's K2 numbers.

**Provides:** `docs/pitch/numbers.md` (every number with its source and a "measured / sourced / assumption" tag), `descriptions.md` (title, short ≤255 chars, long ≥100 words, tags), `video-script.md` + `shot-list.md` (DESIGN §11.3), `slides.md` → `slides.pdf` (9 slides, §11.4), `cover.html` → `public/cover.png` (§11.5), `README.md` (§11.5), `src/content/**` (the `/about` copy and ROI inputs for WP7b).

**Acceptance and dates:**
- **D1 18:00:** numbers sheet v1 (sources for $0.60/min loaded CSR cost or mark it an assumption), short description, tags.
- **D2 18:00:** video script v1 and slide outline; `/about` copy in `src/content`.
- **D3 12:00:** README v1, slides v1, cover v1; the rough-video shot list for 19:00.
- **D4 16:00:** script v2 with measured numbers; final shot list for 19:00.
- **D5 18:00:** final PDF, cover, README, descriptions; the video edited (captions, ≤5 min, MP4).

---

## 4. Day-by-day schedule (IST), gates and commit gates

Each **gate** = the integrator merges the listed branches, `npm run typecheck && npm test` pass, the app deploys to Zerops (from G1), and the **user pushes** to the public repo. 8 gates spread over the week give an honest commit history.

| When | Who | What | Gate / exit |
|---|---|---|---|
| **D0 Thu Sep 24, evening** | User | The §9 "tonight" checklist: first commit + public repo push, Zerops + zcli login, Polar sandbox OAT, `npm run secrets:init` (after WP0b), participants + consent messages | **Initial commit pushed** |
| D0 21:00 → D1 08:00 | WP0a, WP0b | Wave 0 | **G0 (D1 08:00):** contracts frozen and merged; build green; commit gate 1 |
| **D1 Fri Sep 25** 09:00 | Wave 1 starts | WP1, WP2, WP3, WP4, WP5, WP5b, WP6, WP7, WP7b, WP8, WP9, WP13 | |
| D1 09:30 | WP5b | **T-D1-0** (first update), then T-D1-1…5 | |
| D1 10:00–14:30 | **User + volunteers** | **Recording session (§5)** | Takes on disk; `kit report` |
| D1 by 12:00 | WP0b | T-D1-8/10 on Zerops (needs the user's `zcli login`); from then on every agent uses `LIMITS_ROLE=remote` | Authority live |
| D1 afternoon | WP4, WP6, WP8, WP9 | T-D1-6/7, T-D1-9, T-D1-0b; `calls:build` on the day's takes; auto-labels for 5 pilot takes | |
| **D1 20:00** | Integrator | merge all Wave-1 branches so far | **G1:** every Day-1 test answered with fallbacks chosen (`VA_KEYTERMS`, `PAY_TOOL_MODE`, WS pre-open, `TUNING_8K`, Polar pricing path); `/dev/audio` streams a real take into a live case card; commit gate 2 |
| **D2 Sat Sep 26** 09:00 | Wave 2 starts (WP9b, WP10, WP11, WP12) | T-D1-11 promote probe (WP10) | |
| D2 by 12:00 | User | review labels for the 5 pilot takes (≈30 min, `review-labels.ts`) | |
| **D2 14:00** | Integrator | | **G2 vertical slice:** s01 Watch (live per-channel STT) → case card → Pass at an arbitrary second → Daniel's line + acceptance → AI greeting audible with the correct snapshot; commit gate 3 |
| D2 20:00 | WP9b, WP5b | **K1, K3 (pilot), K2 (prelim)** | checkpoint (§6) |
| D2 22:00 | Integrator | | commit gate 4 |
| **D3 Sun Sep 27** | all | tools and stages, Polar + simulate, MockPhone, autopilot, verification, runs/holds | |
| **D3 16:00** | Integrator + WP12 | deploy | **G3 full judge path on the Zerops URL:** live STT + VA + stages + a real Polar sandbox payment (and Simulate) + confirmation + "✓ Verified from recording" + autopilot; spec 1 green; commit gate 5 |
| D3 19:00 | User | **rough video v1** from WP13's shot list (tests the story and the timing) | |
| **D4 Mon Sep 28** | WP9b, WP10, WP11, WP12 | all sweeps; `/evals`, Explorer, Promote; recorded bundles; K4; matrix pass 1 | 12:00 commit gate 6 |
| D4 19:00 | User | **final video recording** on the deployed URL (mode badge visible) | |
| D4 20:00 | Integrator | | **Feature freeze; K4 checkpoint;** commit gate 7 |
| **D5 Tue Sep 29** | all | buffer: fixes only, matrix pass 2, spec 2 live, runbook; video edit or re-record; slides PDF, cover, README final | **22:00 release candidate tagged;** commit gate 8 |
| **D6 Wed Sep 30** 08:00 | User + WP12 | deploy freeze; set `LEDGER_EPOCH`, `AAI_JUDGING_BUDGET_USD` from the dashboard balance; `/status` green | |
| D6 by **10:00** | User | submit on lablab: title, short/long descriptions, tags, cover, MP4, PDF, public repo, app URL, demo platform | **Submitted** (hard internal limit 12:00; lablab closes 20:30) |

---

## 5. Day-1 recording session (D1, user + 1–2 volunteers)

The full procedure is `docs/recording-day.md` (the recording kit). This section is the build plan's view of it.

**Before 10:00:**
1. `participants.json` filled with real `+91` numbers and consent. **The two people who will record s01 must have `"scope": "public"`** (s01 is the demo call). If nobody can be public, s01 is recorded by the user with a consenting friend or family member.
2. `.\kit check` green; Twilio balance ≥ $8 (22 takes + retakes ≈ $6–7, the tail pack ≈ $0.25).
3. Everyone has their role cards (`docs/role-cards.html`, printed or on a second screen).

**10:00–14:30, order (from recording-day §6):** sound check s02 → warm-up block → **s01 twice** (keep the better one) → **immediately the tail pack** (DESIGN §11.6: same two people, one extra take marked `--discard --note "TAILPACK"`) → corrections block → crosstalk/noise → declined calls → Hinglish s19/s20 when the Hindi speaker is free. After each take: listen, `kit mark --keep|--discard [--override …]`.

**Rules that matter for Baton:**
- The rep's handoff line must be clear and followed by a pause, and the customer's acceptance must be spoken clearly ("Sure, go ahead"): both are cut from the recording and replayed in the demo.
- Separate rooms, always (channel separation is the evidence).
- Golden 16 kHz calls: **skip** unless everything finishes early (DESIGN App. C Q2).

**By 15:00:** `.\kit report` → `data/calls/manifest.json`; the user tells the build session which takes are public. WP9 runs `npm run calls:build` and auto-labels; WP11 runs `cut-tailpack.ts`; WP4 picks 2 takes for T-D1-6.

**D2 by 12:00:** the user reviews the 5 pilot takes' labels (≈30 min).

---

## 6. Kill criteria, cut list, never cut

**K1: STT quality** (D2 20:00, WP9b, `npm run eval:k1`). Entity recall of truth facts in per-channel finals (`pc_ctx`, normalized values) on ≥5 real takes, and final latency. **Pass:** recall ≥90%, p50 ≤1.0 s. **If it fails at 8 kHz:** keep Baton; demo the best 8 kHz take with honest numbers and rely on PENDING confirmation; show 8 kHz as the robustness curve.

**K2: handoff latency** (D2 20:00 prelim, D3 16:00 final; WP5b, `npm run eval:k2`). 10 manual takeovers of s01 from India: click → first audible and dead air after the handoff clip; plus the early-pass run (t≈20 s) that completes payment and confirmation. **Pass:** dead air p50 ≤0.5 s, click → first audible p50 ≤ clip length + 1.0 s, and the early pass completes. **If it fails:** D3 gets 6 h (earlier WS pre-open, `leadMs`, silence trim, a shorter greeting), re-measured at D3 14:00, then the pivot rule.

**K3: takeover correctness** (D2 20:00, WP9b, `npm run eval:sweep -- --pilot`). **Pass:** `wrongAsserted = 0` at 100% of points and `reaskProjected = 0` at ≥90%. **If it fails:** D3 gets 6 h (stricter late rule, assert only facts verified ≥N s before arm, verifier cadence), re-measured D3 14:00, then the pivot rule.

**K4: free-tier load** (D4 20:00, WP12). DESIGN §9.5. **If it fails:** `STT_OPENS_PER_MIN=3`; Watch defaults to the cached replay with a "Go live" button; `VA_MAX_CONCURRENT` set to the observed limit.

**Pivot rule:** if K2 or K3 still fail at D3 14:00, **descope, don't pivot**: ship Watch, the evidence case card, the Explorer and `/evals`; the AI half demos only at the recorded handoff (auto-baton); the manual Pass is labelled "experimental".

### Cut list (applied in v1.1; ≈30–35 agent-hours and ≈$4.5 of AssemblyAI credit saved)

| # | Cut | Saves |
|---|---|---|
| 1 | P2 "Be the customer" (the mic is still available in the AI half) | 6–8 h |
| 2 | "Call the promoted agent" and full `/api/agent-tools` (only `lookup_policy` + a polite stub) | 4 h |
| 3 | Live spot-checks 15 → 5 | 3 h, $1.4 |
| 4 | T-D1-6 grid 54 → 16 sessions (+1 Hinglish) | 2 h, $0.5 |
| 5 | `mono_diar` only on the 5 pilot takes | 1 h, $0.3 |
| 6 | Golden 16 kHz two-recorder calls (and their pipeline branch) | 3 h |
| 7 | Streaming-fetch start, WSS pre-flight probe, custom domain | 4 h |
| 8 | Coach marks (the narrator strip stays) | 2 h |
| 9 | Explorer toggles beyond version + `pc_ctx`/`pc_noctx` | 2 h |
| 10 | K4 10 min → 5 min; dev/e2e live runs trimmed | 1 h, $1.3 |
| 11 | Hinglish takes as a K1 gate (reported separately instead) | 1 h |
| 12 | Hot upgrade cached → live: **scheduled last**, D4 polish | (4 h if dropped) |
| — | Dev + eval budget 16.4 → ≈12 (§7) | ≈$4.5 in total |

**If late, cut next, in this order:** the hot upgrade; the verifier (sol) in the live path (keep its cached ablation); the Explorer's variant toggle; `/status` page polish; the typed-reply TTS (chips + autopilot remain); the Hinglish takes in the eval; the second recorded bundle.

### Never cut

- s01 Watch with live per-channel U3.5 Pro plus `agent_context`;
- deterministic status and greeting; the AI disclosure in the greeting;
- the pass-the-baton protocol plus auto-baton;
- the Voice Agent with progressive tools and the verbatim disclosure;
- the fail-closed Polar sandbox step, with Simulate and the mock fallback;
- the async "✓ Verified from recording" QA card;
- v1/v2/v3 sweep curves with a mid-utterance series, the Explorer and `/evals`, with provenance labels;
- the labelled cached replay and recorded AI session;
- caps, the limits authority and the kill switch;
- the submission assets of DESIGN §11.

---

## 7. Live-spend budget per WP (AssemblyAI $, before the judging window)

| WP | Budget | Main uses |
|---|---|---|
| WP0a/WP0b | 0.05 | Deploy smoke |
| WP2 | 0.30 | Synthetic full checks, token tests |
| WP3, WP1, WP7, WP7b, WP13 | 0.00 | — |
| WP4 | 0.80 | Worklet tests, the 16-session 8 kHz grid, 1 Hinglish run |
| WP5 + WP5b | 2.50 | T-D1-0…5, integration, K2 (10 takeovers + early pass) |
| WP6 | 0.40 | Full-run payments |
| WP8 | 0.30 | Async verification tests, T-D1-0b |
| WP9 + WP9b | 3.50 | Labels, 2 STT variants on all takes, `mono_diar` on 5, 5 spot-checks |
| WP10 | 0.30 | T-D1-11 probe |
| WP11 | 0.70 | Tail-pack transcription, recorded bundles |
| WP12 | 2.00 | K4 (5 min + 3 concurrent VA), live e2e on D3–D5 |
| Video (user) | 1.00 | Rough + final takes |
| **Total** | **≈11.9** | Leaves ≈$36 at the epoch → ≈$31 judging budget + $5 reserve (DESIGN §7.2) |

**OpenAI:** WP3 ≈$1, WP9/9b ≈$4, WP11 ≈$0.5, others ≈$1.5. Keep it under $10 before judging (set a usage limit in the OpenAI dashboard).

---

## 8. Integration checkpoints (who plugs into whom, and when)

| When | Integration | Glue owner | Test |
|---|---|---|---|
| D1 13:00 | WP1 early deliverable (tool schemas, stages, first update, greeting) available on `wp/wp1` | WP1 | WP5b re-runs T-D1-0 with compiler output at G1 |
| D1 18:00 | WP4 `SttChannelManager` + WP3 `/api/extract` + WP1 derive on `/dev/audio` | WP4 | Case card JSON updates live |
| D2 10:00 | WP5 `TakeoverController` + WP5b `VoiceAgentController` + WP4 + WP1 compile + WP2 runs/VA token | WP5 | Pass on `/dev/audio` → greeting audible |
| **D2 14:00** | WP7 orchestrator wires WP4/WP5/WP5b into `/call` | WP7 | **G2** |
| D3 11:00 | WP6 tools + MockPhone in WP5b/WP7 | WP6 provides; WP7 mounts | Pay stage completes (simulate), then Polar |
| D3 13:00 | WP8 verification → QA card; WP11 `CustomerInput` → `ReplyControls` | WP8/WP11 provide; WP7 renders | Verified badge ≤25 s after end; autopilot run |
| **D3 16:00** | Everything on Zerops | WP12 | **G3** + spec 1 |
| D4 12:00 | WP9b outputs → WP10 pages; WP11 bundles → recorded-AI path | WP10, WP11 | `/evals`, `/explorer`; a forced `replay_only` run |
| D4 18:00 | WP12 e2e over everything; matrix pass 1 | WP12 | Specs 1–4 |

---

## 9. What the user must do (accounts, tokens, env, recording)

**Tonight (D0):**
1. **Repo:** check the new `LICENSE` (MIT) and the `.gitignore` block that keeps `research/` private except `research/10*.md`. Make the first commit, create a **public** GitHub repo, push. Answer DESIGN App. C Q8 (agents commit locally on `wp/*` branches).
2. **Zerops:** sign up at app.zerops.io ($15 credit, no card); create an access token and run `zcli login` yourself in a terminal (agents then use the logged-in CLI). Recommended: the $10 verification for +$50.
3. **Polar sandbox:** create the org at sandbox.polar.sh; an OAT with `checkouts:read/write`, `products:read/write`, `customers:read/write`; put it in `.env` as `POLAR_ACCESS_TOKEN`; add the demo email alias as an org member.
4. **AssemblyAI:** note the dashboard balance (C11). **OpenAI:** set a monthly usage limit.
5. **Secrets:** after WP0b lands, run `npm run secrets:init` (fills the random secrets in `.env` without printing them).
6. **Recording kit:** `participants.json` with real numbers and consent (s01 pair = public); send the consent messages; save the Twilio number as a contact; `.\kit check`.

**D1:** the recording session (§5); `.\kit report` by 15:00; tell the build session which takes are public.
**D2:** review 5 pilot labels by 12:00.
**D3:** register the Polar webhook and embedding hosts (DESIGN §10.2) with WP6/WP12; enter Zerops secrets; enable the GitHub monitor workflow; record the rough video at 19:00.
**D4:** record the final video at 19:00.
**D5:** edit the video; approve slides, cover, README.
**D6:** set the epoch and judging budget at 08:00; submit by 10:00.
**During judging (Oct 1–21):** each morning, post the AssemblyAI dashboard balance (`/api/admin/flags {aaiBalanceUsd}`) and glance at `/status`.
