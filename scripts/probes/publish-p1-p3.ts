/**
 * publish-p1-p3.ts - WP18·0: the stored-agent publish probes P-1 / P-2 / P-3 (PLATFORM §8.3), local, no deploy.
 *
 * 1. `POST /v1/agents`: a Dental-deposit relay prompt at its first stage with an EMPTY case plus the deploy marker,
 *    no greeting, voice alba, `input.transcription_mode:"balanced"`, and one HTTP tool `send_deposit_link`:
 *    `POST https://postman-echo.com/post?next_step=Now%20ask…colour.` with the header `X-Changeover-Key: <random>`.
 * 2. Three sessions, each through scripts/lib/aai-open.ts (limits guard + ledger, always session.end):
 *    `session.update{agent_id}` ALONE → on `session.ready`: `session.update{system_prompt (frozen case), input}` and
 *    at once `reply.create{"Say exactly the following greeting, word for word, then stop and wait: …"}`
 *      P-1: verbatim similarity of the greeting ≥ 0.95 and first audible ≤ 2.5 s after `session.ready`;
 *    then the customer clip "Yes, please text me the link." → the agent calls the HTTP tool (the informational
 *    `tool.call` reaches us and is NEVER answered) →
 *      P-3: the next audible reply follows the in-band `next_step` (asks for a favourite colour);
 * 3. After the sessions: the timeline artifact's `tool_calls[].result` = the postman-echo body →
 *      P-2: args arrived as a JSON body, `X-Changeover-Key` arrived, and EVERY request header AssemblyAI sent.
 * 4. `DELETE /v1/agents/{id}` (always, in `finally`) → 204, then `GET` → 404.
 *
 * Output: scripts/probes/out/publish-p1-p3.{jsonl,result.json} (git-ignored). The probe key is random per run, is
 * never written (the echoed header is reported as "matched"), and dies with the agent. Audio is logged as byte counts.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/probes/publish-p1-p3.ts [--runs 3] [--max-usd 0.18]
 *
 * Budget (TASKS-v2 §6 WP18 T0): ≤ $0.20. Each session is capped at 50 s ($0.0625); the loop stops early once the
 * measured spend would pass --max-usd.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RealtimeAudioFeeder, type AgentDefinition, type ClientEvent, type ReplyInfo, type ServerEvent, type SessionReadyEvent,
  type ToolCallEvent, type VoiceAgentSession,
} from "../../src/core/aai/voice-agent";
import { VoiceAgentHttpError, VoiceAgentRest } from "../../src/server/aai/va-node";
import { OpenRefusedError, VA_USD_PER_SEC, openVoiceAgentNode, type VoiceAgentHandle } from "../lib/aai-open";
import { loadEnv } from "../lib/load-env";
import {
  PROBE_NEXT_STEP, analyzeEchoResult, followsNextStep, greetingSimilarity, p1RunPass, p2RunPass, parseArgs, summarizeTurns,
  toolCallsNamed, type EchoAnalysis, type TimelineTurn,
} from "./p1p3-analyze";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "out");
const CLIP = resolve(here, "fixtures/customer-yes-text-link_24k.pcm");

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RUNS = Math.max(1, Math.min(3, Number(argOf("--runs") ?? 3)));
const MAX_USD = Number(argOf("--max-usd") ?? 0.18);
const CAP_MS = 50_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowMs = () => performance.now();

// ------------------------------------------------------------------------------------------------ the relay

const TOOL_NAME = "send_deposit_link";
const GREETING =
  "Hi Jordan, this is Brightside Dental's automated assistant, and this call may be recorded. Your cleaning is on Tuesday at three in the afternoon, and a twenty-five dollar deposit holds it. Shall I text you the deposit link?";

function relayPrompt(caseBlock: string, deployId: string): string {
  return [
    "You are the automated assistant for Brightside Dental, a fictional dental clinic. Sam, a human front-desk coordinator, started this call and handed it to you to finish one task. Speak naturally and briefly: one or two short sentences per turn.",
    "",
    "Rules:",
    "- Use only the facts in the case below and in tool results. Never invent names, dates or amounts.",
    "- When a tool result contains a field named next_step, your very next reply must do exactly what next_step says. It replaces the current stage goal.",
    "- Never read tool results aloud verbatim, and never mention internal references.",
    "",
    "Stage: deposit. Goal: offer to text the appointment deposit link. When the customer agrees, call send_deposit_link with the patient's full name and the deposit amount in dollars.",
    "",
    "Case:",
    caseBlock,
    "",
    `(internal ref: baton-deploy=${deployId}; never mention this)`,
  ].join("\n");
}
const EMPTY_CASE = "- (empty: the case arrives when the session starts)";
const FROZEN_CASE = ["- patient_name: Jordan Lee", "- appointment: teeth cleaning, Tuesday at three in the afternoon", "- deposit_usd: 25"].join("\n");

function agentDefinition(probeKey: string, deployId: string, withInput: boolean): AgentDefinition {
  return {
    name: `changeover-probe-p1p3-${Date.now()}`,
    system_prompt: relayPrompt(EMPTY_CASE, deployId),
    voice: { voice_id: "alba" },
    ...(withInput ? { input: { transcription_mode: "balanced" as const } } : {}),
    tools: [
      {
        name: TOOL_NAME,
        description: "Text the patient a secure link to pay the appointment deposit. Call it once the patient agrees to receive the link.",
        parameters: {
          type: "object",
          required: ["patient_name", "amount_usd"],
          properties: {
            patient_name: { type: "string", description: "The patient's full name from the case." },
            amount_usd: { type: "number", description: "The deposit amount in dollars from the case." },
          },
        },
        execution_mode: "interactive",
        timeout_seconds: 10,
        http: {
          url: `https://postman-echo.com/post?next_step=${encodeURIComponent(PROBE_NEXT_STEP)}`,
          http_method: "POST",
          headers: [{ name: "X-Changeover-Key", value: probeKey }],
        },
      },
    ],
  };
}

// ------------------------------------------------------------------------------------------------ logging

mkdirSync(OUT_DIR, { recursive: true });
const LOG = resolve(OUT_DIR, "publish-p1-p3.jsonl");
writeFileSync(LOG, "");
const T0 = nowMs();
let PROBE_KEY = "";

function scrub(v: unknown): unknown {
  const s = JSON.stringify(v, (_k, val: unknown) => (typeof val === "string" && PROBE_KEY && val.includes(PROBE_KEY) ? val.split(PROBE_KEY).join("[probe key]") : val));
  return s === undefined ? null : JSON.parse(s);
}
function write(rec: Record<string, unknown>): void {
  appendFileSync(LOG, JSON.stringify(scrub({ t: Math.round(nowMs() - T0), ...rec })) + "\n");
}
function logEvent(run: number, dir: "in" | "out", ev: ServerEvent | ClientEvent, atMs: number): void {
  if (ev.type === "input.audio" || ev.type === "reply.audio") return;
  const o: Record<string, unknown> = { ...(ev as Record<string, unknown>) };
  if ("resume_token" in o) o.resume_token = "***";
  if (o.type === "session.update") {
    const s = o.session as Record<string, unknown> | undefined;
    if (s && typeof s.system_prompt === "string") o.session = { ...s, system_prompt: `[${s.system_prompt.length} chars]` };
  }
  if ((o.type === "session.ready" || o.type === "session.updated") && o.config && typeof o.config === "object") {
    const c = o.config as Record<string, unknown>;
    if (typeof c.system_prompt === "string") o.config = { ...c, system_prompt: `[${c.system_prompt.length} chars]` };
  }
  appendFileSync(LOG, JSON.stringify(scrub({ t: Math.round(atMs - T0), run, dir, ev: o })) + "\n");
}

// ------------------------------------------------------------------------------------------------ helpers

const listeners = new WeakMap<VoiceAgentSession, Set<(r: ReplyInfo) => void>>();
function onReplyDone(s: VoiceAgentSession, fn: (r: ReplyInfo) => void): () => void {
  let set = listeners.get(s);
  if (!set) {
    const l = new Set<(r: ReplyInfo) => void>();
    set = l;
    listeners.set(s, l);
    s.replies.onReplyDone = (r) => {
      for (const f of [...l]) f(r);
    };
  }
  set.add(fn);
  return () => set.delete(fn);
}
function waitReply(s: VoiceAgentSession, timeoutMs: number, pred: (r: ReplyInfo) => boolean): Promise<ReplyInfo | null> {
  return new Promise((res) => {
    const off = onReplyDone(s, (r) => {
      if (!pred(r)) return;
      clearTimeout(t);
      off();
      res(r);
    });
    const t = setTimeout(() => {
      off();
      res(null);
    }, timeoutMs);
  });
}

async function openQueued(run: number): Promise<VoiceAgentHandle> {
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  for (;;) {
    try {
      return await openVoiceAgentNode({
        capMs: CAP_MS,
        label: `wp18_p1p3_run${run}`,
        source: "script",
        connect: { onEvent: (d, ev, at) => logEvent(run, d, ev, at) },
      });
    } catch (e) {
      if (e instanceof OpenRefusedError && e.code === "E_VA_CAPACITY" && Date.now() < deadline) {
        if (e.message !== last) console.log(`[run ${run}] VA slot busy (shared laptop guard), queueing: ${e.message}`);
        last = e.message;
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
}

interface RunResult {
  run: number;
  sessionId: string | null;
  error?: string;
  readyConfig?: Record<string, unknown>;
  runtimeUpdate?: { reply: string; ms: number | null; error?: unknown; echoedMode?: unknown };
  greeting?: { text: string | null; similarity: number | null; firstAudibleMs: number | null; replyStartedMs: number | null; kind?: string };
  p1Pass?: boolean;
  toolCall?: { reachedClient: boolean; args: Record<string, unknown> | null; afterClipEndMs: number | null; dispatcher: unknown };
  afterTool?: { text: string | null; kind?: string; firstAudibleAfterToolCallMs: number | null; followsNextStep: boolean; allReplies: { kind?: string; text?: string }[] };
  p3Pass?: boolean;
  sessionSeconds?: number | null;
  usd?: number | null;
}

async function runOnce(run: number, agentId: string, clip: Uint8Array, deployId: string): Promise<RunResult> {
  const out: RunResult = { run, sessionId: null };
  const h = await openQueued(run);
  const s = h.session;
  write({ note: "opened", run, liveSessionId: h.liveSessionId });
  let feeder: RealtimeAudioFeeder | null = null;
  try {
    const ready = (await s.start({ agent_id: agentId }, 15_000)) as SessionReadyEvent;
    const readyAt = nowMs();
    out.sessionId = ready.session_id;
    const cfg = (ready.config ?? {}) as Record<string, unknown>;
    const tools = (cfg.tools as Record<string, unknown>[] | undefined) ?? [];
    out.readyConfig = {
      greeting: cfg.greeting ?? null,
      voice: (cfg.output as Record<string, unknown> | undefined)?.voice ?? null,
      transcriptionMode: (cfg.input as Record<string, unknown> | undefined)?.transcription_mode ?? null,
      tools: tools.map((t) => ({ name: t.name, http: !!t.http, method: (t.http as Record<string, unknown> | undefined)?.method ?? null })),
      promptChars: typeof cfg.system_prompt === "string" ? cfg.system_prompt.length : null,
    };

    // P-1: the §8.3 sequence, with no wait between the update and the reply.create (the product's order).
    const updated = s.waitFor("session.updated", { timeoutMs: 8000, alsoResolveOn: ["session.error"] }).catch(() => null);
    const greetingDone = waitReply(s, 30_000, (r) => r.kind === "speech" || r.kind === "unspoken_text" || r.kind === "silent_no_output");
    s.sendUpdate({ system_prompt: relayPrompt(FROZEN_CASE, deployId), input: { transcription_mode: "balanced" } });
    s.replyNow(`Say exactly the following greeting, word for word, then stop and wait: ${GREETING}`);
    feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    const up = await updated;
    out.runtimeUpdate = {
      reply: up?.type ?? "timeout",
      ms: up ? Math.round(nowMs() - readyAt) : null,
      ...(up?.type === "session.error" ? { error: { code: (up as { code?: string }).code, message: (up as { message?: string }).message } } : {}),
      ...(up?.type === "session.updated" ? { echoedMode: ((up as { config?: { input?: { transcription_mode?: unknown } } }).config?.input?.transcription_mode) ?? null } : {}),
    };
    const g = await greetingDone;
    out.greeting = {
      text: g?.text ?? null,
      similarity: greetingSimilarity(GREETING, g?.text),
      firstAudibleMs: g?.firstAudibleAtMs !== undefined ? Math.round(g.firstAudibleAtMs - readyAt) : null,
      replyStartedMs: g ? Math.round(g.startedAtMs - readyAt) : null,
      ...(g?.kind ? { kind: g.kind } : {}),
    };
    out.p1Pass = p1RunPass({ similarity: out.greeting.similarity, firstAudibleMs: out.greeting.firstAudibleMs });
    console.log(`[run ${run}] greeting sim=${out.greeting.similarity} firstAudible=${out.greeting.firstAudibleMs}ms`);

    // P-3: customer agrees → HTTP tool (AssemblyAI calls postman-echo) → the next audible reply.
    await sleep(700);
    const toolCall = s
      .waitFor("tool.call", { timeoutMs: 25_000, pred: (e) => e.name === TOOL_NAME })
      .then((e) => ({ ev: e as ToolCallEvent, at: nowMs() }))
      .catch(() => null);
    const clipTiming = await feeder.play(clip);
    const clipEnd = nowMs();
    void clipTiming;
    const tc = await toolCall;
    const replies: ReplyInfo[] = [];
    const offAll = onReplyDone(s, (r) => {
      if (tc && r.startedAtMs >= tc.at - 5000) replies.push(r);
    });
    let answer: ReplyInfo | null = null;
    if (tc) {
      answer = await waitReply(s, 20_000, (r) => r.kind === "speech" && (r.firstAudibleAtMs ?? 0) > tc.at);
    }
    offAll();
    out.toolCall = {
      reachedClient: !!tc,
      args: tc ? parseArgs((tc.ev as unknown as { arguments?: unknown }).arguments) : null,
      afterClipEndMs: tc ? Math.round(tc.at - clipEnd) : null,
      dispatcher: s.tools.traces.map((t) => ({ name: t.call.name, dropped: t.dropped ?? null, sent: t.sentAtMs !== undefined })),
    };
    out.afterTool = {
      text: answer?.text ?? null,
      ...(answer?.kind ? { kind: answer.kind } : {}),
      firstAudibleAfterToolCallMs: answer?.firstAudibleAtMs !== undefined && tc ? Math.round(answer.firstAudibleAtMs - tc.at) : null,
      followsNextStep: followsNextStep(answer?.text),
      allReplies: replies.map((r) => ({ ...(r.kind ? { kind: r.kind } : {}), ...(r.text ? { text: r.text } : {}) })),
    };
    out.p3Pass = out.afterTool.followsNextStep;
    console.log(`[run ${run}] tool.call=${!!tc} next reply="${(answer?.text ?? "").slice(0, 90)}" follows=${out.p3Pass}`);
    await sleep(500);
  } catch (e) {
    out.error = String(e);
    console.error(`[run ${run}] error: ${String(e)}`);
  } finally {
    await feeder?.stop().catch(() => undefined);
    await h.close("probe_done");
    const secs = s.ended?.session_duration_seconds ?? null;
    out.sessionSeconds = secs;
    out.usd = secs !== null ? Math.round(secs * VA_USD_PER_SEC * 10000) / 10000 : null;
    write({ note: "closed", run, sessionId: s.sessionId ?? null, sessionSeconds: secs, usd: out.usd, closed: s.closed ?? null });
  }
  return out;
}

interface P2Result {
  sessionId: string;
  calls: number;
  analysis: EchoAnalysis | null;
  toolArgs: Record<string, unknown> | null;
  durationMs: number | null;
  isError: boolean | null;
  timedOut: boolean | null;
  turns: Record<string, unknown>[];
  error?: string;
}

async function readTimeline(rest: VoiceAgentRest, sessionId: string): Promise<P2Result> {
  const base: P2Result = { sessionId, calls: 0, analysis: null, toolArgs: null, durationMs: null, isError: null, timedOut: null, turns: [] };
  try {
    const rec = await rest.waitForArtifacts(sessionId, { want: ["timeline"], timeoutMs: 90_000, intervalMs: 5000 });
    const url = rec.artifacts?.find((a) => a.type === "timeline")?.url;
    if (!url) return { ...base, error: "no timeline artifact" };
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const tl = (await res.json()) as { turns?: TimelineTurn[] };
    const turns = tl.turns ?? [];
    const calls = toolCallsNamed(turns, TOOL_NAME);
    const first = calls[0]?.call;
    const toolArgs = first ? parseArgs(first.arguments) : null;
    return {
      ...base,
      calls: calls.length,
      toolArgs,
      analysis: first ? analyzeEchoResult(first.result, toolArgs ?? {}, PROBE_KEY) : null,
      durationMs: first?.duration_ms ?? null,
      isError: first ? !!first.is_error : null,
      timedOut: first ? !!first.timed_out : null,
      turns: summarizeTurns(turns, PROBE_KEY),
    };
  } catch (e) {
    return { ...base, error: String(e) };
  }
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  loadEnv();
  if (process.env.RUN_LIVE !== "1") {
    console.error("Refusing to run: live AssemblyAI calls need RUN_LIVE=1 (TASKS-v2 §2 rule 6).");
    process.exit(2);
  }
  if (!process.env.BATON_DEPLOY_ID || !process.env.BATON_DEPLOY_ID.startsWith("dev-")) process.env.BATON_DEPLOY_ID = "dev-wp18";
  const deployId = process.env.BATON_DEPLOY_ID;
  const key = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) throw new Error("ASSEMBLYAI_API_KEY missing (value never printed)");
  const rest = new VoiceAgentRest(key);
  const clip = new Uint8Array(readFileSync(CLIP));
  PROBE_KEY = randomBytes(32).toString("base64url");

  const result: Record<string, unknown> = { startedAt: new Date().toISOString(), deployId, runsPlanned: RUNS, greeting: GREETING, greetingWords: GREETING.split(/\s+/).length };
  let agentId: string | null = null;
  const runs: RunResult[] = [];
  try {
    // 1. Create the stored agent (retry once without `input` if the stored-agent schema rejects it).
    let createdWithInput = true;
    let created;
    try {
      created = await rest.createAgent(agentDefinition(PROBE_KEY, deployId, true));
    } catch (e) {
      if (!(e instanceof VoiceAgentHttpError) || e.status >= 500) throw e;
      result.createWithInputError = { status: e.status, body: scrub(e.body) };
      createdWithInput = false;
      created = await rest.createAgent(agentDefinition(PROBE_KEY, deployId, false));
    }
    agentId = created.id;
    write({ note: "agent created", agentId, createdWithInput });
    const rec = await rest.getAgent(agentId);
    const recTools = (rec.tools ?? []) as Record<string, unknown>[];
    result.agent = {
      id: agentId,
      createdWithInput,
      recordGreeting: rec.greeting ?? null,
      recordInput: scrub(rec.input ?? null),
      recordVoice: rec.voice ?? null,
      recordTools: recTools.map((t) => ({ name: t.name, http: scrub(t.http ?? null) })),
      headerValueOmittedOnRead: !JSON.stringify(rec).includes(PROBE_KEY),
    };
    console.log(`agent ${agentId} created (input ${createdWithInput ? "accepted" : "rejected"})`);

    // 2. Sessions.
    let spent = 0;
    for (let i = 1; i <= RUNS; i++) {
      if (spent + CAP_MS / 1000 * VA_USD_PER_SEC > MAX_USD + 0.02 && i > 1) {
        result.stoppedEarly = `spend ${spent.toFixed(4)} + next cap would pass --max-usd ${MAX_USD}`;
        break;
      }
      const r = await runOnce(i, agentId, clip, deployId);
      runs.push(r);
      spent += r.usd ?? (CAP_MS / 1000) * VA_USD_PER_SEC;
      if (r.error && !r.sessionId) break;
    }
    result.runs = runs;
    result.vaUsd = Math.round(spent * 10000) / 10000;

    // 3. P-2 from the timelines (artifacts appear ≈7 s after the end).
    const p2: P2Result[] = [];
    for (const r of runs) if (r.sessionId) p2.push(await readTimeline(rest, r.sessionId));
    result.p2 = p2;

    // Verdicts.
    const done = runs.filter((r) => r.sessionId && !r.error);
    const p1 = done.length === RUNS && done.every((r) => r.p1Pass);
    const p3 = done.length === RUNS && done.every((r) => r.p3Pass);
    const p2ok = p2.length === RUNS && p2.every((x, i) => p2RunPass(x.analysis, !!runs[i]?.p3Pass || !!runs[i]?.afterTool?.text));
    result.verdict = {
      P1: p1 ? "PASS" : "FAIL",
      P2: p2ok ? "PASS" : "FAIL",
      P3: p3 ? "PASS" : "FAIL",
      runsCompleted: done.length,
      chosenMode: p1 && p3 && p2ok ? "stored-agent" : "inline fallback (\"Inline session (same playbook)\")",
    };
  } catch (e) {
    result.error = String(e);
    console.error(e);
  } finally {
    // 4. Always delete the probe agent.
    if (agentId) {
      const del = await rest.deleteAgent(agentId).catch((e: unknown) => `error: ${String(e)}`);
      const after = await rest.request("GET", `/agents/${encodeURIComponent(agentId)}`, undefined, "get-agent-after-delete").catch(() => null);
      result.agentDeleted = { deleteStatus: del, getAfterStatus: after?.status ?? null };
      write({ note: "agent deleted", agentId, deleteStatus: del, getAfterStatus: after?.status ?? null });
      console.log(`agent ${agentId} delete → ${String(del)}, GET after → ${after?.status ?? "?"}`);
    }
    result.finishedAt = new Date().toISOString();
    const path = resolve(OUT_DIR, "publish-p1-p3.result.json");
    writeFileSync(path, JSON.stringify(scrub(result), null, 2) + "\n");
    console.log(JSON.stringify(scrub(result.verdict ?? { error: result.error }), null, 1));
    console.log(path);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
