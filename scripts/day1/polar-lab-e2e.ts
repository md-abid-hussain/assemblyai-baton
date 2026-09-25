/**
 * scripts/day1/polar-lab-e2e.ts - the MockPhone against the real WP6 routes on `next dev` (port 3107) and the Polar
 * SANDBOX, driven by Playwright. Start the dev server with the same payment config as the seed, seed, then drive:
 *
 *   PAYMENTS_MODE=polar APP_URL=http://localhost:3107 EMBED_ORIGINS=http://localhost:3107 npx next dev --webpack -p 3107
 *   npx tsx --conditions=react-server scripts/polar/lab-seed.ts --mode polar
 *   npx tsx --conditions=react-server scripts/day1/polar-lab-e2e.ts "<lab URL printed by lab-seed>" [--pay hosted|simulate] [--headed]
 *
 * (`--webpack`: Turbopack refuses the worktree's node_modules junction, "points out of the filesystem root".)
 *
 * Steps: lock screen → thread → e-sign (consent + typed name, POST /esign) → pay sheet (Polar total) → "Pay with Polar
 * sandbox" (the embed; on a host that is not in Polar's Embedding list it must fail fast and fall back) → either the
 * hosted "Open checkout in a new tab" link paid with the public test card (→ /pay/done → server reconcile) or Simulate
 * → the phone reaches `paid` only from the server. Screenshots and timings: scripts/day1/out/lab-*.png, lab-e2e.json.
 * Sandbox only; stops on a visible captcha challenge (never solved).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, type Frame, type Page } from "@playwright/test";

import { repoRoot } from "../lib/load-env";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function frameWith(page: Page, selector: string, timeoutMs: number): Promise<Frame> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of page.frames()) if (await f.$(selector).catch(() => null)) return f;
    await sleep(250);
  }
  throw new Error(`no frame with ${selector}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("http"));
  if (!url) throw new Error("pass the lab URL printed by scripts/polar/lab-seed.ts");
  const payWith = args.includes("--pay") ? args[args.indexOf("--pay") + 1] : "hosted";
  const out = resolve(repoRoot(), "scripts", "day1", "out");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: !args.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (t[k] = Date.now() - t0);
  const phoneState = () => page.getAttribute("section[data-phone-state]", "data-phone-state");
  const waitState = async (s: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await phoneState()) === s) return;
      await sleep(200);
    }
    throw new Error(`phone never reached ${s} (at ${await phoneState()})`);
  };
  const r: Record<string, unknown> = { payWith };
  try {
    await page.goto(url, { waitUntil: "load" });
    await waitState("sms-received", 60_000);
    mark("smsShown");
    await page.screenshot({ path: resolve(out, "lab-1-lock.png") });
    await page.getByRole("button", { name: /Messages · now/ }).click();
    await page.getByRole("button", { name: /\/pay\// }).click();
    await waitState("esign");
    await page.waitForSelector("text=Review & sign");
    await sleep(500);
    await page.screenshot({ path: resolve(out, "lab-2-esign.png") });
    await page.getByRole("checkbox").check();
    // The e-sign summary (PaymentView extras) prefills the typed name; give a cold dev server time to answer.
    const nameSel = "section[data-phone-state] form input:not([type=checkbox])";
    for (let i = 0; i < 100 && !(await page.inputValue(nameSel)); i++) await sleep(200);
    r.prefilledName = await page.inputValue(nameSel);
    if (!r.prefilledName) await page.fill(nameSel, "Priya Raman");
    r.esignSummary = (await page.textContent("section[data-phone-state] dl"))?.replace(/\s+/g, " ").slice(0, 240);
    await page.getByRole("button", { name: "Sign" }).click();
    await waitState("signed");
    mark("signed");
    await page.screenshot({ path: resolve(out, "lab-3-pay.png") });
    r.payAmountText = await page.textContent("section[data-phone-state] p.text-3xl");

    if (payWith === "simulate") {
      await page.getByRole("button", { name: /Skip: simulate payment/ }).click();
      mark("simulateTapped");
    } else {
      await page.getByRole("button", { name: /Pay with Polar sandbox/ }).click();
      mark("payTapped");
      r.cardText = await page.textContent("[data-testid=test-card]");
      // The embed either opens (host allowlisted in Polar) or fails fast and falls back to the hosted link.
      const end = Date.now() + 20_000;
      let st = await phoneState();
      while (Date.now() < end && (st === "checkout-loading" || st === null)) {
        await sleep(200);
        st = await phoneState();
      }
      mark("embedSettled");
      r.embedOutcome = st;
      r.embedFailedCopy = (await page.$("text=The embedded checkout could not open here")) !== null;
      r.leftoverOverlay = (await page.$('iframe[src*="polar.sh"]')) !== null;
      await page.screenshot({ path: resolve(out, "lab-4-after-embed.png") });
      if (st === "signed") {
        const [tab] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("link", { name: "Open checkout in a new tab" }).click()]);
        mark("hostedOpened");
        await tab.waitForLoadState("load");
        const card = await frameWith(tab, "#payment-numberInput", 45_000);
        await sleep(1000);
        await card.fill("#payment-numberInput", "4242424242424242");
        await card.fill("#payment-expiryInput", "1234");
        await card.fill("#payment-cvcInput", "123");
        const polar = await frameWith(tab, 'button[type="submit"]', 10_000);
        await polar.click('button[type="submit"]');
        mark("hostedPayClicked");
        await tab.waitForURL(/\/pay\/done/, { timeout: 90_000 });
        await tab.waitForSelector("text=Payment received: return to the Baton tab", { timeout: 30_000 });
        mark("payDoneShown");
        r.payDoneText = (await tab.textContent("main"))?.slice(0, 200);
        await tab.screenshot({ path: resolve(out, "lab-5-pay-done.png") });
        await tab.close();
      }
    }
    await waitState("paid", 60_000);
    mark("phonePaid");
    await sleep(500);
    await page.screenshot({ path: resolve(out, "lab-6-paid.png") });
    r.doneText = (await page.textContent("section[data-phone-state]"))?.replace(/\s+/g, " ").slice(0, 200);
    r.stateLog = await page.$$eval("[data-testid=phone-log] li", (els) => els.map((e) => e.textContent));
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    await page.screenshot({ path: resolve(out, "lab-error.png") }).catch(() => undefined);
  } finally {
    r.timingsMs = t;
    r.pageErrors = errors;
    await browser.close();
  }
  console.log(JSON.stringify(r, null, 1));
  writeFileSync(resolve(out, `lab-e2e-${payWith}.json`), JSON.stringify(r, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : String(e));
  process.exit(1);
});
