/**
 * client/customer/customer-input.ts - WP11's `CustomerInput` (contracts/services.ts): the customer half of the AI
 * half. Autopilot + suggestion chips + the optional mic, over the clip sources of clips.ts.
 *
 * It reads the console store (WP7) rather than the event stream: every fact it needs - the agent's finished spoken
 * replies, the stage, the payment, the case snapshot, the call's policy - is already reduced there, and a recorded
 * bundle replays through the same store, so autopilot behaves identically under `replay_only`.
 *
 * What it never does: synthesize (`/api/tts` is cut), speak over the agent, speak twice for one reply, or touch the
 * card. During `pay` it says one line and leaves the visible countdown and the simulate tap to the MockPhone
 * (DESIGN §5.8 step 6).
 */
import "client-only";

import type { CaseState, FieldId, PaymentStatus, PolicyRecord, Stage } from "@/core/contracts/case";
import type { SimAiClipRef } from "@/core/contracts/ext/wp17-sim";
import type { UiPhase, Wp7UiState } from "@/core/contracts/ext/wp7-ui";
import type { CustomerInput, MicSource, Suggestion } from "@/core/contracts/services";
import type { IntentSpec } from "@/core/contracts/v2/relay";

import { planAutopilot, samePlan, type AutopilotPlan, type AutopilotSnapshot } from "./autopilot";
import {
  chainClipIndexes, createChipIndex, createClipLoader, createSimClipIndex, loadChipManifest, EMPTY_CLIP_INDEX,
  type ClipIndex, type ClipLoader, type CustomerClipRef,
} from "./clips";
import { CHIP_MANIFEST_URL, ChipManifestSchema, type ChipManifest } from "./manifest";
import { buildSuggestions, type CustomerSuggestion } from "./suggestions";

/** The AI half is running and the customer may speak. */
const LIVE_PHASES: ReadonlySet<UiPhase> = new Set<UiPhase>(["ai-listening", "ai-thinking", "ai-speaking", "paying"]);
const PAYING_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["created", "open", "confirmed"]);
/** DESIGN §5.15: the clip is played locally at 70% so the judge hears "their" line. */
export const LOCAL_CLIP_VOLUME = 0.7;

/** What the Voice Agent controller must offer (WP5b `VoiceAgentControllerExt`). */
export interface CustomerVaPort {
  playCustomerClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }>;
}

/** What the audio engine must offer (WP4 `AudioEngine`). */
export interface CustomerAudioPort {
  playPcm24k(pcm: Int16Array, opts?: { volume?: number }): Promise<void>;
  openMic(targetRate: 16000 | 24000): Promise<MicSource>;
  setAudioSession?(kind: "playback" | "play-and-record"): void;
}

export interface CustomerStorePort {
  getState(): Wp7UiState;
  subscribe(cb: () => void): () => void;
}

export interface CustomerInputDeps {
  store: CustomerStorePort;
  /** The current pass's Voice Agent controller, or null between passes. */
  va: () => CustomerVaPort | null;
  engine: () => CustomerAudioPort | null;
  /**
   * Route the judge's mic to the Voice Agent. WP7's `TakeoverHandle.setMicSource` survives a new pass, so prefer
   * it; the default falls back to nothing (the mic toggle then reports "unavailable" rather than lying).
   */
  setMicSource?: (src: MicSource | null) => void;
  /** A simulated call's pre-voiced AI half (`SimCallResolution.aiClips`), when this run is a sim. */
  aiClips?: Readonly<Record<string, SimAiClipRef>> | null;
  /** Non-Baton relays: WP14a's compiled `IntentSpec` (the generic suggestion engine). */
  spec?: () => IntentSpec | undefined;
  /** Watch mode offers the "Try this" live-conflict chip. */
  offerTry?: boolean;
  /** Test seam: use this pack instead of fetching `/tts/manifest.json`. */
  manifest?: ChipManifest | null;
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  log?: (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => void;
}

/** `CustomerInput` plus the two things the page owner needs and the frozen interface does not carry. */
export interface CustomerInputExt extends CustomerInput {
  /** Turn the mic back off (the toggle's other direction): frames stop, chips and autopilot work again. */
  disableMic(): Promise<void>;
  dispose(): void;
}

interface Derived {
  live: boolean;
  paying: boolean;
  items: CustomerSuggestion[];
  isRequest: boolean;
}

const EMPTY: Derived = { live: false, paying: false, items: [], isRequest: false };

export class CustomerInputController implements CustomerInputExt {
  mode: "autopilot" | "chips" | "typed" | "mic" = "autopilot";

