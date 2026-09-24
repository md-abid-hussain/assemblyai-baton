import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests are $0 and run on every change (DESIGN §9.1). Integration tests need RUN_LIVE=1 (DESIGN §9.2).
// `server-only` / `client-only` throw when imported outside a bundler's matching condition; in vitest both are no-ops.
const noop = fileURLToPath(new URL("./scripts/lib/empty-module.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) },
      { find: /^server-only$/, replacement: noop },
      { find: /^client-only$/, replacement: noop },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "tests/e2e/**", "spikes/**", "tools/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Live tests share one AssemblyAI account: never run files in parallel when RUN_LIVE=1 (TASKS §0.5).
    fileParallelism: process.env.RUN_LIVE !== "1",
    passWithNoTests: true,
  },
});
