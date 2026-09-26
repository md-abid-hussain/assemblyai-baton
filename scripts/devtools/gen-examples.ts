/**
 * devtools/gen-examples.ts - write `examples/relays/*.yaml` from the gallery JSON (SAAS §5.2). WP23.
 *
 *   npx tsx scripts/devtools/gen-examples.ts            # write every example
 *   npx tsx scripts/devtools/gen-examples.ts --check     # exit 1 if a committed example has drifted
 *
 * The examples are the relay-as-code story a developer meets first: the Baton flagship as a YAML file with the
 * `# yaml-language-server` header, ready for `changeover validate` and for VS Code. They are GENERATED from
 * `data/relays/<slug>.json` through the codec's `serialize`, so an example can never drift from the blueprint the
 * app actually runs, and the file doubles as a check that `serialize` is deterministic.
 *
 * A gallery file with no example yet (WP17's `dental-deposit.json` lands later) is reported, not written, unless
 * `--all` is passed: which examples are committed is a decision, not an accident of what happens to be in `data/`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BlueprintSchema } from "../../src/core/contracts/v2/blueprint";
import { serialize, yamlSchemaHeader } from "../../src/core/relay-code/codec";
import { PRODUCTION_APP_URL } from "./gen-json-schema";

export const GALLERY_DIR = "data/relays";
export const EXAMPLES_DIR = "examples/relays";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Top-level gallery blueprints: `data/relays/*.json`, without the `*.presets.json` sidecars (PLATFORM §7.5.3). */
export function galleryFiles(root: string = ROOT): string[] {
  const dir = join(root, GALLERY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".presets.json"))
    .sort();
}

export const exampleNameFor = (galleryFile: string): string => `${basename(galleryFile, ".json")}.yaml`;

/** The exact bytes of one example: the gallery blueprint, serialized as YAML with the IDE header. */
export function renderExample(galleryJson: unknown, appUrl: string = PRODUCTION_APP_URL): string {
  const blueprint = BlueprintSchema.parse(galleryJson);
  return serialize(blueprint, "yaml", { header: yamlSchemaHeader(`${appUrl}/schemas/blueprint-2.0.json`) });
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const all = argv.includes("--all");
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "") || PRODUCTION_APP_URL;
  let drifted = 0;
  let written = 0;
  mkdirSync(join(ROOT, EXAMPLES_DIR), { recursive: true });
  for (const file of galleryFiles()) {
    const target = join(ROOT, EXAMPLES_DIR, exampleNameFor(file));
    const exists = existsSync(target);
    if (!exists && !all) {
      process.stdout.write(`skip ${file}: no committed example yet (pass --all to create one)\n`);
      continue;
    }
    const next = renderExample(JSON.parse(readFileSync(join(ROOT, GALLERY_DIR, file), "utf8")), appUrl);
    if (check) {
      if (!exists || readFileSync(target, "utf8") !== next) {
        drifted++;
        process.stderr.write(`${EXAMPLES_DIR}/${exampleNameFor(file)} has drifted from ${GALLERY_DIR}/${file}\n`);
      }
      continue;
    }
    writeFileSync(target, next);
    written++;
    process.stdout.write(`wrote ${EXAMPLES_DIR}/${exampleNameFor(file)} (${next.length} bytes)\n`);
  }
  if (check && drifted > 0) {
    process.stderr.write("run: npx tsx scripts/devtools/gen-examples.ts\n");
    return 1;
  }
  if (check) process.stdout.write("examples are up to date\n");
  else process.stdout.write(`${written} example(s) written\n`);
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) process.exit(main(process.argv.slice(2)));
