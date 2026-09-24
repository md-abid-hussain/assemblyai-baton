/** scan-secrets.ts - assert no loaded secret (or temp/resume token) appears in spikes/out/va-* files. Prints counts only. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT_DIR, secretValues } from "../lib/env.ts";
const secrets = secretValues();
let bad = 0;
for (const f of readdirSync(OUT_DIR).filter((n) => n.startsWith("va-") && /\.(jsonl|json)$/.test(n))) {
  const text = readFileSync(resolve(OUT_DIR, f), "utf8");
  const hits = secrets.filter((s) => text.includes(s)).length;
  const jwtish = (text.match(/eyJ[A-Za-z0-9_-]{40,}/g) ?? []).length;
  const longTok = (text.match(/AQI[A-Za-z0-9_\-+/=]{200,}/g) ?? []).length;
  const bearer = (text.match(/Bearer [A-Za-z0-9]{20,}/g) ?? []).length;
  if (hits || jwtish || longTok || bearer) bad++;
  console.log(f.padEnd(52), { secretHits: hits, jwtLike: jwtish, rawTempTokens: longTok, bearer });
}
console.log(bad ? `FOUND ISSUES in ${bad} files` : "clean");
