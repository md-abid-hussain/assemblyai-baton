/**
 * scripts/polar/lab-seed.ts - seed a LOCAL dev database with one fictional s01 case, drive the REAL tool handlers up to
 * the pay link (WP1 core + WP3 repository + WP6 payments, i.e. the default `wp6()` composition), and print a
 * `/pay/lab` URL that mounts the MockPhone against that payment (DEV ONLY).
 *
 *   npx tsx --conditions=react-server scripts/polar/lab-seed.ts [--mode polar|mock] [--origin http://localhost:3107]
 *
 * Steps: WP3 `create` (kit s01 policy) → takeover row → update_case_field × 8 → confirm_effective_date →
 * get_disclosure premium_change + esign_consent → send_esign_and_pay_link (push: `link_sent`). Polar mode creates a
 * real SANDBOX checkout for the disclosed amount (POLAR_SERVER must be sandbox). Run `next dev -p 3107` with the same
 * PAYMENTS_MODE / APP_URL / EMBED_ORIGINS (scripts/day1/polar-lab-e2e.ts prints the command).
 *
 * Uses DATABASE_URL (refuses anything that is not localhost), CASE_TOKEN_SECRET and VISITOR_SECRET from .env; never
 * prints them. The printed case/visitor tokens are short-lived dev credentials for this fictional case only.
 */
import type { FieldId } from "../../src/core/contracts/case";
import type { ToolArgs, ToolName } from "../../src/core/contracts/tools";
import { issueCaseToken } from "../../src/server/auth/case-token";
import { issueVisitorToken } from "../../src/server/auth/visitor";
import { getCaseRepository } from "../../src/server/cases";
import { closeDb, getDb } from "../../src/server/db/client";
import * as schema from "../../src/server/db/schema";
import { resetEnvCache } from "../../src/server/env";
import { wp6 } from "../../src/server/tools/wiring";
import { newId } from "../../src/lib/ids";
import { loadEnv } from "../lib/load-env";

const VISITOR = "lab-visitor";
const S01_ANSWERS: [FieldId, string][] = [
  ["driver_full_name", "Maya Raman"], ["driver_dob", "March 14, 2009"], ["driver_relation", "daughter"], ["license_state", "Ohio"],
  ["license_status", "provisional"], ["vehicle_assignment", "2021 Honda Civic"], ["operator_type", "primary"], ["garaging_zip", "44107"],
];

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] ?? d : d);
  const mode = opt("--mode", "polar") as "polar" | "mock";
  const origin = opt("--origin", "http://localhost:3107");
  process.env.PAYMENTS_MODE = mode;
  process.env.APP_URL ||= origin;
  process.env.EMBED_ORIGINS ||= origin;
  resetEnvCache();
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(dbUrl)) throw new Error("lab-seed only runs against a local DATABASE_URL");
  if (mode === "polar" && (process.env.POLAR_SERVER ?? "sandbox") !== "sandbox") throw new Error("sandbox only");
  if (mode === "polar" && (!process.env.POLAR_ACCESS_TOKEN || !process.env.POLAR_PRODUCT_ID)) throw new Error("POLAR_ACCESS_TOKEN / POLAR_PRODUCT_ID missing (scripts/polar/setup.ts)");
  if (!process.env.CASE_TOKEN_SECRET || !process.env.VISITOR_SECRET) throw new Error("CASE_TOKEN_SECRET / VISITOR_SECRET missing (run npm run secrets:init)");

  const { caseId } = await getCaseRepository().create({ mode: "watch", callId: null, scenarioId: "s01", visitorId: VISITOR, ipKey: "lab" });
  const takeoverId = `tko_${newId()}`;
  await getDb().insert(schema.takeovers).values({ id: takeoverId, caseId, armedAt: new Date(), tArmMs: 60_000 });

  const w = wp6();
  let n = 0;
  const call = async <N extends ToolName>(name: N, a: ToolArgs[N]) => {
    const out = await w.tools.handle(name, a, { caseId, takeoverId, callId: `lab_${++n}`, visitorId: VISITOR, origin });
    return out;
  };
  for (const [field, value] of S01_ANSWERS) {
    const r = await call("update_case_field", { field, value, reason: "newly_provided" });
    if (r.result.result !== "accepted") throw new Error(`update_case_field ${field}: ${JSON.stringify(r.result)}`);
  }
  const d = await call("confirm_effective_date", { date: "2026-10-02", customer_words: "October 2nd" });
  if (d.result.accepted !== true) throw new Error(`confirm_effective_date: ${JSON.stringify(d.result)}`);
  for (const kind of ["premium_change", "esign_consent"] as const) {
    const r = await call("get_disclosure", { kind });
    if (r.result.ok !== true) throw new Error(`get_disclosure ${kind}: ${JSON.stringify(r.result)}`);
  }
  const pay = await call("send_esign_and_pay_link", { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes, text me" });
  if (pay.result.status !== "link_sent" || !pay.ui?.paymentId) throw new Error(`send_esign_and_pay_link: ${JSON.stringify(pay.result)}`);
  const view = await w.payments.view(pay.ui.paymentId, { origin });

  const token = await issueCaseToken({ caseId, visitorId: VISITOR, takeoverId, scopes: ["case", "tools"] });
  const visitor = issueVisitorToken(VISITOR);
  console.log(
    JSON.stringify({
      caseId, takeoverId, paymentId: view.id, provider: view.provider, status: view.status, amountCents: view.amountCents,
      totalAmountCents: view.totalAmountCents, embed: !!view.embed, sms: pay.ui.sms,
    }),
  );
  // The visitor token makes WP2's requireCase match the case token's `vid` (the page sends it as x-baton-visitor).
  console.log(`${origin}/pay/lab?paymentId=${view.id}#token=${token}&visitor=${encodeURIComponent(visitor)}`);
  await closeDb();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : String(e));
  process.exit(1);
});
