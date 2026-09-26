/**
 * relay-code/index.ts - the public face of the codec (SAAS §5.3). WP23.
 *
 * Everything the Studio, the server and the CLI import comes from here. The only thing this module adds to
 * ./codec.ts is the kernel's linter: `validateSource` here runs syntax → zod → lint → codec, while the version
 * exported from ./codec.ts takes the linter as an option and stays free of the kernel (which is how the codec
 * could be written and tested before `lintBlueprint` landed).
 *
 * Pure and isomorphic: no node, DOM or server imports (tests/unit/core/relay-code/boundaries.test.ts).
 */
import { lintBlueprint, type LintOptions } from "../relay/lint";
import type { Blueprint } from "../contracts/v2/blueprint";
import type { SourceFormat } from "../contracts/v3/relay-code";
import { validateSource as validateSourceWith, type ValidateOptions, type ValidatedSource } from "./codec";

export {
  CodecError, applyEdit, convert, parseSource, serialize, sniffFormat, yamlSchemaHeader,
  type LintFn, type ParsedSource, type ValidateOptions, type ValidatedSource,
} from "./codec";
export { validateSourceWith };
export {
  ROOT_EXTRA_KEYS, credentialDiagnostics, diagnostic, hasBlockingErrors, hasErrors, lintDiagnostics,
  unknownKeyDiagnostics, zodDiagnostics, type Locate, type Path,
} from "./diagnostics";
export { diffLines, unifiedDiff, type DiffLabels } from "./diff";
export {
  childSchema, declaredKeys, objectShape, orderValue, resolveUnion, schemaAtPath, schemaType, unwrap,
} from "./order";
export { MAX_SOURCE_BYTES, CODEC_CODES } from "../contracts/v3/relay-code";
export type { CodeDiagnostic, CodecCode, Range, RelaySource, RelaySourceView, SourceFormat } from "../contracts/v3/relay-code";

/** The kernel's linter as the codec's `LintFn`. `opts` carries the context K1/K2/W2 need (PLATFORM §3.4). */
export const kernelLint = (opts: LintOptions = {}) => (blueprint: Blueprint) => lintBlueprint(blueprint, opts);

/**
 * Validate a blueprint file: syntax → zod → lint → codec (SAAS §5.3).
 * `blueprint`/`hash` are null when the file did not parse, failed zod, or carries a credential; lint errors leave
 * them set, because lint blocks Test and Publish, not Save.
 */
export function validateSource(text: string, format?: SourceFormat, options: ValidateOptions & { lintOptions?: LintOptions } = {}): ValidatedSource {
  const { lintOptions, ...rest } = options;
  return validateSourceWith(text, format, { lint: kernelLint(lintOptions), ...rest });
}
