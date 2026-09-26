/**
 * scripts/polar/setup.ts - one-time Polar SANDBOX setup (DESIGN §5.12 "Setup").
 *
 *   npx tsx scripts/polar/setup.ts [--write-env] [--scenarios s01,s02,...]
 *
 * Creates (idempotently) in the sandbox organisation of POLAR_ACCESS_TOKEN:
 *  1. the one-time product "Baton demo: policy change payment (sandbox)" with a nominal fixed catalog price (every
 *     checkout overrides it with an ad-hoc, tax-inclusive price);
 *  2. one fictional demo customer per scenario (the scenario's fictional policyholder and US address; externalId
 *     `baton-demo-<scenarioId>`), so a checkout with `customerId` prefills and locks name and email;
 *  3. the generic RELAY demo customer (key "relay", WP16·2), which every relay's `payment_link` bills.
 * Prints POLAR_PRODUCT_ID and POLAR_DEMO_CUSTOMERS (ids are not secrets). `--write-env` also sets both in `.env`.
 *
 * Emails: `POLAR_DEMO_CUSTOMER_EMAIL=name@domain` (the org member's alias, DESIGN §3.4) gives `name+baton-sNN@domain`.
 * Without it a fictional `baton-demo+sNN@mailinator.com` is used (Polar rejects domains that do not accept mail, e.g.
 * example.com; the sandbox only delivers email to org members). `--update-email` re-points existing demo customers
 * to the current alias. Refuses to run against production. Never prints the token.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Polar } from "@polar-sh/sdk";

import { loadEnv, repoRoot } from "../lib/load-env";

export const PRODUCT_NAME = "Baton demo: policy change payment (sandbox)";
const NOMINAL_PRICE_CENTS = 100;

interface KitScenario {
  id: string;
  customer: { name: string; address: { street: string; city: string; state: string; zip: string } };
}

/**
 * WP16·2 (PLATFORM §6.1 "Adapter"): the ONE generic demo customer every RELAY payment bills. `POLAR_DEMO_CUSTOMERS`
 * is keyed by Baton scenario id, and a relay has no scenario, so `payment_link` looks up the key "relay" instead
 * (`RELAY_DEMO_CUSTOMER_KEY`). Without this entry the sandbox checkout still works, but it asks the judge for a name
 * and an email mid-demo. Fictional, like every scenario customer; the address is `RELAY_FALLBACK_ADDRESS` from
 * `src/server/payments/relay-account.ts`, and a unit test holds the two together.
 */
export const RELAY_DEMO_SCENARIO: KitScenario = {
  id: "relay",
  customer: { name: "Jordan Avery", address: { street: "418 Harborview Lane", city: "Lakewood", state: "OH", zip: "44107" } },
};

export function demoEmail(base: string | undefined, scenarioId: string): string {
  if (base && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base)) {
    const [local, domain] = base.split("@") as [string, string];
    return `${local.split("+")[0]}+baton-${scenarioId}@${domain}`;
  }
  return `baton-demo+${scenarioId}@mailinator.com`;
}

function loadScenarios(only: string[] | null): KitScenario[] {
  const dir = resolve(repoRoot(), "data", "scenarios");
  return readdirSync(dir)
    .filter((f) => /^s\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as KitScenario)
    .filter((s) => !only || only.includes(s.id));
}

async function findProduct(polar: Polar): Promise<string | null> {
  const pages = await polar.products.list({ query: PRODUCT_NAME, limit: 50 });
  for await (const page of pages) {
    for (const p of page.result.items) if (p.name === PRODUCT_NAME && !p.isArchived) return p.id;
  }
  return null;
}

async function ensureCustomer(polar: Polar, s: KitScenario, emailBase: string | undefined, updateEmail: boolean): Promise<string> {
  const externalId = `baton-demo-${s.id}`;
  let existing: { id: string; email: string | null } | null = null;
  try {
    const c = await polar.customers.getExternal({ externalId });
    existing = { id: c.id, email: c.email ?? null };
  } catch {
    /* not found → create */
  }
  if (existing) {
    const want = demoEmail(emailBase, s.id);
    if (updateEmail && existing.email !== want) await polar.customers.update({ id: existing.id, customerUpdate: { email: want } });
    return existing.id;
  }
  const a = s.customer.address;
  const c = await polar.customers.create({
    externalId,
    email: demoEmail(emailBase, s.id),
    name: s.customer.name,
    billingAddress: { country: "US", line1: a.street, city: a.city, state: `US-${a.state}`, postalCode: a.zip },
    metadata: { baton: "demo", scenario: s.id, fictional: true },
  });
  return c.id;
}

function upsertEnv(path: string, entries: Record<string, string>): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/);
  for (const [k, v] of Object.entries(entries)) {
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const writeEnv = args.includes("--write-env");
  const updateEmail = args.includes("--update-email");
  const sIdx = args.indexOf("--scenarios");
  const only = sIdx >= 0 ? (args[sIdx + 1] ?? "").split(",").filter(Boolean) : null;

  const token = process.env.POLAR_ACCESS_TOKEN?.trim();
  const server = (process.env.POLAR_SERVER?.trim() || "sandbox") as "sandbox" | "production";
  if (!token) throw new Error("POLAR_ACCESS_TOKEN is not set (value never printed)");
  if (server !== "sandbox") throw new Error("scripts/polar/setup.ts only runs against the Polar SANDBOX (POLAR_SERVER=sandbox)");
  const polar = new Polar({ accessToken: token, server: "sandbox" });

  let productId = await findProduct(polar);
  if (productId) console.log(`product exists: ${productId}`);
  else {
    const p = await polar.products.create({
      name: PRODUCT_NAME,
      description: "Fictional demo payment for Baton (sandbox only). Every checkout sets its own ad-hoc amount.",
      recurringInterval: null,
      prices: [{ amountType: "fixed", priceAmount: NOMINAL_PRICE_CENTS, priceCurrency: "usd" }],
      metadata: { baton: "demo" },
    });
    productId = p.id;
    console.log(`product created: ${productId}`);
  }

  // The Baton scenarios, plus the one generic relay customer (WP16·2) unless `--scenarios` leaves it out.
  const wanted = [...loadScenarios(only), ...(!only || only.includes(RELAY_DEMO_SCENARIO.id) ? [RELAY_DEMO_SCENARIO] : [])];
  const customers: Record<string, string> = {};
  for (const s of wanted) {
    customers[s.id] = await ensureCustomer(polar, s, process.env.POLAR_DEMO_CUSTOMER_EMAIL?.trim(), updateEmail);
    console.log(`customer ${s.id}: ${customers[s.id]} (${s.customer.name}, fictional)`);
  }

  console.log("\n# add to .env (not secrets):");
  console.log(`POLAR_PRODUCT_ID=${productId}`);
  console.log(`POLAR_DEMO_CUSTOMERS=${JSON.stringify(customers)}`);
  if (writeEnv) {
    upsertEnv(resolve(repoRoot(), ".env"), { POLAR_PRODUCT_ID: productId, POLAR_DEMO_CUSTOMERS: JSON.stringify(customers) });
    console.log("(.env updated: POLAR_PRODUCT_ID, POLAR_DEMO_CUSTOMERS)");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, "/").endsWith("scripts/polar/setup.ts");
if (isMain) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`setup failed: ${msg.slice(0, 400)}`);
    process.exit(1);
  });
}
