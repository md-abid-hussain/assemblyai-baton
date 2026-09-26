import "server-only";

/**
 * Registering WP21's ports (SAAS §4, §14). WP21.
 *
 * Two ports move off their C3 defaults here and nowhere else:
 *  - `Entitlements` → the DB store (`src/server/entitlements/store.ts`), so plans come from `org_entitlements`
 *    and per-org overrides apply;
 *  - `BillingProvider` → Polar in the sandbox, or the simulated provider (§4.7).
 *
 * `getBilling()` is lazy on purpose. Building the Polar provider needs the Better Auth instance (the plugin owns
 * the `/checkout` endpoint), and `auth.ts` builds *its* plugin list from `polarPlugins()` — so constructing one
 * eagerly from the other's module scope is a cycle. Resolving at call time also means an env change in dev takes
 * effect on the next request instead of on the next restart.
 */
import type { BillingProvider } from "../../core/contracts/v3/services";
import { createDbEntitlements, setEntitlementRefresher } from "../entitlements/store";
import { log } from "../log";
import { setBillingProvider, setEntitlements } from "../saas/ports";
import { billingMode } from "./config";
import { createPolarBilling, createSimulatedBilling, polarDepsFrom } from "./provider";

const billingLog = log.child({ component: "billing" });

/** Injected by `registerBilling()`; kept behind a function so tests can register their own. */
type AuthApiResolver = () => { checkout?: unknown } | null;
let resolveAuthApi: AuthApiResolver = () => null;

/**
 * The provider for this request. Never throws: a Polar mode that cannot be built degrades to simulated, which is
 * §4.7's rule ("K-BILL trips → simulated") applied automatically rather than by hand.
 */
export function getBilling(): BillingProvider {
  if (billingMode() !== "polar") return createSimulatedBilling();
  const api = resolveAuthApi();
  if (!api?.checkout) {
    billingLog.warn("polar mode selected but the plugin is not mounted; using simulated billing");
    return createSimulatedBilling();
  }
  try {
    return createPolarBilling(polarDepsFrom(api));
  } catch (e) {
    billingLog.error("polar provider unavailable; using simulated billing", { err: String(e) });
    return createSimulatedBilling();
  }
}

/**
 * Called once at server start-up (and in tests' `beforeEach`). `authApi` is `requireAuth().api` in production;
 * passing it in keeps this module free of any `better-auth` import (the WP19 boundaries rule).
 */
export function registerBilling(authApi?: AuthApiResolver): void {
  if (authApi) resolveAuthApi = authApi;
  setEntitlements(createDbEntitlements());
  setBillingProvider({
    get mode() {
      return getBilling().mode;
    },
    startCheckout: (i) => getBilling().startCheckout(i),
    syncOrg: (orgId) => getBilling().syncOrg(orgId),
    syncCheckout: (checkoutId, orgId, userId) => getBilling().syncCheckout(checkoutId, orgId, userId),
  } as BillingProvider);
  // `Entitlements.refresh` reaches Polar through the provider, fail-static (§4.4).
  setEntitlementRefresher(async (orgId) => {
    await getBilling().syncOrg(orgId);
  });
}

/** Undo `registerBilling` for a test that wants the C3 defaults back. */
export function resetBillingRegistration(): void {
  resolveAuthApi = () => null;
  setEntitlementRefresher(null);
}
