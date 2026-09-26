/**
 * WP7·3 acceptance (PLATFORM §7.6, TASKS-v2 WP7 acceptance 2, 3, 4), $0, server-rendered.
 *
 * 2. The flagship renders **byte-identically** whether the run carries the Baton `UiSpec` or no spec at all, in every
 *    s01 state. That is the whole safety claim of making the console spec-driven: Baton's pixels do not move.
 * 3. The Dental fixture — a second relay — renders its own fields, groups, stage labels and deposit phone from its
 *    `UiSpec`, and none of Baton's.
 * 4. The provenance strip is on **every** run, with the right four values for recorded, simulated, dry-run and
 *    cached-replay runs, and no stacked badge is left anywhere in the markup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FIXTURES, fixtureLog } from "@/client/fixtures";
import { DENTAL_UI_SPEC } from "@/client/fixtures/dental";
import { resolveAt } from "@/client/fixtures/player";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { initialUiState, replayLog } from "@/client/store/reduce";
import { narrator, passEstimate, phaseCopy, provenance, qaVerifiedCopy } from "@/client/store/selectors";
import { createConsoleStore } from "@/client/store/store";
import { agentNameOf, BATON_UI_SPEC, paySteps } from "@/client/store/ui-spec";
import { CallConsole } from "@/components/call/call-console";
import { RELAY_CONSOLE_INPUTS, RELAY_CONSOLE_MODES } from "@/components/call/relay-console";
import { ConsoleEnvProvider, type ConsoleEnv } from "@/components/common/console-context";
import type { UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { ProvenanceStrip } from "@/core/contracts/v2/api";
import type { UiSpec } from "@/core/contracts/v2/relay";

const S01_FIXTURES = FIXTURES.filter((f) => f.name.startsWith("s01"));

function stateAt(log: readonly UiLogEntry[], t: number) {
  return replayLog(log.filter((e) => e.t <= t), initialUiState());
}

function markup(log: readonly UiLogEntry[], t: number, env: Partial<ConsoleEnv> = {}): string {
  const store = createConsoleStore(stateAt(log, t));
  return renderToStaticMarkup(
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={{ fixture: "t", clockNow: () => t, ...env }}>
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>,
  );
}

/** The rendered page as a reader sees it: tags dropped, entities decoded (React escapes `'` as `&#x27;`). */
const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|\s+/g, " ");

/** The same log with the run's `UiSpec` replaced (null = "no spec": a fixture log or a pre-v2 server). */
const withSpec = (log: readonly UiLogEntry[], relay: UiSpec | null): UiLogEntry[] =>
  log.map((e) => ("type" in e && e.type === "ui.relay" ? { ...e, relay } : e));

/** A log whose `ui.relay` carries this provenance (the four segments the server states at case creation). */
const withProvenance = (log: readonly UiLogEntry[], p: ProvenanceStrip): UiLogEntry[] =>
  log.map((e) => ("type" in e && e.type === "ui.relay" ? { ...e, provenance: p } : e));

const RECORDED: ProvenanceStrip = {
  humanHalf: "recorded",
  transcription: { kind: "live", date: null },
  aiHalf: { kind: "live", date: null },
  customerInAiHalf: "synthetic",
  detail: null,
};

// ------------------------------------------------------------------------------------ acceptance 2

