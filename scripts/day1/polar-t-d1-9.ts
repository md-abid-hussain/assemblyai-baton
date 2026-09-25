/**
 * scripts/day1/polar-t-d1-9.ts - T-D1-9 (DESIGN App. B, §5.12) against the Polar SANDBOX, driven by Playwright.
 *
 *   npx tsx --conditions=react-server scripts/day1/polar-t-d1-9.ts [--runs 5] [--hosted 1] [--headed]
 *
 * Per run: create an ad-hoc checkout exactly as the app does (buildCheckoutCreate: fixed tax-inclusive price, demo
 * customer, fictional address, no discount codes, embedOrigin = this harness), then in chromium:
 *  - open a local page (http://localhost:3107, the embed origin) that runs `Polar.EmbedCheckout.create(url)` from the
 *    shipped @polar-sh/checkout bundle with the app's listeners (success → preventDefault, confirmed, close);
 *  - inspect the checkout: no editable amount, email locked, name prefilled, address prefilled, no discount field;
 *  - pay with Stripe's public TEST card 4242 4242 4242 4242 · 12/34 · 123 (sandbox: "Payments are not processed");
 *  - assert the embed `success` did NOT navigate the page; poll Polar (server GET) until `succeeded`; close the overlay;
 *  - time the funnel (tap → overlay loaded → Pay now → confirmed → success event → server succeeded).
 * `--hosted N` also runs the hosted new-tab variant (successUrl → /pay/done on this harness).
 *
 * Never touches production (refuses unless POLAR_SERVER=sandbox). Prints no secrets. If a VISIBLE captcha challenge
 * appears the run stops and is reported as blocked (it is never solved or bypassed). Results: scripts/day1/out/.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { chromium, type Frame, type Page } from "@playwright/test";

import { buildCheckoutCreate, sdkPolarApi, type PolarApi } from "../../src/server/polar/client";
import { loadEnv, repoRoot } from "../lib/load-env";

const PORT = 3107;
const ORIGIN = `http://localhost:${PORT}`;
const TEST_CARD = { number: "4242424242424242", exp: "1234", cvc: "123" };
const AMOUNTS = [2340, 920, 3410, 1840, 2785, 2960, 1520];

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><title>T-D1-9 embed harness</title></head>
<body style="font-family:sans-serif"><h1>Baton T-D1-9 embed harness</h1><p id="state">idle</p>
<button id="pay" style="font-size:20px">Pay with Polar sandbox (test card)</button>
<script src="/embed.global.js"></script>
<script>
window.__ev = []; window.__href0 = location.href; window.__nav = 0;
window.addEventListener("beforeunload", function () { window.__nav++; });
function mark(n, x) { window.__ev.push({ n: n, t: performance.now(), x: x || null }); document.getElementById("state").textContent = n; }
document.getElementById("pay").onclick = async function () {
  mark("tap");
  var url = new URLSearchParams(location.search).get("url");
  var co = await window.Polar.EmbedCheckout.create(url, { theme: "light", onLoaded: function () { mark("loaded"); } });
  window.__co = co; mark("created");
  co.addEventListener("confirmed", function () { mark("confirmed"); });
  co.addEventListener("success", function (e) { e.preventDefault(); mark("success", { redirect: e.detail.redirect, successURL: e.detail.successURL }); });
  co.addEventListener("close", function () { mark("close"); });
};
</script></body></html>`;

function startHarness(): Promise<Server> {
  const embedJs = readFileSync(resolve(repoRoot(), "node_modules/@polar-sh/checkout/dist/embed.global.js"));
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? "/", ORIGIN);
    if (u.pathname === "/embed.global.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(embedJs);
    } else if (u.pathname === "/embed.html") {
      res.writeHead(200, { "content-type": "text/html" }).end(HARNESS);
    } else if (u.pathname === "/pay/done") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><h1 id="done">Payment received: return to the Baton tab</h1>`);
    } else res.writeHead(404).end();
  });
  return new Promise((ok) => srv.listen(PORT, "127.0.0.1", () => ok(srv)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function frameWith(page: Page, selector: string, timeoutMs: number): Promise<Frame> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      if (await f.$(selector).catch(() => null)) return f;
    }
    await sleep(250);
  }
  throw new Error(`no frame with ${selector}`);
}

async function visibleCaptcha(page: Page): Promise<boolean> {
  // Stripe mounts an INVISIBLE hCaptcha (hidden challenge iframe) that passes on its own in test mode. Only a challenge
  // that is actually shown to the user counts; the run then stops (it is never solved or bypassed).
  for (const f of page.frames()) {
    if (!/hcaptcha\.com\/captcha\/v1\/.*#frame=challenge/.test(f.url())) continue;
    const el = await f.frameElement().catch(() => null);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    const shown = await el
      .evaluate((node) => {
        let n: Element | null = node as Element;
        while (n) {
          const cs = getComputedStyle(n);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
          n = n.parentElement;
        }
        return true;
      })
      .catch(() => false);
    if (shown && box && box.width > 100 && box.height > 100 && box.y < 900 && box.y + box.height > 0) return true;
  }
  return false;
}

interface Inspect { emailLocked: boolean; emailValue: string; nameValue: string; addressPrefilled: boolean; discountField: boolean; amountField: boolean; totalText: string }

// A string, not a function: tsx/esbuild's keepNames injects `__name(...)` into serialized callbacks, which the page lacks.
const INSPECT_JS = String.raw`(() => {
  var email = document.querySelector('input[name="customer_email"]');
  var name = document.querySelector('input[name="customer_name"]');
  var line1 = document.querySelector('input[name="customer_billing_address.line1"]');
  var inputs = Array.prototype.map.call(document.querySelectorAll("input"), function (i) {
    return (i.name + " " + i.placeholder + " " + (i.getAttribute("aria-label") || "")).toLowerCase();
  });
  var total = /Total\s*\n?\s*(\$[\d.,]+)/.exec(document.body.innerText);
  return {
    emailLocked: !!email && (email.disabled || email.readOnly),
    emailValue: email ? email.value : "",
    nameValue: name ? name.value : "",
    addressPrefilled: !!line1 && line1.value.length > 0,
    discountField: inputs.some(function (s) { return s.indexOf("discount") >= 0 || s.indexOf("coupon") >= 0; }),
    amountField: inputs.some(function (s) { return /\bamount\b|\bprice\b/.test(s); }),
    totalText: total ? total[1] : ""
  };
})()`;

async function inspectCheckout(polarFrame: Frame): Promise<Inspect> {
  return (await polarFrame.evaluate(INSPECT_JS)) as Inspect;
}

async function payInFrames(page: Page, t: Record<string, number>, t0: number): Promise<void> {
  const card = await frameWith(page, "#payment-numberInput", 45_000);
  await card.fill("#payment-numberInput", TEST_CARD.number);
  await card.fill("#payment-expiryInput", TEST_CARD.exp);
  await card.fill("#payment-cvcInput", TEST_CARD.cvc);
  t.filled = performance.now() - t0;
  const polar = await frameWith(page, 'button[type="submit"]', 10_000);
  await polar.click('button[type="submit"]');
  t.payClicked = performance.now() - t0;
}

async function waitServerSucceeded(api: PolarApi, id: string, timeoutMs: number): Promise<{ status: string; totalAmount: number; polls: number }> {
  const end = Date.now() + timeoutMs;
  let polls = 0;
  let last = { status: "open", totalAmount: -1 };
  while (Date.now() < end) {
    polls++;
    const co = await api.getCheckout(id);
    last = { status: co.status, totalAmount: co.totalAmount };
    if (co.status === "succeeded" || co.status === "failed" || co.status === "expired") break;
    await sleep(1000);
  }
  return { ...last, polls };
}

async function main(): Promise<void> {
  loadEnv();
  if ((process.env.POLAR_SERVER ?? "sandbox") !== "sandbox") throw new Error("T-D1-9 runs against the Polar SANDBOX only");
  const token = process.env.POLAR_ACCESS_TOKEN;
  const productId = process.env.POLAR_PRODUCT_ID;
  if (!token || !productId) throw new Error("POLAR_ACCESS_TOKEN and POLAR_PRODUCT_ID are required (run scripts/polar/setup.ts --write-env)");
  const customers = JSON.parse(process.env.POLAR_DEMO_CUSTOMERS ?? "{}") as Record<string, string>;
  const args = process.argv.slice(2);
  const num = (flag: string, def: number): number => {
    const i = args.indexOf(flag);
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  const runs = num("--runs", 5);
  const hosted = num("--hosted", 0);
  const headed = args.includes("--headed");
  const api = sdkPolarApi({ accessToken: token, server: "sandbox" });
  const policy = { address: { street: "1427 Belle Avenue", city: "Lakewood", state: "OH", zip: "44107" }, policyholder: { firstName: "Priya", lastName: "Raman" } };

  const srv = await startHarness();
  const browser = await chromium.launch({ headless: !headed });
  const results: Record<string, unknown>[] = [];
  const outDir = resolve(repoRoot(), "scripts", "day1", "out");
  mkdirSync(outDir, { recursive: true });
  try {
    for (let i = 0; i < runs + hosted; i++) {
      const variant = i < runs ? "embed" : "hosted";
      const amountCents = AMOUNTS[i % AMOUNTS.length]!;
      const r: Record<string, unknown> = { run: i + 1, variant, amountCents };
      const tc = performance.now();
      const co = await api.createCheckout(
        buildCheckoutCreate({
          productId, amountCents, customerId: customers.s01 ?? null, policy, embedOrigin: ORIGIN,
          metadata: { paymentId: `t-d1-9-${i + 1}`, caseId: "t-d1-9", takeoverId: "t-d1-9" },
          successUrl: `${ORIGIN}/pay/done?checkout_id={CHECKOUT_ID}`,
        }),
      );
      Object.assign(r, {
        createMs: Math.round(performance.now() - tc), checkoutId: co.id, totalAmount: co.totalAmount, taxAmount: co.taxAmount,
        totalEqualsAmount: co.totalAmount === amountCents, embedOrigin: co.embedOrigin, customerLocked: co.customerId !== null,
      });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const t: Record<string, number> = {};
      let framingBlocked = false;
      page.on("console", (m) => {
        if (m.type() === "error" && m.text().includes("frame-ancestors")) framingBlocked = true;
      });
      try {
        const t0 = performance.now();
        if (variant === "embed") {
          await page.goto(`${ORIGIN}/embed.html?url=${encodeURIComponent(co.url)}`, { waitUntil: "load" });
          const href0 = page.url();
          await page.click("#pay");
          const polarFrame = await Promise.race([
            frameWith(page, 'input[name="customer_email"]', 45_000),
            (async () => {
              while (!framingBlocked) await sleep(200);
              throw new Error(`embed blocked by Polar (frame-ancestors 'none'): add ${ORIGIN} under Polar Settings → Preferences → Embedding`);
            })(),
          ]);
          await page.waitForFunction(() => (window as unknown as { __ev: { n: string }[] }).__ev.some((e) => e.n === "loaded"), null, { timeout: 45_000 }).catch(() => undefined);
          t.loaded = performance.now() - t0;
          await sleep(1500); // let Stripe mount the card element
          r.inspect = await inspectCheckout(polarFrame);
          if (await visibleCaptcha(page)) throw new Error("blocked: visible captcha challenge (not solved)");
          await payInFrames(page, t, t0);
          await page.waitForFunction(() => (window as unknown as { __ev: { n: string }[] }).__ev.some((e) => e.n === "success"), null, { timeout: 90_000 });
          const ev = (await page.evaluate(() => (window as unknown as { __ev: unknown[] }).__ev)) as { n: string; t: number; x: unknown }[];
          const at = (n: string) => ev.find((e) => e.n === n)?.t ?? null;
          const tap = at("tap") ?? 0;
          const rel = (n: string) => (at(n) === null ? null : Math.round(at(n)! - tap));
          Object.assign(t, { evLoaded: rel("loaded") ?? -1, evConfirmed: rel("confirmed") ?? -1, evSuccess: rel("success") ?? -1 });
          r.successDetail = ev.find((e) => e.n === "success")?.x ?? null;
          await sleep(3000);
          const nav = await page.evaluate(() => (window as unknown as { __nav: number }).__nav);
          r.successDidNotNavigate = page.url() === href0 && nav === 0;
          const s = await waitServerSucceeded(api, co.id, 60_000);
          t.serverSucceeded = performance.now() - t0;
          Object.assign(r, { serverStatus: s.status, serverTotal: s.totalAmount, serverPolls: s.polls });
          await page.evaluate(() => (window as unknown as { __co?: { close(): void } }).__co?.close());
          await sleep(500);
          r.overlayClosedByUs = (await page.$('iframe[src*="polar.sh"]')) === null;
        } else {
          await page.goto(co.url, { waitUntil: "load" });
          const polarFrame = await frameWith(page, 'input[name="customer_email"]', 45_000);
          t.loaded = performance.now() - t0;
          await sleep(1500);
          r.inspect = await inspectCheckout(polarFrame);
          if (await visibleCaptcha(page)) throw new Error("blocked: visible captcha challenge (not solved)");
          await payInFrames(page, t, t0);
          await page.waitForURL(/\/pay\/done\?checkout_id=/, { timeout: 90_000 });
          t.redirectedToDone = performance.now() - t0;
          r.doneUrlHasCheckoutId = page.url().includes(co.id);
          const s = await waitServerSucceeded(api, co.id, 60_000);
          t.serverSucceeded = performance.now() - t0;
          Object.assign(r, { serverStatus: s.status, serverTotal: s.totalAmount, serverPolls: s.polls });
        }
        r.ok = r.serverStatus === "succeeded" && r.totalEqualsAmount === true && (variant === "hosted" || r.successDidNotNavigate === true);
      } catch (e) {
        r.ok = false;
        r.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        await page.screenshot({ path: resolve(outDir, `polar-t-d1-9-run${i + 1}-error.png`), fullPage: true }).catch(() => undefined);
      } finally {
        r.timingsMs = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)]));
        await page.close().catch(() => undefined);
      }
      results.push(r);
      console.log(JSON.stringify(r));
    }
  } finally {
    await browser.close();
    srv.close();
  }
  const med = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]! : null);
  const stats = (variant: string) => {
    const ok = results.filter((r) => r.variant === variant && r.ok);
    const pick = (k: string) => ok.map((r) => (r.timingsMs as Record<string, number>)[k]).filter((x): x is number => typeof x === "number" && x >= 0);
    const keys = variant === "embed" ? ["evLoaded", "filled", "payClicked", "evConfirmed", "evSuccess", "serverSucceeded"] : ["loaded", "filled", "payClicked", "redirectedToDone", "serverSucceeded"];
    return {
      runs: results.filter((r) => r.variant === variant).length,
      ok: ok.length,
      createCheckoutMedianMs: med(ok.map((r) => r.createMs as number)),
      medianMsFromTap: Object.fromEntries(keys.map((k) => [k, med(pick(k))])),
      maxServerSucceededMs: pick("serverSucceeded").length ? Math.max(...pick("serverSucceeded")) : null,
    };
  };
  const summary = { at: new Date().toISOString(), embed: stats("embed"), hosted: stats("hosted") };
  console.log(JSON.stringify({ summary }));
  writeFileSync(resolve(outDir, "polar-t-d1-9.json"), JSON.stringify({ summary, results }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 400) : String(e));
  process.exit(1);
});
