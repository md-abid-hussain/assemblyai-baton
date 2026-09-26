/**
 * contracts/ext/wp16-connectors.ts - WP16-local connector types that the frozen v2 contracts do not carry
 * (TASKS-v2 §2 rule 3: WP-local types live in `ext/`). Types and constants only; no runtime behaviour.
 *
 * - `WP16_CONNECTOR_ERROR_CODES`: the few owner-facing refusal codes that `V2_ERROR_CODES` has no slot for
 *   (a bad connector URL, an oversized request, a wrong content type, …). They only ever travel in
 *   `ConnectorTestResponse.errorCode` (a plain string) and in `connector_calls.error_code`; routes still answer
 *   with the v1/v2 `ApiError` codes.
 * - `ConnectorCallRecord`: one `connector_calls` row (PLATFORM §2.4, migration 0001 by WP14b), as WP16 writes it.
 */
import type { CONNECTOR_MODES, CONNECTOR_OUTCOME_STATUSES, V2ErrorCode } from "../v2/api";

/** Connector refusals with no `V2_ERROR_CODES` entry (owner-facing only; never shown to the agent). */
export const WP16_CONNECTOR_ERROR_CODES = [
  "E_CONN_URL",                // not https, a port other than 443, userinfo, an over-long or unusable host
  "E_CONN_REQUEST_TOO_LARGE",  // the request body or URL is over 8 KiB
  "E_CONN_CONTENT_TYPE",       // a 2xx response that is neither JSON nor text/plain
  "E_CONN_BAD_RESPONSE",       // a 2xx JSON response that does not parse
  "E_CONN_HTTP",               // a non-2xx, non-3xx response (the agent sees {status:"failed", http_status})
  "E_CONN_NETWORK",            // connect, TLS or socket failure
  "E_CONN_ARGS",               // the args do not satisfy the connector's params
  "E_CONN_RATE_LIMITED",       // a §6.2 call limit (per run, workspace, host or global) is spent
] as const;
export type Wp16ConnectorErrorCode = (typeof WP16_CONNECTOR_ERROR_CODES)[number];

/** Every code a connector call can end with: the v2 `E_CONN_*` codes plus the WP16-local ones. */
export type ConnectorErrorCode =
  | Extract<V2ErrorCode, `E_CONN_${string}`>
  | Wp16ConnectorErrorCode;

export type ConnectorOutcomeStatus = (typeof CONNECTOR_OUTCOME_STATUSES)[number];
export type ConnectorMode = (typeof CONNECTOR_MODES)[number];

/** One `connector_calls` row. Only status, timings, byte counts and the args hash; never header or secret values. */
export interface ConnectorCallRecord {
  id: string;
  caseId: string | null;
  takeoverId: string | null;
  relayVersionId: string | null;
  publicationId: string | null;
  connectorId: string;
  toolName: string;
  mode: ConnectorMode;
  status: ConnectorOutcomeStatus;
  httpStatus: number | null;
  ms: number;
  reqBytes: number;
  resBytes: number;
  /** sha256 of the canonical `{tool, args}` JSON (hex, 64 chars): the gateway dedupe key (PLATFORM §6.3 step 5). */
  argsHash: string | null;
  /** Exactly what the agent saw (secret values already redacted). Stored for the 30 s gateway dedupe. */
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
}