describe("acceptance 2: the flagship renders byte-identically with the Baton UiSpec and without one", () => {
  const cases = S01_FIXTURES.flatMap((f) => f.reaches.map((phase) => [f.name, phase] as const));

  it.each(cases)("%s at %s is byte-identical spec vs fallback", (name, phase) => {
    const log = fixtureLog(name) ?? [];
    const t = resolveAt(log, phase);
    expect(t).not.toBeNull();
    const spec = markup(withSpec(log, BATON_UI_SPEC), t as number);
    const fallback = markup(withSpec(log, null), t as number);
    expect(spec).toBe(fallback);
    expect(spec.length).toBeGreaterThan(2000);
  });

  it("the fallback is the flagship's spec, so 'no spec' is not a different relay", () => {
    const log = fixtureLog("s01-full") ?? [];
    const t = resolveAt(log, "shadowing:end") as number;
    const s = stateAt(withSpec(log, null), t);
    expect(agentNameOf(BATON_UI_SPEC)).toBe("Baton");
    expect(narrator(s).text).toContain("Baton is listening silently");
    expect(paySteps(BATON_UI_SPEC)).toMatchObject({ esign: true, payment: true, verb: "sign and pay" });
  });

  it("a different relay title in the spec does change the render (the comparison above is not vacuous)", () => {
    const log = fixtureLog("s01-full") ?? [];
    const t = resolveAt(log, "shadowing:end") as number;
    const renamed: UiSpec = { ...BATON_UI_SPEC, relay: { ...BATON_UI_SPEC.relay, title: "Roadside · tow request", flagship: false } };
    expect(markup(withSpec(log, renamed), t)).not.toBe(markup(withSpec(log, null), t));
  });
});

// ------------------------------------------------------------------------------------ modes

describe("RelayConsole modes: a stranger's relay never gets the visitor's microphone (PLATFORM §8.3)", () => {
  it("every mode is covered, and only the flagship and Test offer the mic", () => {
    expect(Object.keys(RELAY_CONSOLE_INPUTS).sort()).toEqual([...RELAY_CONSOLE_MODES].sort());
    expect(RELAY_CONSOLE_INPUTS.flagship.mic).toBe(true);
    expect(RELAY_CONSOLE_INPUTS.test.mic).toBe(true);
    for (const mode of ["shared", "published"] as const) {
      expect(RELAY_CONSOLE_INPUTS[mode], mode).toMatchObject({ mic: false, typed: false, autopilot: true });
    }
  });

  it("the strip says who the customer is per mode: 'you (mic)' only where the mic is offered", () => {
    const log = fixtureLog("s01-full") ?? [];
    const s = stateAt(log, resolveAt(log, "ai-speaking") as number);
    for (const mode of RELAY_CONSOLE_MODES) {
      const i = RELAY_CONSOLE_INPUTS[mode];
      const customerInput = !i.autopilot && i.mic ? ("mic" as const) : ("synthetic" as const);
      const tag = provenance(s, { customerInput }).segments.find((g) => g.key === "customer")?.tag;
      expect(tag, mode).toBe(i.mic ? "YOU" : "SYNTHETIC");
    }
  });
});

// ------------------------------------------------------------------------------------ acceptance 3

