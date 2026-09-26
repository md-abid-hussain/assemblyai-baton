"use client";
/**
 * client/studio/code-target.ts - "take me to this in the Code tab".
 *
 * Three places produce this link and one consumes it, so the fragment is a contract and lives in its own module:
 *
 *   Overview's lint summary  ──#L8:11──▶ ┐
 *   Configure's "Edit in Code →"  ──#Pplaybook.greeting──▶ ├─▶ the Code tab reveals a caret
 *   a diagnostic row         ──#L…──▶ ┘
 *
 * **Why two shapes.** A diagnostic already knows its range, and re-deriving it would risk disagreeing with the
 * marker the builder just clicked. A *section* has no range at all — it has a path — and a path is the only thing
 * that survives the edit the builder is about to make. So a diagnostic links by line and a section links by path,
 * and `resolveTarget` turns the second into the first with the codec's own `locate`, which is the same function
 * that placed every marker in the file.
 *
 * A fragment rather than a query string: the Code tab reads it once on mount from `window.location.hash`, and
 * `useSearchParams` in a client component would drag a Suspense boundary into the route for a scroll position.
 */
import "client-only";

import { parseSource, type SourceFormat } from "@/core/relay-code";

export type Path = (string | number)[];

export interface Caret {
  /** 1-based, as a caret is everywhere a person reads one. */
  line: number;
  col: number;
}

export type CodeTarget = ({ kind: "line" } & Caret) | { kind: "path"; path: Path };

/** `["playbook","stages",0,"goal"]` → `"playbook.stages.0.goal"`. */
export const joinPath = (path: Path): string => path.join(".");

/** The inverse. A segment of only digits is an array index: `applyEdit` and `locate` both need a real number. */
export const splitPath = (s: string): Path =>
  s.split(".").filter(Boolean).map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));

/** `#L8:11` — the codec's `startCol` is 0-based, so callers add one before they get here. */
export const lineHash = (line: number, col: number): string => `#L${line}:${col}`;

export const pathHash = (path: Path): string => `#P${encodeURIComponent(joinPath(path))}`;

/**
 * Parse either shape. Anything else is `null`, so a hand-typed or stale fragment scrolls nowhere instead of
 * throwing inside an effect during hydration.
 */
export function parseCodeTarget(hash: string): CodeTarget | null {
  const raw = hash.trim().replace(/^#/, "");
  if (raw === "") return null;
  const line = /^L(\d+)(?::(\d+))?$/.exec(raw);
  if (line) {
    const l = Number(line[1]);
    const c = line[2] ? Number(line[2]) : 1;
    if (!Number.isFinite(l) || l < 1) return null;
    return { kind: "line", line: l, col: Number.isFinite(c) && c >= 1 ? c : 1 };
  }
  if (!raw.startsWith("P")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice(1));
  } catch {
    // A lone "%" in the fragment: `decodeURIComponent` throws a URIError, and a bad link must not break the tab.
    return null;
  }
  const path = splitPath(decoded);
  return path.length === 0 ? null : { kind: "path", path };
}

/**
 * Where the caret goes, in the text as it stands now.
 *
 * A path is resolved with `parseSource(...).locate`, the codec's own key/value locator — the same one that gave
 * every diagnostic its range, so a section jump and an error jump land by the same rule. `which: "key"` puts the
 * caret on `greeting:` rather than inside the block under it, which is what "take me to this section" means.
 */
export function resolveTarget(target: CodeTarget, text: string, format: SourceFormat): Caret | null {
  if (target.kind === "line") return { line: target.line, col: target.col };
  const { locate } = parseSource(text, format);
  const range = locate(target.path, "key");
  if (!range) return null;
  /*
   * The codec's `locate` walks *up* the path until something has a range, so a path the document does not have
   * resolves to the whole document. That is right for a diagnostic — it must point somewhere — and wrong here: a
   * stale link would silently scroll the reader to line 1 as if it had found their section. A non-empty path that
   * lands exactly on the root is that fallback, so it counts as not found and the caret stays where it is.
   */
  const root = locate([]);
  if (root && range.startLine === root.startLine && range.startCol === root.startCol) return null;
  return { line: range.startLine, col: range.startCol + 1 };
}
