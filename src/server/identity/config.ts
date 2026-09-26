import "server-only";

/**
 * The identity layer's environment (SAAS §15), read straight from `process.env`.
 *
 * `src/server/env.ts` is WP12's file and its `EnvSchema` does not list these names (WP19·1 decision 8), so they are
 * read here with safe defaults. If WP12 later adds them to `EnvSchema`, this file becomes a one-line delegation and
 * nothing else changes.
 *
 * **The rule that shapes this file:** a deployment with no `BETTER_AUTH_SECRET` must still boot and serve the v2
 * app. `BETTER_AUTH_SECRET` missing → `TENANCY_MODE=legacy` (§15), which is also the K-AUTH kill switch (§2.8).
 * So nothing here throws at import time; `authConfigured()` answers, and the callers degrade.
 */
import { env } from "../env";

/** Better Auth requires ≥ 32 characters (§15). A shorter value is treated as "not configured", never truncated. */
export const MIN_SECRET_LENGTH = 32;

const read = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

/** Never returned to a caller that prints; used only to construct the Better Auth instance. */
export function betterAuthSecret(): string | undefined {
  const s = read("BETTER_AUTH_SECRET");
  return s && s.length >= MIN_SECRET_LENGTH ? s : undefined;
}

/** The public https origin. `BETTER_AUTH_URL` wins; `APP_URL` is the documented default (§15). */
export function betterAuthUrl(): string | undefined {
  return read("BETTER_AUTH_URL") ?? env().APP_URL;
}

export function appUrl(): string | undefined {
  return env().APP_URL;
}

export const isProd = (): boolean => env().NODE_ENV === "production";
export const isDev = (): boolean => env().NODE_ENV !== "production";

/**
 * Whether the Better Auth instance can be built at all. Everything the instance needs at construction time:
 * the secret, a base URL and a database. Without all three, the app runs the v2 legacy path.
 */
export function authConfigured(): boolean {
  return Boolean(betterAuthSecret() && betterAuthUrl() && env().DATABASE_URL);
}

/** Why auth is off, for `/api/health` and the K-AUTH notice. Names only, never values (DESIGN §3.4). */
export function authMissing(): string[] {
  const missing: string[] = [];
  if (!betterAuthSecret()) missing.push("BETTER_AUTH_SECRET");
  if (!betterAuthUrl()) missing.push("BETTER_AUTH_URL");
  if (!env().DATABASE_URL) missing.push("DATABASE_URL");
  return missing;
}

/** GitHub is optional (§3.2, P4): no client id → no button, no provider. */
export function githubProvider(): { clientId: string; clientSecret: string } | null {
  const clientId = read("GITHUB_CLIENT_ID");
  const clientSecret = read("GITHUB_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** `trustedOrigins` (§3.9): the public origin, plus localhost in dev so `next dev` on any port works. */
export function trustedOrigins(): string[] {
  const out = new Set<string>();
  const app = appUrl();
  if (app) out.add(app.replace(/\/+$/, ""));
  const base = betterAuthUrl();
  if (base) out.add(base.replace(/\/+$/, ""));
  if (isDev()) {
    out.add("http://localhost:3000");
    out.add("http://localhost:3190");
  }
  return [...out];
}

/** §3.3 step 2. Deliberately far above anything a judging session reaches; they are anti-junk-row limits. */
export function guestLimits(): { perDeviceDaily: number; perIpKeyHourly: number; perIpKeyDaily: number; globalDaily: number } {
  const n = (name: string, def: number): number => {
    const raw = Number(read(name));
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : def;
  };
  return {
    perDeviceDaily: n("GUEST_PER_DEVICE_DAILY", 10),
    perIpKeyHourly: n("GUEST_PER_IPKEY_HOURLY", 30),
    perIpKeyDaily: n("GUEST_PER_IPKEY_DAILY", 120),
    globalDaily: n("GUEST_DAILY_CAP", 2000),
  };
}