describe("acceptance 3: the Dental fixture renders from its own UiSpec", () => {
  const log = () => fixtureLog("dental-deposit") ?? [];

  it("the case card shows the relay's fields and groups, and no Baton field", () => {
    const page = text(markup(log(), resolveAt(log(), "shadowing:end") as number));
    for (const label of ["Patient's full name", "Procedure", "Appointment date", "Appointment time"]) {
      expect(page).toContain(label);
    }
    for (const group of ["Patient", "Appointment"]) expect(page).toContain(group);
    for (const baton of ["Driver's full name", "Garaging ZIP", "License status", "Vehicle assignment"]) {
      expect(page).not.toContain(baton);
    }
  });

  it("the stage strip uses the relay's own stage labels", () => {
    const page = text(markup(log(), resolveAt(log(), "paying") as number));
    expect(page).toContain("Deposit terms");
    expect(page).toContain("Close");
    expect(page).not.toContain("Disclose");
  });

  it("the phone takes a deposit and never offers an e-sign", () => {
    expect(DENTAL_UI_SPEC.phone).toEqual({ payment: true, esign: false, smsSender: "Cedar Hollow Dental" });
    expect(paySteps(DENTAL_UI_SPEC)).toMatchObject({ verb: "pay", verbs: "pays" });
    const s = stateAt(log(), resolveAt(log(), "paying") as number);
    expect(phaseCopy(s).body).toBe("Pay with the Polar sandbox test card, or skip with a simulated payment.");
    expect(narrator(s).text).toBe("Your turn: tap the text on the phone to pay");
    const page = text(markup(log(), resolveAt(log(), "paying") as number));
    expect(page).toContain("Cedar Hollow Dental");
    expect(page).not.toContain("Harborview Insurance Agency");
  });

  it("a second relay is never called Baton, and the chip names it with its version", () => {
    const s = stateAt(log(), resolveAt(log(), "shadowing:end") as number);
    expect(agentNameOf(DENTAL_UI_SPEC)).toBe("The relay agent");
    expect(narrator(s).text).toBe("Human half: The relay agent is listening silently; watch facts turn green");
    const page = text(markup(log(), resolveAt(log(), "shadowing:end") as number));
    expect(page).toContain("Dental · booking deposit");
    expect(page).toContain("v3");
    // "Pass the baton" is the universal action in every relay (PLATFORM §2 glossary), so it stays.
    expect(page).toContain("Pass the baton");
  });

  it("the pass estimate counts only the facts this relay's AI would have to ask for", () => {
    const s = stateAt(log(), resolveAt(log(), "shadowing:end") as number);
    expect(s.caseState).not.toBeNull();
    // Four required dental fields, minus whatever the human half already verified; the rep-only deposit is never one
    // the AI collects, so the estimate can never exceed four (Baton's own number does not move: see store.test.ts).
    const est = passEstimate({ caseState: s.caseState, relay: DENTAL_UI_SPEC });
    expect(est.facts).toBeLessThanOrEqual(4);
    expect(est.text).toMatch(/^Pass now: the AI will |^Pass any time/);
    // The deposit is rep-only, so adding it as a required field would not change the count.
    const withDeposit: UiSpec = {
      ...DENTAL_UI_SPEC,
      fields: DENTAL_UI_SPEC.fields.map((f) => (f.id === "deposit_amount_usd" ? { ...f, required: true } : f)),
    };
    expect(passEstimate({ caseState: s.caseState, relay: withDeposit }).facts).toBe(est.facts);
  });
});

// ------------------------------------------------------------------------------------ acceptance 4

