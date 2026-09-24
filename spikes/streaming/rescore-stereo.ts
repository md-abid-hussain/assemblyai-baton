/** Re-score out/streaming-stereo.summary.json from the raw per-channel logs (edge-timestamp error, attribution). Run from spikes/: npx tsx streaming/rescore-stereo.ts */
import { readFileSync, writeFileSync } from "node:fs";
import { dialogScript, stats, wer, entityHits } from "./harness.ts";
import type { TurnMessage } from "./client.ts";
const load = (f: string) => readFileSync(`out/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.dir === "in" && l.data.type === "Turn" && l.data.end_of_turn).map((l) => ({ wallMs: l.wallMs as number, t: l.data as TurnMessage }));
const script = dialogScript();
const merged = [...load("streaming-stereo-left-adjuster.jsonl").map((x) => ({ ...x, ch: "adjuster" })), ...load("streaming-stereo-right-claimant.jsonl").map((x) => ({ ...x, ch: "claimant" }))]
  .filter((x) => x.t.words.length).sort((a, b) => a.t.words[0]!.start - b.t.words[0]!.start);
// match each final to the SAME speaker's script turn with the largest overlap (per-channel => speaker known by construction)
const rows = merged.map((x) => {
  const s = x.t.words[0]!.start, e = x.t.words.at(-1)!.end;
  let best = -1, bestOv = -Infinity;
  for (const t of script.turns) if (t.speaker === x.ch) { const ov = Math.min(e, t.end_ms) - Math.max(s, t.start_ms); if (ov > bestOv) { bestOv = ov; best = t.index; } }
  return { ch: x.ch, scriptTurn: best, overlapMs: bestOv, start: s, end: e, lag: Math.round(x.wallMs - e), text: x.t.transcript };
});
const startErr: number[] = [], endErr: number[] = [];
for (const t of script.turns) {
  const fs = rows.filter((r) => r.scriptTurn === t.index);
  if (!fs.length) continue;
  startErr.push(fs[0]!.start - t.start_ms);
  endErr.push(fs.at(-1)!.end - t.end_ms);
}
const hyp = merged.map((x) => x.t.transcript).join(" ");
const out = {
  finals: rows.length,
  finalsOverlappingOwnSpeakerTurn: rows.filter((r) => r.overlapMs > 0).length,
  scriptTurnsCovered: new Set(rows.map((r) => r.scriptTurn)).size,
  wer: wer(script.turns.map((t) => t.text).join(" "), hyp),
  missing: entityHits(hyp).missing,
  finalLagFromLastWordEnd: stats(rows.map((r) => r.lag)),
  edgeTimestampErrorMs: { firstWordStartMinusScriptStart: stats(startErr), lastWordEndMinusScriptEnd: stats(endErr), rawStart: startErr, rawEnd: endErr },
};
console.log(JSON.stringify(out, null, 1));
const sum = JSON.parse(readFileSync("out/streaming-stereo.summary.json", "utf8"));
sum.merged.rescored = out;
sum.status = out.finalsOverlappingOwnSpeakerTurn === out.finals ? "PASS" : "PARTIAL";
sum.rescoreNote = "attribution is by construction in per-channel mode; the original midpoint-based check mis-assigned short replies because turn-edge word timestamps absorb neighbouring silence (first start early, last end late)";
writeFileSync("out/streaming-stereo.summary.json", JSON.stringify(sum, null, 2));
