import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DENTAL_UI_SPEC } from "@/client/fixtures/dental";
import { BATON_UI_SPEC, caseTitleOf, groupsOf, labelsOf, relayChip, requiredOf, specOf } from "@/client/store/ui-spec";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import type { UiSpec } from "@/core/contracts/v2/relay";
import { compileRelay } from "@/core/relay/compile";

/** The `UiSpec` the server would send for a blueprint on disk. */
function uiOf(file: string, flagship: boolean): UiSpec {
  const bp = BlueprintSchema.parse(JSON.parse(readFileSync(`data/relays/${file}.json`, "utf8")));
  return compileRelay(bp, { flagship }).ui;
}

/** What the console actually renders from: labels, groups, the required set, stage labels, disclosures, the phone. */
const rendered = (u: UiSpec) => ({
  fields: u.fields.map((f) => [f.id, f.label, f.required, f.group, f.hidden, f.type, f.repOnly] as const),
  stages: u.stages.map((s) => [s.kind, s.label] as const),
  disclosures: u.disclosures.map((d) => [d.id, d.title] as const),
  phone: u.phone,
  flagship: u.relay.flagship,
  title: u.relay.title,
  slug: u.relay.slug,
});

describe("UiSpec (PLATFORM §7.6): the console renders any relay from its spec", () => {
  it("BATON_UI_SPEC equals the flagship's compiled spec, so the fallback can never drift", () => {
    expect(rendered(BATON_UI_SPEC)).toEqual(rendered(uiOf("baton-add-driver", true)));
  });

  it("the Dental fixture's spec equals the relay WP17 ships", () => {
    const real = uiOf("dental-deposit", false);
    expect(rendered(DENTAL_UI_SPEC)).toEqual({ ...rendered(real), flagship: false });
    // Its own stage labels and a phone with a deposit but no e-sign: the two things the flagship would hide.
    expect(DENTAL_UI_SPEC.stages.map((s) => s.label)).toEqual(["Confirm", "Deposit terms", "Deposit", "Close"]);
    expect(DENTAL_UI_SPEC.phone).toEqual({ payment: true, esign: false, smsSender: "Cedar Hollow Dental" });
  });

  it("falls back to the flagship when a run has no spec (fixture logs, recorded bundles)", () => {
    expect(specOf({ relay: null })).toBe(BATON_UI_SPEC);
    expect(specOf({ relay: DENTAL_UI_SPEC })).toBe(DENTAL_UI_SPEC);
  });

  it("required set, labels and groups come from the spec", () => {
    expect(requiredOf(BATON_UI_SPEC)).toHaveLength(10);
    expect(requiredOf(DENTAL_UI_SPEC)).toEqual(["patient_full_name", "procedure", "appointment_date", "appointment_time"]);
    expect(labelsOf(DENTAL_UI_SPEC)("appointment_time")).toBe("Appointment time");
    // An id the spec does not know still renders as something a person can read.
    expect(labelsOf(DENTAL_UI_SPEC)("waiting_room_notes")).toBe("Waiting room notes");
    expect(groupsOf(DENTAL_UI_SPEC).map((g) => g.group)).toEqual(["Patient", "Appointment", "Deposit"]);
    expect(groupsOf(BATON_UI_SPEC).map((g) => g.group)).toEqual(["Driver", "License", "Vehicle", "Change", "Rep decisions", "Price"]);
  });

  it("the case card's heading is the relay title after the brand; the chip keeps the full title and the version", () => {
    expect(caseTitleOf(BATON_UI_SPEC)).toBe("Add a driver");
    expect(caseTitleOf(DENTAL_UI_SPEC)).toBe("Booking deposit");
    expect(caseTitleOf({ ...BATON_UI_SPEC, relay: { ...BATON_UI_SPEC.relay, title: "Roadside help" } })).toBe("Roadside help");
    expect(relayChip(BATON_UI_SPEC)).toEqual({ title: "Baton · add a driver", version: null, flagship: true });
    expect(relayChip(DENTAL_UI_SPEC)).toEqual({ title: "Dental · booking deposit", version: "v3", flagship: false });
  });
});
