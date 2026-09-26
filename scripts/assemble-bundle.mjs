// assemble-bundle.mjs (DESIGN §10.1): turn the Next standalone output + script bundles into ./bundle,
// the only thing Zerops deploys (`deployFiles: bundle`).
//   1. rm -rf bundle
//   2. .next/standalone/.  → bundle/
//   3. .next/static        → bundle/.next/static
//   4. public              → bundle/public
//   5. drizzle             → bundle/drizzle
//   6. dist/{migrate,cron}.mjs → bundle/
//   7. assert bundle/server.js exists
//   8. replace every symlink inside bundle/ with a real copy of its target (see materializeSymlinks)
import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => join(ROOT, ...s);
const out = p("bundle");

/**
 * `--clean` (QA-FIX): remove `bundle/` and stop. `npm run build` runs this BEFORE `next build`, because Next
 * traces the working tree before this script's own `rm -rf bundle` ever runs: a `bundle/` left by the previous
 * build was traced into `.next/standalone` and copied into the new `bundle/`, nesting one level deeper on every
 * unclean rebuild (10 levels, 235 MB of 329 MB, measured). `outputFileTracingExcludes` now also lists
 * `./bundle/**`; this is the second lock, and the assertion at the end of this file is the alarm.
 */
if (process.argv.includes("--clean")) {
  // A warning, never a failure: on Windows a running `node bundle/server.js` (or a virus scanner) holds the
  // directory and `rmSync` throws EBUSY. Refusing to build over that would be worse than building — the
  // post-assembly `bundle/bundle` assertion at the end of this file is the check that actually matters.
  try {
    rmSync(out, { recursive: true, force: true });
    console.log("[assemble-bundle] cleaned bundle/ before the build");
  } catch (err) {
    console.warn(`[assemble-bundle] could not clean bundle/ (${err.code ?? err.message}); is a server still running?`);
  }
  process.exit(0);
}

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

// QA-FIX: a previous build's artefact must never be inside this one. If this fires, `./bundle/**` has fallen out
// of `outputFileTracingExcludes` in next.config.mjs (or the build ran without the `--clean` step).
if (existsSync(join(out, "bundle"))) {
  fail("bundle/bundle exists: a previous build was traced into this one (next.config.mjs outputFileTracingExcludes must list ./bundle/**)");
}

/**
 * Turbopack loads `serverExternalPackages` (pg, ws) through hashed aliases, `.next/node_modules/<pkg>-<hash>`, which are
 * symlinks. Next's standalone copy keeps them as symlinks (readlink → symlink), and `cpSync(…, {dereference})` above does
 * not dereference nested entries, so bundle/ shipped a link whose target exists only in the build container. On Zerops
 * (separate build and runtime containers) every DB route then failed with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'pg-<hash>'`. Same-container runs (local, Docker) cannot show this.
 * Fix: copy each link's resolved target into place, so the artefact contains no symlinks at all.
 */
function materializeSymlinks(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (lstatSync(f).isSymbolicLink()) {
      const link = readlinkSync(f);
      let target;
      try {
        target = realpathSync(f);
      } catch {
        fail(`dangling symlink ${relative(out, f)} -> ${link}`);
      }
      rmSync(f, { recursive: true, force: true }); // removes the link itself, never its target
      cpSync(target, f, { recursive: true, force: true, dereference: true });
      console.log(`[assemble-bundle] materialized ${relative(out, f)} (was a symlink to ${link})`);
      n++;
      if (statSync(f).isDirectory()) n += materializeSymlinks(f);
    } else if (e.isDirectory()) {
      n += materializeSymlinks(f);
    }
  }
  return n;
}
const materialized = materializeSymlinks(out);
const leftover = [];
const findLinks = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (lstatSync(f).isSymbolicLink()) leftover.push(relative(out, f));
    else if (e.isDirectory()) findLinks(f);
  }
};
findLinks(out);
if (leftover.length) fail(`symlinks left in bundle/: ${leftover.slice(0, 5).join(", ")}`);
const extDir = join(out, ".next", "node_modules");
if (existsSync(extDir)) {
  for (const pkg of readdirSync(extDir)) {
    if (!existsSync(join(extDir, pkg, "package.json"))) fail(`external module .next/node_modules/${pkg} has no package.json`);
  }
}

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
console.log(
  `[assemble-bundle] bundle/ ready: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB, ${materialized} symlink(s) materialized (server.js, migrate.mjs, cron.mjs, drizzle/, public/, .next/static/)`,
);
