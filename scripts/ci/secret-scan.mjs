#!/usr/bin/env node
/**
 * secret-scan.mjs - pre-push guard. Fails if any value from the local .env (>= 8 chars), any key-shaped string,
 * or any private path (.env, participants.json, raw call audio, private research) appears in the files changed
 * in a git range. Never prints secret values, only variable names and file paths.
 *   node scripts/ci/secret-scan.mjs origin/main..HEAD
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const range = process.argv[2] || "origin/main..HEAD";
const envText = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const env = envText.split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).replace(/\s+#.*$/, "").trim()]; })
  .filter(([, v]) => v.length >= 8);
const files = execSync(`git diff --name-only --diff-filter=AMR ${range}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const keyPattern = /(sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,})|(AC[0-9a-f]{32})|(polar_(oat|pat)_[A-Za-z0-9]{10,})/;
const forbidden = /(^|\/)\.env$|participants\.json$|^data\/calls\/(raw|split)\/|^research\/(?!10)/;
let hits = 0;
for (const f of files) {
  if (forbidden.test(f)) { console.log(`FORBIDDEN PATH: ${f}`); hits++; continue; }
  let buf; try { buf = fs.readFileSync(f); } catch { continue; }
  const latin = buf.toString("latin1");
  for (const [k, v] of env) if (latin.includes(v)) { console.log(`LEAK: value of ${k} found in ${f}`); hits++; }
  if (!/\.(wav|mulaw|png|jpg|pdf|mp4|ogg|mp3|webm)$/.test(f)) {
    const m = buf.toString("utf8").match(keyPattern);
    if (m) { console.log(`KEY-SHAPED STRING in ${f} (${m[0].slice(0, 8)}…)`); hits++; }
  }
}
console.log(`secret-scan: ${files.length} files in ${range}, ${env.length} secret values checked, hits=${hits}`);
process.exit(hits ? 1 : 0);
