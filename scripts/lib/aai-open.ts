/**
 * aai-open.ts - the ONLY place Node scripts and live tests open AssemblyAI sessions (TASKS §0.5, DESIGN §2.3).
 *
 *   openStreaming()       one Streaming STT session  (acquire n=1 → ledger → connect → report → always terminate)
 *   openStreamingPair()   rep + customer sessions    (acquire n=2 atomically, both or neither)
 *   openVoiceAgentNode()  one Voice Agent session    (vaAcquire → ledger → connectNode → heartbeat → always session.end)
 *   withStreaming / withStreamingPair / withVoiceAgentNode: callback forms that close in `finally`.
 *
 * Every open goes through `getLimitsAuthority()` (the laptop file guard until the Zerops authority is live).
 * Handles register SIGINT/SIGTERM/exit hooks so a Ctrl-C still sends Terminate / session.end.
 * `tests/unit/boundaries.test.ts` fails on direct `StreamingSession.connect` / `connectNode(` elsewhere.
 * Live use needs `RUN_LIVE=1` in tests (TASKS §0.5); scripts decide for themselves.
 */
import type { LimitsAuthority, OpenSource } from "../../src/core/contracts/services";
import { StreamingSession, type ConnectOptions, type StreamingParams, type TerminationMessage } from "../../src/core/aai/streaming";
import type { VoiceAgentSession } from "../../src/core/aai/voice-agent";
import { connectNode, nodeWebSocketFactory } from "../../src/server/aai/va-node";
import { getLimitsAuthority } from "./limits";
import { loadEnv } from "./load-env";

/** List prices (DESIGN §7.1). */
export const STT_USD_PER_SEC = 0.45 / 3600;
export const VA_USD_PER_SEC = 4.5 / 3600;

