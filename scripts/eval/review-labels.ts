/**
 * review-labels.ts - the human review of auto-labels (DESIGN §6.1 step 4; ≈30 min for the 5 pilot takes).
 *
 *   npx tsx --conditions=react-server scripts/eval/review-labels.ts --list
 *   npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId>                  print, flagged items first
 *   npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId> --edit "<edit>" [--edit …] [--approve]
 *   npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId> --interactive    walk the flagged items
 *
 * Edits (times: ms, 12.5s or mm:ss.s):
 *   driver_dob.statedAtMs=00:41.2   driver_dob.ackedAtMs=null   drop:driver_age
 *   handoff.lineStartMs=95.3s  handoff.acceptStartMs=…  handoff=none   tailStartsMs=01:31.0   diagnosisEndsMs=…
 * --approve sets reviewed:true (refused while labelProblems() reports anything); --unapprove sets it back to false.
 * Every item prints its quote and timestamp; the transcript around it comes from data/labels/<callId>.auto.json.
 * No network, no spend.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { LabelsAutoFileSchema, type LabelsAutoFile } from "../../src/core/contracts/ext/wp9-data";
import type { CallLabels } from "../../src/core/contracts/scenario";
import { stableJson } from "../../src/core/scenario/assets";
import { applyLabelEdit, fmtMs, labelProblems, parseLabelEdit } from "../../src/core/scenario/labels";
import { parseKit } from "../../src/core/scenario/kit";
import { labelsAutoPath, labelsPath, readLabels, resolvePaths, str } from "../calls/lib/kit-io";

type Utt = LabelsAutoFile["utterances"][number];

function readAuto(dataRoot: string, callId: string): LabelsAutoFile | null {
  const p = labelsAutoPath(dataRoot, callId);
  return existsSync(p) ? parseKit(LabelsAutoFileSchema, JSON.parse(readFileSync(p, "utf8")), `${callId}.auto.json`) : null;
}

const around = (utts: readonly Utt[], ms: number | null, n = 1): string[] => {
  if (ms === null) return [];
  const i = utts.findIndex((u) => u.endMs >= ms);
  if (i < 0) return [];
  return utts.slice(Math.max(0, i - n), i + n + 1).map((u) => `      [${u.id}] ${u.channel.padEnd(8)} ${fmtMs(u.startMs)} ${u.text}`);
};

/** The review printout (flagged items first). Exported for the unit test. */
export function renderReview(l: CallLabels, auto: LabelsAutoFile | null, o: { context?: boolean } = {}): string {
  const lines: string[] = [];
  const flagsOf = (key: string) => auto?.items.find((i) => i.key === key);
  lines.push(`${l.callId}  reviewed=${l.reviewed}  mentions=${l.mentions.length}  diagnosisEnds=${fmtMs(l.diagnosisEndsMs)}  tailStarts=${fmtMs(l.tailStartsMs)}`);
  const h = l.handoff;
  const hi = flagsOf("handoff");
  lines.push(
    `  handoff  line ${fmtMs(h?.lineStartMs)}–${fmtMs(h?.lineEndMs)}  accept ${fmtMs(h?.acceptStartMs)}–${fmtMs(h?.acceptEndMs)}` +
      `${hi?.flags.length ? `  !! ${hi.flags.join(",")}` : ""}${hi?.note ? `  (${hi.note})` : ""}`,
  );
  if (o.context && auto) lines.push(...around(auto.utterances, h?.lineStartMs ?? null));
  const rows = l.mentions.map((m) => ({ m, item: flagsOf(m.field) }));
  rows.sort((a, b) => (b.item?.flags.length ?? 0) - (a.item?.flags.length ?? 0) || a.m.statedAtMs - b.m.statedAtMs);
  for (const { m, item } of rows) {
    lines.push(
      `  ${item?.flags.length ? "!!" : "ok"} ${m.field.padEnd(28)} ${m.valueNorm.padEnd(22)} ${m.channel.padEnd(8)} stated ${fmtMs(m.statedAtMs)} acked ${fmtMs(m.ackedAtMs)}` +
        `${item?.flags.length ? `  [${item.flags.join(",")}]` : ""}`,
    );
    lines.push(`      "${m.quote}"${item?.note ? `  (${item.note})` : ""}`);
    if (o.context && auto && item?.flags.length) lines.push(...around(auto.utterances, m.statedAtMs));
  }
  for (const item of auto?.items ?? []) {
    if (item.field && !l.mentions.some((m) => m.field === item.field)) lines.push(`  -- ${item.field.padEnd(28)} (no mention)  [${item.flags.join(",")}]  ${item.note}`);
  }
  const problems = labelProblems(l, null);
  if (problems.length) lines.push(`  PROBLEMS: ${problems.join("; ")}`);
  return lines.join("\n");
}

