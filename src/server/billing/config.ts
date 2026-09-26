import "server-only";

/**
 * The billing layer's environment (SAAS §4.3, §4.7, §15), read straight from `process.env`.
 *
 * `src/server/env.ts` is WP12's file and its `EnvSchema` does not list the v3 billing names (the same decision
 * WP19 recorded for `src/server/identity/config.ts`), so they are read here with safe defaults. If WP12 later adds
 * them, this file becomes a one-line delegation and nothing else changes.
 *
 * **The rule that shapes this file:** a deployment with no Polar configuration must still boot and still *sell*.
 * `billingMode()` therefore never throws and never returns `polar` on a doubt — a missing token, a missing product
 * id or any `POLAR_SERVER` other than `sandbox` selects `simulated` (§4.7), which runs the same UI through the
 * labelled simulated checkout. `BILLING_MODE` set by hand wins in the safe direction only: it can force
 * `simulated`, never `polar`.
 *
 * Secrets are read, never returned to anything that prints and never logged (DESIGN §3.4): only `pro`/`business`
 * product ids (not secrets) and the mode leave this module.
 */
import type { PlanId } from "../../core/contracts/v3/identity";

/** The two purchasable plans (SAAS §4.1). `guest` and `free` are never bought. */
export const PAID_PLANS = ["pro", "business"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

export const isPaidPlan = (v: unknown): v is PaidPlan =>
  typeof v === "string" && (PAID_PLANS as readonly string[]).includes(v);

const read = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

/** Never returned to a caller that prints; used only to construct the Polar client. */
export const polarAccessToken = (): string | undefined => read("POLAR_ACCESS_TOKEN");

/**
 * `sandbox` unless the deployment says otherwise. **Billing only runs against the sandbox**: any other value
 * disables it (§4.3), so a mis-set variable can never point a checkout at real money.
 */
export const polarServer = (): string => read("POLAR_SERVER") ?? "sandbox";
export const isSandbox = (): boolean => polarServer() === "sandbox";

/** Product ids are configuration, not secrets: they live in `zerops.yml` (§4.3). */
export function productIds(): Record<PaidPlan, string | undefined> {
  return { pro: read("POLAR_PRODUCT_PRO"), business: read("POLAR_PRODUCT_BUSINESS") };
}

/** `slug → productId` for the plugin's checkout options, with the unset plans dropped. */
export function productList(): { productId: string; slug: PaidPlan }[] {
  const ids = productIds();
  return PAID_PLANS.flatMap((slug) => (ids[slug] ? [{ productId: ids[slug] as string, slug }] : []));
}

/** The optional P4 billing webhook secret (§4.3). Its own secret, not the v2 payments one. */
export const billingWebhookSecret = (): string | undefined => read("POLAR_BILLING_WEBHOOK_SECRET");

/** The public origin. Relative URLs are correct locally, so an unset `APP_URL` is not an error. */
export const appUrl = (): string | undefined => read("APP_URL")?.replace(/\/+$/, "");

/** Absolute when `APP_URL` is set, relative otherwise — both are valid `successUrl`/`returnUrl` inputs. */
export const appPath = (path: string): string => `${appUrl() ?? ""}${path}`;

export const BILLING_RETURN_PATH = "/app/settings/billing";
export const SIMULATED_CHECKOUT_PATH = "/app/settings/billing/simulated-checkout";

export type BillingMode = "polar" | "simulated";

/** Why billing is not on Polar, for the Billing page and `/api/health`. Names only, never values. */
export function billingMissing(): string[] {
  const missing: string[] = [];
  if (!polarAccessToken()) missing.push("POLAR_ACCESS_TOKEN");
  if (!isSandbox()) missing.push("POLAR_SERVER=sandbox");
  const ids = productIds();
  for (const p of PAID_PLANS) if (!ids[p]) missing.push(p === "pro" ? "POLAR_PRODUCT_PRO" : "POLAR_PRODUCT_BUSINESS");
  return missing;
}

/**
 * `polar` only when everything is present *and* the server is the sandbox; `simulated` otherwise (§4.7).
 *
 * `BILLING_MODE=simulated` is the K-BILL kill switch (TASKS-v3 §10) and is honoured. `BILLING_MODE=polar` is
 * deliberately **not** honoured on its own: it cannot conjure a token, and a deployment that lies about its
 * configuration should degrade, not fail at checkout time in front of a judge.
 */
export function billingMode(): BillingMode {
  if (read("BILLING_MODE") === "simulated") return "simulated";
  return billingMissing().length === 0 ? "polar" : "simulated";
}

/** The plan an org falls back to when nothing has been bought (§4.4 rule 1). */
export const planForOrgKind = (kind: string | null | undefined): PlanId => (kind === "guest" ? "guest" : "free");
