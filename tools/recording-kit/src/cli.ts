/**
 * cli.ts - Baton Day-1 recording kit.
 *
 *   kit check                      read-only health check (auth, balance, number, geo permissions, files)
 *   kit scenarios                  validate data/scenarios/*.json and list them
 *   kit cards [--only s01,s02]     regenerate docs/role-cards.md + docs/role-cards.html
 *   kit call --scenario s01 ...    place ONE recorded role-play call (asks for confirmation) / --dry-run
 *   kit list [--limit 20]          recent recordings on the Twilio account (read-only)
 *   kit fetch <CallSid|RecSid>     (re)download a recording, split it, write the sidecar
 *   kit split <name> [--channel-map customer,rep]   re-split a downloaded file locally
 *   kit mark <name> --keep|--discard [--note ..] [--override f=v] [--status f=S]
 *   kit report                     summary of every take + data/calls/manifest.json
 *   kit hangup <CallSid>           emergency hang-up of one of your calls
 *   kit selftest                   offline tests (no network)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { renderCardsHtml, renderCardsMarkdown } from "./cards.ts";
import { loadTwilioEnv, maskSecret, redact, requireTwilioEnv } from "./env.ts";
import { type ResolvedParticipant, loadParticipantsFile, resolveParticipant } from "./participants.ts";
import { DOCS_DIR, MANIFEST_PATH, PARTICIPANTS_PATH, RAW_DIR, repoRel } from "./paths.ts";
import { checkDialable, estimateCost, maskPhone, RATES_USD } from "./phone.ts";
import {
  type FactField, type LoadedScenario, type Status, FACT_FIELDS, STATUSES,
  findScenario, loadAllScenarios, parseFactValue, validateAll, validateScenario,
} from "./scenarios.ts";
import {
  type ChannelMap, type Role, type Sidecar, channelMapFor, consentSummary, listSidecars, newSidecar, nextTake,
  parseChannelMap, rawWavPath, readSidecar, resolveBase, splitRecording, toSidecarParticipant, writeSidecar,
} from "./sidecar.ts";
import { runSelftest } from "./selftest.ts";
import {
  type CallResource, type RecordingResource, TERMINAL_CALL_STATUSES, TwilioClient, isCallSid, isRecordingSid,
} from "./twilio.ts";
import {
  MAX_TIME_LIMIT_S, MIN_TIME_LIMIT_S, PARENT_EXTRA_S, PARENT_RING_TIMEOUT_S, TWIML_MAX_CHARS, buildTwiml, prettyTwiml,
} from "./twiml.ts";
import { compactUtc, errMsg, fmtDuration, localStamp, sleep, table } from "./util.ts";

const HELP = `Baton recording kit - record role-play calls as dual-channel WAVs

Usage (from tools/recording-kit):  .\\kit <command> [options]     (Windows PowerShell / cmd)
                                   ./kit.sh <command> [options]   (Git Bash / macOS / Linux)

Commands
  check                         Read-only health check: .env, Twilio auth, balance, your number,
                                India/US geo permissions, participants.json, scenario files.
  scenarios                     Validate data/scenarios/*.json and print the scenario table.
  cards [--only s01,s02]        Regenerate docs/role-cards.md and docs/role-cards.html.
  call --scenario sNN           Place ONE recorded role-play call. Always asks you to type "call" first.
       [--rep KEY|+E164]          who plays the rep (participants.json key or a +E.164 number)
       [--customer KEY|+E164]     who plays the customer
       [--dial-first rep|customer]  who Twilio rings first = recording channel 1 (default: rep)
       [--time-limit 300]         hard cap on the conversation in seconds (60-300)
       [--dry-run]                validate everything and print the TwiML; no network, no call
       [--consent-confirmed]      required when you pass raw numbers instead of participants.json keys
       [--show-numbers]           print full numbers in the dry-run TwiML (masked by default)
       [--note "text"]            store a note in the sidecar
  list [--limit 20]             Recent recordings on the account (read-only).
  fetch <CallSid|RecordingSid>  (Re)download a recording, split it, write the sidecar.
       [--scenario sNN] [--channel-map rep,customer] [--rep KEY] [--customer KEY]
  split <name> [--channel-map customer,rep]
                                Re-split an already downloaded file (no network), e.g. if channels were swapped.
  mark <name> [--keep|--discard] [--note "text"] [--override field=value] [--status field=STATUS]
                                Review a take: keep/discard it and record what was actually said.
  report                        Table of every take per scenario; writes data/calls/manifest.json.
  hangup <CallSid>              Hang up one of your calls right now.
  selftest                      Offline self-test (WAV split, TwiML, validation). No network.

Files
  audio + sidecars   data/calls/raw/<scenario>_<utc>.wav|.json   (git-ignored, private)
  per-role WAVs      data/calls/split/<scenario>_<utc>_rep.wav / _customer.wav  (8 kHz mono PCM16)
  phone numbers      tools/recording-kit/participants.json   (git-ignored; copy participants.example.json)
  guide              docs/recording-day.md
`;

// ------------------------------------------------------------------------------------------ helpers

const ok = (m: string) => console.log(`[ok]   ${m}`);
const warnLine = (m: string) => console.log(`[warn] ${m}`);

async function confirmTyped(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  rl.on("SIGINT", () => ac.abort());
  try {
    const answer = await rl.question(question, { signal: ac.signal });
    return answer.trim().toLowerCase() === expected;
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function describeParticipant(p: ResolvedParticipant): string {
  const scope = p.consent.source === "cli-flag" ? (p.consent.recording ? "confirmed via flag" : "NOT confirmed") : `${p.consent.recording ? "yes" : "NO"}, scope ${p.consent.scope}`;
  return `${p.displayName.padEnd(14)} ${maskPhone(p.phone).padEnd(18)} consent: ${scope}`;
}

function pickRecording(recs: RecordingResource[]): RecordingResource | null {
  const done = recs.filter((r) => r.status === "completed");
  done.sort((a, b) => b.channels - a.channels || Number(b.duration ?? 0) - Number(a.duration ?? 0));
  return done[0] ?? null;
}

function num(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fillCallFields(sc: Sidecar, call: CallResource, children: CallResource[]): void {
  sc.twilio.call_status = call.status;
  sc.twilio.call_duration_s = num(call.duration);
  sc.twilio.call_start = call.start_time;
  sc.twilio.call_end = call.end_time;
  sc.twilio.child_calls = children.map((c) => ({ sid: c.sid, status: c.status, duration_s: num(c.duration) }));
}

async function downloadAndSplit(tw: TwilioClient, sc: Sidecar, rec: RecordingResource): Promise<void> {
  console.log(`Downloading ${rec.sid} (${rec.channels} channel${rec.channels === 1 ? "" : "s"}, ${rec.duration ?? "?"} s) ...`);
  const bytes = await tw.downloadRecordingWav(rec.sid, 2);
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(rawWavPath(sc.base), bytes);
  sc.twilio.recording_sid = rec.sid;
  sc.twilio.recording_status = rec.status;
  sc.twilio.recording_duration_s = num(rec.duration);
  sc.twilio.recording_channels = rec.channels;
  sc.twilio.recording_source = rec.source;
  sc.twilio.recording_start = rec.start_time;
  try {
    splitRecording(sc, bytes);
  } catch (e) {
    sc.review.notes.push(`split failed: ${errMsg(e)}`);
    writeSidecar(sc);
    throw new Error(`downloaded ${repoRel(rawWavPath(sc.base))} but could not split it: ${errMsg(e)}`);
  }
  writeSidecar(sc);
}

function printSummary(sc: Sidecar): void {
  if (!sc.files || !sc.audio) return;
  const a = sc.audio;
  console.log(`\nSaved (private, git-ignored):`);
  console.log(`  stereo    ${sc.files.stereo}   (${fmtDuration(a.duration_s)}, ${a.source_channels} ch, ${a.source_sample_rate} Hz ${a.source_format})`);
  console.log(`  rep       ${sc.files.rep}`);
  console.log(`  customer  ${sc.files.customer}`);
  console.log(`  sidecar   ${repoRel(resolve(RAW_DIR, `${sc.base}.json`))}`);
  console.log(`  channel map: channel 1 = ${sc.channel_map["1"]}, channel 2 = ${sc.channel_map["2"]}`);
  console.log(`\nLevels:`);
  for (const role of ["rep", "customer"] as const) {
    const c = a.channels[role];
    console.log(`  ${role.padEnd(9)} avg ${String(c.rms_dbfs).padStart(6)} dBFS, peak ${String(c.peak_dbfs).padStart(6)} dBFS, speech ${String(Math.round(c.active_ratio * 100)).padStart(3)}%, first sound at ${c.first_active_s ?? "-"} s`);
  }
  console.log(`  both talking at once: ${Math.round(a.overlap_ratio * 100)}% of talk time`);
  if (a.warnings.length) {
    console.log(`\nWarnings:`);
    for (const w of a.warnings) console.log(`  - ${w}`);
  } else console.log(`\nNo audio warnings.`);
  console.log(`\nNext: listen to both split files. Good take ->  .\\kit mark ${sc.base} --keep`);
  console.log(`      Bad take -> .\\kit mark ${sc.base} --discard --note "why"   and record the scenario again.`);
}

// ------------------------------------------------------------------------------------------ commands

async function cmdCheck(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, allowPositionals: false });
  let problems = 0;
  const fail = (m: string) => {
    console.log(`[FAIL] ${m}`);
    problems++;
  };
  console.log("Recording kit check (read-only: nothing is dialed, nothing is changed)\n");

  const envc = loadTwilioEnv();
  envc.problems.forEach(fail);
  envc.warnings.forEach(warnLine);
  if (envc.env) {
    const env = envc.env;
    ok(`.env has TWILIO_ACCOUNT_SID (${maskSecret(env.accountSid)}), TWILIO_AUTH_TOKEN (hidden), TWILIO_PHONE_NUMBER (${maskPhone(env.phoneNumber)})`);
    const tw = new TwilioClient(env);
    try {
      const a = await tw.getAccount();
      if (a.status === "active") ok(`Twilio auth works; account status "${a.status}", type "${a.type}"`);
      else fail(`account status is "${a.status}" (needs "active")`);
      if (a.type === "Trial") warnLine("trial account: Twilio adds a spoken trial message and only dials verified numbers");
    } catch (e) {
      fail(`auth / account lookup failed: ${errMsg(e)}`);
    }
    try {
      const b = await tw.getBalance();
      const bal = Number(b.balance);
      const perCall = estimateCost("+919000000000", "+919000000000", 150, 20).usd;
      const line = `balance ${bal.toFixed(2)} ${b.currency} = roughly ${Math.floor(bal / perCall)} role-play calls of ~2.5 min (~$${perCall.toFixed(2)} each)`;
      if (bal >= 3) ok(line);
      else warnLine(line);
    } catch (e) {
      warnLine(`balance lookup failed: ${errMsg(e)}`);
    }
    try {
      const n = await tw.findIncomingNumber(env.phoneNumber);
      if (!n) fail("TWILIO_PHONE_NUMBER is not one of this account's numbers");
      else if (n.capabilities?.voice) ok("TWILIO_PHONE_NUMBER belongs to this account and is voice-capable");
      else fail("TWILIO_PHONE_NUMBER is on the account but not voice-capable");
    } catch (e) {
      warnLine(`number lookup failed: ${errMsg(e)}`);
    }
    for (const iso of ["IN", "US"]) {
      try {
        const p = await tw.getDialingPermission(iso);
        const line = `geo permission ${p.name}: low-risk numbers ${p.low_risk_numbers_enabled ? "ENABLED" : "disabled"}, high-risk special ${p.high_risk_special_numbers_enabled ? "enabled" : "disabled"}`;
        if (p.low_risk_numbers_enabled) ok(line);
        else if (iso === "IN") fail(`${line} - enable India in Console > Voice > Settings > Geo permissions`);
        else warnLine(line);
      } catch (e) {
        warnLine(`could not read ${iso} geo permissions (${errMsg(e)}); check Console > Voice > Settings > Geo permissions`);
      }
    }
    try {
      const live = [...(await tw.listCalls({ status: "in-progress", pageSize: 5 })), ...(await tw.listCalls({ status: "ringing", pageSize: 5 }))];
      if (live.length) warnLine(`${live.length} call(s) ringing/in progress right now: ${live.map((c) => c.sid).join(", ")}`);
      else ok("no calls ringing or in progress");
    } catch (e) {
      warnLine(`call list failed: ${errMsg(e)}`);
    }
    try {
      const recs = await tw.listRecordings(5);
      ok(`recordings API reachable (${recs.length} most recent shown by "kit list")`);
    } catch (e) {
      fail(`recordings list failed: ${errMsg(e)}`);
    }
  }

  const pf = loadParticipantsFile();
  if (!existsSync(PARTICIPANTS_PATH)) warnLine("participants.json not found - copy participants.example.json and fill in real numbers (or pass +numbers with --consent-confirmed)");
  pf.problems.forEach(fail);
  if (pf.file) {
    for (const [key, p] of Object.entries(pf.file.participants)) {
      const c = checkDialable(p.phone.replace(/[\s\-().]/g, ""), { allowIntl: false, realCall: true, label: `participant ${key}` });
      c.errors.forEach(fail);
      c.warnings.forEach(warnLine);
      if (c.ok) {
        const line = `participant ${key} (${p.name}) ${maskPhone(p.phone)}: consent ${p.consent.recording ? "yes" : "NO"}, scope ${p.consent.scope}${p.speaks_hindi ? ", speaks Hindi" : ""}`;
        if (p.consent.recording) ok(line);
        else warnLine(`${line} - cannot be dialed until consent.recording is true`);
      }
    }
  }

  try {
    const all = loadAllScenarios();
    const v = validateAll(all);
    let errs = 0;
    for (const [base, r] of v.perFile) for (const e of r.errors) {
      fail(`${base}: ${e}`);
      errs++;
    }
    v.setErrors.forEach((e) => {
      fail(e);
      errs++;
    });
    if (!errs) ok(`${all.length} scenarios valid (${all.filter((l) => l.scenario.language === "hinglish").length} Hinglish)`);
  } catch (e) {
    fail(`scenario load failed: ${errMsg(e)}`);
  }

  console.log(problems ? `\n${problems} problem(s) to fix before recording.` : `\nAll checks passed. Next:  .\\kit call --scenario s01 --dry-run`);
  return problems ? 1 : 0;
}

function cmdScenarios(args: string[]): number {
  parseArgs({ args, options: {}, allowPositionals: false });
  const all = loadAllScenarios();
  const v = validateAll(all);
  const rows = all.map(({ scenario: s }) => [
    s.id,
    s.title.length > 58 ? `${s.title.slice(0, 57)}...` : s.title,
    s.language,
    `${s.target_duration_s.min}-${s.target_duration_s.max}s`,
    `b${s.handoff.at_beat} ~${s.handoff.approx_at_s}s ${s.handoff.customer_response}`,
    `${s.casting.customer}${s.casting.hindi_needed ? "+hi" : ""}`,
  ]);
  console.log(table(["id", "title", "lang", "length", "hand-off", "customer"], rows));
  let errors = 0;
  for (const [base, r] of v.perFile) {
    for (const e of r.errors) {
      console.log(`[FAIL] ${base}: ${e}`);
      errors++;
    }
    for (const w of r.warnings) console.log(`[warn] ${base}: ${w}`);
  }
  for (const e of v.setErrors) {
    console.log(`[FAIL] ${e}`);
    errors++;
  }
  console.log(errors ? `\n${errors} validation error(s).` : `\n${all.length} scenarios valid.`);
  return errors ? 1 : 0;
}

function cmdCards(args: string[]): number {
  const { values } = parseArgs({ args, options: { only: { type: "string" } }, allowPositionals: false });
  let all = loadAllScenarios();
  const v = validateAll(all);
  const errs = [...v.setErrors, ...[...v.perFile].flatMap(([b, r]) => r.errors.map((e) => `${b}: ${e}`))];
  if (errs.length) throw new Error(`fix scenario errors first (kit scenarios):\n  - ${errs.join("\n  - ")}`);
  if (values.only) {
    const want = new Set(values.only.split(",").map((x) => x.trim().toLowerCase()));
    all = all.filter((l) => want.has(l.scenario.id));
  }
  mkdirSync(DOCS_DIR, { recursive: true });
  const md = resolve(DOCS_DIR, "role-cards.md");
  const html = resolve(DOCS_DIR, "role-cards.html");
  writeFileSync(md, renderCardsMarkdown(all));
  writeFileSync(html, renderCardsHtml(all));
  console.log(`Wrote ${repoRel(md)} and ${repoRel(html)} (${all.length} scenarios, ${all.length * 2} cards).`);
  console.log(`Print: open the .html in a browser and press Ctrl+P (each card starts on a new page).`);
  return 0;
}

async function cmdCall(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      scenario: { type: "string", short: "s" },
      rep: { type: "string" },
      customer: { type: "string" },
      "dial-first": { type: "string", default: "rep" },
      "time-limit": { type: "string", default: String(MAX_TIME_LIMIT_S) },
      "dry-run": { type: "boolean", default: false },
      "consent-confirmed": { type: "boolean", default: false },
      "show-numbers": { type: "boolean", default: false },
      "allow-intl": { type: "boolean", default: false },
      note: { type: "string" },
    },
  });
  const dry = values["dry-run"] === true;
  if (!values.scenario) throw new Error("--scenario is required (e.g. --scenario s01)");
  const loaded = findScenario(values.scenario);
  const s = loaded.scenario;
  const sv = validateScenario(s, s.id);
  if (sv.errors.length) throw new Error(`scenario ${s.id} is invalid (kit scenarios):\n  - ${sv.errors.join("\n  - ")}`);

  const dialFirst = values["dial-first"];
  if (dialFirst !== "rep" && dialFirst !== "customer") throw new Error('--dial-first must be "rep" or "customer"');
  const timeLimit = Number(values["time-limit"]);
  if (!Number.isInteger(timeLimit) || timeLimit < MIN_TIME_LIMIT_S || timeLimit > MAX_TIME_LIMIT_S) {
    throw new Error(`--time-limit must be a whole number of seconds from ${MIN_TIME_LIMIT_S} to ${MAX_TIME_LIMIT_S} (hard cap)`);
  }

  console.log(dry ? "DRY RUN (no network, no call)\n" : "Preparing a REAL recorded call\n");
  const envc = loadTwilioEnv();
  if (!envc.env) {
    envc.problems.forEach((p) => console.log(`[FAIL] ${p}`));
    return 1;
  }
  const env = envc.env;
  ok(`.env Twilio settings look valid (SID ${maskSecret(env.accountSid)}, token hidden, from ${maskPhone(env.phoneNumber)})`);

  const pf = loadParticipantsFile();
  if (pf.problems.length) throw new Error(`participants.json problems:\n  - ${pf.problems.join("\n  - ")}`);
  const consentFlag = values["consent-confirmed"] === true;
  const rep = resolveParticipant("rep", values.rep, pf.file, consentFlag);
  const customer = resolveParticipant("customer", values.customer, pf.file, consentFlag);
  const partyA = dialFirst === "rep" ? rep : customer;
  const partyB = dialFirst === "rep" ? customer : rep;
  const channelMap: ChannelMap = channelMapFor(dialFirst);

  const errors: string[] = [];
  const warnings: string[] = [...envc.warnings, ...sv.warnings.map((w) => `scenario: ${w}`)];
  for (const p of [rep, customer]) {
    const c = checkDialable(p.phone, { allowIntl: values["allow-intl"] === true, realCall: !dry, label: `${p.role} (${p.displayName})` });
    errors.push(...c.errors);
    warnings.push(...c.warnings);
    if (p.phone === env.phoneNumber) errors.push(`${p.role} number is your own Twilio number`);
    if (!p.consent.recording) {
      errors.push(
        p.consent.source === "cli-flag"
          ? `${p.role}: raw number given - add --consent-confirmed once both people agreed to be recorded`
          : `${p.role} (${p.displayName}): consent.recording is false in participants.json - get their consent first (docs/recording-day.md, "Consent")`,
      );
    }
  }
  if (rep.phone === customer.phone) errors.push("rep and customer have the same phone number");
  if (s.casting.hindi_needed && pf.file) {
    const needs: ResolvedParticipant[] = s.tags.includes("bilingual_rep") ? [rep, customer] : [customer];
    for (const p of needs) if (p.key !== "cli" && pf.file.participants[p.key]?.speaks_hindi === false) warnings.push(`${s.id} is Hinglish but ${p.displayName} is marked speaks_hindi: false`);
  }

  const twiml = buildTwiml({ partyB: partyB.phone, callerId: env.phoneNumber, timeLimitS: timeLimit });
  const shown = values["show-numbers"] ? twiml : twiml.split(partyB.phone).join(maskPhone(partyB.phone)).split(env.phoneNumber).join(maskPhone(env.phoneNumber));
  const typical = estimateCost(partyA.phone, partyB.phone, s.target_duration_s.max, 20);
  const worst = estimateCost(partyA.phone, partyB.phone, timeLimit, PARENT_EXTRA_S);

  console.log(`\nScenario   ${s.id} - ${s.title}`);
  console.log(`           ${s.language}, aim for ${s.target_duration_s.min}-${s.target_duration_s.max} s, hand-off ~${s.handoff.approx_at_s} s (${s.handoff.customer_response})`);
  console.log(`Channel 1  (dialed first)  ${partyA.role.padEnd(8)} ${describeParticipant(partyA)}`);
  console.log(`Channel 2  (bridged in)    ${partyB.role.padEnd(8)} ${describeParticipant(partyB)}`);
  console.log(`From       ${maskPhone(env.phoneNumber)} (your Twilio number)`);
  console.log(`Caps       conversation ${timeLimit} s (Dial timeLimit) · whole call ${timeLimit + PARENT_EXTRA_S} s · each phone rings max ${PARENT_RING_TIMEOUT_S} s`);
  console.log(`Cost       typical ~$${typical.usd.toFixed(2)} (${typical.parentMin}+${typical.childMin} billed min + recording) · worst case at the cap ~$${worst.usd.toFixed(2)}${typical.verified ? "" : "  [a non-India rate is approximate]"}`);
  console.log(`           rates: India mobile $${RATES_USD.IN_mobile_per_min}/min per leg, recording $${RATES_USD.recording_per_min}/min (research/15 §3)`);
  console.log(`\nTwiML sent inline with the call (${twiml.length}/${TWIML_MAX_CHARS} chars${values["show-numbers"] ? "" : ", numbers masked here"}):\n${prettyTwiml(shown)}\n`);
  for (const w of warnings) warnLine(w);
  if (errors.length) {
    for (const e of errors) console.log(`[FAIL] ${e}`);
    console.log(`\n${errors.length} problem(s) - no call placed.`);
    return 1;
  }
  if (dry) {
    console.log("DRY RUN OK - no call placed, no API request made.");
    console.log(`To record for real, run the same command without --dry-run.`);
    return 0;
  }

  // ---------------------------------------------------------------- real call
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("refusing to dial without an interactive terminal: the confirmation prompt needs a human. Run this in your own terminal.");
  }
  const tw = new TwilioClient(env);
  const account = await tw.getAccount();
  if (account.status !== "active") throw new Error(`Twilio account is "${account.status}", not active`);
  try {
    const b = await tw.getBalance();
    const bal = Number(b.balance);
    const need = worst.usd + 0.5;
    console.log(`Balance    ${bal.toFixed(2)} ${b.currency}`);
    if (Number.isFinite(bal) && bal < need) throw new Error(`balance ${bal.toFixed(2)} is below the safety floor of ${need.toFixed(2)} (worst-case call + $0.50). Top up first.`);
  } catch (e) {
    if (errMsg(e).includes("safety floor")) throw e;
    warnLine(`could not read the balance (${errMsg(e)}); continuing only if you confirm`);
  }
  const live = [...(await tw.listCalls({ status: "in-progress", from: env.phoneNumber, pageSize: 5 })), ...(await tw.listCalls({ status: "ringing", from: env.phoneNumber, pageSize: 5 }))];
  if (live.length) throw new Error(`another call from your number is still active (${live.map((c) => c.sid).join(", ")}). Wait for it to end or run: .\\kit hangup <CallSid>`);

  console.log(`\nWhat happens: ${partyA.displayName}'s phone rings first (+1 number, may show "International Call").`);
  console.log(`They hear a short recording notice, then ${partyB.displayName}'s phone rings. Once both are connected,`);
  console.log(`the rep opens the call. Hang up either phone to finish. Ctrl+C here hangs up the call.\n`);
  const go = await confirmTyped(`Type "call" to dial ${partyA.displayName} now (anything else cancels): `, "call");
  if (!go) {
    console.log("Cancelled - no call placed.");
    return 1;
  }

  const base = `${s.id}_${compactUtc()}`;
  const take = nextTake(s.id);
  const call = await tw.createCall({ to: partyA.phone, twiml, timeoutS: PARENT_RING_TIMEOUT_S, timeLimitS: timeLimit + PARENT_EXTRA_S });
  console.log(`\nCall placed. CallSid ${call.sid}  (take ${take}, files will be named ${base}.*)`);
  const sc = newSidecar({
    base,
    scenario: loaded,
    take,
    dialedFirst: dialFirst,
    channelMap,
    participants: { rep: toSidecarParticipant(rep), customer: toSidecarParticipant(customer) },
    callSid: call.sid,
    fromMasked: maskPhone(env.phoneNumber),
    timeLimitS: timeLimit,
  });
  if (values.note) sc.review.notes.push(values.note);
  writeSidecar(sc);

  const final = await waitForCall(tw, call.sid, partyA.displayName, partyB.displayName, timeLimit);
  const children = await tw.listChildCalls(call.sid);
  fillCallFields(sc, final, children);
  const answered = children.some((c) => c.status === "completed" || c.status === "in-progress");
  if (final.status !== "completed" || !answered) {
    sc.state = "call_ended_no_recording";
    writeSidecar(sc);
    const why =
      final.status !== "completed"
        ? `${partyA.displayName}'s leg ended as "${final.status}"`
        : `${partyB.displayName}'s phone ${children[0] ? `ended as "${children[0].status}"` : "was never reached"}`;
    console.log(`\nNo conversation was recorded: ${why}. Nothing to download (you were billed only for connected time).`);
    console.log(`Tips: busy/no-answer -> check the person is ready; failed -> run .\\kit check (geo permissions, error 13227/21215 in the Console debugger).`);
    return 2;
  }
  console.log(`\nCall finished (${fmtDuration(num(final.duration))} on ${partyA.displayName}'s leg). Waiting for Twilio to publish the recording...`);
  const rec = await waitForRecording(tw, call.sid);
  if (!rec) {
    sc.state = "call_ended_no_recording";
    writeSidecar(sc);
    console.log(`No completed recording is attached to ${call.sid}. Try later:  .\\kit fetch ${call.sid}`);
    return 2;
  }
  await downloadAndSplit(tw, sc, rec);
  printSummary(sc);
  return 0;
}

async function waitForCall(tw: TwilioClient, sid: string, aName: string, bName: string, timeLimitS: number): Promise<CallResource> {
  const t0 = Date.now();
  const elapsed = () => fmtDuration((Date.now() - t0) / 1000);
  let status = "";
  let hangupSent = false;
  const childStatus = new Map<string, string>();
  const onSigint = () => {
    if (hangupSent) {
      console.log(`\nSecond Ctrl+C: exiting without waiting. Later run:  .\\kit fetch ${sid}`);
      process.exit(130);
    }
    hangupSent = true;
    console.log("\nCtrl+C: hanging up the call (press Ctrl+C again to quit without waiting)...");
    const target = status === "in-progress" ? "completed" : "canceled";
    tw.updateCallStatus(sid, target).then(
      () => console.log("Hang-up request accepted."),
      (e: unknown) => console.log(`Hang-up request failed: ${errMsg(e)} - hang up on the phone, or run: .\\kit hangup ${sid}`),
    );
  };
  process.on("SIGINT", onSigint);
  const hints: Record<string, string> = {
    queued: "Twilio is about to ring the first phone",
    ringing: `${aName}'s phone is ringing - answer it`,
    "in-progress": `${aName} answered: recording notice, then ${bName}'s phone rings`,
  };
  try {
    const deadline = t0 + (timeLimitS + PARENT_EXTRA_S + 120) * 1000;
    let polls = 0;
    let lastBeat = Date.now();
    for (;;) {
      const call = await tw.getCall(sid);
      if (call.status !== status) {
        status = call.status;
        console.log(`[${elapsed()}] call ${status}${hints[status] ? ` - ${hints[status]}` : ""}`);
      }
      if (TERMINAL_CALL_STATUSES.has(call.status)) return call;
      if (call.status === "in-progress" && polls % 2 === 0) {
        for (const c of await tw.listChildCalls(sid)) {
          if (childStatus.get(c.sid) !== c.status) {
            childStatus.set(c.sid, c.status);
            const msg =
              c.status === "ringing" ? `${bName}'s phone is ringing` :
              c.status === "in-progress" ? "BOTH CONNECTED - recording now. Rep, start the call! (hang up either phone to finish)" :
              `${bName}'s leg: ${c.status}`;
            console.log(`[${elapsed()}] ${msg}`);
          }
        }
      }
      if (Date.now() - lastBeat > 30_000 && [...childStatus.values()].includes("in-progress")) {
        console.log(`[${elapsed()}] ...still recording (cap ${fmtDuration(timeLimitS)})`);
        lastBeat = Date.now();
      }
      if (Date.now() > deadline) throw new Error(`call ${sid} is still "${call.status}" past the safety window - check the Twilio Console, then run .\\kit fetch ${sid}`);
      polls++;
      await sleep(2500);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function waitForRecording(tw: TwilioClient, callSid: string): Promise<RecordingResource | null> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 240_000) {
    const recs = await tw.listCallRecordings(callSid);
    const best = pickRecording(recs);
    if (best) return best;
    if (recs.length && recs.every((r) => r.status === "absent" || r.status === "deleted")) return null;
    if (!recs.length && Date.now() - t0 > 60_000) return null;
    const msg = recs.length ? `recording ${recs[0]!.sid} is "${recs[0]!.status}"` : "no recording listed yet";
    if (msg !== last) {
      console.log(`  ${msg}...`);
      last = msg;
    }
    await sleep(3000);
  }
  throw new Error(`the recording was not ready after 4 minutes - try again later:  .\\kit fetch ${callSid}`);
}

async function cmdList(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { limit: { type: "string", default: "20" } }, allowPositionals: false });
  const limit = Math.min(100, Math.max(1, Number(values.limit) || 20));
  const tw = new TwilioClient(requireTwilioEnv());
  const recs = await tw.listRecordings(limit);
  const local = listSidecars();
  const byRec = new Map(local.filter((s) => s.twilio.recording_sid).map((s) => [s.twilio.recording_sid!, s.base]));
  const byCall = new Map(local.map((s) => [s.twilio.call_sid, s.base]));
  if (!recs.length) {
    console.log("No recordings on this Twilio account yet.");
    return 0;
  }
  const rows = recs.map((r) => [
    localStamp(r.start_time ?? r.date_created),
    r.sid,
    r.call_sid,
    fmtDuration(num(r.duration)),
    String(r.channels),
    r.status,
    r.source,
    byRec.get(r.sid) ?? byCall.get(r.call_sid) ?? "-",
  ]);
  console.log(table(["started (local)", "recording sid", "call sid", "dur", "ch", "status", "source", "local file"], rows));
  console.log(`\n${recs.length} recording(s). Download one with:  .\\kit fetch <call sid> --scenario sNN`);
  return 0;
}

async function cmdFetch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scenario: { type: "string" },
      "channel-map": { type: "string" },
      rep: { type: "string" },
      customer: { type: "string" },
    },
  });
  const ref = positionals[0];
  if (!ref) throw new Error("usage: kit fetch <CallSid|RecordingSid> [--scenario sNN] [--channel-map rep,customer]");
  const tw = new TwilioClient(requireTwilioEnv());
  let rec: RecordingResource | null = null;
  let callSid: string;
  if (isRecordingSid(ref)) {
    rec = await tw.getRecording(ref);
    callSid = rec.call_sid;
  } else if (isCallSid(ref)) callSid = ref;
  else throw new Error(`"${ref}" is not a CallSid (CA + 32 hex) or RecordingSid (RE + 32 hex)`);

  const call = await tw.getCall(callSid);
  if (call.parent_call_sid) {
    console.log(`${callSid} is a child leg; using its parent ${call.parent_call_sid} (recordings live on the parent).`);
    callSid = call.parent_call_sid;
  }
  const parent = callSid === call.sid ? call : await tw.getCall(callSid);
  let sc = listSidecars().find((x) => x.twilio.call_sid === callSid) ?? null;
  if (sc) {
    console.log(`Found existing sidecar ${sc.base}; re-downloading into it.`);
    if (values["channel-map"]) sc.channel_map = parseChannelMap(values["channel-map"]);
    if (values.scenario && sc.scenario?.id !== findScenario(values.scenario).scenario.id) {
      console.log(`[warn] keeping the sidecar's scenario ${sc.scenario?.id ?? "unknown"}; --scenario ignored for an existing take`);
    }
  } else {
    const loaded: LoadedScenario | null = values.scenario ? findScenario(values.scenario) : null;
    if (!loaded) console.log("[warn] no --scenario given; the take is filed as 'unknown' (pass --scenario sNN to link it)");
    const pf = loadParticipantsFile();
    const participants: Partial<Record<Role, ReturnType<typeof toSidecarParticipant>>> = {};
    if (values.rep) participants.rep = toSidecarParticipant(resolveParticipant("rep", values.rep, pf.file, false));
    if (values.customer) participants.customer = toSidecarParticipant(resolveParticipant("customer", values.customer, pf.file, false));
    const cmap = values["channel-map"] ? parseChannelMap(values["channel-map"]) : channelMapFor("rep");
    const started = parent.start_time ? new Date(parent.start_time) : new Date();
    const sid = loaded?.scenario.id ?? "unknown";
    sc = newSidecar({
      base: `${sid}_${compactUtc(started)}`,
      scenario: loaded,
      take: nextTake(sid),
      dialedFirst: cmap["1"],
      channelMap: cmap,
      participants,
      callSid,
      fromMasked: maskPhone(parent.from),
      timeLimitS: null,
    });
    if (!values["channel-map"]) sc.review.notes.push("channel map assumed rep,customer (default: rep dialed first)");
  }
  fillCallFields(sc, parent, await tw.listChildCalls(callSid));
  if (!rec || rec.call_sid !== callSid) rec = pickRecording(await tw.listCallRecordings(callSid));
  if (!rec) {
    writeSidecar(sc);
    throw new Error(`no completed recording is attached to ${callSid}`);
  }
  await downloadAndSplit(tw, sc, rec);
  printSummary(sc);
  return 0;
}

function cmdSplit(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "channel-map": { type: "string" } } });
  const ref = positionals[0];
  if (!ref) throw new Error("usage: kit split <name|path.wav> [--channel-map customer,rep]");
  const base = resolveBase(ref);
  const raw = rawWavPath(base);
  if (!existsSync(raw)) throw new Error(`${repoRel(raw)} not found (download it first with kit fetch)`);
  let sc = readSidecar(base);
  if (!sc) {
    const cmap = values["channel-map"] ? parseChannelMap(values["channel-map"]) : channelMapFor("rep");
    sc = newSidecar({ base, scenario: null, take: 1, dialedFirst: cmap["1"], channelMap: cmap, participants: {}, callSid: "unknown", fromMasked: "unknown", timeLimitS: null });
    sc.review.notes.push("sidecar created by kit split (no call metadata)");
  } else if (values["channel-map"]) {
    const next = parseChannelMap(values["channel-map"]);
    if (next["1"] !== sc.channel_map["1"]) sc.review.notes.push(`channel map changed to ${next["1"]},${next["2"]} by kit split on ${new Date().toISOString()}`);
    sc.channel_map = next;
  }
  splitRecording(sc, readFileSync(raw));
  writeSidecar(sc);
  printSummary(sc);
  return 0;
}

function cmdMark(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      keep: { type: "boolean", default: false },
      discard: { type: "boolean", default: false },
      note: { type: "string", multiple: true },
      override: { type: "string", multiple: true },
      status: { type: "string", multiple: true },
    },
  });
  const ref = positionals[0];
  if (!ref) throw new Error('usage: kit mark <name> [--keep|--discard] [--note "..."] [--override field=value] [--status field=STATUS]');
  if (values.keep && values.discard) throw new Error("choose --keep or --discard, not both");
  const base = resolveBase(ref);
  const sc = readSidecar(base);
  if (!sc) throw new Error(`no sidecar for ${base}`);
  if (values.keep) sc.review.status = "keep";
  if (values.discard) sc.review.status = "discard";
  for (const n of values.note ?? []) sc.review.notes.push(n);
  const splitKv = (kv: string): [FactField, string] => {
    const i = kv.indexOf("=");
    const k = kv.slice(0, i).trim();
    if (i < 1 || !(FACT_FIELDS as readonly string[]).includes(k)) throw new Error(`"${kv}": expected field=value with field one of ${FACT_FIELDS.join(", ")}`);
    return [k as FactField, kv.slice(i + 1).trim()];
  };
  for (const kv of values.override ?? []) {
    const [k, v] = splitKv(kv);
    sc.review.fact_overrides[k] = parseFactValue(k, v);
  }
  for (const kv of values.status ?? []) {
    const [k, v] = splitKv(kv);
    const st = v.toUpperCase();
    if (!(STATUSES as readonly string[]).includes(st)) throw new Error(`status for ${k} must be ${STATUSES.join("|")}`);
    sc.review.status_overrides[k] = st as Status;
  }
  if (sc.review.status === "keep") {
    for (const other of listSidecars()) {
      if (other.base !== sc.base && other.scenario?.id && other.scenario.id === sc.scenario?.id && other.review.status === "keep") {
        console.log(`[warn] ${other.base} is also marked keep for ${other.scenario.id}; the eval will use the newest kept take`);
      }
    }
  }
  writeSidecar(sc);
  console.log(`${base}: review status ${sc.review.status}`);
  if (sc.review.notes.length) console.log(`  notes: ${sc.review.notes.join(" | ")}`);
  if (Object.keys(sc.review.fact_overrides).length) console.log(`  fact overrides: ${JSON.stringify(sc.review.fact_overrides)}`);
  if (Object.keys(sc.review.status_overrides).length) console.log(`  status overrides: ${JSON.stringify(sc.review.status_overrides)}`);
  return 0;
}

function cmdReport(args: string[]): number {
  parseArgs({ args, options: {}, allowPositionals: false });
  const scenarios = loadAllScenarios();
  const sidecars = listSidecars();
  const rows: string[][] = [];
  const manifest: unknown[] = [];
  let recorded = 0;
  for (const { scenario: s } of scenarios) {
    const takes = sidecars.filter((x) => x.scenario?.id === s.id).sort((a, b) => a.take - b.take);
    const usable = takes.filter((t) => t.state === "downloaded" && t.review.status !== "discard");
    const chosen = [...usable].reverse().find((t) => t.review.status === "keep") ?? usable[usable.length - 1] ?? null;
    if (chosen) recorded++;
    rows.push([
      s.id,
      s.language,
      String(takes.length),
      String(takes.filter((t) => t.review.status === "keep").length),
      chosen ? chosen.base : "-",
      chosen?.audio ? fmtDuration(chosen.audio.duration_s) : "-",
      chosen ? (chosen.consent.publishable ? "public" : chosen.consent.all_recording_consent ? "private" : "unknown") : "-",
      chosen?.audio?.warnings.length ? String(chosen.audio.warnings.length) : chosen ? "0" : "-",
    ]);
    manifest.push({
      scenario_id: s.id,
      title: s.title,
      language: s.language,
      chosen_take: chosen?.base ?? null,
      takes: takes.map((t) => ({
        base: t.base,
        take: t.take,
        state: t.state,
        review: t.review.status,
        duration_s: t.audio?.duration_s ?? null,
        files: t.files ?? null,
        all_recording_consent: t.consent.all_recording_consent,
        publishable: t.consent.publishable,
        warnings: t.audio?.warnings ?? [],
        has_overrides: Object.keys(t.review.fact_overrides).length + Object.keys(t.review.status_overrides).length > 0,
      })),
    });
  }
  const orphans = sidecars.filter((x) => !x.scenario || !scenarios.some((l) => l.scenario.id === x.scenario!.id));
  console.log(table(["id", "lang", "takes", "kept", "chosen take", "dur", "consent", "warn"], rows));
  if (orphans.length) console.log(`\n${orphans.length} take(s) not linked to a scenario: ${orphans.map((o) => o.base).join(", ")}`);
  const missing = scenarios.filter((_, i) => rows[i]![4] === "-").map((l) => l.scenario.id);
  console.log(`\n${recorded}/${scenarios.length} scenarios have a usable take.${missing.length ? ` Still to record: ${missing.join(", ")}` : ""}`);
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(
    MANIFEST_PATH,
    JSON.stringify({ generated_at: new Date().toISOString(), recorded, total: scenarios.length, orphans: orphans.map((o) => o.base), scenarios: manifest }, null, 2) + "\n",
  );
  console.log(`Wrote ${repoRel(MANIFEST_PATH)}`);
  return 0;
}

async function cmdHangup(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const sid = positionals[0];
  if (!sid || !isCallSid(sid)) throw new Error("usage: kit hangup <CallSid>");
  const tw = new TwilioClient(requireTwilioEnv());
  const call = await tw.getCall(sid);
  if (TERMINAL_CALL_STATUSES.has(call.status)) {
    console.log(`${sid} already ended (${call.status}).`);
    return 0;
  }
  const r = await tw.updateCallStatus(sid, call.status === "in-progress" ? "completed" : "canceled");
  console.log(`${sid}: hang-up sent (status now ${r.status}).`);
  return 0;
}

// ------------------------------------------------------------------------------------------ main

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "check": return cmdCheck(rest);
    case "scenarios": return cmdScenarios(rest);
    case "cards": return cmdCards(rest);
    case "call": return cmdCall(rest);
    case "list": return cmdList(rest);
    case "fetch": return cmdFetch(rest);
    case "split": return cmdSplit(rest);
    case "mark": return cmdMark(rest);
    case "report": return cmdReport(rest);
    case "hangup": return cmdHangup(rest);
    case "selftest": return runSelftest();
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(redact(`\nERROR: ${errMsg(err)}`));
    process.exitCode = 1;
  },
);
