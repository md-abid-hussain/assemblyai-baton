import "server-only";

/**
 * The connector test console (PLATFORM §6.5; WP16·3). One connector of one of the org's relays, run with
 * `mode:"console"` and no case.
 *
 * What the owner gets back is deliberately wider than what an agent ever sees: the redacted request line and
 * headers (secret values as `‹secret:name›`), the signature that was sent, status / ms / bytes, the picked result
 * exactly as the agent would receive it, and the raw response body — **capped at 2 KiB on the public deployment**
 * (`APP_ENV=production`), because the console is a debugging aid, not an egress channel for a large response.
 *
 * **Money connectors are dry runs.** `payment_link`, `confirmation`, `esign_mock` and `sms_mock` all mutate a run
 * (a checkout, a case status, a confirmation number), and the console has no run, so instead of executing them it
 * renders what *would* happen: the amount source and its clamp, the disclosure the tool waits for, the connectors
 * a confirmation requires, the SMS template. Nothing is created, nothing is charged, no case row moves.
 * `completion_webhook` is not a tool at all and answers the same way.
 *
 * `http_action` and `lookup_table` really run — that is the point of the console — with the full SSRF guard, the
 * org host policy, the call limits and one `connector_calls` row, exactly as a live call.
 */
import type { Connector } from "../../core/contracts/v2/blueprint";
import type { CompiledRelay, ConnectorCtx, ConnectorOutcome } from "../../core/contracts/v2/services";
import { BatonError } from "../../core/contracts/errors";
import { PAYMENT_MAX_CENTS, PAYMENT_MIN_CENTS } from "../payments/relay-account";
import { log } from "../log";
import { getConnectorCallLog } from "./index";
import { connectorOf, paramsOf, RelayConnectorRuntime } from "./runtime";
import type { HttpActionReport } from "./http";

const consoleLog = log.child({ component: "connector-console" });

/** PLATFORM §6.5 shows the raw body; §6.2 caps what we ever hold. On the public deployment it is 2 KiB. */
export const CONSOLE_RAW_CAP_PRODUCTION = 2048;

export interface ConsoleTestInput {
  orgId: string;
  relayId: string;
  connectorId: string;
  args: Record<string, unknown>;
}

export interface ConsoleTestReport {
  connectorId: string;
  type: Connector["type"];
  toolName: string | null;
  /** The relay version the console compiled and ran against. */
  relayVersionId: string | null;
  /** True when nothing was executed because the connector needs a run (money connectors). */
  dryRun: boolean;
  status: ConnectorOutcome["status"];
  /** Exactly what the agent would have received. */
  result: Record<string, unknown>;
  errorCode: string | null;
  message: string | null;
  httpStatus: number | null;
  ms: number;
  reqBytes: number;
  resBytes: number;
  request: HttpActionReport["request"];
  signature: string | null;
  raw: string | null;
  rawTruncated: boolean;
  address: string | null;
  droppedHeaders: string[];
  /** Set on a dry run: the fields the owner needs to see without executing anything. */
  wouldDo: Record<string, unknown> | null;
}

/** The connectors that need a live run; the console renders them instead of executing them. */
const DRY_RUN_TYPES: ReadonlySet<Connector["type"]> = new Set([
  "payment_link", "confirmation", "esign_mock", "sms_mock", "completion_webhook",
]);

const rawCap = (src: Record<string, string | undefined> = process.env): number | null => {
  const appEnv = src.APP_ENV?.trim().toLowerCase();
  const production = appEnv ? appEnv === "production" : src.NODE_ENV === "production";
  return production ? CONSOLE_RAW_CAP_PRODUCTION : null;
};

export interface ConsoleDeps {
  /** The compiled relay for this workspace's relay, and the version it came from. */
  load?: (orgId: string, relayId: string) => Promise<{ compiled: CompiledRelay; versionId: string | null }>;
  runtime?: () => RelayConnectorRuntime;
}

/** WP14b's registry: the owner's draft is snapshotted (content-addressed) and compiled, as a Test run would. */
async function defaultLoad(orgId: string, relayId: string): Promise<{ compiled: CompiledRelay; versionId: string | null }> {
  const d = (await import("../relays")).getRelaysDeps();
  const run = await d.registry.resolveRun(orgId, { relayId });
  const compiled = await d.engine.forVersion(run.versionId);
  return { compiled, versionId: run.versionId };
}

