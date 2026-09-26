import "server-only";

import { getPool } from "../db/client";
import { PgConnectorCallLog, type ConnectorCallLog } from "./call-log";

/**
 * WP16 connector runtime, public surface (PLATFORM §6). WP16·1 ships the guarded HTTP core and its parts; the
 * `ConnectorRuntime` / `RelayToolService` assembly lands in WP16·2 (see docs/notes/wp16.md).
 */
export { checkAddress, isIpLiteral, type AddressVerdict } from "./address";
export {
  argsAsValues, paymentConfirmed, runConfirmation, runEsignMock, runPaymentLink, runSmsMock,
  type BuiltinConnectorDeps, type ConnectorRun,
} from "./builtins";
export {
  connectorForTool, connectorOf, paramsOf, RelayConnectorRuntime, type ConnectorExecuteInput, type ConnectorRuntimeDeps,
} from "./runtime";
export { defaultConfirmationNumber, payLinkOf, spokenChars } from "./text";
export { validateToolArgs, type ToolParams, type ValidateToolArgsResult } from "./args";
export { argsHash, canonicalJson, DEDUPE_WINDOW_MS, MemoryConnectorCallLog, PgConnectorCallLog, type ConnectorCallLog } from "./call-log";
export {
  assertHostAllowed, DEFAULT_CONNECTOR_HOST_ALLOWLIST, destinationPolicy, isHostAllowed, parseDestination,
  type Destination, type DestinationPolicy,
} from "./destination";
export { createConnectorResolver, DNS_TIMEOUT_MS, pinnedLookup, resolvePublic, type ConnectorResolver } from "./dns";
export { handleEcho } from "./echo";
// WP16·3: the org host policy, the test console, the composition root and the webhook client (SAAS §5.6, §7.4).
export {
  assertHostResolvesPublic, checkConnectorHost, getOrgHostStore, installConnectorHostPolicy, normalizeConnectorHost,
  OrgConnectorHostPolicy, orgConnectorHosts, orgHostLimit, setHostCheckResolver, setOrgHostStore,
  type HostVerdict, type OrgHostStore,
} from "./host-policy";
export { installConnectorPorts, resetConnectorPortsInstall } from "./install";
export { CONSOLE_RAW_CAP_PRODUCTION, runConsoleTest, type ConsoleTestReport } from "./console";
export { publicHttpsPost, WEBHOOK_TIMEOUT_MS, type PublicHttpsPostResult } from "./public-post";
export {
  completionBody, sendCompletionWebhooks, type CompletionFacts, type CompletionWebhookResult,
} from "./completion-webhook";
export { ConnectorError, isConnectorError } from "./errors";
export { hmacHex, signatureHeader, verifyHmac, type HmacVerdict } from "./hmac";
export {
  executeHttpAction, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TIMEOUT_MS,
  type HttpActionDeps, type HttpActionInput, type HttpActionReport,
} from "./http";
export { prepareHttpAction, type HttpActionConnector, type SecretResolver } from "./http-connector";
export { lookupRow, LOOKUP_LIMITS, normalizeLookupKey, parseLookupTable, type LookupResult, type LookupTable } from "./lookup-table";
export { CONNECTOR_LIMITS, connectorLimiter, ConnectorRateLimiter } from "./rate-limit";
export { FORBIDDEN_DECLARED_HEADERS, isForbiddenDeclaredHeader, pickResponse, redactDeep, redactText } from "./shape";

let callLog: ConnectorCallLog | null = null;
/** The process-wide `connector_calls` log on Postgres (migration 0001). */
export function getConnectorCallLog(): ConnectorCallLog {
  return (callLog ??= new PgConnectorCallLog(getPool()));
}
