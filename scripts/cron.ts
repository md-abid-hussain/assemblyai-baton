/**
 * cron.ts → bundle/cron.mjs (DESIGN §10.1). Zerops crontab calls `node bundle/cron.mjs light|full|purge|tick`.
 * A tiny local POST to the running app's cron route with the cron secret; no curl (Alpine may lack it).
 * Never prints the secret.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./lib/load-env";

export const CRON_KINDS = ["light", "full", "purge", "tick"] as const;
export type CronKind = (typeof CRON_KINDS)[number];

export function cronUrl(kind: CronKind, base = `http://127.0.0.1:${process.env.PORT || "3000"}`): string {
  return `${base.replace(/\/$/, "")}/api/internal/cron?kind=${kind}`;
}

async function main(argv: string[]): Promise<number> {
  loadEnv();
  const kind = argv[0] as CronKind | undefined;
  if (!kind || !CRON_KINDS.includes(kind)) {
    console.error(`usage: node bundle/cron.mjs ${CRON_KINDS.join("|")}`);
    return 2;
  }
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error(JSON.stringify({ level: "error", component: "cron", msg: "CRON_SECRET is not set" }));
    return 1;
  }
  const base = process.env.CRON_TARGET_URL?.trim() || undefined;
  const t0 = Date.now();
  const res = await fetch(cronUrl(kind, base), {
    method: "POST",
    headers: { "x-cron-secret": secret },
    signal: AbortSignal.timeout(kind === "full" ? 110_000 : 55_000),
  });
  const body = (await res.text()).slice(0, 2000);
  const line = { t: new Date().toISOString(), level: res.ok ? "info" : "error", component: "cron", kind, status: res.status, ms: Date.now() - t0, body };
  (res.ok ? console.log : console.error)(JSON.stringify(line));
  return res.ok ? 0 : 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(JSON.stringify({ level: "error", component: "cron", msg: e instanceof Error ? e.message : String(e) }));
      process.exit(1);
    },
  );
}
