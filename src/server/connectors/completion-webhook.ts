import "server-only";

/**
 * `completion_webhook` (PLATFORM §6.1 table, §6.2; WP16·3, the T3 SHOULD).
 *
 * The one connector that is **not a tool**: no agent can call it, and the runtime refuses it by design. It fires
 * once, when a run finishes — after verification, or after the 60 s the verifier is given — and POSTs a signed
 * JSON export of what the run produced.
 *
 * Shape and guards:
 *  - the body carries only what the blueprint's `include` asks for (`case`, `qa`, `payment`) plus the run header;
 *    **never an audio URL, a recording id or a transcript**, and never a secret;
 *  - it is signed with the same C2 headers as an `http_action` (`X-Changeover-Timestamp`,
 *    `X-Changeover-Signature: v1=…`, `X-Changeover-Delivery`), so a customer endpoint verifies both with one
 *    15-line recipe;
 *  - it goes out through the SSRF-guarded client, and — because the URL comes from a BLUEPRINT, not from a
 *    webhook-endpoint setting — the §5.6 connector host policy applies, exactly as it does to `http_action`;
 *  - one `connector_calls` row per attempt, and it never throws into the caller: a run must complete whether or
 *    not the customer's endpoint is up. There is no retry here (SAAS §7 webhooks are the durable channel).
 *
 * The caller is the terminal-transition path (WP14b's takeover completion / WP18's verify job), which owns the
 * facts; this module owns the wire. See `docs/notes/requests/wp16-to-wp14b.md`.
 */
import { randomUUID } from "node:crypto";

import { CONNECTOR_HEADERS } from "@/core/contracts/v2/api";
import type { Connector, SecretRef } from "@/core/contracts/v2/blueprint";
import type { CompiledRelay } from "@/core/contracts/v2/services";
import { argsHash, type ConnectorCallLog } from "./call-log";
import { parseDestination } from "./destination";
import { isConnectorError } from "./errors";
import { checkConnectorHost } from "./host-policy";
import { signatureHeader } from "./hmac";
import { publicHttpsPost } from "./public-post";
import { log as rootLog, type Logger } from "../log";

export type CompletionWebhookConnector = Extract<Connector, { type: "completion_webhook" }>;

/** What the terminal path knows. Everything is optional: `include` decides what is actually sent. */
export interface CompletionFacts {
  runId: string;
  caseId: string;
  outcome: string;
  endedAt: string;
  /** Field ids → status/value pairs, already redacted by the caller to what the owner may export. */
  case?: Record<string, unknown>;
  qa?: Record<string, unknown>;
  payment?: Record<string, unknown>;
}

export interface CompletionWebhookDeps {
  /** The relay owner's workspace: whose secret is resolved and whose host policy applies. */
  workspaceId: string;
  secrets: { resolve(ws: string, ref: SecretRef): Promise<string> };
  callLog?: ConnectorCallLog;
  post?: typeof publicHttpsPost;
  hostCheck?: (orgId: string, host: string) => Promise<{ ok: boolean; message?: string }>;
  now?: () => number;
  uuid?: () => string;
  log?: Logger;
}

export interface CompletionWebhookResult {
  connectorId: string;
  status: "ok" | "blocked" | "error" | "refused";
  httpStatus: number | null;
  errorCode: string | null;
  ms: number;
  /** The exact body that was signed and sent (owner diagnostics; never contains a secret). */
  body: string | null;
  signature: string | null;
}

/** The export body. Only the requested sections, and only fields the caller passed. */
export function completionBody(c: CompletionWebhookConnector, compiled: CompiledRelay, f: CompletionFacts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    event: "run.completed",
    relay: compiled.ui.relay.slug,
    version: compiled.ui.relay.versionId,
    run: { id: f.runId, case: f.caseId, outcome: f.outcome, ended_at: f.endedAt },
  };
  if (c.include.includes("case") && f.case) body.case = f.case;
  if (c.include.includes("qa") && f.qa) body.qa = f.qa;
  if (c.include.includes("payment") && f.payment) body.payment = f.payment;
  return body;
}

