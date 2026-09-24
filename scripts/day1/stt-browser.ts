/**
 * stt-browser.ts - drives /dev/audio in real browsers with Playwright ($0: loopback STT, no AssemblyAI calls).
 *
 *   npx tsx scripts/day1/stt-browser.ts [--base http://localhost:3104] [--browsers chromium,firefox,webkit]
 *                                        [--seconds 20] [--long 180] [--background 60] [--headed] [--out result.json]
 *
 * Checks per browser (T-D1-7 desktop part): worklets load from a Blob URL under the app CSP; the CallPlayer ticks at
 * real-time pace; the STT feed never produces an out-of-range frame (no 3007) and its offset stays 0; finals arrive
 * on the right channel; the VA output worklet plays and reports first-audible; the paced feeder sends 50 ms frames;
 * the mic capture delivers 16 kHz frames (fake device where the browser supports it).
 * `--long`: the 3-minute drift run (chromium). `--background`: a second tab in front for N s (acceptance 2).
 */
import { writeFileSync } from "node:fs";

import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const BASE = arg("base", "http://localhost:3104")!;
const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

interface Diag {
  ctxRate: number; ctxState: string; ticks: number; callMs: number; wallElapsedMs: number; driftMs: number; pace: number; maxTickGapMs: number;
  hiddenMs: number; visibility: { at: number; state: string }[]; sttStatus: Record<string, string> | null;
  sttMetrics: { maxFeedOffsetMs: Record<string, number>; framesSent: Record<string, number>; closes: { code: number }[]; beginChecks: { ok: boolean }[] } | null;
  loopback: { channel: string; frames: number; audioMs: number; rejected: number }[]; finals: { turnId: string; recvMs: number; source: string }[];
  errors: string[]; workletError: string | null; va: { firstAudible: { lagMs: number }[]; underruns: number }; feeder: { frames: number; clipEndCtxMs: number | null };
  mic: { open: boolean; frames: number; samples: number; levelDb: number }; ended: boolean;
}

async function launch(name: string): Promise<Browser> {
  const t = TYPES[name]!;
  if (name === "chromium") {
    // --channel chromium = the full browser in new-headless mode (tabs get real visibility changes); default = headless shell.
    const channel = arg("channel");
    // Playwright disables Chrome's background throttling by default; a real background-tab test must not.
    const ignoreDefaultArgs = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
    return t.launch({ headless: !has("headed"), ignoreDefaultArgs, ...(channel ? { channel } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  }
  if (name === "firefox") {
    return t.launch({ headless: !has("headed"), firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 } });
  }
  return t.launch({ headless: !has("headed") });
}

async function diag(page: Page): Promise<Diag> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__wp4 ?? null)) as never);
}

