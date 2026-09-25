import "server-only";

import { log } from "../log";
import { wp6 } from "../tools/wiring";

/**
 * `/pay/done?checkout_id=…` (the hosted new-tab variant's success URL, DESIGN §5.12): ask the server to reconcile
 * that checkout with Polar (a server GET; nothing the browser says counts). Safe without auth: it can only make the
 * server read Polar, rate-limited by the reconcile interval. Never throws (the page always renders).
 */
export async function reconcileCheckout(checkoutId: string | null | undefined): Promise<"succeeded" | "pending" | "unknown"> {
  if (!checkoutId || !/^[A-Za-z0-9_-]{8,80}$/.test(checkoutId)) return "unknown";
  try {
    const w = wp6();
    const p = await w.payments.store.getByCheckout(checkoutId);
    if (!p) return "unknown";
    const v = await w.payments.view(p.id, { reconcile: true });
    return v.status === "succeeded" ? "succeeded" : "pending";
  } catch (err) {
    log.child({ component: "pay-done" }).warn("reconcile failed", { err: err instanceof Error ? err.message.slice(0, 160) : String(err) });
    return "unknown";
  }
}
