#!/usr/bin/env node
/**
 * staged-key-scan.mjs - pre-commit guard (installed as the shared git pre-commit hook for every worktree).
 * Blocks a commit when the STAGED content contains:
 *   - any value from the repo's .env (>= 8 chars), or
 *   - any string shaped like a real provider credential (OpenAI, Stripe, Polar, Twilio, GitHub, AWS, Slack, Google,
 *     PEM private keys), real OR fake.
 * Tests that need a credential-shaped value must build it at runtime, e.g. ["polar", "oat", "x".repeat(24)].join("_"),
 * so no credential-shaped literal ever exists in the repository or its history.
 * Prints only file paths and pattern names - never the matched value.
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const MAIN_ENV = "C:/Users/abid1/Desktop/assembly-ai/.env";
const envText = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : fs.existsSync(MAIN_ENV) ? fs.readFileSync(MAIN_ENV, "utf8") : "";
const envValues = envText.split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).replace(/\s+#.*$/, "").trim()]; })
  .filter(([, v]) => v.length >= 8);

const PATTERNS = [
  ["openai-key", /\bsk-(proj|svcacct|admin|live|test)?-?[A-Za-z0-9_-]{20,}/],
  ["stripe-key", /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/],
  ["webhook-signing-secret", /\bwhsec_[A-Za-z0-9+/=_-]{10,}/],
  ["polar-token", /\bpolar_(oat|pat|at|rt|cs|ci|whs)_[A-Za-z0-9_-]{8,}/],
  ["twilio-sid-or-key", /\b(AC|SK)[0-9a-f]{32}\b/],
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private-key", /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
];
const BINARY = /\.(wav|mulaw|png|jpg|jpeg|gif|webp|pdf|mp4|ogg|mp3|webm|ico|woff2?)$/i;

const staged = execSync("git diff --cached --name-only --diff-filter=AMR", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
let hits = 0;
for (const f of staged) {
  if (/(^|\/)\.env$/.test(f)) { console.error(`BLOCKED: ${f} (.env files must never be committed)`); hits++; continue; }
  let content;
  try { content = execSync(`git show :"${f}"`, { encoding: "latin1", maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
  for (const [k, v] of envValues) if (content.includes(v)) { console.error(`BLOCKED: ${f} contains the value of ${k} from .env`); hits++; }
  if (BINARY.test(f)) continue;
  for (const [name, re] of PATTERNS) {
    if (re.test(content)) { console.error(`BLOCKED: ${f} contains a ${name}-shaped string (build test fakes at runtime instead)`); hits++; }
  }
}
if (hits) {
  console.error(`\npre-commit: ${hits} problem(s). No credential-shaped literal (real or fake) may be committed.`);
  process.exit(1);
}
