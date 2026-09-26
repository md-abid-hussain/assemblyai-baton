import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy (DESIGN §8.4). Additions, all verified by /dev/csp (T-D1-10):
 *  - `script-src blob:`: AudioWorklet modules are loaded from Blob URLs and worklets are governed by script-src;
 *  - `'unsafe-eval'` and `ws:` only in `next dev` (React refresh / HMR); never in production;
 *  - `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'self'`: cheap hardening.
 */
export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", "blob:", "https://cdn.jsdelivr.net", ...(isDev ? ["'unsafe-eval'"] : [])],
  "worker-src": ["'self'", "blob:"],
  "connect-src": [
    "'self'",
    "wss://streaming.assemblyai.com",
    "wss://agents.assemblyai.com",
    "https://sandbox-api.polar.sh",
    ...(isDev ? ["ws:"] : []),
  ],
  "frame-src": ["https://sandbox.polar.sh", "https://*.polar.sh", "https://js.stripe.com", "https://*.stripe.com"],
  "media-src": ["'self'", "blob:", "https://*.amazonaws.com"],
  "img-src": ["'self'", "data:", "https:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'", "data:"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'self'"],
};

export const CONTENT_SECURITY_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => `${k} ${v.join(" ")}`)
  .join("; ");

export const securityHeaders = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Permissions-Policy", value: "microphone=(self), camera=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  // D10: `npm run typecheck` (TypeScript 6.0.3) is the gate; Next's build-time type check is off.
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ["pg", "ws"],
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md + CLAUDE.md into the repo root (changing every agent's context).
  agentRules: false,
  // Pin the tracing/workspace root to this repo (a stray lockfile higher up must not move server.js).
  outputFileTracingRoot: ROOT,
  turbopack: { root: ROOT },
  // Keep spikes, tools, research and private call audio out of the traced server bundle. Paths are anchored
  // with "./": an unanchored "dist/**" also matched node_modules/pg-protocol/dist and broke pg at runtime.
  // `./bundle/**` (QA-FIX): `next build` traces *before* `scripts/assemble-bundle.mjs` does its `rm -rf bundle`,
  // so a `bundle/` left by the previous build was swept into `.next/standalone` and copied into the new one. It
  // compounded on every unclean rebuild — 10 levels of `bundle/bundle/…`, 235 MB of 329 MB — and made the build
  // non-idempotent. `assemble-bundle.mjs` now fails loudly if a nested copy ever reappears.
  outputFileTracingExcludes: {
    "*": ["./spikes/**", "./tools/**", "./research/**", "./data/calls/**", "./bundle/**", "./node_modules/sharp/**", "./node_modules/@img/**"],
  },
  // G1 (wp3-to-integrator §3): the Express prefill and cached-replay events read WP9's extraction cache with fs at
  // run time; `data/` is not traced otherwise. Matches nothing until WP9 writes data/cache/extract/**.
  // G2-finish (wp14b-to-wp12 §2): the gallery seed reads data/relays/*.json with fs at run time (FsGallerySource),
  // and /api/cases resolves relay versions. Without these the deployed gallery is silently empty.
  // QA-FIX: the scenario policies. `src/instrumentation.ts`'s `[WIRE-SCENARIOS]` step statically imports
  // `src/generated/scenarios.json`, which is the primary path and needs no tracing at all; these entries keep the
  // `FsCaseDataSource` **fallback** honest, because it reads both files by a computed relative path that the
  // tracer cannot see. Without either, `POST /api/cases` answered `404 "Unknown scenario s01."` on the built
  // server and the guest demo was dead (the kit files are ~10 small JSON documents).
  outputFileTracingIncludes: {
    "/api/cases": [
      "./data/cache/extract/**", "./data/relays/*.json", "./data/scenarios/*.json", "./src/generated/scenarios.json",
    ],
    "/api/extract": ["./data/cache/extract/**"],
    "/api/relays": ["./data/relays/*.json"],
    "/api/relays/[id]": ["./data/relays/*.json"],
    "/api/relays/[id]/compiled": ["./data/relays/*.json"],
  },
  // No server-side image optimisation: keeps the native, LGPL-licensed libvips (sharp) out of the deploy bundle.
  // `next/image` still works and serves the original files (pre-size images in public/).
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
