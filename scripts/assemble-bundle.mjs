// assemble-bundle.mjs (DESIGN §10.1): turn the Next standalone output + script bundles into ./bundle,
// the only thing Zerops deploys (`deployFiles: bundle`).
//   1. rm -rf bundle
//   2. .next/standalone/.  → bundle/
//   3. .next/static        → bundle/.next/static
//   4. public              → bundle/public
//   5. drizzle             → bundle/drizzle
//   6. dist/{migrate,cron}.mjs → bundle/
//   7. assert bundle/server.js exists
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => join(ROOT, ...s);
const out = p("bundle");

function fail(msg) {
  console.error(`[assemble-bundle] ${msg}`);
  process.exit(1);
}

function copy(from, to, { required = true } = {}) {
  if (!existsSync(from)) {
    if (required) fail(`missing ${from}`);
    return false;
  }
  cpSync(from, to, { recursive: true, force: true, dereference: true });
  return true;
}

const standalone = p(".next", "standalone");
if (!existsSync(standalone)) fail("missing .next/standalone (is `output: \"standalone\"` set and did `next build` run?)");

rmSync(out, { recursive: true, force: true });
copy(standalone, out);
copy(p(".next", "static"), join(out, ".next", "static"));
copy(p("public"), join(out, "public"), { required: false });
copy(p("drizzle"), join(out, "drizzle"));
for (const f of ["migrate.mjs", "cron.mjs"]) copy(p("dist", f), join(out, f));

// Never ship local secrets: Next may trace a root .env into standalone output.
for (const f of readdirSync(out)) if (/^\.env(\..*)?$/.test(f) && f !== ".env.example") rmSync(join(out, f), { force: true });

if (!existsSync(join(out, "server.js"))) fail("bundle/server.js not found (standalone output nested under another root?)");

let files = 0;
let bytes = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) walk(f);
    else {
      files++;
      bytes += statSync(f).size;
    }
  }
};
walk(out);
console.log(`[assemble-bundle] bundle/ ready: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB (server.js, migrate.mjs, cron.mjs, drizzle/, public/, .next/static/)`);