/** Fire every `completion_webhook` on the relay. Returns one result per connector; never throws. */
export async function sendCompletionWebhooks(
  compiled: CompiledRelay,
  facts: CompletionFacts,
  deps: CompletionWebhookDeps,
): Promise<CompletionWebhookResult[]> {
  const hooks = (compiled.blueprint?.connectors ?? []).filter(
    (c): c is CompletionWebhookConnector => c.type === "completion_webhook",
  );
  const out: CompletionWebhookResult[] = [];
  for (const c of hooks) out.push(await sendOne(c, compiled, facts, deps));
  return out;
}

async function sendOne(
  c: CompletionWebhookConnector,
  compiled: CompiledRelay,
  facts: CompletionFacts,
  deps: CompletionWebhookDeps,
): Promise<CompletionWebhookResult> {
  const now = deps.now ?? Date.now;
  const log = (deps.log ?? rootLog).child({ component: "completion-webhook" });
  const started = now();
  const result: CompletionWebhookResult = {
    connectorId: c.id, status: "error", httpStatus: null, errorCode: null, ms: 0, body: null, signature: null,
  };
  const done = async (): Promise<CompletionWebhookResult> => {
    result.ms = Math.max(0, now() - started);
    try {
      await deps.callLog?.record({
        caseId: facts.caseId,
        takeoverId: facts.runId,
        relayVersionId: compiled.versionId,
        publicationId: null,
        connectorId: c.id,
        toolName: c.id, // a completion webhook has no tool name; the connector id keeps the row readable
        mode: "live",
        status: result.status,
        httpStatus: result.httpStatus,
        ms: result.ms,
        reqBytes: result.body ? Buffer.byteLength(result.body) : 0,
        resBytes: 0,
        argsHash: argsHash(c.id, { run: facts.runId }),
        result: { status: result.status },
        errorCode: result.errorCode,
      });
    } catch (err) {
      log.warn("connector_calls insert failed", { connectorId: c.id, err });
    }
    return result;
  };

  try {
    const dest = parseDestination(c.url);
    const check = await (deps.hostCheck ?? checkConnectorHost)(deps.workspaceId, dest.host);
    if (!check.ok) {
      result.status = "blocked";
      result.errorCode = "E_CONN_HOST_NOT_ALLOWED";
      log.warn("completion webhook host is not allowed", { connectorId: c.id, host: dest.host });
      return done();
    }
    if (!c.hmacSecret) {
      // Lint K2 refuses this at save time; a cloned relay can still reach here, and an UNSIGNED export is worse
      // than no export: the receiver could not tell it from anyone else's POST.
      result.status = "refused";
      result.errorCode = "E_CONN_SECRET_MISSING";
      return done();
    }
    const secret = await deps.secrets.resolve(deps.workspaceId, c.hmacSecret);
    const body = JSON.stringify(completionBody(c, compiled, facts));
    const ts = Math.floor(now() / 1000);
    const signature = signatureHeader(secret, ts, body);
    result.body = body;
    result.signature = signature;

    const post = deps.post ?? publicHttpsPost;
    const r = await post(dest.url.toString(), {
      headers: {
        [CONNECTOR_HEADERS.timestamp]: String(ts),
        [CONNECTOR_HEADERS.signature]: signature,
        [CONNECTOR_HEADERS.delivery]: (deps.uuid ?? randomUUID)(),
      },
      body,
    });
    result.httpStatus = r.status;
    result.errorCode = r.errorCode;
    result.status = r.ok ? "ok" : r.errorCode === "E_CONN_HTTP" ? "error" : "error";
    if (!r.ok) log.warn("completion webhook was not accepted", { connectorId: c.id, status: r.status, errorCode: r.errorCode });
    return done();
  } catch (err) {
    result.errorCode = isConnectorError(err) ? err.code : "E_CONN_INTERNAL";
    log.warn("completion webhook failed", { connectorId: c.id, code: result.errorCode });
    return done();
  }
}
