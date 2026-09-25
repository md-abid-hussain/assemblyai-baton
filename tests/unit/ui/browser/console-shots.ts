/**
 * tests/unit/ui/browser/console-shots.ts - WP7·2 browser pass over the call console (TASKS v1.1 WP7 acceptance 1 and 4):
 *   - screenshots of every G2 state at 1440×900, 1366×768, 1024×768 and 390×844 (mobile emulation), light, plus the
 *     dark theme at 1366×768 and 390 (the console follows the OS theme);
 *   - the phone check: WP6's MockPhone fully inside the viewport at 1366×768, then driven through
 *     SMS → thread → e-sign → Sign → Skip: simulate payment → Paid (the /dev/ui `phone=wp6` harness, no network);
 *   - a Lighthouse-style accessibility score per state (a11y-audit.ts), required ≥ 90.
 *
 * Run against a dev server (next dev --webpack -p 3108) or a deploy:
 *   BASE_URL=http://localhost:3108 npx tsx tests/unit/ui/browser/console-shots.ts
 * Writes PNGs and report.json to OUT_DIR (default test-results/wp7-shots, git-ignored). $0: fixture pages only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import { auditPage } from "./a11y-audit";

const BASE = process.env.BASE_URL ?? "http://localhost:3108";
const OUT = process.env.OUT_DIR ?? "test-results/wp7-shots";
const ROUTE = process.env.ROUTE ?? "/call/s01"; // /call/<id>?fixture=… renders the same console as a live /call run

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, mobile: false },
  { name: "1366x768", width: 1366, height: 768, mobile: false },
  { name: "1024", width: 1024, height: 768, mobile: false },
  { name: "390", width: 390, height: 844, mobile: true },
] as const;

const STATES = [
  { name: "countdown", q: "express=1", waitMs: 700 },
  { name: "preflight", q: "at=preflight" },
  { name: "shadowing", q: "at=shadowing:end" },
  { name: "protocol", q: "at=compiling" },
  { name: "ai-speaking", q: "at=ai-speaking+2000" },
  { name: "paying", q: "at=paying+3000" },
  { name: "completed-qa", q: "at=end", waitMs: 1600 },
] as const;

interface Row {
  viewport: string;
  scheme?: Scheme;
  state: string;
  file: string;
  a11y: number;
  failing: { id: string; weight: number; items: string[] }[];
  horizontalScroll: boolean;
  phoneInViewport?: boolean;
}

/** `q` is "key=value"; the value is encoded (a raw "+" in `at=paying+3000` would decode as a space). */
const url = (q: string) => {
  const [k, v = ""] = q.split("=");
  return `${BASE}${ROUTE}?fixture=s01-full&chrome=0&phone=wp6&${k}=${encodeURIComponent(v)}`;
};

type Scheme = "light" | "dark";

