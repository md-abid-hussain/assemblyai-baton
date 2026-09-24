/**
 * T3 / C6 - text injection without audio: conversation.message alone (does the agent reply?), then
 * reply.create; role:"system" context; reply.create with instructions; and an experiment sending
 * tool.result immediately (before reply.done) to see whether the documented timing rule is enforced.
 * No audio is sent at all in this session (also tests that a session works text-only).
 *
 *   npx tsx voice-agent/t3-text-injection.ts
 * Log: spikes/out/va-t3-text-injection.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { LOOKUP_ORDER_TOOL, SYSTEM_PROMPT, lookupOrder } from "./core-loop-config.ts";
import { awaitTurn, brief, newRecorder, open, vaLogger } from "./harness.ts";

const log = vaLogger("t3-text-injection");
const rec = newRecorder();
const out: Record<string, unknown> = {};

async function main() {
  // probe: docs type greeting as `string | null` - does an explicit null work on the first update?
  const s0 = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
  try {
    const r0 = await s0.start({ system_prompt: SYSTEM_PROMPT, greeting: null, output: { voice: "alba" } } as never);
    out.greetingNull = { ok: true, session_id: r0.session_id };
  } catch (e) {
    out.greetingNull = { ok: false, error: (e as { event?: unknown }).event ?? String(e) };
  }
  await s0.end();
  out.greetingNullClose = s0.closed ?? null;
  console.log("greeting:null ->", brief(out.greetingNull), brief(out.greetingNullClose));

  const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
  const hardStop = setTimeout(() => void s.end(), 150_000);
  s.tools.register("lookup_order", (a) => lookupOrder(a));
  const ready = await s.start({ system_prompt: SYSTEM_PROMPT, output: { voice: "alba" }, tools: [LOOKUP_ORDER_TOOL] });
  out.session_id = ready.session_id;

  // A: conversation.message only (docs: does not trigger a reply)
  out.A_messageOnly = await awaitTurn(s, rec, log, "A conversation.message (user) only", () => s.send({ type: "conversation.message", role: "user", content: "Hi, what's the status of order 4 8 1 5 2 9?" }), { expectReply: false, quietMs: 5000 });
  console.log("A", brief(out.A_messageOnly, 800));

  // B: reply.create (should answer A, probably via lookup_order)
  out.B_replyCreate = await awaitTurn(s, rec, log, "B reply.create", () => s.send({ type: "reply.create" }));
  console.log("B", brief(out.B_replyCreate, 1200));

  // C: system-role context + reply.create with instructions
  out.C_systemPlusInstructions = await awaitTurn(s, rec, log, "C conversation.message (system) + reply.create{instructions}", () => {
    s.send({ type: "conversation.message", role: "system", content: "Context from the CRM: the caller's first name is Priya and she is a Gold member." });
    s.send({ type: "reply.create", instructions: "Thank the caller by first name for being a Gold member, in one short sentence." });
  });
  console.log("C", brief(out.C_systemPlusInstructions, 1200));

  // D: user message + reply.create in one go (the pattern used by later tests for latency)
  out.D_userPlusReply = await awaitTurn(s, rec, log, "D conversation.message (user) + reply.create", () => { s.sendConversationMessage("What is two plus two? Answer in three words."); s.replyNow(); });
  console.log("D", brief(out.D_userPlusReply, 1200));

  // E: tool.result sent immediately (not waiting for reply.done)
  s.tools.policy = "immediate";
  out.E_immediateToolResult = await awaitTurn(s, rec, log, "E tool.result sent immediately", () => { s.sendConversationMessage("Can you also check order 1 2 3 4 5 6 for me?"); s.replyNow(); });
  const eTrace = s.tools.traces[s.tools.traces.length - 1];
  out.E_trace = eTrace ? { call: eTrace.call, sentBeforeReplyDone: true, result: eTrace.result } : null;
  console.log("E", brief(out.E_immediateToolResult, 1200));
  s.tools.policy = "reply_done";

  clearTimeout(hardStop);
  out.sessionEnded = (await s.end()) ?? null;
  out.toolTraces = s.tools.traces.map((t) => ({ name: t.call.name, args: t.call.arguments, call_id: t.call.call_id, heldMs: t.sentAtMs && t.handlerDoneAtMs ? Math.round(t.sentAtMs - t.handlerDoneAtMs) : null, dropped: t.dropped ?? null }));

  const a = out.A_messageOnly as { replyStartedMs: number | null };
  const b = out.B_replyCreate as { replyStartedMs: number | null };
  log.result(a.replyStartedMs === null && b.replyStartedMs !== null ? "PASS" : "PARTIAL", out);
  log.close();
  console.log(brief(out.toolTraces, 2000));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