  private readonly d: CustomerInputDeps;
  private readonly now: () => number;
  private readonly setT: (cb: () => void, ms: number) => unknown;
  private readonly clearT: (id: unknown) => void;
  private readonly loader: ClipLoader;
  private readonly unsub: () => void;

  private chipIndex: ClipIndex = EMPTY_CLIP_INDEX;
  private simIndex: ClipIndex = EMPTY_CLIP_INDEX;
  private truth: Partial<Record<FieldId, string>> = {};
  private autopilotOn = true;
  private disposed = false;

  private mic: MicSource | null = null;
  private timer: unknown = null;
  private plan: AutopilotPlan | null = null;
  private speaking = false;

  private lastReplyId: string | null = null;
  private replyDoneAt: number | null = null;
  private lastSpokeAt: number | null = null;
  private paySpoken = false;
  private wasPaying = false;
  private tryOffered = false;

  /** Memo key for the suggestion build (the orchestrator calls `suggestions()` on every store change). */
  private memoKey = "";
  private memo: Derived = EMPTY;

  constructor(deps: CustomerInputDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.setT = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearT = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.loader = createClipLoader({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.log ? { log: (l, m, data) => deps.log?.(l, m, data) } : {}),
    });
    if (deps.aiClips && Object.keys(deps.aiClips).length) this.simIndex = createSimClipIndex(deps.aiClips);
    if (deps.manifest) this.useManifest(deps.manifest);
    else void this.fetchManifest();
    this.unsub = deps.store.subscribe(() => this.onStoreChange());
  }

  // -------------------------------------------------------------------------------------- CustomerInput

  /**
   * The contract shape only: `clip`/`field` stay internal so a recorded bundle's `ui.suggestions` entry keeps to
   * `Suggestion`. `audioUrl` is enough to play a chip that came back from the UI.
   */
  suggestions(): Suggestion[] {
    return this.derive().items.map(({ id, text, audioUrl, voice, kind }) => ({ id, text, audioUrl, voice, kind }));
  }

  async play(s: Suggestion): Promise<void> {
    this.takeOver("chips");
    await this.speak(s, "chip");
  }

  /**
   * Typed replies (DESIGN §5.15 "Typed"). Typed TTS is CUT (P§13 X5): a typed phrase is only spoken when the
   * committed pack happens to carry it, otherwise the judge is told to use a chip.
   */
  async sendTyped(text: string): Promise<void> {
    this.takeOver("typed");
    const clip = this.index().byText(text);
    if (!clip) {
      this.d.log?.("info", "typed reply has no clip (typed TTS is cut): use a suggested reply", { chars: text.length });
      return;
    }
    await this.speakClip(clip);
  }

