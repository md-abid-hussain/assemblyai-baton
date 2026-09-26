import "server-only";

import type { ConnectorErrorCode, ConnectorOutcomeStatus } from "@/core/contracts/ext/wp16-connectors";

/**
 * `ConnectorError`: a refused or failed connector step. `code` is a v2 `E_CONN_*` code or a WP16-local one
 * (contracts/ext/wp16-connectors.ts); `status` is the `connector_calls.status` it maps to. The message is
 * owner-facing (console, logs) and never carries a secret value, a header value or the raw response.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status: ConnectorOutcomeStatus;
  constructor(code: ConnectorErrorCode, message: string, status?: ConnectorOutcomeStatus) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status ?? DEFAULT_STATUS[code];
  }
}

const DEFAULT_STATUS: Record<ConnectorErrorCode, ConnectorOutcomeStatus> = {
  E_CONN_HOST_NOT_ALLOWED: "blocked",
  E_CONN_ADDRESS: "blocked",
  E_CONN_URL: "refused",
  E_CONN_REQUEST_TOO_LARGE: "refused",
  E_CONN_SECRET_MISSING: "refused",
  E_CONN_ARGS: "refused",
  E_CONN_RATE_LIMITED: "refused",
  E_CONN_DNS: "error",
  E_CONN_REDIRECT: "error",
  E_CONN_ENCODING: "error",
  E_CONN_TOO_LARGE: "error",
  E_CONN_CONTENT_TYPE: "error",
  E_CONN_BAD_RESPONSE: "error",
  E_CONN_HTTP: "error",
  E_CONN_NETWORK: "error",
  E_CONN_TIMEOUT: "timeout",
};

export const isConnectorError = (e: unknown): e is ConnectorError => e instanceof ConnectorError;
