/**
 * scripts/polar/lab-seed.ts - seed a LOCAL dev database with one fictional case + takeover + payment and print a
 * `/pay/lab` URL that mounts the MockPhone against it (DEV ONLY; the tool routes still need WP3's CaseRepository).
 *
 *   npx tsx --conditions=react-server scripts/polar/lab-seed.ts [--mode polar|mock] [--amount 2340] [--origin http://localhost:3107]
 *
 * Uses DATABASE_URL (refuses anything that is not localhost) and CASE_TOKEN_SECRET from .env; never prints them.
 * Polar mode creates a real SANDBOX checkout (POLAR_SERVER must be sandbox).
 */
import { SignJWT } from "jose";

import { closeDb, getDb } from "../../src/server/db/client";
import * as schema from "../../src/server/db/schema";
import { resetEnvCache } from "../../src/server/env";
import { PaymentService } from "../../src/server/payments/service";
import { DbPaymentStore } from "../../src/server/payments/store";
import { sdkPolarApi } from "../../src/server/polar/client";
import { newId } from "../../src/lib/ids";
import { loadEnv } from "../lib/load-env";

const POLICY = {
  policyNumber: "NBM-4418207", carrier: "Northbeam Mutual", agencyName: "Harborview Insurance Agency", repFirstName: "Daniel",
  policyholder: { firstName: "Priya", lastName: "Raman" }, phoneOnFileLast4: "8207",
  address: { street: "1427 Belle Avenue", city: "Lakewood", state: "OH", zip: "44107" },
  existingDrivers: [{ name: "Priya Raman", relation: "named_insured" }],
  vehicles: [{ id: "veh1", year: 2021, make: "Honda", model: "Civic", label: "2021 Honda Civic" }],
  currentMonthlyPremiumUsd: 96, callDate: "2026-09-25",
};

async function main(): Promise<void> {
  loadEnv();
  resetEnvCache();
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] ?? d : d);
  const mode = opt("--mode", "polar") as "polar" | "mock";
  const amount = Number(opt("--amount", "2340"));
  const origin = opt("--origin", "http://localhost:3107");
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(dbUrl)) throw new Error("lab-seed only runs against a local DATABASE_URL");
  if (mode === "polar" && (process.env.POLAR_SERVER ?? "sandbox") !== "sandbox") throw new Error("sandbox only");
  const secret = process.env.CASE_TOKEN_SECRET;
  if (!secret) throw new Error("CASE_TOKEN_SECRET missing (run npm run secrets:init)");

  const db = getDb();
  const caseId = `lab_${newId()}`;
  const takeoverId = `tko_${newId()}`;
  await db.insert(schema.cases).values({
    id: caseId, mode: "watch", callId: null, scenarioId: "s01", policy: POLICY, state: {}, status: "ai_active", visitorId: "lab-visitor", ipKey: "lab", tArmMs: 60_000,
  });
  await db.insert(schema.takeovers).values({ id: takeoverId, caseId, tArmMs: 60_000, stage: "pay" });
  const customers = JSON.parse(process.env.POLAR_DEMO_CUSTOMERS ?? "{}") as Record<string, string>;
  const polarReady = mode === "polar" && !!process.env.POLAR_ACCESS_TOKEN && !!process.env.POLAR_PRODUCT_ID;
  const svc = new PaymentService({
    store: new DbPaymentStore(db),
    polar: polarReady ? sdkPolarApi({ accessToken: process.env.POLAR_ACCESS_TOKEN!, server: "sandbox" }) : null,
    polarConfig: polarReady ? { productId: process.env.POLAR_PRODUCT_ID!, demoCustomers: customers, embedOrigins: [origin], appUrl: origin } : null,
    mode: async () => mode,
  });
  const { payment, label } = await svc.create({ caseId, takeoverId, scenarioId: "s01", amountCents: amount, policy: POLICY, origin });
  const token = await new SignJWT({ vid: "lab-visitor", scp: ["case", "tools"], tko: takeoverId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("baton")
    .setSubject(caseId)
    .setIssuedAt()
    .setExpirationTime("45m")
    .sign(new TextEncoder().encode(secret));
  console.log(JSON.stringify({ caseId, takeoverId, paymentId: payment.id, provider: payment.provider, status: payment.status, checkoutId: payment.checkoutId, label }));
  // The token is a short-lived dev credential for this fictional case only; it goes in the URL fragment (never sent to a server).
  console.log(`${origin}/pay/lab?paymentId=${payment.id}#token=${token}`);
  await closeDb();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : String(e));
  process.exit(1);
});
