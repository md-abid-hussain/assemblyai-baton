/**
 * Helpers for the WP13 content tests: read the pitch markdown files and parse their tables and fenced blocks.
 * Test-only, $0, no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function readRepoFile(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

export function repoFileExists(rel: string): boolean {
  return existsSync(join(ROOT, rel));
}

export interface NumberRow {
  id: string;
  number: string;
  tag: string;
  provenance: string;
  source: string;
  usedIn: string;
}

/** Every `| N-… |` row of `docs/pitch/numbers.md` (ID, Number, Tag, Provenance, Source, Used in). */
export function numberRows(md: string): NumberRow[] {
  const rows: NumberRow[] = [];
  for (const line of md.split("\n")) {
    if (!/^\| N-[a-z0-9-]+ \|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const [id = "", number = "", tag = "", provenance = "", source = "", usedIn = ""] = cells;
    rows.push({ id, number, tag, provenance, source, usedIn });
    if (cells.length !== 6) throw new Error(`numbers.md row ${id} has ${cells.length} cells, expected 6`);
  }
  return rows;
}

/** The first ```text block under the `## <heading>` of a markdown file. */
export function textBlockUnder(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const rest = md.slice(start + heading.length + 5);
  const m = /```text\n([\s\S]*?)\n```/.exec(rest);
  if (!m?.[1]) throw new Error(`no text block under "## ${heading}"`);
  return m[1].trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
