import "server-only";

import type { Connector } from "../../core/contracts/v2/blueprint";
import type { CompiledRelay, ConnectorCtx, ConnectorOutcome, ConnectorRuntime } from "../../core/contracts/v2/services";
import { lookupRow, parseLookupTable, type LookupTable } from "../../core/relay/lookup-table";
import { validateToolArgs, type ToolParams } from "../../core/relay/tool-args";
import { log as rootLog, type Logger } from "../log";
import {
  runConfirmation, runEsignMock, runPaymentLink, runSmsMock, type BuiltinConnectorDeps, type ConnectorRun,
} from "./builtins";
import { argsHash, type ConnectorCallLog } from "./call-log";
import { destinationPolicy, type DestinationPolicy } from "./destination";
import { isConnectorError } from "./errors";
import { executeHttpAction, type HttpActionDeps, type HttpActionReport } from "./http";
import { prepareHttpAction, type SecretResolver } from "./http-connector";
import { connectorLimiter, type ConnectorRateLimiter } from "./rate-limit";

/**
 * `ConnectorRuntime` (TASKS-v2 §5; PLATFORM §6): ONE entry point for every connector of a compiled relay, used by
 * `RelayToolService` (test and live runs), by WP18's published gateway and by WP16·3's test console.
 *
 * What it does on every call, in this order:
 *   1. find the connector on the compiled relay (an unknown id is a refusal, never a throw);
 *   2. `validateToolArgs` against the connector's declared params (the tool service has already validated, but the
 *      console and the gateway reach us directly, and validating twice costs nothing);
 *   3. the §6.2 call limits (`connectorLimiter`), which a refusal does NOT count;
 *   4. dispatch by type;
 *   5. one `connector_calls` row, holding only status, ms, byte counts, the args hash and the agent-visible result.
 *
 * It never throws: a `ConnectorError` from the HTTP path, a bad table, a missing secret and a rate refusal all come
 * back as a `ConnectorOutcome` the agent can act on, because a Voice Agent tool call that 500s is dead air.
 *
 * `payment_link`, `confirmation`, `sms_mock` and `esign_mock` need the RUN (its snapshot, account, named values and
 * payment). The caller passes it as `i.run`; `RelayToolService` has it loaded already, so the case is read once per
 * tool call. Without it (the console, PLATFORM §6.5) those four answer `not_available` — the dry-run render is
 * WP16·3's `/api/connectors/test`. `lookup_table` and `http_action` need no run and work in the console today.
 */

export interface ConnectorExecuteInput {
  compiled: CompiledRelay;
  connectorId: string;
  args: Record<string, unknown>;
  ctx: ConnectorCtx;
  /** WP16·2: the loaded run, for the connectors that need one. */
  run?: ConnectorRun;
  /**
   * WP16·3 (PLATFORM §6.5): the test console wants the owner-facing detail of an `http_action` — the redacted
   * request line, the signature, the raw body — which never reaches the agent. Set only by `/api/connectors/test`.
   */
  onHttpReport?: (report: HttpActionReport) => void;
}

export interface ConnectorRuntimeDeps extends BuiltinConnectorDeps {
  secrets: SecretResolver;
  callLog: ConnectorCallLog;
  limiter?: ConnectorRateLimiter;
  /** Default: `destinationPolicy()` (read per call, so an env change is picked up). */
  policy?: () => DestinationPolicy;
  /**
   * WP16·3 (SAAS §5.6): the org-aware host check, run before any DNS lookup. Default: `checkConnectorHost` from
   * `./host-policy` (imported lazily, so a runtime without a database still constructs).
   */
  hostCheck?: (orgId: string, host: string) => Promise<{ ok: boolean; message?: string }>;
  /** Transport overrides for the HTTP path (tests). */
  http?: Omit<HttpActionDeps, "policy">;
  /** Parsed `lookup_table`s, keyed by `<blueprint hash>:<connector id>`. */
  tableCacheSize?: number;
}

const LOOKUP_ARG_PARAMS: ToolParams = { type: "object", required: ["key"], properties: { key: { type: "string" } } };

export class RelayConnectorRuntime implements ConnectorRuntime {
  private readonly limiter: ConnectorRateLimiter;
  private readonly policy: () => DestinationPolicy;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly tables = new Map<string, LookupTable | { error: string }>();
  private readonly tableCacheSize: number;

  constructor(private readonly deps: ConnectorRuntimeDeps) {
    this.limiter = deps.limiter ?? connectorLimiter;
    this.policy = deps.policy ?? (() => destinationPolicy());
    this.now = deps.now ?? Date.now;
    this.log = (deps.log ?? rootLog).child({ component: "connectors" });
    this.tableCacheSize = deps.tableCacheSize ?? 50;
  }

