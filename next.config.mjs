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
  outputFileTracingExcludes: {
    "*": ["./spikes/**", "./tools/**", "./research/**", "./data/calls/**", "./node_modules/sharp/**", "./node_modules/@img/**"],
  },
  // No server-side image optimisation: keeps the native, LGPL-licensed libvips (sharp) out of the deploy bundle.
  // `next/image` still works and serves the original files (pre-size images in public/).
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
