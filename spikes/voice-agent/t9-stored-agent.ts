/**
 * T9 / C22 (+ C19, C6-audio) - stored agent via REST, bind with session.update {agent_id}, then later
 * session.update of system_prompt and tools on the stored-agent session. Also:
 *   - conversation.message (system) followed by real speech: does the injected context reach the reply?
 *   - agent_id mixed with inline fields; unknown agent_id
 *   - the same agent id on agents.us.assemblyai.com (C19)
 * Deletes the agent at the end (and verifies the delete).
 *
 *   npx tsx voice-agent/t9-stored-agent.ts
 * Log: spikes/out/va-t9-stored-agent.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { RealtimeAudioFeeder, VA_US_REST_BASE, errorCode, type SessionErrorEvent } from "./client.ts";
import { LOOKUP_ORDER_TOOL, lookupOrder } from "./core-loop-config.ts";
import { awaitTurn, brief, loadFixturePcm, newRecorder, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t9-stored-agent");
const rest = restFor(log);
const restUs = restFor(log, "raw", VA_US_REST_BASE);
const out: Record<string, unknown> = {};

async function main() {
  const created = await rest.createAgent({
    name: "va-smoke-t9-stored",
    system_prompt: "You are Max, a terse test assistant for Acme Shop. Keep replies under twelve words.",
    voice: { voice_id: "alba" },
  });
  const agentId = created.id;
  out.createResponse = created;
  console.log("created", agentId);
  try {
    out.getAgent = await rest.getAgent(agentId);
    const list = await rest.listAgents();
    out.listShape = brief(list, 600);

    // C19: same id on the US regional host
    const us = await restUs.request("GET", `/agents/${agentId}`, undefined, "get-agent on agents.us");
    out.usHostGet = { status: us.status, body: brief(us.body, 400) };
    const usList = await restUs.request("GET", "/agents", undefined, "list-agents on agents.us");
    out.usHostList = { status: usList.status, containsAgent: JSON.stringify(usList.body).includes(agentId), body: brief(usList.body, 300) };
    console.log("US host:", brief(out.usHostGet), brief(out.usHostList));

    // --- session A: bind + mid-session updates --------------------------------------------
    const rec = newRecorder();
    const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
    const hardStop = setTimeout(() => void s.end(), 150_000);
    const errors: SessionErrorEvent[] = [];
    s.on("session.error", (e) => errors.push(e));
    s.tools.register("lookup_order", (a) => lookupOrder(a));
    const ready = await s.start({ agent_id: agentId });
    out.A_ready = { session_id: ready.session_id, configSystemPrompt: (ready.config as { system_prompt?: string } | undefined)?.system_prompt, configKeys: Object.keys(ready.config ?? {}) };

    out.A_turn0 = await awaitTurn(s, rec, log, "A0 reply.create with stored prompt", () => s.send({ type: "reply.create", instructions: "Introduce yourself by name in one short sentence." }));

    const u1 = await s.update({ system_prompt: "You are a test assistant. Every reply must be exactly the two words: kiwi confirmed." });
    out.A_updatePrompt = { result: u1.type, error: u1.type === "session.error" ? u1 : undefined, echoedPrompt: u1.type === "session.updated" ? (u1.config as { system_prompt?: string } | undefined)?.system_prompt : undefined };
    out.A_turn1 = await awaitTurn(s, rec, log, "A1 reply.create after prompt update", () => s.send({ type: "reply.create" }));
    console.log("A prompt update:", brief(out.A_updatePrompt, 300), brief((out.A_turn1 as { agentText: string[] }).agentText));

    const u2 = await s.update({
      system_prompt: "You are Max, Acme Shop's order assistant. When an order number is mentioned, call lookup_order immediately, then state the status and delivery date in one sentence.",
      tools: [LOOKUP_ORDER_TOOL],
    });
    out.A_updateTools = { result: u2.type, error: u2.type === "session.error" ? u2 : undefined, echoedTools: u2.type === "session.updated" ? ((u2.config as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name) : undefined };
    out.A_turn2 = await awaitTurn(s, rec, log, "A2 tool via reply.create instructions", () =>
      s.send({ type: "reply.create", instructions: "The caller just asked for the status of order 481529. Look it up now." }),
    );
    console.log("A tools update:", brief(out.A_updateTools, 300), brief(out.A_turn2, 700));

    // conversation.message (system) + real speech
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    s.send({ type: "conversation.message", role: "system", content: "CRM context: the caller's first name is Priya. Always address the caller as Priya." });
    await sleep(300);
    const q = loadFixturePcm("question_24k.wav");
    const idx = rec.events.length;
    await feeder.play(q.bytes);
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const evs = rec.events.slice(idx);
      const lastDone = [...evs].reverse().find((e) => e.ev.type === "reply.done");
      const lastStart = [...evs].reverse().find((e) => e.ev.type === "reply.started");
      const toolsOpen = s.tools.traces.some((t) => t.sentAtMs === undefined && !t.dropped);
      if (lastDone && lastStart && lastDone.ms > lastStart.ms && !toolsOpen && log.elapsed() - lastDone.ms > 1500) break;
      await sleep(200);
    }
    await feeder.stop();
    const speechEvs = rec.events.slice(idx);
    out.A_speechWithSystemMessage = {
      userTranscripts: speechEvs.filter((e) => e.ev.type === "transcript.user").map((e) => (e.ev as { text?: string }).text),
      agentText: speechEvs.filter((e) => e.ev.type === "transcript.agent").map((e) => (e.ev as { text?: string }).text),
      toolCalls: speechEvs.filter((e) => e.ev.type === "tool.call").map((e) => e.ev),
    };
    out.A_systemMessageUsedInSpeechTurn = JSON.stringify(out.A_speechWithSystemMessage).toLowerCase().includes("priya");
    console.log("A speech+system msg:", brief(out.A_speechWithSystemMessage, 900));

    clearTimeout(hardStop);
    out.A_errors = errors.map((e) => ({ code: errorCode(e), message: e.message, param: e.param }));
    out.A_ended = (await s.end()) ?? null;

    // --- session B: agent_id mixed with inline fields ------------------------------------
    const sB = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
    try {
      await sB.start({ agent_id: agentId, system_prompt: "inline" } as never, 8000);
      out.B_mixed = { ready: true };
    } catch (e) {
      out.B_mixed = { ready: false, error: (e as { event?: unknown }).event ?? String(e), open: sB.isOpen };
    }
    if (sB.isOpen) {
      try {
        const r = await sB.start({ agent_id: agentId }, 8000);
        out.B_bindAfterMixedError = { ready: true, session_id: r.session_id };
      } catch (e) {
        out.B_bindAfterMixedError = { ready: false, error: (e as { event?: unknown }).event ?? String(e) };
      }
    }
    await sB.end();
    out.B_close = sB.closed ?? null;
    console.log("B mixed:", brief(out.B_mixed, 400), brief(out.B_bindAfterMixedError, 300));

    // --- session C: unknown agent id -----------------------------------------------------
    const sC = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
    try {
      await sC.start({ agent_id: "00000000-0000-4000-8000-000000000000" }, 8000);
      out.C_unknownAgent = { ready: true };
    } catch (e) {
      out.C_unknownAgent = { ready: false, error: (e as { event?: unknown }).event ?? String(e) };
    }
    await sC.end();
    out.C_close = sC.closed ?? null;
    console.log("C unknown agent:", brief(out.C_unknownAgent, 400), brief(out.C_close));
  } finally {
    out.deleteStatus = await rest.deleteAgent(agentId);
    const after = await rest.request("GET", `/agents/${agentId}`, undefined, "get-agent after delete");
    out.getAfterDelete = { status: after.status, body: after.body };
    console.log("deleted:", out.deleteStatus, "GET after delete:", after.status);
  }
  const ok = (out.A_updatePrompt as { result: string }).result === "session.updated" && (out.A_updateTools as { result: string }).result === "session.updated";
  log.result(ok ? "PASS" : "FAIL", out);
  log.close();
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