  async execute(i: ConnectorExecuteInput): Promise<ConnectorOutcome> {
    const started = this.now();
    const c = connectorOf(i.compiled, i.connectorId);
    if (!c) {
      this.log.warn("unknown connector", { connectorId: i.connectorId, hash: i.compiled.hash });
      return { status: "refused", succeeded: false, result: { status: "not_available", instruction: "That action is not configured on this relay." } };
    }
    const toolName = "toolName" in c ? c.toolName : c.id;

    const bad = this.validate(c, i.args);
    if (bad) return this.record(i, c, toolName, bad, started, "E_CONN_ARGS");

    const host = hostOf(c);
    const verdict = this.limiter.take(
      { runKey: i.ctx.takeoverId ?? consoleKey(i.ctx), connectorId: c.id, workspaceId: i.ctx.workspaceId, host },
      started,
    );
    if (!verdict.ok) {
      this.log.warn("connector call limit", { connectorId: c.id, limit: verdict.limit, workspaceId: i.ctx.workspaceId });
      const out: ConnectorOutcome = { status: "refused", succeeded: false, result: { status: "failed", reason: "rate_limited" } };
      return this.record(i, c, toolName, out, started, "E_CONN_RATE_LIMITED");
    }

    try {
      const out = await this.dispatch(c, i);
      return await this.record(i, c, toolName, out.outcome, started, out.errorCode ?? null, out.httpStatus ?? null, out.bytes);
    } catch (err) {
      const code = isConnectorError(err) ? err.code : "E_CONN_INTERNAL";
      const message = isConnectorError(err) ? err.message : "This action could not be completed.";
      this.log.warn("connector failed", { connectorId: c.id, code, err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      const outcome: ConnectorOutcome = { status: "error", succeeded: false, result: { status: "failed", reason: reasonOf(code) } };
      void message;
      return this.record(i, c, toolName, outcome, started, code);
    }
  }

  // ------------------------------------------------------------------------------------------ dispatch

  private async dispatch(
    c: Connector,
    i: ConnectorExecuteInput,
  ): Promise<{ outcome: ConnectorOutcome; errorCode?: string | null; httpStatus?: number | null; bytes?: { req: number; res: number } }> {
    switch (c.type) {
      case "lookup_table":
        return { outcome: this.lookup(c, i) };
      case "http_action": {
        const input = await prepareHttpAction(c, { args: i.args, run: runBody(i) }, this.deps.secrets, i.ctx.workspaceId);
        const report = await executeHttpAction(input, {
          ...(this.deps.http ?? {}),
          policy: this.policy(),
          checkHost: (host) => this.checkHost(i.ctx.workspaceId, host),
        });
        i.onHttpReport?.(report);
        return {
          outcome: { status: report.status, succeeded: report.status === "ok", result: report.agentResult },
          errorCode: report.errorCode,
          httpStatus: report.httpStatus,
          bytes: { req: report.reqBytes, res: report.resBytes },
        };
      }
      case "payment_link": {
        const run = this.runOr(i);
        if (!run) return { outcome: noRun() };
        return { outcome: await runPaymentLink(c, i.args, run, i.ctx, this.deps) };
      }
      case "confirmation": {
        const run = this.runOr(i);
        if (!run) return { outcome: noRun() };
        return { outcome: await runConfirmation(c, run, this.deps, (id) => connectorOf(i.compiled, id)?.type ?? null) };
      }
      case "sms_mock": {
        const run = this.runOr(i);
        if (!run) return { outcome: noRun() };
        return { outcome: await runSmsMock(c, i.args, run, this.deps) };
      }
      case "esign_mock": {
        const run = this.runOr(i);
        if (!run) return { outcome: noRun() };
        return { outcome: await runEsignMock(c, i.args, run, i.ctx, this.deps) };
      }
      case "completion_webhook":
        // Not a tool: it fires on run completion (WP16·3), never from an agent call.
        return { outcome: { status: "refused", succeeded: false, result: { status: "not_available" } } };
    }
  }

  private runOr(i: ConnectorExecuteInput): ConnectorRun | null {
    return i.run ?? null;
  }

  /**
   * The §5.6 host gate. `ctx.workspaceId` is already the org that OWNS the relay (on a published run the gateway
   * passes the publication's org), which is exactly whose allowed hosts must decide — never the caller's.
   */
  private async checkHost(orgId: string, host: string): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.hostCheck) return this.deps.hostCheck(orgId, host);
    const { checkConnectorHost } = await import("./host-policy");
    return checkConnectorHost(orgId, host);
  }

