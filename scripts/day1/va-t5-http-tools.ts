/**
 * T-D1-5: inline `session.update` with HTTP tools (per-case HTTP tools; DESIGN App. B). WP5b. Informational: the
 * MVP uses client function tools; HTTP tools were only verified on STORED agents (10a §9).
 *
 * One session (first update = the confirm fixture, interactive function tools). Then three mid-session tool-list
 * updates, each non-fatal if rejected (10a §3):
 *   a) stored-agent shape, no `type`:   {name, description, parameters, execution_mode, timeout_seconds, http}
 *   b) `type:"http"` + the same fields
 *   c) `type:"function"` + an `http` block
 * For the first shape that is accepted with a non-null `http` echo, reply.create asks the agent to call it and to
 * read back the `source` value from the result: the HTTP endpoint (postman-echo, as in 10a) echoes the query string,
 * so a correct read-back proves AssemblyAI invoked it. The informational client `tool.call` is never answered.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t5-http-tools.ts
 */
import type { InlineSessionConfig } from "../../src/core/aai/voice-agent";
import { toolsFor } from "./va-build-fixtures";
import { closeVa, openVaQueued, readFixture, requireLive, sleep, startFeeder, waitReplyDone, waitToolCall, writeResult } from "./va-lib";

const MARKER = "baton-kiwi-7";
const base = {
  name: "check_policy_status",
  description: "Look up the status of the customer's policy change. Call it when asked to check the policy status.",
  parameters: { type: "object", required: ["policy_number"], properties: { policy_number: { type: "string", description: "The policy number" } } },
  execution_mode: "interactive",
  timeout_seconds: 10,
  http: { url: `https://postman-echo.com/get?source=${MARKER}`, http_method: "GET" },
};
const SHAPES: Record<string, Record<string, unknown>> = {
  a_no_type: { ...base },
  b_type_http: { type: "http", ...base },
  c_type_function_with_http: { type: "function", ...base },
};

async function main(): Promise<void> {
  requireLive();
  const fx = readFixture("first-update-confirm.json");
  const out: Record<string, unknown> = {};
  const v = await openVaQueued({ name: "t-d1-5-http-tools", capMs: 90_000 });
  const s = v.session;
  const attempts: Record<string, unknown>[] = [];
  try {
    await s.start(fx.session as InlineSessionConfig, 10_000);
    const feeder = startFeeder(s);
    // let the greeting play out (it is immutable and would talk over the probe)
    await waitReplyDone(s, 40_000);
    let accepted: string | null = null;
    for (const [id, tool] of Object.entries(SHAPES)) {
      const r = await s.update({ tools: [...(toolsFor("confirm") as unknown as NonNullable<InlineSessionConfig["tools"]>), tool as never] }, 5000).catch((e) => ({ type: "timeout", e: String(e) }));
      const rec: Record<string, unknown> = { id, reply: r.type };
      if (r.type === "session.error") rec.error = { code: (r as { code?: string }).code, message: (r as { message?: string }).message, param: (r as { param?: string }).param };
      if (r.type === "session.updated") {
        const echoed = ((r as { config?: { tools?: Record<string, unknown>[] } }).config?.tools ?? []).find((t) => t.name === base.name);
        rec.echo = echoed ? { type: echoed.type ?? null, http: echoed.http ?? null, execution_mode: echoed.execution_mode } : null;
        if (echoed?.http && !accepted) accepted = id;
      }
      attempts.push(rec);
      await sleep(300);
    }
    out.attempts = attempts;
    out.acceptedShape = accepted;
    if (accepted) {
      await s.update({ tools: [...(toolsFor("confirm") as unknown as NonNullable<InlineSessionConfig["tools"]>), SHAPES[accepted] as never] }, 5000);
      const call = waitToolCall(s, 20_000, base.name);
      s.replyNow(`Call check_policy_status now with policy number BSC-2290316. Then tell the customer the exact value of the "source" field in the result, spelled out.`);
      const tc = await call;
      out.toolCallReachedClient = !!tc;
      out.dispatcherTrace = s.tools.traces.map((t) => ({ name: t.call.name, dropped: t.dropped ?? null, sent: t.sentAtMs !== undefined }));
      const answer = await waitReplyDone(s, 30_000, (r) => r.kind === "speech");
      out.answer = answer?.text ?? null;
      out.invoked = !!answer?.text && /kiwi/i.test(answer.text);
    }
    await feeder.stop();
  } catch (e) {
    out.error = String(e);
  } finally {
    const c = await closeVa(v);
    out.sessionSeconds = c.sessionSeconds;
    out.usd = c.usd;
  }
  out.verdict = out.invoked ? "PASS (accepted and invoked)" : out.acceptedShape ? "PARTIAL (accepted, invocation not proven)" : "FAIL (inline http tools rejected) → function tools (MVP default)";
  const path = writeResult("t-d1-5", out);
  console.log(JSON.stringify(out, null, 1));
  console.log(path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
