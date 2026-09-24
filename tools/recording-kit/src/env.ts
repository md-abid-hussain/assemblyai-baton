/**
 * env.ts - read Twilio credentials from the repo-root .env (read-only) and keep them out of output.
 *
 * Rules:
 *  - Values are never printed. Validation messages say what is wrong, not what the value is.
 *  - Every loaded secret is registered with `redact()`, which the CLI applies to any error text
 *    before printing it.
 */
import { existsSync, readFileSync } from "node:fs";
import { ENV_PATH } from "./paths.ts";
import { E164, cleanPhone } from "./phone.ts";

export interface TwilioEnv {
  accountSid: string;
  authToken: string;
  /** Your Twilio voice number, E.164 (the From / callerId of both legs). */
  phoneNumber: string;
}

export interface EnvCheck {
  env: TwilioEnv | null;
  problems: string[];
  warnings: string[];
}

const secrets = new Set<string>();

/** Replace any loaded secret that appears in `text` with a masked form. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(maskSecret(s));
  return out;
}

export function maskSecret(v: string): string {
  if (v.length <= 8) return `***(${v.length})`;
  return `${v.slice(0, 2)}...${v.slice(-4)}`;
}

/**
 * Minimal .env parser: KEY=VALUE lines, optional `export `, single/double quotes,
 * and inline comments on unquoted values ("KEY=   # comment" -> empty).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    const q = val[0];
    if ((q === '"' || q === "'") && val.indexOf(q, 1) > 0) {
      val = val.slice(1, val.indexOf(q, 1));
    } else if (val.startsWith("#")) {
      val = "";
    } else {
      val = val.replace(/\s+#.*$/, "").trim();
    }
    out[key] = val;
  }
  return out;
}

/** Load and validate TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER. */
export function loadTwilioEnv(path: string = ENV_PATH): EnvCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(path)) {
    return { env: null, problems: [`.env not found at ${path}`], warnings };
  }
  const vars = parseDotenv(readFileSync(path, "utf8"));
  const sid = vars.TWILIO_ACCOUNT_SID ?? "";
  const token = vars.TWILIO_AUTH_TOKEN ?? "";
  const phone = cleanPhone(vars.TWILIO_PHONE_NUMBER ?? "");

  if (!sid) problems.push("TWILIO_ACCOUNT_SID is missing or empty in .env");
  else if (!/^AC[0-9a-f]{32}$/i.test(sid)) problems.push("TWILIO_ACCOUNT_SID does not look like 'AC' + 32 hex characters (value not shown)");

  if (!token) problems.push("TWILIO_AUTH_TOKEN is missing or empty in .env");
  else if (/\s/.test(token)) problems.push("TWILIO_AUTH_TOKEN contains whitespace (value not shown)");
  else if (!/^[0-9a-f]{32}$/i.test(token)) {
    warnings.push("TWILIO_AUTH_TOKEN is not 32 hex characters; fine if Twilio changed the format, otherwise re-copy it (value not shown)");
  }

  if (!phone) problems.push("TWILIO_PHONE_NUMBER is missing or empty in .env");
  else if (!E164.test(phone)) problems.push("TWILIO_PHONE_NUMBER is not E.164 (expected +1XXXXXXXXXX, no spaces)");
  else if (!phone.startsWith("+1")) warnings.push("TWILIO_PHONE_NUMBER is not a +1 number; the kit was planned around a US number");

  if (sid) secrets.add(sid);
  if (token) secrets.add(token);

  return {
    env: problems.length === 0 ? { accountSid: sid, authToken: token, phoneNumber: phone } : null,
    problems,
    warnings,
  };
}

/** Load or throw with every problem listed. */
export function requireTwilioEnv(): TwilioEnv {
  const c = loadTwilioEnv();
  if (!c.env) throw new Error(`Twilio settings in .env are not usable:\n  - ${c.problems.join("\n  - ")}`);
  return c.env;
}