  /** `lookup_table`: parsed once per `(blueprint hash, connector)` and cached, then one row lookup. */
  private lookup(c: Extract<Connector, { type: "lookup_table" }>, i: ConnectorExecuteInput): ConnectorOutcome {
    const key = `${i.compiled.hash}:${c.id}`;
    let entry = this.tables.get(key);
    if (entry === undefined) {
      const parsed = parseLookupTable({ format: c.format, data: c.data, keyColumn: c.keyColumn });
      entry = parsed.ok ? parsed.table : { error: parsed.errors[0] ?? "the table could not be parsed" };
      if (this.tables.size >= this.tableCacheSize) this.tables.delete(this.tables.keys().next().value as string);
      this.tables.set(key, entry);
    }
    if ("error" in entry) {
      this.log.warn("lookup table did not parse", { connectorId: c.id, error: entry.error });
      return { status: "error", succeeded: false, result: { status: "failed", reason: "unavailable" } };
    }
    const row = lookupRow(entry, i.args.key);
    return "data" in row
      ? { status: "ok", succeeded: true, result: { data: row.data } }
      : { status: "ok", succeeded: false, result: { status: "not_found" } };
  }

  // ------------------------------------------------------------------------------------------ args, logging

  /** `validateToolArgs` against the connector's declared params; null = the args are fine. */
  private validate(c: Connector, args: Record<string, unknown>): ConnectorOutcome | null {
    const params = paramsOf(c);
    if (!params) return null;
    const r = validateToolArgs(params, args);
    if (r.ok) return null;
    return { status: "refused", succeeded: false, result: { status: "failed", reason: "invalid_args", instruction: `Call it again with ${r.errors[0] ?? "the declared arguments"}.` } };
  }

  private async record(
    i: ConnectorExecuteInput,
    c: Connector,
    toolName: string,
    outcome: ConnectorOutcome,
    started: number,
    errorCode: string | null,
    httpStatus: number | null = null,
    bytes: { req: number; res: number } = { req: 0, res: 0 },
  ): Promise<ConnectorOutcome> {
    try {
      await this.deps.callLog.record({
        caseId: i.ctx.caseId,
        takeoverId: i.ctx.takeoverId,
        relayVersionId: i.compiled.versionId,
        publicationId: i.ctx.publicationId,
        connectorId: c.id,
        toolName,
        mode: i.ctx.mode,
        status: outcome.status,
        httpStatus,
        ms: Math.max(0, this.now() - started),
        reqBytes: bytes.req,
        resBytes: bytes.res,
        argsHash: argsHash(toolName, i.args),
        result: outcome.result,
        errorCode,
      });
    } catch (err) {
      // The log is analytics and the gateway's dedupe memory; losing a row must never lose the tool answer.
      this.log.warn("connector_calls insert failed", { connectorId: c.id, err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
    return outcome;
  }
}

// ------------------------------------------------------------------------------------------ helpers

export function connectorOf(compiled: CompiledRelay, id: string): Connector | null {
  return compiled.blueprint?.connectors.find((c) => c.id === id) ?? null;
}

/** The connector that exposes this tool name, or null (built-in tools have none). */
export function connectorForTool(compiled: CompiledRelay, toolName: string): Connector | null {
  return compiled.blueprint?.connectors.find((c) => "toolName" in c && c.toolName === toolName) ?? null;
}

/** The declared `params` of a connector, or null when its argument shape is fixed by the kernel. */
export function paramsOf(c: Connector): ToolParams | null {
  if (c.type === "sms_mock" || c.type === "http_action") return c.params;
  if (c.type === "lookup_table") return LOOKUP_ARG_PARAMS;
  return null;
}

const hostOf = (c: Connector): string | null => {
  if (c.type !== "http_action" && c.type !== "completion_webhook") return null;
  try {
    return new URL(c.url).hostname;
  } catch {
    return null;
  }
};

const consoleKey = (ctx: ConnectorCtx): string | null => (ctx.mode === "console" ? `console:${ctx.workspaceId}` : null);

const noRun = (): ConnectorOutcome => ({
  status: "refused",
  succeeded: false,
  result: { status: "not_available", instruction: "This action needs a live run." },
});

/** The `run` block of an `http_action` request body (PLATFORM §6.2 "Request"). */
function runBody(i: ConnectorExecuteInput): { relay: string; version: number; case: string | null; mode: ConnectorCtx["mode"] } {
  const ui = i.compiled.ui.relay;
  return { relay: ui.slug, version: versionOf(i.compiled), case: i.ctx.caseId, mode: i.ctx.mode };
}

/** The published version number is not on `CompiledRelay`; the UI spec's relay block is, and 0 means "draft". */
function versionOf(compiled: CompiledRelay): number {
  const n = Number(compiled.ui.relay.versionId?.split(":").at(-1));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** An owner-facing error code → the one-word reason the agent is told (PLATFORM §6.2 "Result to the agent"). */
function reasonOf(code: string): string {
  if (code === "E_CONN_SECRET_MISSING") return "not_configured";
  if (code === "E_CONN_HOST_NOT_ALLOWED") return "destination_not_allowed";
  if (code === "E_CONN_TIMEOUT") return "timeout";
  return "unavailable";
}