describe("acceptance 4: one provenance strip per run, four right values, no stacked badges", () => {
  it.each(FIXTURES.map((f) => [f.name] as const))("%s carries exactly one four-segment strip in every state", (name) => {
    const log = fixtureLog(name) ?? [];
    for (const phase of FIXTURES.find((f) => f.name === name)?.reaches ?? []) {
      const t = resolveAt(log, phase);
      if (t === null) continue;
      const html = markup(log, t);
      const where = `${name} @ ${phase}`;
      // Exactly one strip, never two stacked.
      expect(html.match(/Where this run comes from/g)?.length, where).toBe(1);
      for (const key of ["human", "transcription", "ai", "customer"]) {
        expect(html.match(new RegExp(`data-provenance="${key}"`, "g"))?.length, `${where} · ${key}`).toBe(1);
      }
    }
  });

  it("each segment is a named group, not a labelled generic span (ARIA prohibits that, and Lighthouse fails it)", () => {
    const log = fixtureLog("s01-full") ?? [];
    const html = markup(log, resolveAt(log, "shadowing:end") as number);
    const segments = html.match(/<span[^>]*data-provenance="[^"]+"[^>]*>/g) ?? [];
    expect(segments).toHaveLength(4);
    for (const s of segments) {
      expect(s).toContain('role="group"');
      expect(s).toMatch(/aria-label="[^"]+"/);
    }
  });

  it("no console component renders a stacked provenance badge of its own any more", () => {
    const root = join(__dirname, "..", "..", "..");
    const retired = ["SIMULATED AUDIO", "RECORDED AI SESSION", "CACHED REPLAY"];
    const sources = ["src/components/call/top-bar.tsx", "src/components/call/call-console.tsx", "src/components/call/state-cards.tsx", "src/client/store/selectors.ts"];
    for (const file of sources) {
      // Comments may name the retired badges (they say what the strip replaced); rendered strings may not.
      const code = readFileSync(join(root, file), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join("\n");
      for (const badge of retired) expect(code, `${file} still renders ${badge}`).not.toContain(badge);
    }
  });

  const tags = (log: readonly UiLogEntry[], t: number, customerInput: "synthetic" | "mic" = "synthetic") =>
    provenance(stateAt(log, t), { customerInput }).segments.map((g) => g.tag);

  it("a recorded take: RECORDED · LIVE · LIVE · (you or synthetic)", () => {
    const log = withProvenance(fixtureLog("s01-full") ?? [], RECORDED);
    const t = resolveAt(log, "shadowing:end") as number;
    expect(tags(log, t, "mic")).toEqual(["RECORDED", "LIVE", "LIVE", "YOU"]);
    expect(tags(log, t)).toEqual(["RECORDED", "LIVE", "LIVE", "SYNTHETIC"]);
    expect(provenance(stateAt(log, t), { customerInput: "mic" }).simulated).toBe(false);
  });

  it("a simulated take: SIMULATED, with the detail line the spec fixes", () => {
    const log = fixtureLog("s01-sim") ?? [];
    const t = resolveAt(log, "shadowing:end") as number;
    const view = provenance(stateAt(log, t), { customerInput: "synthetic" });
    expect(view.segments[0]).toMatchObject({ tag: "SIMULATED", value: "simulated (TTS)" });
    expect(view.simulated).toBe(true);
    expect(view.detail).toBe("Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people.");
    expect(markup(log, t)).toContain("SIMULATED");
  });

  it("a text dry run: DRY RUN, and no transcription, AI session or customer voice at all", () => {
    const log = withProvenance(fixtureLog("s01-full") ?? [], {
      ...RECORDED,
      humanHalf: "text_dry_run",
      // The contract has no "none" transcription kind: a dry run states whatever it would have used, and the strip
      // says NONE because the human half is typed text (§7.6). That is exactly the case worth pinning.
      transcription: { kind: "live", date: null },
      aiHalf: { kind: "none", date: null },
      customerInAiHalf: "none",
    });
    const t = resolveAt(log, "shadowing:end") as number;
    expect(tags(log, t, "mic")).toEqual(["DRY RUN", "NONE", "NONE", "NONE"]);
    expect(provenance(stateAt(log, t), { customerInput: "mic" }).simulated).toBe(true);
  });

  it("a cached-transcript replay: CACHED, with the date it was transcribed live", () => {
    const log = fixtureLog("s01-cached") ?? [];
    const t = resolveAt(log, "shadowing:end") as number;
    const view = provenance(stateAt(log, t), { customerInput: "mic" });
    expect(view.segments.map((g) => g.tag)).toEqual(["RECORDED", "CACHED", "LIVE", "YOU"]);
    expect(view.segments[1]?.value).toMatch(/^cached \(\w{3} \d{1,2} \w{3} \d{4}\)$/);
  });

  it("a recorded AI half: the AI and the customer segments are both RECORDED", () => {
    const log = fixtureLog("s01-recorded-ai") ?? [];
    const t = resolveAt(log, "ai-speaking") as number;
    // The mic is irrelevant here: a recorded session already has the customer's own audio.
    expect(tags(log, t, "mic")).toEqual(["RECORDED", "LIVE", "RECORDED", "RECORDED"]);
  });

  it("the QA card says how a simulated run was verified, and never claims a recording it lacks", () => {
    // The card's body lives in a dialog that only opens in a browser, so the wording is checked at its source.
    const at = (name: string) => stateAt(fixtureLog(name) ?? [], resolveAt(fixtureLog(name) ?? [], "completed") as number);
    const sim = qaVerifiedCopy(at("s01-sim"));
    expect(sim.badge).toBe("Verified from the AI half's audio (AssemblyAI async); customer audio simulated");
    expect(sim.how).toContain("The customer's audio in this run is simulated.");
    const rec = qaVerifiedCopy(at("s01-full"));
    expect(rec.badge).toBe("Verified from recording");
    expect(rec.how).not.toContain("simulated");
    // The Dental relay runs on a simulated call too, so its card must carry the same honest wording.
    expect(qaVerifiedCopy(at("dental-deposit")).badge).toBe(sim.badge);
  });
});
