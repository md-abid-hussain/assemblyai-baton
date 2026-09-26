/**
 * scripts/billing/create-plans.ts - one-time Polar **SANDBOX** setup for the SaaS plans (SAAS §4.3).
 *
 *   npx tsx scripts/billing/create-plans.ts [--write-env] [--json]
 *
 * Creates, idempotently, in the sandbox organisation of `POLAR_ACCESS_TOKEN`:
 *  - "Changeover Pro"      — $49/month recurring, `metadata.changeover_plan = "pro"`;
 *  - "Changeover Business" — $299/month recurring, `metadata.changeover_plan = "business"`.
 *
 * It prints **product ids only** (ids are configuration, not secrets: they go into `POLAR_PRODUCT_PRO` and
 * `POLAR_PRODUCT_BUSINESS` in `zerops.yml` and the local `.env`). The access token is read from `.env` and is
 * never printed, logged or written anywhere.
 *
 * **It refuses to run against anything but the sandbox.** `POLAR_SERVER` must be `sandbox`; there is no flag to
 * override that, because the whole point of the plan is that no real money can move. Everything this script
 * touches costs $0.
 *
 * The optional P4 meter ("AI-finished minutes", $0.30/unit on Pro) is *not* created here: it belongs to WP21·3
 * and needs `events:write` traffic to be meaningful. `--json` prints a machine-readable line for the integrator.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Polar } from "@polar-sh/sdk";

import { loadEnv, repoRoot } from "../lib/load-env";

/** The two purchasable plans of SAAS §4.1, exactly as the Billing page names them. */
export const PLAN_PRODUCTS = [
  {
    slug: "pro" as const,
    name: "Changeover Pro",
    envName: "POLAR_PRODUCT_PRO",
    priceCents: 4900,
    description:
      "150 AI-finished minutes a month, 25 live runs a day, 50 relays, 10 seats, HTTP actions to your own hosts, " +
      "webhooks, and the full API. Sandbox only: no real money moves.",
  },
  {
    slug: "business" as const,
    name: "Changeover Business",
    envName: "POLAR_PRODUCT_BUSINESS",
    priceCents: 29_900,
    description:
      "1,000 AI-finished minutes a month, 100 live runs a day, 500 relays, 50 seats, 50 connector hosts, " +
      "10 webhook endpoints and 365-day retention. Sandbox only: no real money moves.",
  },
] satisfies readonly { slug: "pro" | "business"; name: string; envName: string; priceCents: number; description: string }[];

export type PlanProduct = (typeof PLAN_PRODUCTS)[number];

/** A product already in the sandbox with this exact name, not archived. `null` when there is none. */
async function findProduct(polar: Polar, name: string): Promise<string | null> {
  const pages = await polar.products.list({ query: name, limit: 50 });
  for await (const page of pages) {
    for (const p of page.result.items) if (p.name === name && !p.isArchived) return p.id;
  }
  return null;
}

async function ensureProduct(polar: Polar, spec: PlanProduct): Promise<{ id: string; created: boolean }> {
  const existing = await findProduct(polar, spec.name);
  if (existing) return { id: existing, created: false };
  const created = await polar.products.create({
    name: spec.name,
    description: spec.description,
    recurringInterval: "month",
    prices: [{ amountType: "fixed", priceAmount: spec.priceCents, priceCurrency: "usd" }],
    metadata: { changeover_plan: spec.slug },
  });
  return { id: created.id, created: true };
}

/** Set (or replace) a name in `.env`, keeping every other line. Values here are ids, never secrets. */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\n*$/, "")}\n${line}\n`;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const writeEnv = argv.includes("--write-env");
  const asJson = argv.includes("--json");

  const server = process.env.POLAR_SERVER?.trim() ?? "sandbox";
  if (server !== "sandbox") {
    console.error(`refusing to run: POLAR_SERVER is ${JSON.stringify(server)}, and this script is sandbox-only.`);
    process.exitCode = 1;
    return;
  }
  const accessToken = process.env.POLAR_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    console.error("POLAR_ACCESS_TOKEN is not set (names only are ever printed). Set it in .env and re-run.");
    process.exitCode = 1;
    return;
  }

  const polar = new Polar({ accessToken, server: "sandbox" });
  const results: { slug: string; envName: string; id: string; created: boolean }[] = [];
  for (const spec of PLAN_PRODUCTS) {
    const { id, created } = await ensureProduct(polar, spec);
    results.push({ slug: spec.slug, envName: spec.envName, id, created });
    console.log(`${created ? "created" : "exists "}  ${spec.name.padEnd(22)}  ${spec.envName}=${id}`);
  }

  if (writeEnv) {
    const path = resolve(repoRoot(), ".env");
    if (!existsSync(path)) {
      console.error("--write-env: no .env at the repo root; copy the ids above by hand.");
      process.exitCode = 1;
      return;
    }
    let text = readFileSync(path, "utf8");
    for (const r of results) text = upsertEnvLine(text, r.envName, r.id);
    writeFileSync(path, text);
    console.log(`.env updated: ${results.map((r) => r.envName).join(", ")}`);
  }

  if (asJson) console.log(JSON.stringify(Object.fromEntries(results.map((r) => [r.envName, r.id]))));
  console.log("\nPut these two ids in zerops.yml (they are not secrets) and keep POLAR_SERVER=sandbox.");
}

// `tsx scripts/billing/create-plans.ts` runs it; importing the module for a test does not.
const invokedDirectly = process.argv[1] !== undefined && /create-plans\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  void main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
