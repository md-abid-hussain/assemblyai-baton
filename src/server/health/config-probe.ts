import "server-only";

import { missingEnv, type EnvName } from "../env";

/**
 * Deploy-time configuration probe (G2, WP12). Answers "are the app secrets set on this deployment?" by NAME only.
 * It never reads, returns or logs a value: `missingEnv` compares against `undefined`/`null` and hands back names.
 *
 * `REQUIRED` is the set the live Baton slice cannot run without (docs/notes/deploy.md "Secrets", step 1).
 * `OPTIONAL` is set later (Polar step 3, the Vercel mirror); the app falls back to mock payments without them, which
 * is what the G2 criterion uses, so their absence does not make the deployment unconfigured.
 */
export const REQUIRED_SECRET_NAMES = [
  "ASSEMBLYAI_API_KEY",
  "OPENAI_API_KEY",
  "CASE_TOKEN_SECRET",
  "VISITOR_SECRET",
  "ADMIN_KEY",
  "CRON_SECRET",
  "AAI_WEBHOOK_SECRET",
  "AGENT_TOOL_SECRET",
  "LIMITS_AUTHORITY_KEY",
] as const satisfies readonly EnvName[];

export const OPTIONAL_SECRET_NAMES = [
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_PRODUCT_ID",
] as const satisfies readonly EnvName[];

export type ConfigProbe = {
  /** True when every required secret is set. */
  ok: boolean;
  /** Names of the unset required secrets (never values). */
  missing: EnvName[];
  /** Names of the unset optional secrets (never values). */
  missingOptional: EnvName[];
};

export function configProbe(): ConfigProbe {
  try {
    const missing = missingEnv(REQUIRED_SECRET_NAMES);
    return { ok: missing.length === 0, missing, missingOptional: missingEnv(OPTIONAL_SECRET_NAMES) };
  } catch {
    // An invalid value somewhere in the schema: report unconfigured without echoing the EnvError text.
    return { ok: false, missing: [...REQUIRED_SECRET_NAMES], missingOptional: [...OPTIONAL_SECRET_NAMES] };
  }
}
