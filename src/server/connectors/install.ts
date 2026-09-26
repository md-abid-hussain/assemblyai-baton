import "server-only";

/**
 * WP16's composition root for the v3 ports (SAAS §14; WP16·3).
 *
 * Three registrations, all idempotent, all called from the first WP16 route a process serves (the secrets routes,
 * the connector-host routes and the test console) rather than at module load, so importing a connector module in a
 * test never reaches for a database:
 *
 *  - `ConnectorHostPolicy` → the org policy (the deployment allowlist ∪ the org's hosts on Pro+);
 *  - `SecretRebinder`      → the re-sealing rebinder the claim flow calls inside its transaction;
 *  - the `secrets` and `connectorHosts` counters, so `Entitlements.assertCount` can answer with a real number
 *    before WP21 exists.
 *
 * `installConnectorPorts()` is safe to call on every request: each piece flips its own `installed` flag. Tests call
 * `resetConnectorPortsInstall()` after `resetSaasPorts()` so the next call re-registers.
 */
import { getSecretStore } from "../secrets";
import { installSecretRebinder, resetSecretRebinderInstall } from "../secrets/rebind";
import { log } from "../log";
import { setOrgCounter } from "../saas/ports";
import { installConnectorHostPolicy, resetConnectorHostPolicyInstall } from "./host-policy";

const installLog = log.child({ component: "connectors" });

let countersInstalled = false;

export function installConnectorPorts(): void {
  installConnectorHostPolicy();
  installSecretRebinder();
  if (countersInstalled) return;
  countersInstalled = true;
  setOrgCounter("secrets", async (orgId) => {
    try {
      return (await getSecretStore().list(orgId)).length;
    } catch (err) {
      // A counter that cannot count must not block the action it guards; the store's own cap still applies.
      installLog.warn("could not count secrets for the plan check", { orgId, err });
      return 0;
    }
  });
}

/** Tests: re-register after `resetSaasPorts()`. */
export function resetConnectorPortsInstall(): void {
  countersInstalled = false;
  resetConnectorHostPolicyInstall();
  resetSecretRebinderInstall();
}
