/**
 * build-assets.ts - `npm run calls:build` (DESIGN §5.1.1, §6.1; TASKS WP9).
 *
 *   npm run calls:build [-- --calls-dir <kit data/calls>] [--scenarios-dir <dir>] [--out <root>] [--data-root <root>]
 *                          [--featured s01] [--check]
 *
 * Reads the recording kit's files (READ-ONLY: manifest.json, raw/*.json sidecars, split/*_{rep,customer}.wav), the
 * kit scenarios and WP9's own labels + STT caches, and writes:
 *   src/generated/calls.json            CallManifestEntry[] (featured, picker, hashed asset URLs, handoff, bundles)
 *   src/generated/scenarios.json        Scenario[] (one per kit scenario; the chosen take's overrides applied)
 *   src/generated/call-scenarios.json   callId → Scenario (each take's own overrides; the eval's truth)
 *   public/calls/<callId>/…             rep/customer µ-law + peaks, PUBLISHABLE takes only (others are pruned)
 *   public/data/cached-turns/<callId>.json   from the take's complete pc_ctx STT cache, publishable takes only
 *
 * Idempotent: no timestamps in outputs, files are rewritten only when their bytes change, stale files are pruned.
 * `--check` computes everything and exits 1 if any output would change (CI / "is the build fresh?").
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CallManifestEntry, Scenario } from "../../src/core/contracts/scenario";
import { callAssetFiles, stableJson, takeAudioOf } from "../../src/core/scenario/assets";
import { planCalls, type TakeInput } from "../../src/core/scenario/build";
import { cachedTurnsFileOf, isCompleteCache } from "../../src/core/scenario/stt-cache";
import {
  loadKit, parseFlags, pruneDir, readLabels, readSplit, readSttCache, resolvePaths, sha256HexOf, str, writeIfChanged, type PipelinePaths,
} from "./lib/kit-io";

export interface BuildOptions {
  featuredScenarioId?: string;
  /** Compute only; report what would change. */
  check?: boolean;
  log?: (line: string) => void;
}

export interface BuildReport {
  calls: CallManifestEntry[];
  scenarios: Scenario[];
  warnings: string[];
  /** Output paths (relative to outRoot) that were (or, with check, would be) written or removed. */
  changed: string[];
}

/** `/replays/<bundleId>/` recorded for this call (WP11, §7.5): a dir whose meta/events JSON names the callId. */
function findBundle(outRoot: string, callId: string): string | null {
  const dir = join(outRoot, "public", "replays");
  if (!existsSync(dir)) return null;
  for (const id of readdirSync(dir).sort()) {
    for (const f of ["meta.json", "bundle.json", "events.json"]) {
      const p = join(dir, id, f);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as { callId?: unknown; meta?: { callId?: unknown } };
        if (j.callId === callId || j.meta?.callId === callId) return `/replays/${encodeURIComponent(id)}/`;
      } catch {
        /* not ours to judge */
      }
    }
    if (id === callId) return `/replays/${encodeURIComponent(id)}/`;
  }
  return null;
}

/** `/tts/voice/<scenarioId>/manifest.json` (WP11 tail pack, §11.6), if present. */
function findTailPack(outRoot: string, scenarioId: string): string | null {
  return existsSync(join(outRoot, "public", "tts", "voice", scenarioId, "manifest.json")) ? `/tts/voice/${encodeURIComponent(scenarioId)}/manifest.json` : null;
}

