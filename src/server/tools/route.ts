import "server-only";

import { ToolRequestSchema } from "../../core/contracts/api";
import { BatonError, isBatonError } from "../../core/contracts/errors";
import { BatonToolNameSchema, safeParseToolArgs, type ToolName } from "../../core/contracts/tools";
import { newId } from "../../lib/ids";
import { log } from "../log";
import { json, rateLimited, readJson, route, type Params } from "../payments/http";
import type { RelayToolContext } from "../../core/contracts/v2";
import { wp6, type Wp6 } from "./wiring";

/**
 * Route #14 `POST /api/tools/[name]` (DESIGN §4.4): takeover token (scope "tools"), 60 calls per takeover,
 * idempotent on `(takeoverId, callId)` via the `tool_calls` unique index. Invalid model arguments are answered with
 * HTTP 200 and `INVALID_ARGS_RESULTS[name]` (G0), so the agent gets an answer it can act on.
 *
 * WP16·2 (PLATFORM §6.3): the route picks the service from the CASE, not from the tool name:
 * - `relay_version_id = null` and `RELAY_ENGINE=legacy` → WP6's `Wp6ToolService` (the unchanged Baton path);
 * - otherwise → `RelayToolService` (the stage gate, the generic built-ins and the connectors).
 *
 * Both sides share the `tool_calls` idempotency above, so a browser retry of one `call_id` replays whichever
 * service answered first. The tool NAME is only id-checked here: a relay names its own tools, so the legacy
 * `ToolNameSchema` enum applies to the legacy path alone (PLATFORM §4.7).
 */

const toolLog = log.child({ component: "tools-route" });
const REPLAY_WAIT_MS = 8_000;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

export const postTool = route<{ name: string }>("tools.post", async (req, ctx: Params<{ name: string }>) => {
  const { name } = await ctx.params;
  if (!TOOL_NAME_RE.test(name)) throw new BatonError("E_NOT_FOUND", "No such tool.");
  const body = await readJson(req, ToolRequestSchema);
  const w = wp6();
  const auth = await w.requireTakeover(req, { takeoverId: body.takeoverId, scope: "tools" });
  const rl = await w.rateLimiter.hit("tools", body.takeoverId, 60, 3600);
  if (!rl.ok) rateLimited(rl.retryAfterSec);

  const tko = await w.toolStore.getTakeover(body.takeoverId);
  if (!tko) throw new BatonError("E_NOT_FOUND", "No such takeover.");
  if (tko.caseId !== auth.caseId) throw new BatonError("E_FORBIDDEN", "The takeover belongs to another case.");

  const origin = req.headers.get("origin") ?? w.appUrl ?? new URL(req.url).origin;
  const base = { caseId: auth.caseId, takeoverId: body.takeoverId, callId: body.callId, visitorId: auth.visitorId, origin };
  const relay = await relayRoute(w, auth.caseId);
  if (!relay) {
    // P§4.7: the legacy leg is Baton's, so the enum still gates it. WP14a's widening renamed the enum to
    // `BatonToolNameSchema` and made `ToolNameSchema` the permissive relay-tool id, hence the name here.
    const parsedName = BatonToolNameSchema.safeParse(name);
    if (!parsedName.success) throw new BatonError("E_NOT_FOUND", "No such tool.");
    return legacyTool(w, parsedName.data, body, base);
  }
  const relayCtx: RelayToolContext = { ...base, mode: relay.mode, publicationId: null };

  const argsJson = asRecord(body.args);
  const begin = await w.toolStore.beginCall({ id: newId(), takeoverId: body.takeoverId, callId: body.callId, name, args: argsJson });
  if (!begin.fresh) {
    const cur = await waitForFirstAttempt(w, body.takeoverId, body.callId, begin);
    if (!cur) return retryThisCall();
    if (cur.result === null) throw new BatonError("E_CASE_STATE", "This tool call is still running.", { retryAfterMs: 1000 });
    return json(await relay.tools.replay(name, cur.result, relayCtx));
  }
  try {
    const outcome = await relay.tools.handle(name, body.args, relayCtx);
    await w.toolStore.finishCall(begin.id, outcome.result, isRejection(outcome.result) ? "rejected" : "ok");
    return json(outcome);
  } catch (e) {
    await w.toolStore.abortCall(begin.id).catch(() => undefined);
    toolLog.warn("relay tool handler failed", { name, takeoverId: body.takeoverId, code: isBatonError(e) ? e.code : "E_INTERNAL" });
    throw e;
  }
});

/** The unchanged WP6 path. */
async function legacyTool(
  w: Wp6,
  name: ToolName,
  body: { takeoverId: string; callId: string; args?: unknown },
  toolCtx: { caseId: string; takeoverId: string; callId: string; visitorId: string; origin: string },
): Promise<Response> {
  const args = safeParseToolArgs(name, body.args);
  const begin = await w.toolStore.beginCall({ id: newId(), takeoverId: body.takeoverId, callId: body.callId, name, args: asRecord(body.args) });
  if (!begin.fresh) {
    const cur = await waitForFirstAttempt(w, body.takeoverId, body.callId, begin);
    if (!cur) return retryThisCall();
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
}

/**
 * PLATFORM §6.3: which service runs this case. A case that names a relay version always runs the generic service;
 * a version-less case runs it only with `RELAY_ENGINE=kernel` (then `forVersion(null)` compiles the flagship).
 */
async function relayRoute(w: Wp6, caseId: string): Promise<{ tools: NonNullable<Wp6["relayTools"]>; mode: RelayToolContext["mode"] } | null> {
  const tools = w.relayTools;
  if (!tools || !w.relayCaseOf) return null;
  const c = await w.relayCaseOf(caseId);
  if (!c) return null;
  if (!c.relayVersionId && (w.relayEngine ?? "legacy") !== "kernel") return null;
  return { tools, mode: c.mode === "live" ? "live" : "test" };
}

/** A retry of the same VA call_id: wait for the first attempt, then answer with its result. */
async function waitForFirstAttempt(
  w: Wp6,
  takeoverId: string,
  callId: string,
  begin: { result: Record<string, unknown> | null; status: string | null },
): Promise<{ result: Record<string, unknown> | null; status: string | null } | null> {
  const deadline = Date.now() + REPLAY_WAIT_MS;
  let cur: { result: Record<string, unknown> | null; status: string | null } | null = begin;
  while (cur && cur.result === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    cur = await w.toolStore.getCall(takeoverId, callId);
  }
  return cur;
}

/** The first attempt was aborted while we waited: answer 409 so the browser retries (it re-runs then). */
function retryThisCall(): never {
  throw new BatonError("E_CASE_STATE", "The first attempt of this tool call failed: retry.", { retryAfterMs: 500 });
}

const asRecord = (args: unknown): Record<string, unknown> =>
  (args && typeof args === "object" ? args : { value: args ?? null }) as Record<string, unknown>;

/** A handler answer that refuses (kept as `rejected` in tool_calls, for the QA details). */
function isRejection(r: Record<string, unknown>): boolean {
  return r.ok === false || r.accepted === false || r.result === "rejected" || r.status === "not_sent" || r.status === "not_available";
}
