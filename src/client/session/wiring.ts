/**
 * client/session/wiring.ts - the REAL controllers behind /call (G2 Baton slice): WP4's audio engine, CaseSync, cached
 * replay and STT channel manager; WP5's TakeoverController; WP5b's Voice Agent controller and latency HUD; WP1's
 * compiler (the client-compile fallback, the first-update validator and the paid → close stage source).
 *
 * Follows docs/notes/requests/wp4-to-wp7.md, wp5-to-wp7.md, docs/notes/wp5.md §6.2 and wp5b.md §5. Nothing here is
 * Baton-specific beyond what those controllers already are (the relay console, TASKS-v2 WP7 D2, swaps the compile
 * and stage sources for the relay engine's).
 *
 * Client constants that must match the server env defaults (src/server/env.ts): PAY_TOOL_MODE=push, VA_KEYTERMS=1.
 * The server compile (route #11) is authoritative; these only shape the local-compile fallback and the stage source.
 */
import "client-only";

import type { CaseState, Stage } from "@/core/contracts/case";
import type { PayToolMode, VaStageSource } from "@/core/contracts/ext/wp5b-va";
import { compilePrompt, compileTakeover, toolsForStage, validateFirstUpdate } from "@/core/compiler";

import { getAudioEngine } from "../audio/engine";
import { HttpCaseSync } from "../case/case-sync";
import { createLatencyHud, hudMetricReporter } from "../hud/latency";
import { createPageLifecycle, type BrowserPageLifecycle } from "../platform/lifecycle";
import { CachedReplay } from "../replay/cached-replay";
import { HttpSttApi, type SttApi } from "../stt/api";
import { LiveSttChannelManager, type SttConnect } from "../stt/channel-manager";
import { createTakeoverController, HttpTakeoverApi, type TakeoverApi, type VaSession } from "../takeover";
import { createVoiceAgentController, type VaControllerConfig, type VoiceAgentControllerImpl } from "../va/controller";
import type { HumanHalf, SessionContext, SessionControllers, TakeoverHandle } from "./orchestrator";
import { createHttpToolPorts, type ToolPortsFactory } from "./tool-ports";

export const CLIENT_PAY_TOOL_MODE: PayToolMode = "push";
export const CLIENT_VA_KEYTERMS = true;

export interface BrowserWiringOptions {
  /** Routes #14/#15 for the VA controller. Default: the contract-exact HTTP ports; G2: WP6's `createCallTool`/`createPaymentsClient`. */
  toolPorts?: ToolPortsFactory;
  /** WP4: a Begin mismatch is fatal in dev/CI, a warning in production. */
  strictBegin?: boolean;
  vaConfig?: Partial<VaControllerConfig>;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** Transport seams (tests; the browser defaults are fetch, HttpSttApi, a real WebSocket). */
  transport?: HumanHalfTransport;
}

export interface HumanHalfTransport {
  fetch?: typeof fetch;
  sttApi?: SttApi;
  sttConnect?: SttConnect;
}

/** "Ask for {rep}" (DESIGN §1.4 S2): the reply.create instructions that make the agent call hand_back_to_rep. */
export const askForRepInstructions = (rep: string): string =>
  `The customer just asked to speak to ${rep}. Call hand_back_to_rep now with reason "customer_request" and a one-sentence summary for ${rep}, then say ${rep} is coming back.`;

export function createBrowserControllers(o: BrowserWiringOptions = {}): SessionControllers {
  let lifecycle: BrowserPageLifecycle | null = null;
  return {
    engine: () => getAudioEngine(),
    lifecycle: () => (lifecycle ??= createPageLifecycle()),
    createHumanHalf: (c) => createHumanHalf(c, o),
    createTakeover: (c) => wireTakeover(c, o),
  };
}

/** WP4 request §2: CaseSync → CachedReplay (prefetched by the caller) → LiveSttChannelManager. */
export function createHumanHalf(c: SessionContext, o: Pick<BrowserWiringOptions, "strictBegin" | "log" | "transport"> = {}): HumanHalf {
  const visitorToken = c.create.visitorToken;
  const t = o.transport ?? {};
  const caseSync = new HttpCaseSync({
    caseToken: c.create.caseToken,
    ...(visitorToken ? { visitorToken } : {}),
    ...(t.fetch ? { fetchImpl: t.fetch } : {}),
    sink: c.sink,
    now: c.now,
    initialState: c.create.state,
  });
  const cached = new CachedReplay({
    caseId: c.create.caseId, sink: c.sink, caseSync, now: c.now, url: c.create.cachedTurnsUrl, takeover: c.takeoverState,
    ...(t.fetch ? { fetchImpl: t.fetch } : {}),
  });
  const stt = new LiveSttChannelManager({
    api: t.sttApi ?? new HttpSttApi({ caseToken: c.create.caseToken, ...(visitorToken ? { visitorToken } : {}), ...(t.fetch ? { fetchImpl: t.fetch } : {}) }),
    ...(t.sttConnect ? { connect: t.sttConnect } : {}),
    sink: c.sink,
    caseSync,
    cached,
    now: c.now,
    takeover: c.takeoverState,
    strictBegin: o.strictBegin ?? process.env.NODE_ENV !== "production",
    ...(o.log ? { log: o.log } : {}),
  });
  return { caseSync, cached, stt };
}