/** The console's own runtime: the real secrets, the real call log, and side-effect deps that are never reached. */
async function defaultRuntime(): Promise<RelayConnectorRuntime> {
  const secrets = async () => (await import("../secrets")).getSecretStore();
  const unreachable = (what: string) => (): never => {
    throw new BatonError("E_INTERNAL", `The test console never ${what}.`);
  };
  return new RelayConnectorRuntime({
    secrets: {
      resolve: async (ws, ref) => (await secrets()).resolve(ws, ref),
      nameOf: async (ws, ref) => (await secrets()).nameOf(ws, ref),
    },
    callLog: getConnectorCallLog(),
    payments: { create: unreachable("creates a payment") },
    store: {
      markConnector: unreachable("marks a connector"),
      putConfirmationNumber: unreachable("writes a confirmation number"),
      setCaseStatus: unreachable("moves a case"),
    },
  });
}

export async function runConsoleTest(i: ConsoleTestInput, deps: ConsoleDeps = {}): Promise<ConsoleTestReport> {
  const { compiled, versionId } = await (deps.load ?? defaultLoad)(i.orgId, i.relayId);
  const c = connectorOf(compiled, i.connectorId);
  if (!c) throw new BatonError("E_NOT_FOUND", "This relay has no connector with that id.");
  const toolName = "toolName" in c ? c.toolName : null;

  const base: ConsoleTestReport = {
    connectorId: c.id, type: c.type, toolName, relayVersionId: versionId, dryRun: false,
    status: "ok", result: {}, errorCode: null, message: null, httpStatus: null, ms: 0, reqBytes: 0, resBytes: 0,
    request: null, signature: null, raw: null, rawTruncated: false, address: null, droppedHeaders: [], wouldDo: null,
  };

  if (DRY_RUN_TYPES.has(c.type)) {
    return { ...base, dryRun: true, status: "refused", result: { status: "dry_run" }, wouldDo: dryRunRender(c) };
  }

  const ctx: ConnectorCtx = {
    caseId: null, takeoverId: null, publicationId: null, workspaceId: i.orgId, mode: "console",
    origin: (process.env.APP_URL ?? "").replace(/\/+$/, ""),
  };
  let http: HttpActionReport | null = null;
  const runtime = deps.runtime ? deps.runtime() : await defaultRuntime();
  const outcome = await runtime.execute({
    compiled, connectorId: c.id, args: i.args, ctx,
    onHttpReport: (r) => {
      http = r;
    },
  });
  const r = http as HttpActionReport | null;
  const cap = rawCap();
  const raw = r?.raw ?? null;
  const truncated = cap !== null && raw !== null && raw.length > cap;
  consoleLog.info("connector test", { orgId: i.orgId, connectorId: c.id, type: c.type, status: outcome.status });
  return {
    ...base,
    status: outcome.status,
    result: outcome.result,
    errorCode: r?.errorCode ?? null,
    message: r?.message ?? null,
    httpStatus: r?.httpStatus ?? null,
    ms: r?.ms ?? 0,
    reqBytes: r?.reqBytes ?? 0,
    resBytes: r?.resBytes ?? 0,
    request: r?.request ?? null,
    signature: r?.signature ?? null,
    raw: truncated ? raw!.slice(0, cap!) : raw,
    rawTruncated: truncated,
    address: r?.address ?? null,
    droppedHeaders: r?.droppedHeaders ?? [],
  };
}

/** What a run-bound connector WOULD do. Configuration only: no case, no account, no amount is computed. */
function dryRunRender(c: Connector): Record<string, unknown> {
  switch (c.type) {
    case "payment_link":
      return {
        action: "create a payment link",
        provider: c.provider,
        amountFrom: c.amount,
        clampUsd: { min: PAYMENT_MIN_CENTS / 100, max: PAYMENT_MAX_CENTS / 100 },
        requiresDisclosure: c.requiresDisclosure,
        esign: c.esign,
        smsTemplate: c.smsTemplate,
        note: "In a run this creates one checkout per takeover. The console creates nothing.",
      };
    case "confirmation":
      return {
        action: "send the confirmation",
        requires: c.requires,
        smsTemplate: c.smsTemplate,
        note: "In a run this is refused until every required connector has succeeded (a paid payment, for money).",
      };
    case "esign_mock":
      return { action: "send the e-sign document", documentTitle: c.documentTitle, smsTemplate: c.smsTemplate, requiresDisclosure: c.requiresDisclosure };
    case "sms_mock":
      return { action: "send the mock SMS", template: c.template, params: paramsOf(c) };
    case "completion_webhook":
      return {
        action: "POST the signed completion export",
        url: c.url,
        include: c.include,
        signed: c.hmacSecret !== null,
        note: "This fires when the run completes, never from a tool call.",
      };
    default:
      return { action: "nothing" };
  }
}
