/**
 * blueprint-hash.ts - the blueprint hash `build-gallery` writes into `src/generated/sim-calls.json`.
 *
 * WP17·1 mirrored WP14a's implementation here because `src/core/relay/**` was not yet on `main`. It is now (G2), so
 * this file is a re-export: `blueprintHash = sha256(canonicalJson(blueprint))`, keys sorted (PLATFORM §3.2
 * "Versioning"). There is exactly one implementation again, which matters because `CallCatalog` matches the
 * manifest's `relay.blueprintHash` (and each preset variant's) against the hash WP14b's registry stored for the
 * seeded relay version. `tests/unit/server/sim/dental-gallery.test.ts` pins the committed hashes and checks that
 * WP14b's own patch applier reproduces the variant hashes.
 */
export { blueprintHash, canonicalJson } from "../../../src/core/relay/migrate";
