import "server-only";

/**
 * `validateToolArgs` (PLATFORM §4.7) — the canonical implementation now lives in `src/core/relay/tool-args.ts`
 * (WP14a), and this module is the re-export WP16·1 promised in `docs/notes/requests/wp16-to-wp14a.md` §1.
 *
 * WP16·1 shipped a server-side stand-in because WP14a's had not landed. Keeping both would be worse than the
 * original gap: the connector runtime and the tool service validate the SAME connector's arguments, so two
 * implementations could disagree about what reaches an upstream. There is one now. The WP16·1 tests still import
 * this path and still pin the behaviour.
 */
export { MAX_ARG_STRING, validateToolArgs, type ToolArgValue, type ToolParams, type ValidateToolArgsResult } from "../../core/relay/tool-args";
