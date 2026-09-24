/**
 * T4 / C7 / C21 - server-side HTTP tool on a stored agent, pointed at a public echo endpoint. Triggered by
 * real speech (fixtures/question_24k.wav). Questions: does a tool.call event reach the client? What does
 * the agent say with the echoed body? How are header values returned on GET (masked "***" vs omitted)?
 * The agent is deleted at the end.
 *
 *   npx tsx voice-agent/t4-http-tool.ts [echoUrl]
 * Log: spikes/out/va-t4-http-tool.jsonl
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { RealtimeAudioFeeder, type HttpTool } from "./client.ts";
import { OUT_DIR, brief, loadFixturePcm, newRecorder, open, restFor, sleep, vaLogger } from "./harness.ts";

const ECHO_URL = process.argv[2] ?? "https://postman-echo.com/get?source=aai-voice-agent-smoke";
const log = vaLogger("t4-http-tool");
const rest = restFor(log);
const out: Record<string, unknown> = { echoUrl: ECHO_URL };

const HTTP_TOOL: HttpTool = {
  name: "check_order_status",
  description: "Check the shipping status of an Acme Shop order by its 6-digit order number. Call this as soon as the caller gives an order number.",
  parameters: {
    type: "object",
    properties: {
      order_number: { type: "string", description: "6-digit order number; may contain spaces between digits.", pattern: " *([0-9] *){6}", examples: ["481529", "4 8 1 5 2 9"] },
    },
    required: ["order_number"],
  },
  execution_mode: "interactive",
  timeout_seconds: 10,
  http: { url: ECHO_URL, http_method: "GET", headers: [{ name: "X-Smoke-Test", value: "smoke-header-value-not-secret" }] },
};

async function main() {
  // plain echo reachability from here (not from AssemblyAI) for reference
  const t = performance.now();
  const direct = await fetch(ECHO_URL.replace("source=", "direct_probe=1&source="), { redirect: "manual" });
  out.directEcho = { status: direct.status, ms: Math.round(performance.now() - t), location: direct.headers.get("location"), bodyStart: (await direct.text()).slice(0, 200) };
  console.log("direct echo:", brief(out.directEcho));

  const agent = await rest.createAgent({
    name: "va-smoke-t4-http",
    system_prompt:
      "You are Max, the AI assistant for Acme Shop. When the caller gives an order number, call check_order_status right away. The status service is a test echo: its response contains an 'args' object with the order number you sent. Tell the caller, in one sentence, which order number the service confirmed receiving, digit by digit. Never invent a delivery date.",
    voice: { voice_id: "alba" },
    tools: [HTTP_TOOL],
  });
  out.createdTools = agent.tools;
  try {
    const got = await rest.getAgent(agent.id);
    out.getAgentTools = got.tools;
    const hdrs = ((got.tools?.[0] as { http?: { headers?: unknown } } | undefined)?.http?.headers ?? null) as unknown;
    out.headerReadShape = hdrs;
    console.log("GET tool headers:", brief(hdrs));

    const rec = newRecorder();
    const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
    const hardStop = setTimeout(() => void s.end(), 120_000);
    const toolCalls: unknown[] = [];
    s.on("tool.call", (e) => toolCalls.push(e));
    // No handler: the dispatcher learns from session.ready that check_order_status has an http block and
    // records its informational tool.call as dropped:"server_side" instead of answering it.
    const ready = await s.start({ agent_id: agent.id });
    out.session_id = ready.session_id;
    out.readyTools = (ready.config as { tools?: unknown } | undefined)?.tools;
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    await sleep(500);
    const q = loadFixturePcm("question_24k.wav");
    const clip = await feeder.play(q.bytes);
    const speechEnd = clip.recordStartMs - log.t0 + q.speechEndMs;
    const until = Date.now() + 35000;
    while (Date.now() < until) {
      const after = rec.events.filter((e) => e.ms > speechEnd);
      const lastDone = [...after].reverse().find((e) => e.ev.type === "reply.done");
      const lastStart = [...after].reverse().find((e) => e.ev.type === "reply.started");
      const spoke = after.some((e) => e.ev.type === "transcript.agent" && /\d|one|two|four|eight|nine|five/i.test(String((e.ev as { text?: string }).text)));
      if (spoke && lastDone && lastStart && lastDone.ms > lastStart.ms && log.elapsed() - lastDone.ms > 1500) break;
      await sleep(200);
    }
    await feeder.stop();
    clearTimeout(hardStop);
    out.ended = (await s.end()) ?? null;
    const rel = (ms: number) => Math.round(ms - speechEnd);
    out.toolCallEventsReachingClient = toolCalls;
    out.dispatcherTraces = s.tools.traces.map((t) => ({ name: t.call.name, dropped: t.dropped ?? null, sent: t.sentAtMs !== undefined }));
    out.replyKinds = s.replies.replies.map((r) => ({ kind: r.kind, text: r.text ?? null, leadingSilenceMs: Math.round(r.leadingSilenceMs), tools: r.toolCalls }));
    out.sequence = rec.events
      .filter((e) => !["reply.audio", "transcript.agent.delta", "transcript.user.delta"].includes(e.ev.type) && e.ms > speechEnd - 8000)
      .map((e) => `${rel(e.ms)}ms ${e.ev.type} ${JSON.stringify({ ...(e.ev as object), type: undefined }).slice(0, 220)}`);
    out.agentText = rec.events.filter((e) => e.ev.type === "transcript.agent").map((e) => (e.ev as { text?: string }).text);
    out.userText = rec.events.filter((e) => e.ev.type === "transcript.user").map((e) => (e.ev as { text?: string }).text);
    out.replyAudioChunksPerReply = Object.fromEntries([...rec.audioByReply].map(([k, v]) => [k, v.length]));
    console.log("tool.call events at client:", toolCalls.length);
    console.log("agent said:", brief(out.agentText, 1200));

    const sessFile = resolve(OUT_DIR, "va-sessions.json");
    const prev = existsSync(sessFile) ? (JSON.parse(readFileSync(sessFile, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(sessFile, JSON.stringify({ ...prev, t4: { session_id: ready.session_id, endedAt: new Date().toISOString() } }, null, 2));
  } finally {
    out.deleteStatus = await rest.deleteAgent(agent.id);
    console.log("deleted agent:", out.deleteStatus);
  }
  const said = JSON.stringify(out.agentText).toLowerCase();
  const confirmed = /4.?8.?1.?5.?2.?9|four,? eight,? one,? five,? two,? nine/.test(said);
  log.result(confirmed ? "PASS" : "PARTIAL", out);
  log.close();
  console.log(brief(out.sequence, 5000));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
