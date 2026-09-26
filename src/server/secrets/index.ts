import "server-only";

import { getPool } from "../db/client";
import { PgSecretRepo } from "./repo";
import { ConnectorSecretStore } from "./store";
import { secretPlanLimits } from "./plan";

export {
  ConnectorSecretStore, SecretError, MAX_SECRETS_PER_WORKSPACE, MAX_SECRET_VALUE_BYTES, NO_EXPIRY_MS, SECRET_TTL_MS,
  type SecretPlanLimits,
} from "./store";
export { MemorySecretRepo, PgSecretRepo, type SecretRepo, type SecretRow } from "./repo";
export { ConnectorSecretRebinder, installSecretRebinder } from "./rebind";
export { secretPlanLimits } from "./plan";

let store: ConnectorSecretStore | null = null;

/**
 * The process-wide `SecretStore` on Postgres (`connector_secrets`, migration 0001). The key is read lazily on first
 * use (HKDF from AGENT_TOOL_SECRET, or CONNECTOR_SECRETS_KEY): a deploy without it boots and fails closed with an
 * `EnvError` naming the variable.
 *
 * WP16·3: the count and the TTL come from the workspace's plan (SAAS §4.1) through `secretPlanLimits`, so a Guest
 * gets 3 secrets for 7 days and a Pro org gets 50 that do not expire — without any call site changing.
 */
export function getSecretStore(): ConnectorSecretStore {
  return (store ??= new ConnectorSecretStore({ repo: new PgSecretRepo(getPool()), plan: secretPlanLimits }));
}

/** Tests (and a future in-memory dev mode) replace the process store; `null` restores the Postgres one. */
export function setSecretStore(s: ConnectorSecretStore | null): void {
  store = s;
}
