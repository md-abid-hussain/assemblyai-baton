/** analyze-clips.ts - speech segments (gaps > 250 ms) of the core-loop clips, used to anchor turn latencies. */
import { readWav } from "../lib/wav.ts";
import { rmsDbfs } from "../lib/audio.ts";
import { ttsPcm24k } from "../lib/tts.ts";
function segs(samples: Int16Array, rate: number) {
  const win = rate / 100; const out: [number, number][] = []; let cur: number | null = null; let lastLoud = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    const loud = rmsDbfs(samples.subarray(i, i + win)) > -45;
    const t = (i / rate) * 1000;
    if (loud) { if (cur === null) cur = t; lastLoud = t + 10; }
    else if (cur !== null && t - lastLoud > 250) { out.push([Math.round(cur), Math.round(lastLoud)]); cur = null; }
  }
  if (cur !== null) out.push([Math.round(cur), Math.round(lastLoud)]);
  return out;
}
const q = readWav("fixtures/question_24k.wav");
console.log("question segments (ms, gaps>250ms):", JSON.stringify(segs(q.samples, 24000)));
const b = await ttsPcm24k({ input: "Wait, sorry, stop. Can you just text me the tracking number instead?", voice: "marin" });
console.log("barge segments:", JSON.stringify(segs(b.samples, 24000)), "cached", b.cached);
