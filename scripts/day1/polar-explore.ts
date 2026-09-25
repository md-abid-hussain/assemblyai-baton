/**
 * scripts/day1/polar-explore.ts - dump the Polar SANDBOX checkout page structure (frames, inputs, buttons) for a fresh
 * ad-hoc checkout, so T-D1-9's Playwright driver targets real selectors. Sandbox only; prints no secrets.
 *
 *   npx tsx scripts/day1/polar-explore.ts [--customer s01] [--amount 2340]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

import { buildCheckoutCreate, sdkPolarApi } from "../../src/server/polar/client";
import { loadEnv, repoRoot } from "../lib/load-env";

async function main(): Promise<void> {
  loadEnv();
  if ((process.env.POLAR_SERVER ?? "sandbox") !== "sandbox") throw new Error("sandbox only");
  const args = process.argv.slice(2);
  const amount = Number(args[args.indexOf("--amount") + 1] ?? 2340) || 2340;
  const scen = args.includes("--customer") ? args[args.indexOf("--customer") + 1]! : "s01";
  const customers = JSON.parse(process.env.POLAR_DEMO_CUSTOMERS ?? "{}") as Record<string, string>;
  const api = sdkPolarApi({ accessToken: process.env.POLAR_ACCESS_TOKEN!, server: "sandbox" });
  const co = await api.createCheckout(
    buildCheckoutCreate({
      productId: process.env.POLAR_PRODUCT_ID!,
      amountCents: amount,
      customerId: customers[scen] ?? null,
      policy: { address: { street: "1427 Belle Avenue", city: "Lakewood", state: "OH", zip: "44107" }, policyholder: { firstName: "Priya", lastName: "Raman" } },
      embedOrigin: null,
      metadata: { paymentId: "explore", caseId: "explore", takeoverId: "explore" },
    }),
  );
  console.log(JSON.stringify({ id: co.id, status: co.status, amount: co.amount, totalAmount: co.totalAmount, taxAmount: co.taxAmount, customerId: co.customerId, url: co.url }));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(co.url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(8000);
  const outDir = resolve(repoRoot(), "scripts", "day1", "out");
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "polar-explore.png"), fullPage: true });
  const dump: unknown[] = [];
  for (const f of page.frames()) {
    const items = await f
      .evaluate(() =>
        Array.from(document.querySelectorAll("input,button,select,textarea,[role=button]")).map((el) => {
          const e = el as HTMLInputElement;
          return {
            tag: e.tagName, type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, ariaLabel: e.getAttribute("aria-label"),
            disabled: e.disabled, readOnly: e.readOnly, value: e.type === "password" ? "" : (e.value ?? "").slice(0, 60),
            text: (e.textContent ?? "").trim().slice(0, 60), autocomplete: e.getAttribute("autocomplete"),
          };
        }),
      )
      .catch((err: unknown) => [{ error: String(err).slice(0, 100) }]);
    dump.push({ url: f.url().slice(0, 120), name: f.name(), items });
  }
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  writeFileSync(resolve(outDir, "polar-explore.json"), JSON.stringify({ checkout: co.id, frames: dump, text }, null, 2));
  console.log(`frames: ${page.frames().length}; dump → scripts/day1/out/polar-explore.json`);
  await browser.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 400) : String(e));
  process.exit(1);
});
