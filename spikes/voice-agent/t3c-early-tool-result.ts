/**
 * T3c - tool.result timing: the documented rule (send only after reply.done) held the result ~2.3 s in the
 * core loop because the tool.call arrives inside a SILENT pre-amble reply. Does sending tool.result
 * immediately work (no error, correct answer) and does it cut the time to the audible answer?
 * Also an end-to-end check of the final client.ts API (token connect, maxDurationMs, ReplyTracker,
 * ToolDispatcher policies). Triggered with reply.create instructions (no audio needed).
 *
 *   npx tsx voice-agent/t3c-early-tool-result.ts
 * Log: spikes/out/va-t3c-early-tool-result.jsonl
 */
import { type ReplyInfo } from "./client.ts";
import { LOOKUP_ORDER_TOOL } from "./core-loop-config.ts";
import { brief, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t3c-early-tool-result");
const rest = restFor(log, "bearer");
const out: Record<string, unknown> = {};

async function main() {
  const { token } = await rest.mintToken({ expiresInSeconds: 60, maxSessionDurationSeconds: 180 });
  const s = await open(log, { token, maxDurationMs: 150_000 });
  s.tools.register("lookup_order", (a) => ({ found: true, order_number: String(a.order_number).replace(/\D/g, ""), status: "out for delivery", estimated_delivery: "today before 8 p.m." }));
  const done: ReplyInfo[] = [];
  s.replies.onReplyDone = (r) => {
    done.push(r);
    log.note("reply summary", { ...r, words: `<${r.words.length} words>` });
  };
  await s.start({
    system_prompt: "You are Max, Acme Shop's AI assistant. Whenever an order number is mentioned, call lookup_order first, then give the status and delivery estimate in one short sentence. Never answer order questions from memory; always call the tool again for each new order number.",
    output: { voice: "alba" },
    tools: [LOOKUP_ORDER_TOOL],
  });

  const runs: Record<string, unknown>[] = [];
  const plan: ["reply_done" | "immediate", string][] = [
    ["reply_done", "481529"],
    ["immediate", "736204"],
    ["reply_done", "592817"],
    ["immediate", "318640"],
  ];
  for (const [policy, order] of plan) {
    s.tools.policy = policy;
    const t0 = performance.now();
    const nTraces = s.tools.traces.length;
    const nDone = done.length;
    const errorsBefore = s.timeline.filter((e) => e.type === "session.error").length;
    s.replyNow(`The caller just asked for the status of order ${order.split("").join(" ")}. Look it up now.`);
    const until = Date.now() + 25000;
    let answer: ReplyInfo | undefined;
    while (Date.now() < until) {
      answer = done.slice(nDone).find((r) => r.kind === "speech" && r.text && /deliver|today|8|eight/i.test(r.text));
      if (answer) break;
      await sleep(100);
    }
    await sleep(1200);
    const tr = s.tools.traces[nTraces];
    const pre = done.slice(nDone).find((r) => r.kind === "tool_preamble");
    const row = {
      policy,
      order,
      toolCallMs: tr ? Math.round(tr.receivedAtMs - t0) : null,
      toolArgs: tr?.call.arguments ?? null,
      toolResultSentMs: tr?.sentAtMs ? Math.round(tr.sentAtMs - t0) : null,
      preambleDoneMs: pre?.doneAtMs ? Math.round(pre.doneAtMs - t0) : null,
      preambleSilentMs: pre ? Math.round(pre.audioMs) : null,
      answerStartedMs: answer ? Math.round(answer.startedAtMs - t0) : null,
      answerFirstAudibleMs: answer?.firstAudibleAtMs ? Math.round(answer.firstAudibleAtMs - t0) : null,
      answerLeadingSilenceMs: answer ? Math.round(answer.leadingSilenceMs) : null,
      answer: answer?.text ?? null,
      replyKinds: done.slice(nDone).map((r) => r.kind),
      newErrors: s.timeline.filter((e) => e.type === "session.error").length - errorsBefore,
    };
    runs.push(row);
    console.log(brief(row, 700));
  }
  out.runs = runs;
  out.ended = (await s.end()) ?? null;
  out.allReplies = s.replies.replies.map((r) => ({ kind: r.kind, status: r.status, leadingSilenceMs: Math.round(r.leadingSilenceMs), audioMs: Math.round(r.audioMs), words: r.words.length, text: r.text ?? null, tools: r.toolCalls }));
  const imm = runs.filter((r) => r.policy === "immediate");
  const ok = imm.every((r) => r.answer && r.newErrors === 0);
  log.result(ok ? "PASS" : "PARTIAL", out);
  log.close();
  console.table(runs.map((r) => ({ policy: r.policy, toolCall: r.toolCallMs, resultSent: r.toolResultSentMs, preambleDone: r.preambleDoneMs, answerAudible: r.answerFirstAudibleMs, errors: r.newErrors })));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
