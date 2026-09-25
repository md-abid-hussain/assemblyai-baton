/**
 * stt-hooks.ts - lets one Node process import both `src/client/**` (marked `import "client-only"`) and the
 * server-only Node WebSocket factory used by scripts/lib/aai-open.ts (`import "server-only"`). Under plain Node
 * `server-only` throws; under `--conditions=react-server` `client-only` throws. This resolve hook maps both marker
 * packages to an empty module (exactly what vitest's alias does for unit tests). Scripts only; never bundled.
 *
 * Usage (first thing in an entry script, before any dynamic import of the code that needs it):
 *   import { registerMarkerShim } from "./stt-hooks";
 *   registerMarkerShim();
 *   const lib = await import("./stt-live");
 */
import { register } from "node:module";

const HOOK = `
export async function resolve(specifier, context, next) {
  if (specifier === "client-only" || specifier === "server-only") {
    return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}
`;

let done = false;
export function registerMarkerShim(): void {
  if (done) return;
  done = true;
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`);
}
