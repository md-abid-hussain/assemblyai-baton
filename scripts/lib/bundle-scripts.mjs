// bundle-scripts.mjs (`npm run bundle:scripts`): esbuild scripts/migrate.ts and scripts/cron.ts into
// self-contained ESM files dist/{migrate,cron}.mjs for the production bundle (DESIGN §3.3, §10.1).
//
// Differences from the one-line CLI in DESIGN §3.3, all needed for a working bundle:
//  - `conditions: ["react-server"]` so `server-only` resolves to its empty module outside Next;
//  - a `createRequire` banner, because pg is CommonJS and requires Node built-ins at runtime;
//  - `pg-native` is external (pg only loads it on demand).
import { build } from "esbuild";

const banner = [
  "import { createRequire as __batonCreateRequire } from 'node:module';",
  "const require = __batonCreateRequire(import.meta.url);",
].join("\n");

await build({
  entryPoints: ["scripts/migrate.ts", "scripts/cron.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  packages: "bundle",
  conditions: ["react-server"],
  external: ["pg-native"],
  banner: { js: banner },
  legalComments: "none",
  logLevel: "info",
});