async function boot(page: Page, fixture: "8k" | "16k", mode = "loopback"): Promise<void> {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/dev/audio${has("hold") ? "?hold=1" : ""}`, { waitUntil: "networkidle" });
  await page.selectOption('[data-testid="mode"]', mode);
  await page.selectOption('[data-testid="fixture"]', fixture);
  await page.click('[data-testid="unlock"]');
  await sleep(500);
  await page.click('[data-testid="load"]');
  await page.waitForFunction(() => (window.__wp4 as { loaded?: boolean } | undefined)?.loaded === true, null, { timeout: 20_000 });
  await page.click('[data-testid="start"]');
  (page as unknown as { __errors: string[] }).__errors = errors;
}

function summarize(d: Diag) {
  const m = d.sttMetrics;
  return {
    ctx: `${d.ctxState}@${d.ctxRate}`,
    ticks: d.ticks,
    callS: Math.round(d.callMs) / 1000,
    wallS: Math.round(d.wallElapsedMs) / 1000,
    pace: Math.round(d.pace * 10_000) / 10_000,
    driftMs: Math.round(d.driftMs * 10) / 10,
    maxTickGapMs: Math.round(d.maxTickGapMs),
    hiddenS: Math.round(d.hiddenMs / 100) / 10,
    stt: d.sttStatus,
    maxFeedOffsetMs: m ? Math.max(...Object.values(m.maxFeedOffsetMs)) : null,
    framesSent: m?.framesSent ?? null,
    closes3007: m ? m.closes.filter((c) => c.code === 3007).length : null,
    beginOk: m ? m.beginChecks.every((b) => b.ok) : null,
    loopbackRejected: d.loopback.reduce((s, l) => s + l.rejected, 0),
    finals: d.finals.length,
    finalsRep: d.finals.filter((f) => f.turnId.startsWith("rep")).length,
    finalsCustomer: d.finals.filter((f) => f.turnId.startsWith("customer")).length,
    va: d.va,
    feeder: d.feeder,
    mic: d.mic,
    workletError: d.workletError,
    errors: d.errors.slice(-5),
  };
}

async function shortRun(name: string, seconds: number, fixture: "8k" | "16k") {
  const browser = await launch(name);
  try {
    const ctx = await browser.newContext(name === "chromium" ? { permissions: ["microphone"] } : {});
    const page = await ctx.newPage();
    await boot(page, fixture);
    await sleep(1500);
    await page.click('[data-testid="va"]');
    await page.click('[data-testid="feed"]');
    await page.click('[data-testid="mic"]').catch(() => undefined);
    await sleep(seconds * 1000);
    await page.click('[data-testid="mic"]').catch(() => undefined);
    const d = await diag(page);
    return { browser: name, version: browser.version(), fixture, ...summarize(d), consoleErrors: (page as unknown as { __errors: string[] }).__errors.slice(0, 5) };
  } finally {
    await browser.close();
  }
}

async function longRun(seconds: number, fixture: "8k" | "16k") {
  const browser = await launch("chromium");
  try {
    const page = await (await browser.newContext()).newPage();
    await boot(page, fixture);
    const samples: ReturnType<typeof summarize>[] = [];
    for (let s = 30; s <= seconds; s += 30) {
      await sleep(30_000);
      samples.push(summarize(await diag(page)));
    }
    return { kind: "long", seconds, fixture, samples };
  } finally {
    await browser.close();
  }
}

async function backgroundRun(seconds: number, fixture: "8k" | "16k") {
  const browser = await launch("chromium");
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await boot(page, fixture);
    await sleep(5000);
    const before = summarize(await diag(page));
    // Headless never hides a page, so a real background needs `--headed`: a second tab in front and, with
    // `--minimize`, the window minimized through CDP (both make document.visibilityState "hidden").
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    let restore: (() => Promise<void>) | null = null;
    if (has("minimize")) {
      const cdp = await context.newCDPSession(other);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      restore = async () => {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      };
    }
    await sleep(500);
    const visAfterSwitch = await page.evaluate(() => document.visibilityState);
    await sleep(seconds * 1000);
    if (restore) await restore();
    await page.bringToFront();
    await sleep(1000);
    const after = summarize(await diag(page));
    const vis = (await diag(page)).visibility;
    const dCall = after.callS - before.callS;
    const dWall = after.wallS - before.wallS;
    return {
      kind: "background", seconds, fixture, visibilityDuringSwitch: visAfterSwitch, visibilityLog: vis,
      paceWhileHidden: Math.round((dCall / dWall) * 10_000) / 10_000, finalsWhileHidden: after.finals - before.finals, before, after,
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { base: BASE, at: new Date().toISOString() };
  const browsers = (arg("browsers", "chromium,firefox,webkit") ?? "").split(",").filter(Boolean);
  const seconds = Number(arg("seconds", "20"));
  const fixture = (arg("fixture", "8k") === "16k" ? "16k" : "8k") as "8k" | "16k";
  const short: unknown[] = [];
  for (const b of browsers) {
    try {
      const r = await shortRun(b, seconds, fixture);
      short.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      short.push({ browser: b, error: e instanceof Error ? e.message : String(e) });
      console.log(JSON.stringify(short.at(-1)));
    }
  }
  out.short = short;
  const long = Number(arg("long", "0"));
  if (long > 0) {
    out.long = await longRun(long, fixture);
    console.log(JSON.stringify(out.long));
  }
  const bg = Number(arg("background", "0"));
  if (bg > 0) {
    out.background = await backgroundRun(bg, fixture);
    console.log(JSON.stringify(out.background));
  }
  const file = arg("out");
  if (file) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