/** The paid → close transition (and any stage the VA must enter without a tool response): WP1 on the page's case state. */
export function stageSourceFor(o: { caseState: () => CaseState | null; policy: SessionContext["create"]["policy"]; deployId: string }): VaStageSource {
  return async (stage: Stage) => {
    const state = o.caseState();
    if (!state) throw new Error("no case state");
    return {
      systemPrompt: compilePrompt(state, o.policy, stage, { deployId: o.deployId, payToolMode: CLIENT_PAY_TOOL_MODE }),
      tools: toolsForStage(stage, { payToolMode: CLIENT_PAY_TOOL_MODE }),
    };
  };
}

type TakeoverWiringContext = Parameters<SessionControllers["createTakeover"]>[0];

/** WP5 §6.2: the TakeoverController with WP5b's Voice Agent per attempt, WP5b's HUD and WP1's local compile. */
export function wireTakeover(c: TakeoverWiringContext, o: BrowserWiringOptions & { takeoverApi?: TakeoverApi; openSocket?: Parameters<typeof createVoiceAgentController>[0]["openSocket"] } = {}): TakeoverHandle {
  const visitorToken = () => c.create.visitorToken;
  const base: TakeoverApi = o.takeoverApi ?? new HttpTakeoverApi({ visitorToken });
  let armedToken: string | null = null;
  let current: { takeoverId: string; takeoverToken: string } | null = null;
  // The controller keeps the takeover token private; the verification poll (#20) and the audio route (#21) need it.
  const api: TakeoverApi = {
    arm: async (req, token) => {
      const r = await base.arm(req, token);
      armedToken = r.takeoverToken;
      current = null; // a new pass: the previous pass's VA ids no longer apply
      return r;
    },
    compile: (id, drain, token) => base.compile(id, drain, token),
    events: (id, body, token, opts) => base.events(id, body, token, opts),
    end: (id, body, token, opts) => base.end(id, body, token, opts),
    vaToken: (req, token) => base.vaToken(req, token),
    releaseRun: (runId, token, opts) => base.releaseRun(runId, token, opts),
    reportSession: (r, token) => base.reportSession(r, token),
  };
  const token = () => current?.takeoverToken ?? armedToken;
  const postEvents = async (body: Parameters<TakeoverApi["events"]>[1]) => {
    if (current) await api.events(current.takeoverId, body, current.takeoverToken);
  };
  const hud = createLatencyHud({ onMetric: hudMetricReporter({ sink: c.sink, postEvents, eventTime: c.now }) });
  const policy = c.create.policy;
  const deployId = c.deployId ?? "client";
  const ports = (o.toolPorts ?? createHttpToolPorts)({ takeoverToken: () => token() ?? "", visitorToken: () => visitorToken() });
  const stageSource = stageSourceFor({ caseState: c.caseState, policy, deployId });
  let va: VoiceAgentControllerImpl | null = null;

  const ctl = createTakeoverController({
    ids: { caseId: c.create.caseId, runId: c.plan.runId, caseToken: c.create.caseToken },
    aiHalf: c.plan.aiHalf,
    call: { handoff: c.call.handoff, recordedAiBundle: c.call.recordedAiBundle },
    autoBaton: c.mode === "watch",
    engine: c.engine,
    playback: c.playback,
    stt: c.stt,
    caseSync: c.caseSync,
    api,
    createVa: (_attempt, ids): VaSession => {
      current = ids;
      va = createVoiceAgentController({
        takeoverId: ids.takeoverId,
        repFirst: policy.repFirstName,
        engine: c.engine,
        sink: c.sink,
        callTool: ports.callTool,
        pollPayment: ports.pollPayment,
        stageSource,
        postEvents: (body) => api.events(ids.takeoverId, body, ids.takeoverToken),
        hud,
        validateFirstUpdate,
        ...(c.lifecycle ? { lifecycle: c.lifecycle } : {}),
        ...(o.openSocket ? { openSocket: o.openSocket } : {}),
        eventTime: c.now,
        config: { payToolMode: CLIENT_PAY_TOOL_MODE, vaKeyterms: CLIENT_VA_KEYTERMS, ...o.vaConfig },
      });
      return va;
    },
    localCompile: () =>
      compileTakeover(c.caseSync.state ?? c.create.state, policy, {
        deployId,
        compiledBy: "client",
        keytermsEnabled: CLIENT_VA_KEYTERMS,
        payToolMode: CLIENT_PAY_TOOL_MODE,
      }),
    // WP11's ReplayPlayer is not built yet: no recorded AI half (the machine then treats the call as having no bundle).
    recorded: null,
    sink: c.sink,
    hud,
    eventTime: c.now,
    ...(o.log ? { log: o.log } : {}),
  });

  return {
    ctl,
    token,
    askForRep: () => (va as VoiceAgentControllerImpl | null)?.say(askForRepInstructions(policy.repFirstName)),
    setSessionIds: (ids) => hud.setSessionIds(ids),
  };
}