async function newPage(browser: Browser, vp: (typeof VIEWPORTS)[number], scheme: Scheme = "light"): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    reducedMotion: "reduce",
    colorScheme: scheme,
  });
  const page = await ctx.newPage();
  // tsx/esbuild's keepNames helper, for functions serialised into page.evaluate.
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  return page;
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function phoneBox(page: Page): Promise<{ inViewport: boolean; box: { x: number; y: number; width: number; height: number } | null }> {
  const loc = page.locator('section[aria-label="Customer\'s phone (simulated)"]').first();
  if (!(await loc.count())) return { inViewport: false, box: null };
  const box = await loc.boundingBox();
  const vp = page.viewportSize();
  const inViewport = !!box && !!vp && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5;
  return { inViewport, box };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const rows: Row[] = [];
  try {
    const runs = [
      ...VIEWPORTS.map((vp) => ({ vp, scheme: "light" as Scheme })),
      ...VIEWPORTS.filter((v) => v.name === "1366x768" || v.name === "390").map((vp) => ({ vp, scheme: "dark" as Scheme })),
    ];
    for (const { vp, scheme } of runs) {
      for (const st of STATES) {
        const page = await newPage(browser, vp, scheme);
        await page.goto(url(st.q), { waitUntil: "domcontentloaded" });
        await settle(page, "waitMs" in st ? st.waitMs : 400);
        if (vp.mobile && st.name === "paying") await page.getByRole("tab", { name: /Phone/ }).click().catch(() => undefined);
        const file = `${vp.name}${scheme === "dark" ? "-dark" : ""}-${st.name}.png`;
        await page.screenshot({ path: path.join(OUT, file) });
        const a = await auditPage(page);
        const row: Row = {
          viewport: vp.name, scheme, state: st.name, file, a11y: a.score, horizontalScroll: !(await noHScroll(page)),
          failing: a.audits.filter((x) => x.applicable && !x.pass).map((x) => ({ id: x.id, weight: x.weight, items: x.items })),
        };
        if (st.name === "paying") row.phoneInViewport = (await phoneBox(page)).inViewport;
        rows.push(row);
        console.log(`${vp.name.padEnd(9)} ${scheme.padEnd(5)} ${st.name.padEnd(13)} a11y ${String(a.score).padStart(3)}${row.horizontalScroll ? "  H-SCROLL" : ""}${row.phoneInViewport === false ? "  PHONE-CLIPPED" : ""}${row.failing.length ? `  fails: ${row.failing.map((f) => f.id).join(", ")}` : ""}`);
        await page.context().close();
      }
    }

    // ---- the pay flow on WP6's MockPhone at 1366×768 and 390 px
    for (const vp of VIEWPORTS.filter((v) => v.name === "1366x768" || v.name === "390")) {
      const page = await newPage(browser, vp);
      await page.goto(url("at=paying+3000"), { waitUntil: "domcontentloaded" });
      await settle(page);
      if (vp.mobile) await page.getByRole("tab", { name: /Phone/ }).click().catch(() => undefined);
      const phone = page.locator('section[aria-label="Customer\'s phone (simulated)"]').first();
      const steps: string[] = [];
      const snap = async (name: string) => {
        steps.push(`${name}=${await phone.getAttribute("data-phone-state")}`);
        await page.screenshot({ path: path.join(OUT, `${vp.name}-phone-${name}.png`) });
      };
      await snap("sms");
      await phone.getByRole("button", { name: /Messages/ }).click();
      await phone.getByRole("button", { name: /https?:|\/pay\// }).first().click();
      await page.waitForTimeout(300);
      await snap("esign");
      const esignAudit = await auditPage(page);
      await phone.getByRole("checkbox").check();
      await phone.getByRole("button", { name: "Sign" }).click();
      await page.waitForTimeout(900);
      await snap("pay-sheet");
      await phone.getByRole("button", { name: /simulate payment/i }).click();
      await page.waitForFunction(() => document.querySelector('section[data-phone-state]')?.getAttribute("data-phone-state") === "paid", undefined, { timeout: 8000 });
      await page.waitForTimeout(300);
      await snap("paid");
      const { inViewport } = await phoneBox(page);
      const store = await page.evaluate(() => document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state"));
      rows.push({
        viewport: vp.name, state: "phone-esign", file: `${vp.name}-phone-esign.png`, a11y: esignAudit.score, horizontalScroll: !(await noHScroll(page)),
        failing: esignAudit.audits.filter((x) => x.applicable && !x.pass).map((x) => ({ id: x.id, weight: x.weight, items: x.items })), phoneInViewport: inViewport,
      });
      console.log(`${vp.name.padEnd(9)} phone flow    ${steps.join(" → ")} (final ${store}; in viewport ${inViewport}; e-sign a11y ${esignAudit.score})`);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(rows, null, 2));
  const worst = Math.min(...rows.map((r) => r.a11y));
  const clipped = rows.filter((r) => r.phoneInViewport === false);
  const hs = rows.filter((r) => r.horizontalScroll);
  console.log(`\nminimum a11y ${worst} over ${rows.length} states; phone clipped in ${clipped.length}; horizontal scroll in ${hs.length}. → ${OUT}`);
  if (worst < 90 || clipped.length || hs.length) process.exitCode = 1;
}

void main();