export function buildCalls(paths: PipelinePaths, o: BuildOptions = {}): BuildReport {
  const log = o.log ?? (() => undefined);
  const kit = loadKit(paths);
  const warnings = [...kit.warnings];

  // Audio + labels of every downloaded take (the plan decides which are usable).
  const takes: TakeInput[] = [];
  const audioOf = new Map<string, ReturnType<typeof takeAudioOf>>();
  for (const sc of kit.sidecars) {
    if (sc.state !== "downloaded") continue;
    const pcm = readSplit(paths.callsDir, sc.base);
    if (!pcm) {
      warnings.push(`${sc.base}: split WAVs missing; skipped`);
      continue;
    }
    const audio = takeAudioOf(pcm);
    if (audio.paddedSamples > 0) warnings.push(`${sc.base}: rep/customer lengths differ by ${audio.paddedSamples} samples; padded`);
    audioOf.set(sc.base, audio);
    let labels = null;
    try {
      labels = readLabels(paths.dataRoot, sc.base);
    } catch (e) {
      warnings.push(`${sc.base}: labels ignored (${e instanceof Error ? e.message : String(e)})`);
    }
    takes.push({ sidecar: sc, durationMs: audio.durationMs, labels });
  }

  const plan = planCalls({
    scenarios: kit.scenarios,
    takes,
    ...(kit.manifestChosen ? { manifestChosen: kit.manifestChosen } : {}),
    ...(o.featuredScenarioId ? { featuredScenarioId: o.featuredScenarioId } : {}),
    recordedAiBundle: (callId) => findBundle(paths.outRoot, callId),
    customerTailPack: (sid) => findTailPack(paths.outRoot, sid),
  });
  warnings.push(...plan.warnings);

  const changed: string[] = [];
  const write = (rel: string, data: Uint8Array | string): void => {
    const abs = join(paths.outRoot, rel);
    if (o.check) {
      const want = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (!existsSync(abs) || !readFileSync(abs).equals(want)) changed.push(rel);
    } else if (writeIfChanged(abs, data)) changed.push(rel);
  };
  const prune = (relDir: string, keep: Set<string>): void => {
    const abs = join(paths.outRoot, relDir);
    if (o.check) {
      if (existsSync(abs)) for (const n of readdirSync(abs)) if (!keep.has(n)) changed.push(`${relDir}/${n} (remove)`);
    } else for (const n of pruneDir(abs, keep)) changed.push(`${relDir}/${n} (removed)`);
  };

  // Public audio: publishable takes only; everything else under public/calls is pruned.
  const calls: CallManifestEntry[] = [];
  const publishedDirs = new Set<string>();
  const cachedTurnFiles = new Set<string>();
  for (const pc of plan.calls) {
    const e = pc.entry;
    let assets: CallManifestEntry["assets"] = null;
    if (e.publishAudio) {
      const audio = audioOf.get(e.callId)!;
      const { files, urls } = callAssetFiles(e.callId, audio, sha256HexOf);
      for (const f of files) write(`public/calls/${e.callId}/${f.name}`, f.bytes);
      prune(`public/calls/${e.callId}`, new Set(files.map((f) => f.name)));
      publishedDirs.add(e.callId);
      assets = urls;

      // Cached-turn replay (§5.1.10) needs the take's complete pc_ctx cache and a published take.
      if (pc.dualChannel) {
        try {
          const records = readSttCache(paths.dataRoot, e.callId, "pc_ctx");
          if (records && isCompleteCache(records, "pc_ctx")) {
            write(`public/data/cached-turns/${e.callId}.json`, stableJson(cachedTurnsFileOf(e.callId, records)));
            cachedTurnFiles.add(`${e.callId}.json`);
          } else if (records) warnings.push(`${e.callId}: pc_ctx STT cache incomplete (no trailer); no cached turns published`);
        } catch (err) {
          warnings.push(`${e.callId}: pc_ctx STT cache unreadable (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    calls.push({ ...e, assets });
  }
  prune("public/calls", publishedDirs);
  prune("public/data/cached-turns", cachedTurnFiles);

  const callScenarios = Object.fromEntries(plan.calls.map((c) => [c.entry.callId, c.scenario]));
  write("src/generated/calls.json", stableJson(calls));
  write("src/generated/scenarios.json", stableJson(plan.scenarios));
  write("src/generated/call-scenarios.json", stableJson(callScenarios));

  const featured = calls.filter((c) => c.featured);
  log(
    `calls:build  ${kit.scenarios.length} scenarios, ${kit.sidecars.length} sidecars → ${calls.length} usable takes ` +
      `(${calls.filter((c) => c.publishAudio).length} published, ${calls.filter((c) => c.inEval).length} in eval, ` +
      `${calls.filter((c) => c.picker === "main").length} main / ${calls.filter((c) => c.picker === "more").length} more), ` +
      `featured: ${featured[0]?.callId ?? "none"}; ${changed.length} file(s) ${o.check ? "stale" : "changed"}`,
  );
  return { calls, scenarios: plan.scenarios, warnings, changed };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    "calls-dir": "string",
    "scenarios-dir": "string",
    out: "string",
    "data-root": "string",
    featured: "string",
    check: "boolean",
  });
  const paths = resolvePaths({ callsDir: str(f["calls-dir"]), scenariosDir: str(f["scenarios-dir"]), outRoot: str(f.out), dataRoot: str(f["data-root"]) });
  console.log(`inputs: calls=${paths.callsDir} scenarios=${paths.scenariosDir}\noutputs: ${paths.outRoot} (data: ${paths.dataRoot})`);
  const r = buildCalls(paths, { ...(str(f.featured) ? { featuredScenarioId: str(f.featured)! } : {}), check: f.check === true, log: (l) => console.log(l) });
  for (const w of r.warnings) console.warn(`warn: ${w}`);
  for (const c of r.changed) console.log(`  ${f.check ? "stale" : "wrote"} ${c}`);
  if (f.check && r.changed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