  async enableMic(): Promise<boolean> {
    this.takeOver("mic");
    if (this.mic) return true;
    const engine = this.d.engine();
    if (!engine) return false;
    try {
      engine.setAudioSession?.("play-and-record");
      const src = await engine.openMic(24_000);
      if (this.disposed) {
        await src.stop().catch(() => undefined);
        return false;
      }
      this.mic = src;
      this.route(src);
      return true;
    } catch (e) {
      this.mode = "chips";
      this.d.log?.("warn", "microphone unavailable: chips and autopilot still work", { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async disableMic(): Promise<void> {
    const m = this.mic;
    this.mic = null;
    if (!m) return;
    this.route(null);
    this.d.engine()?.setAudioSession?.("playback");
    await m.stop().catch(() => undefined);
    if (this.mode === "mic") this.mode = "chips";
  }

  setAutopilot(on: boolean): void {
    this.autopilotOn = on;
    if (on) {
      if (this.mode !== "mic") this.mode = "autopilot";
    } else if (this.mode === "autopilot") this.mode = "chips";
    this.reschedule();
  }

  dispose(): void {
    this.disposed = true;
    this.arm(null);
    this.unsub();
    void this.disableMic();
  }

  // -------------------------------------------------------------------------------------- clips

  private async fetchManifest(): Promise<void> {
    const m = await loadChipManifest(this.d.manifestUrl ?? CHIP_MANIFEST_URL, (raw) => ChipManifestSchema.parse(raw), {
      ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}),
      ...(this.d.log ? { log: (l, msg, data) => this.d.log?.(l, msg, data) } : {}),
    });
    if (m && !this.disposed) this.useManifest(m);
  }

  private useManifest(m: ChipManifest): void {
    const callId = this.d.store.getState().context?.callId ?? "";
    const idx = createChipIndex(m, callId);
    this.chipIndex = idx;
    this.truth = idx.truth as Partial<Record<FieldId, string>>;
    this.memoKey = "";
    this.onStoreChange();
  }

  /** Recorded (tail pack) first, then the synthetic chip pack, then the sim's pre-voiced AI half. */
  private index(): ClipIndex {
    return chainClipIndexes(this.chipIndex, this.simIndex);
  }

  // -------------------------------------------------------------------------------------- derivation

  private derive(): Derived {
    const s = this.d.store.getState();
    const policy: PolicyRecord | null = s.context?.policy ?? null;
    const caseState: CaseState | null = s.caseState;
    const live = LIVE_PHASES.has(s.phase) && s.mode !== "recorded_ai" && !s.callEnded;
    if (!policy || !caseState) return { ...EMPTY, live };

    const spoken = s.ai.filter((l) => l.kind === "speech");
    const lastAgentText = spoken.at(-1)?.text ?? "";
    const paymentStatus: PaymentStatus | null = s.payment?.status ?? null;
    const stage: Stage | null = s.stage;
    const paying = s.phase === "paying" || stage === "pay" || (paymentStatus !== null && PAYING_STATUSES.has(paymentStatus));
    const key = [
      spoken.length, spoken.at(-1)?.id ?? "", lastAgentText.length, stage ?? "", paymentStatus ?? "",
      caseState.version, s.aiConfirmed.length, this.chipIndex.size, this.simIndex.size, this.tryOffered ? 1 : 0,
    ].join("|");
    if (key === this.memoKey) return { ...this.memo, live, paying };

    const set = buildSuggestions({
      lastAgentText,
      history: spoken.slice(0, -1).map((l) => l.text),
      snapshot: caseState,
      truth: this.truth,
      stage,
      paymentStatus,
      policy,
      offerTry: (this.d.offerTry ?? true) && !this.tryOffered,
      index: this.index(),
      ...(this.d.spec?.() ? { spec: this.d.spec() as IntentSpec } : {}),
    });
    this.memoKey = key;
    this.memo = { live, paying, items: set.items, isRequest: set.cls.kind !== "statement" };
    return this.memo;
  }

  // -------------------------------------------------------------------------------------- autopilot runner

  private onStoreChange(): void {
    if (this.disposed) return;
    const s = this.d.store.getState();
    const spoken = s.ai.filter((l) => l.kind === "speech");
    const lastId = spoken.at(-1)?.id ?? null;
    if (lastId !== this.lastReplyId) {
      this.lastReplyId = lastId;
      if (lastId !== null) this.replyDoneAt = this.now();
    }
    const d = this.derive();
    if (this.wasPaying && !d.paying) this.paySpoken = false;
    this.wasPaying = d.paying;
    this.reschedule();
  }

  private snapshot(): AutopilotSnapshot {
    const d = this.derive();
    return {
      now: this.now(),
      live: this.autopilotOn && this.mode === "autopilot" && d.live && !this.speaking,
      agentBusy: this.agentBusy(),
      paying: d.paying,
      replyDoneAt: this.replyDoneAt,
      lastSpokeAt: this.lastSpokeAt,
      isRequest: d.isRequest,
      paySpoken: this.paySpoken,
    };
  }

  private agentBusy(): boolean {
    const va = this.d.store.getState().va;
    return va.speaking || va.thinking || va.checking;
  }

  private reschedule(): void {
    const next = planAutopilot(this.snapshot());
    if (samePlan(next, this.plan) && this.timer !== null) return;
    this.arm(next);
  }

  private arm(p: AutopilotPlan | null): void {
    if (this.timer !== null) {
      this.clearT(this.timer);
      this.timer = null;
    }
    this.plan = p;
    if (!p) return;
    const top = this.derive().items[0];
    if (top?.clip) this.loader.warm(top.clip);
    this.timer = this.setT(() => {
      this.timer = null;
      void this.fire();
    }, Math.max(0, p.at - this.now()));
  }

  private async fire(): Promise<void> {
    const plan = this.plan;
    this.plan = null;
    if (this.disposed || !plan) return;
    // Re-check: the agent may have started talking again, or the judge taken over, while the timer ran.
    const next = planAutopilot(this.snapshot());
    if (!next || next.reason !== plan.reason || next.at > this.now()) {
      this.reschedule();
      return;
    }
    // Autopilot has now acted on this reply, whatever happens next: a missing clip, a 404 or a closed session
    // must leave it waiting for the NEXT agent reply, never retrying in a tight loop.
    this.lastSpokeAt = this.now();
    if (plan.reason === "pay") this.paySpoken = true;
    const pick = this.pick(plan.reason);
    if (pick) await this.speak(pick, "autopilot");
    else this.d.log?.("info", "autopilot had nothing it could say for this reply", { reason: plan.reason });
    this.reschedule();
  }

  /** The best candidate for this moment; the stall timer prefers a real answer over "Okay." (§5.15). */
  private pick(reason: AutopilotPlan["reason"]): CustomerSuggestion | null {
    const items = this.derive().items.filter((s) => s.clip !== null);
    if (!items.length) return null;
    const top = items[0]!;
    if (reason !== "stall") return top;
    if (top.kind !== "other") return top;
    return items.find((s) => s.kind === "repeat") ?? top;
  }

  // -------------------------------------------------------------------------------------- speaking

  private async speak(s: Suggestion, source: "chip" | "autopilot"): Promise<void> {
    const cs = s as Partial<CustomerSuggestion>;
    const byUrl: CustomerClipRef | null = s.audioUrl ? { text: s.text, url: s.audioUrl, durationMs: 0, voice: s.voice } : null;
    const clip = cs.clip ?? byUrl ?? this.index().byKind(s.kind, cs.field ?? null) ?? this.index().byText(s.text);
    if (!clip) {
      this.d.log?.("warn", "no clip for this reply: nothing was spoken", { kind: s.kind, source });
      return;
    }
    if (s.kind === "try") this.tryOffered = true;
    await this.speakClip(clip);
  }

  private async speakClip(clip: CustomerClipRef): Promise<void> {
    const va = this.d.va();
    if (!va) {
      this.d.log?.("warn", "no Voice Agent session: the reply was not sent", { url: clip.url });
      return;
    }
    const pcm = await this.loader.load(clip);
    if (!pcm || this.disposed) return;
    this.speaking = true;
    this.lastSpokeAt = this.now();
    // Locally at 70% so the judge hears "their" line; the feeder copy is what the agent hears (§5.15 "Audio").
    const engine = this.d.engine();
    if (engine) void Promise.resolve(engine.playPcm24k(pcm, { volume: LOCAL_CLIP_VOLUME })).catch(() => undefined);
    try {
      await va.playCustomerClip(pcm);
    } catch (e) {
      this.d.log?.("warn", "customer clip was not accepted by the session", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.speaking = false;
      this.lastSpokeAt = this.now();
    }
  }

  // -------------------------------------------------------------------------------------- helpers

  /** The judge took over: autopilot is disabled as soon as a chip, the text box or the mic is used (§5.15). */
  private takeOver(mode: "chips" | "typed" | "mic"): void {
    this.autopilotOn = false;
    this.mode = mode;
    this.arm(null);
  }

  private route(src: MicSource | null): void {
    if (this.d.setMicSource) this.d.setMicSource(src);
    else this.d.log?.("warn", "the mic has nowhere to go: no setMicSource was wired", {});
  }
}

/** The `SessionControllers.createCustomerInput` seam: WP7 builds the deps once per page. */
export const createCustomerInput = (deps: CustomerInputDeps): CustomerInputExt => new CustomerInputController(deps);
