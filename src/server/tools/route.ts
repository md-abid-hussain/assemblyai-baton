import "server-only";

import { ToolRequestSchema } from "../../core/contracts/api";
import { BatonError, isBatonError } from "../../core/contracts/errors";
import { safeParseToolArgs, ToolNameSchema, type ToolName } from "../../core/contracts/tools";
import { newId } from "../../lib/ids";
import { log } from "../log";
import { json, rateLimited, readJson, route, type Params } from "../payments/http";
import { wp6 } from "./wiring";

/**
 * Route #14 `POST /api/tools/[name]` (DESIGN §4.4): takeover token (scope "tools"), 60 calls per takeover,
 * idempotent on `(takeoverId, callId)` via the `tool_calls` unique index. Invalid model arguments are answered with
 * HTTP 200 and `INVALID_ARGS_RESULTS[name]` (G0), so the agent gets an answer it can act on.
 */

const toolLog = log.child({ component: "tools-route" });
const REPLAY_WAIT_MS = 8_000;

export const postTool = route<{ name: string }>("tools.post", async (req, ctx: Params<{ name: string }>) => {
  const { name: rawName } = await ctx.params;
  const parsedName = ToolNameSchema.safeParse(rawName);
  if (!parsedName.success) throw new BatonError("E_NOT_FOUND", "No such tool.");
  const name: ToolName = parsedName.data;
  const body = await readJson(req, ToolRequestSchema);
  const w = wp6();
  const auth = await w.requireTakeover(req, { takeoverId: body.takeoverId, scope: "tools" });
  const rl = await w.rateLimiter.hit("tools", body.takeoverId, 60, 3600);
  if (!rl.ok) rateLimited(rl.retryAfterSec);

  const tko = await w.toolStore.getTakeover(body.takeoverId);
  if (!tko) throw new BatonError("E_NOT_FOUND", "No such takeover.");
  if (tko.caseId !== auth.caseId) throw new BatonError("E_FORBIDDEN", "The takeover belongs to another case.");

  const origin = req.headers.get("origin") ?? w.appUrl ?? new URL(req.url).origin;
  const toolCtx = { caseId: auth.caseId, takeoverId: body.takeoverId, callId: body.callId, visitorId: auth.visitorId, origin };
  const args = safeParseToolArgs(name, body.args);
  const argsJson = (body.args && typeof body.args === "object" ? body.args : { value: body.args ?? null }) as Record<string, unknown>;

  const begin = await w.toolStore.beginCall({ id: newId(), takeoverId: body.takeoverId, callId: body.callId, name, args: argsJson });
  if (!begin.fresh) {
    // A retry of the same VA call_id: wait for the first attempt, then answer with its result.
    const deadline = Date.now() + REPLAY_WAIT_MS;
    let cur: { result: Record<string, unknown> | null; status: string | null } | null = begin;
    while (cur && cur.result === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      cur = await w.toolStore.getCall(body.takeoverId, body.callId);
    }
    if (!cur) return postToolAgain(req, body, name);
    if (cur.result === null) throw new BatonError("E_CASE_STATE", "This tool call is still running.", { retryAfterMs: 1000 });
    return json(await w.tools.replay(name, cur.result, toolCtx));
  }

  if (!args.ok) {
    toolLog.info("invalid tool args", { name, takeoverId: body.takeoverId, issues: args.issues });
    await w.toolStore.finishCall(begin.id, args.result, "rejected");
    return json({ result: args.result });
  }
  try {
    const outcome = await w.tools.handle(name, args.args, toolCtx);
    await w.toolStore.finishCall(begin.id, outcome.result, isRejection(outcome.result) ? "rejected" : "ok");
    return json(outcome);
  } catch (e) {
    // Not stored as a result: the row is dropped so the browser's retry of this call_id runs the handler again.
    await w.toolStore.abortCall(begin.id).catch(() => undefined);
    toolLog.warn("tool handler failed", { name, takeoverId: body.takeoverId, code: isBatonError(e) ? e.code : "E_INTERNAL" });
    throw e;
  }
});

/** The first attempt was aborted while we waited: answer 409 so the browser retries (it re-runs then). */
function postToolAgain(_req: Request, _body: unknown, _name: ToolName): never {
  throw new BatonError("E_CASE_STATE", "The first attempt of this tool call failed: retry.", { retryAfterMs: 500 });
}

/** A handler answer that refuses (kept as `rejected` in tool_calls, for the QA details). */
function isRejection(r: Record<string, unknown>): boolean {
  return r.ok === false || r.accepted === false || r.result === "rejected" || r.status === "not_sent";
}
