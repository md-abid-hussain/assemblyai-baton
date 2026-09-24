/**
 * T3b / C6 follow-up - T3 showed conversation.message is accepted silently but its content never reaches
 * the model (reply.create answered as if nothing was said). Probe which shapes the server validates, and
 * whether any variant (or reply.create.instructions) carries context into the reply.
 *
 *   npx tsx voice-agent/t3b-conversation-message.ts
 * Log: spikes/out/va-t3b-conversation-message.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { errorCode, type SessionErrorEvent } from "./client.ts";
import { awaitTurn, brief, newRecorder, open, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t3b-conversation-message");
const rec = newRecorder();
const out: Record<string, unknown> = {};

async function main() {
  const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
  const hardStop = setTimeout(() => void s.end(), 140_000);
  const errors: SessionErrorEvent[] = [];
  s.on("session.error", (e) => errors.push(e));
  await s.start({ system_prompt: "You are a terse test assistant. Answer in at most eight words. Use any facts given earlier in the conversation.", output: { voice: "alba" } });

  const variants: [string, Record<string, unknown>][] = [
    ["baseline {role:user, content}", { type: "conversation.message", role: "user", content: "My favourite fruit is mango." }],
    ["no fields", { type: "conversation.message" }],
    ["role only", { type: "conversation.message", role: "user" }],
    ["content only", { type: "conversation.message", content: "hello" }],
    ["role assistant", { type: "conversation.message", role: "assistant", content: "I said hi." }],
    ["role bogus", { type: "conversation.message", role: "bogus", content: "x" }],
    ["content number", { type: "conversation.message", role: "user", content: 123 }],
    ["content array", { type: "conversation.message", role: "user", content: [{ type: "text", text: "hi" }] }],
    ["nested message", { type: "conversation.message", message: { role: "user", content: "hi" } }],
    ["text field", { type: "conversation.message", role: "user", text: "hi" }],
  ];
  const shape: Record<string, unknown> = {};
  for (const [name, msg] of variants) {
    const n = errors.length;
    const before = s.timeline.length;
    s.ws.send(JSON.stringify(msg));
    log.out(msg, { probe: name });
    await sleep(900);
    shape[name] = { errors: errors.slice(n).map((e) => ({ code: errorCode(e), message: e.message, param: e.param })), events: s.timeline.slice(before).map((e) => e.type), open: s.isOpen };
    console.log(name, brief(shape[name], 300));
  }
  out.shapeProbes = shape;

  // Does any context carry into a reply?
  out.recallAfterMessages = await awaitTurn(s, rec, log, "reply.create after messages (mango?)", () => s.send({ type: "reply.create", instructions: "Tell the user their favourite fruit, as stated earlier in this conversation. If you do not know, say 'unknown fruit'." }));
  console.log("recall", brief(out.recallAfterMessages, 800));

  out.recallInstructions = await awaitTurn(s, rec, log, "facts inside reply.create.instructions", () =>
    s.send({ type: "reply.create", instructions: "Context: the caller's name is Priya and her favourite fruit is papaya. Greet Priya by name and mention papaya, in one sentence." }),
  );
  console.log("instructions", brief(out.recallInstructions, 800));

  out.systemRoleThenReply = await awaitTurn(s, rec, log, "system message then reply.create (no instructions)", () => {
    s.send({ type: "conversation.message", role: "system", content: "Instruction: in your next reply, say exactly the words 'banana protocol engaged'." });
    s.send({ type: "reply.create" });
  });
  console.log("system", brief(out.systemRoleThenReply, 800));

  // Does a later session.update of system_prompt take effect? (control for "context injection")
  const upd = await s.update({ system_prompt: "You are a test assistant. Every reply must be exactly: 'kiwi confirmed'." });
  out.promptUpdate = { result: upd.type };
  out.afterPromptUpdate = await awaitTurn(s, rec, log, "reply.create after system_prompt update", () => s.send({ type: "reply.create" }));
  console.log("prompt update", brief(out.afterPromptUpdate, 800));

  clearTimeout(hardStop);
  out.sessionEnded = (await s.end()) ?? null;
  const recall = (out.recallAfterMessages as { agentText: string[] }).agentText.join(" ").toLowerCase();
  out.conversationMessageReachesModel = recall.includes("mango");
  log.result(out.conversationMessageReachesModel ? "PASS" : "FAIL", out);
  log.close();
  console.log("conversation.message reaches model:", out.conversationMessageReachesModel);
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