function list(dataRoot: string): void {
  const dir = join(dataRoot, "data", "labels");
  if (!existsSync(dir)) return void console.log("no labels yet");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.endsWith(".auto.json")).sort()) {
    const id = f.slice(0, -5);
    const l = readLabels(dataRoot, id)!;
    const auto = readAuto(dataRoot, id);
    const flagged = auto?.items.filter((i) => i.flags.length).length ?? 0;
    console.log(`${l.reviewed ? "REVIEWED " : "pending  "} ${id}  ${l.mentions.length} mentions, ${flagged} flagged, handoff ${l.handoff ? fmtMs(l.handoff.lineStartMs) : "none"}`);
  }
}

async function interactive(l: CallLabels, auto: LabelsAutoFile | null): Promise<CallLabels> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let cur = l;
  try {
    console.log(renderReview(cur, auto, { context: true }));
    console.log('\nEnter edits one per line (e.g. "driver_dob.statedAtMs=00:41.2", "drop:driver_age"), "approve", or an empty line to finish.');
    for (;;) {
      const line = (await rl.question("> ")).trim();
      if (!line) break;
      try {
        cur = line === "approve" ? applyLabelEdit(cur, { op: "reviewed", value: true }) : applyLabelEdit(cur, parseLabelEdit(line));
        console.log(renderReview(cur, auto));
      } catch (e) {
        console.log(`  ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    rl.close();
  }
  return cur;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const edits: string[] = [];
  let callId: string | undefined;
  const flags = new Set<string>();
  let dataRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--edit") edits.push(argv[++i] ?? "");
    else if (a === "--data-root") dataRoot = argv[++i];
    else if (a.startsWith("--")) flags.add(a.slice(2));
    else callId = a;
  }
  const paths = resolvePaths({ dataRoot: str(dataRoot) });
  if (flags.has("list") || !callId) return list(paths.dataRoot);
  const labels = readLabels(paths.dataRoot, callId);
  if (!labels) throw new Error(`no labels for ${callId} (run label-ground-truth.ts first)`);
  const auto = readAuto(paths.dataRoot, callId);
  let cur = labels;
  if (flags.has("interactive")) cur = await interactive(cur, auto);
  for (const e of edits) cur = applyLabelEdit(cur, parseLabelEdit(e));
  if (flags.has("unapprove")) cur = applyLabelEdit(cur, { op: "reviewed", value: false });
  if (flags.has("approve")) cur = applyLabelEdit(cur, { op: "reviewed", value: true });
  if (cur.reviewed) {
    const problems = labelProblems(cur, null);
    if (problems.length) throw new Error(`not approved: ${problems.join("; ")}`);
  }
  if (JSON.stringify(cur) !== JSON.stringify(labels)) {
    writeFileSync(labelsPath(paths.dataRoot, callId), stableJson(cur));
    console.log(`saved data/labels/${callId}.json (reviewed=${cur.reviewed}); re-run npm run calls:build to refresh calls.json`);
  }
  if (!flags.has("interactive")) console.log(renderReview(cur, auto, { context: flags.has("context") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