const DEFAULT_STT_MAX_MS = 10 * 60_000;
const DEFAULT_VA_CAP_MS = 5 * 60_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const HEARTBEAT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OpenRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[aai-open] ${code}: ${message}`);
    this.name = "OpenRefusedError";
    this.code = code;
  }
}

function apiKey(): string {
  loadEnv();
  const k = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!k) throw new Error("[aai-open] ASSEMBLYAI_API_KEY is missing (value never printed)");
  return k;
}

function deployId(explicit?: string): string {
  loadEnv();
  return explicit ?? process.env.BATON_DEPLOY_ID ?? "dev-local";
}

// ---------------------------------------------------------------------------------------------
// Cleanup on exit
// ---------------------------------------------------------------------------------------------

const closers = new Set<() => Promise<unknown>>();
let hooksInstalled = false;
function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const onSignal = (sig: NodeJS.Signals) => {
    const all = [...closers].map((c) => c().catch(() => undefined));
    void Promise.race([Promise.all(all), sleep(8000)]).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}
function track(close: () => Promise<unknown>): () => void {
  installExitHooks();
  closers.add(close);
  return () => closers.delete(close);
}

// ---------------------------------------------------------------------------------------------
// Streaming STT
// ---------------------------------------------------------------------------------------------

export interface AcquireOptions {
  authority?: LimitsAuthority;
  source?: OpenSource;
  deployId?: string;
  /** Keep polling / retrying for a slot this long (default 120 s). 0 = fail on the first refusal. */
  maxWaitMs?: number;
  runId?: string;
}

/**
 * Acquire `n` STT slots, waiting through `queued` and `E_QUEUE_TIMEOUT` up to `maxWaitMs`. Returns the grant and
 * its per-open live-session ids (length n; [rep, customer] for n = 2), which every report must use (G0).
 */
export async function acquireSttSlots(n: 1 | 2, o: AcquireOptions = {}): Promise<{ grantId: string; sessionIds: string[] }> {
  const authority = o.authority ?? getLimitsAuthority();
  const deadline = Date.now() + (o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let ticket: string | undefined;
  for (;;) {
    const r = await authority.sttAcquire({
      n,
      visitorId: `script:${process.pid}`,
      ipKey: "local",
      source: o.source ?? "script",
      deployId: deployId(o.deployId),
      ...(ticket ? { ticket } : {}),
      ...(o.runId ? { runId: o.runId } : {}),
    });
    if (r.status === "granted") {
      if (r.sessionIds.length !== n) throw new Error(`limits authority granted ${r.sessionIds.length} session ids for n=${n}`);
      return { grantId: r.grantId, sessionIds: r.sessionIds };
    }
    if (r.status === "queued") {
      ticket = r.ticket;
      if (Date.now() + Math.min(r.etaMs, 2000) > deadline) {
        await authority.sttCancel(r.ticket).catch(() => undefined);
        throw new OpenRefusedError("E_QUEUE_TIMEOUT", `still queued after ${o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS} ms`);
      }
      await sleep(Math.min(Math.max(r.etaMs, 250), 2000));
      continue;
    }
    if (r.code === "E_QUEUE_TIMEOUT" && Date.now() + 5000 < deadline) {
      ticket = undefined;
      await sleep(5000);
      continue;
    }
    throw new OpenRefusedError(r.code, r.message);
  }
}

export interface OpenStreamingOptions extends AcquireOptions {
  params: StreamingParams;
  /** Safety cap: terminate automatically after this long (default 10 min). */
  maxDurationMs?: number;
  /** Ledger reservation; defaults to maxDurationMs at the list price. */
  estUsd?: number;
  connect?: Omit<ConnectOptions, "auth" | "params">;
  /** Label for the ledger `action` (e.g. "t-d1-6"). */
  label?: string;
}

export interface StreamingHandle {
  readonly session: StreamingSession;
  /** Our live-session id for reports (from `SlotResult.sessionIds`). */
  readonly sessionId: string;
  /** Terminate (idempotent); reports and settles. Resolves with the Termination message, if any. */
  close(): Promise<TerminationMessage | null>;
}

async function openOneStreaming(
  authority: LimitsAuthority,
  sessionId: string,
  o: OpenStreamingOptions,
  key: string,
): Promise<StreamingHandle> {
  const maxMs = o.maxDurationMs ?? DEFAULT_STT_MAX_MS;
  const env = deployId(o.deployId);
  const reservation = await authority.ledger.reserve({
    provider: "aai_stt",
    action: o.label ?? "script_stt",
    refId: sessionId,
    estUsd: o.estUsd ?? (maxMs / 1000) * STT_USD_PER_SEC,
    env,
  });
  if (!reservation.ok) throw new OpenRefusedError(reservation.code, "local daily AssemblyAI cap reached");
  const ledgerId = reservation.id;

  let session: StreamingSession;
  try {
    session = await StreamingSession.connect({ factory: nodeWebSocketFactory, ...(o.connect ?? {}), auth: { apiKey: key }, params: o.params });
  } catch (e) {
    await authority.ledger.release(ledgerId).catch(() => undefined);
    await authority.report({ sessionId, kind: "stt", event: "closed", billedSeconds: 0 }).catch(() => undefined);
    throw e;
  }
  await authority.report({ sessionId, kind: "stt", event: "opened", providerSessionId: session.begin.id });

  let closing: Promise<TerminationMessage | null> | null = null;
  const timer = setTimeout(() => void close(), maxMs);
  const untrack = track(() => close());
  async function close(): Promise<TerminationMessage | null> {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      untrack();
      const term = await session.terminate().catch(() => null);
      const billed = term?.session_duration_seconds ?? null;
      await authority
        .report({
          sessionId,
          kind: "stt",
          event: "closed",
          providerSessionId: session.begin.id,
          ...(billed !== null ? { billedSeconds: billed } : {}),
          ...(session.closeInfo ? { closeCode: session.closeInfo.code } : {}),
        })
        .catch(() => undefined);
      if (billed !== null) await authority.ledger.settle(ledgerId, billed * STT_USD_PER_SEC).catch(() => undefined);
      return term;
    })();
    return closing;
  }
  return { session, sessionId, close };
}

/** Open one Streaming STT session through the limits authority. Call `close()` (or use `withStreaming`). */
export async function openStreaming(o: OpenStreamingOptions): Promise<StreamingHandle> {
  const authority = o.authority ?? getLimitsAuthority();
  const key = apiKey();
  const { sessionIds } = await acquireSttSlots(1, { ...o, authority });
  return openOneStreaming(authority, sessionIds[0]!, o, key);
}

export interface OpenPairOptions extends Omit<OpenStreamingOptions, "params"> {
  rep: StreamingParams;
  customer: StreamingParams;
}

/** Open the rep + customer pair (one n=2 grant). If either connect fails, the other is terminated. */
export async function openStreamingPair(o: OpenPairOptions): Promise<{ rep: StreamingHandle; customer: StreamingHandle; close(): Promise<void> }> {
  const authority = o.authority ?? getLimitsAuthority();
  const key = apiKey();
  const { sessionIds } = await acquireSttSlots(2, { ...o, authority });
  const [rep, customer] = await Promise.allSettled([
    openOneStreaming(authority, sessionIds[0]!, { ...o, params: o.rep }, key),
    openOneStreaming(authority, sessionIds[1]!, { ...o, params: o.customer }, key),
  ]);
  if (rep.status === "rejected" || customer.status === "rejected") {
    if (rep.status === "fulfilled") await rep.value.close();
    if (customer.status === "fulfilled") await customer.value.close();
    throw rep.status === "rejected" ? rep.reason : (customer as PromiseRejectedResult).reason;
  }
  return {
    rep: rep.value,
    customer: customer.value,
    close: async () => {
      await Promise.all([rep.value.close(), customer.value.close()]);
    },
  };
}

export async function withStreaming<T>(o: OpenStreamingOptions, fn: (h: StreamingHandle) => Promise<T>): Promise<T> {
  const h = await openStreaming(o);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

export async function withStreamingPair<T>(
  o: OpenPairOptions,
  fn: (p: { rep: StreamingHandle; customer: StreamingHandle }) => Promise<T>,
): Promise<T> {
  const p = await openStreamingPair(o);
  try {
    return await fn(p);
  } finally {
    await p.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Voice Agent (Node)
// ---------------------------------------------------------------------------------------------

export interface OpenVoiceAgentOptions extends Omit<AcquireOptions, "maxWaitMs" | "runId"> {
  /** Client-side session cap (the server does not enforce the token's max duration): default 5 min. */
  capMs?: number;
  estUsd?: number;
  takeoverId?: string;
  attempt?: 0 | 1;
  label?: string;
  /** Passed to connectNode (event hooks etc.). Auth is always the API key header. */
  connect?: Omit<Parameters<typeof connectNode>[0], "token" | "apiKey" | "maxDurationMs">;
}

export interface VoiceAgentHandle {
  readonly session: VoiceAgentSession;
  readonly liveSessionId: string;
  /** session.end → wait for session.ended → close; releases the slot, reports and settles. Idempotent. */
  close(reason?: string): Promise<void>;
}

/** Open one Voice Agent session from Node through the limits authority (send `session.update` next). */
export async function openVoiceAgentNode(o: OpenVoiceAgentOptions = {}): Promise<VoiceAgentHandle> {
  const authority = o.authority ?? getLimitsAuthority();
  const key = apiKey();
  const capMs = o.capMs ?? DEFAULT_VA_CAP_MS;
  const env = deployId(o.deployId);

  const slot = await authority.vaAcquire({
    attempt: o.attempt ?? 0,
    capMs,
    source: o.source ?? "script",
    deployId: env,
    ...(o.takeoverId ? { takeoverId: o.takeoverId } : {}),
  });
  if (!slot.ok) throw new OpenRefusedError(slot.code, slot.message);
  const liveSessionId = slot.liveSessionId;

  const reservation = await authority.ledger.reserve({
    provider: "aai_va",
    action: o.label ?? "script_va",
    refId: liveSessionId,
    estUsd: o.estUsd ?? (capMs / 1000) * VA_USD_PER_SEC,
    env,
  });
  if (!reservation.ok) {
    await authority.release(liveSessionId, "ledger_denied").catch(() => undefined);
    throw new OpenRefusedError(reservation.code, "local daily AssemblyAI cap reached");
  }
  const ledgerId = reservation.id;

  let session: VoiceAgentSession;
  const openedAt = Date.now();
  try {
    session = await connectNode({ ...(o.connect ?? {}), apiKey: key, maxDurationMs: capMs });
  } catch (e) {
    await authority.ledger.release(ledgerId).catch(() => undefined);
    await authority.release(liveSessionId, "connect_failed").catch(() => undefined);
    throw e;
  }
  await authority.report({ sessionId: liveSessionId, kind: "va", event: "opened" });

  const hb = setInterval(() => void authority.heartbeat(liveSessionId).catch(() => undefined), HEARTBEAT_MS);
  let closing: Promise<void> | null = null;
  const untrack = track(() => close("signal"));
  async function close(reason = "done"): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(hb);
      untrack();
      await session.end().catch(() => undefined);
      const billedSeconds = Math.ceil((Date.now() - openedAt) / 1000);
      await authority
        .report({
          sessionId: liveSessionId,
          kind: "va",
          event: "closed",
          billedSeconds,
          ...(session.sessionId ? { providerSessionId: session.sessionId } : {}),
          ...(session.closed ? { closeCode: session.closed.code } : {}),
        })
        .catch(() => undefined);
      await authority.release(liveSessionId, reason).catch(() => undefined);
      await authority.ledger.settle(ledgerId, billedSeconds * VA_USD_PER_SEC).catch(() => undefined);
    })();
    return closing;
  }
  return { session, liveSessionId, close };
}

export async function withVoiceAgentNode<T>(o: OpenVoiceAgentOptions, fn: (h: VoiceAgentHandle) => Promise<T>): Promise<T> {
  const h = await openVoiceAgentNode(o);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}
