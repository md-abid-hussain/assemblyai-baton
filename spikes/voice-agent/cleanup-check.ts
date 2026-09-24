/** cleanup-check.ts - list stored agents / webhook subscriptions / phone numbers on both hosts (read-only). */
import { VA_US_REST_BASE } from "./client.ts";
import { restFor, vaLogger } from "./harness.ts";
const log = vaLogger("cleanup-check");
for (const [host, rest] of [["global", restFor(log)], ["us", restFor(log, "raw", VA_US_REST_BASE)]] as const) {
  for (const path of ["/agents", "/webhook-subscriptions", "/phone-numbers"]) {
    const r = await rest.request("GET", path, undefined, `${host} ${path}`);
    console.log(host, path, r.status, JSON.stringify(r.body).slice(0, 120));
  }
}
log.close();
