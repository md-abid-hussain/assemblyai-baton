/**
 * client/fixtures/s01-script.ts - the s01 golden-path call ("Add 17-year-old daughter Maya to the Civic") as a
 * timed script for DEV FIXTURES. Lines follow data/scenarios/s01.json's talk track and facts; timings are
 * plausible, not measured. Real runs replace all of this with live events.
 */
import "client-only";

import type { FieldId, FieldStatus, StatusReason } from "@/core/contracts/case";
import type { CallHandoff } from "@/core/contracts/scenario";

import type { ScriptTurn } from "./builder";

export interface ScriptUpdate {
  field: FieldId;
  status: FieldStatus;
  reason: StatusReason;
  value?: string;
  display?: string;
  /** Evidence quote inside this turn. */
  quote: string;
}

export interface S01Turn extends ScriptTurn {
  updates?: ScriptUpdate[];
}

export const S01_CALL_ID = "s01-fixture";
export const S01_DURATION_MS = 121_000;

export const S01_TURNS: S01Turn[] = [
  { ch: "rep", startMs: 800, endMs: 6200, text: "Thanks for calling Harborview Insurance Agency, this is Daniel. Just so you know, this call is recorded for quality and training. How can I help you today?" },
  {
    ch: "customer", startMs: 7000, endMs: 11600, text: "Hi Daniel. I'd like to add my daughter to our car insurance. She just got her license.",
    updates: [{ field: "driver_relation", status: "PENDING", reason: "stated_once", value: "child", display: "Daughter", quote: "my daughter" }],
  },
  { ch: "rep", startMs: 12200, endMs: 17000, text: "Oh, congratulations to her! Can I get the policyholder's name and your policy number?" },
  { ch: "customer", startMs: 17600, endMs: 24200, text: "Sure, it's Priya Raman, and the policy number is N-B-M four four one eight two zero seven." },
  {
    ch: "rep", startMs: 24800, endMs: 32400, text: "Thank you, Priya. I have your policy here at 1427 Belle Avenue in Lakewood. What's your daughter's full name and date of birth?",
    updates: [{ field: "driver_relation", status: "VERIFIED", reason: "acknowledged", quote: "your daughter's full name" }],
  },
  {
    ch: "customer", startMs: 33000, endMs: 40600, text: "Her name is Maya Raman, M-A-Y-A. Her birthday is March 14th, 2009, so she's seventeen.",
    updates: [
      { field: "driver_full_name", status: "PENDING", reason: "stated_once", value: "Maya Raman", display: "Maya Raman", quote: "Maya Raman, M-A-Y-A." },
      { field: "driver_dob", status: "PENDING", reason: "stated_once", value: "2009-03-14", display: "Mar 14, 2009", quote: "March 14th, 2009," },
      { field: "driver_age", status: "PENDING", reason: "stated_once", value: "17", display: "17", quote: "she's seventeen." },
    ],
  },
  {
    ch: "rep", startMs: 41200, endMs: 49000, text: "So that's Maya Raman, born March 14th, 2009. Which state issued her license, what type is it, and has she had any tickets or accidents?",
    updates: [
      { field: "driver_full_name", status: "VERIFIED", reason: "read_back", quote: "Maya Raman," },
      { field: "driver_dob", status: "VERIFIED", reason: "read_back", quote: "born March 14th, 2009." },
      { field: "driver_age", status: "VERIFIED", reason: "both_stated", quote: "born March 14th, 2009." },
    ],
  },
  {
    ch: "customer", startMs: 49600, endMs: 55400, text: "Ohio. It's her probationary license, she passed last Tuesday. And no tickets, nothing.",
    updates: [
      { field: "license_state", status: "PENDING", reason: "stated_once", value: "OH", display: "Ohio", quote: "Ohio." },
      { field: "license_status", status: "PENDING", reason: "stated_once", value: "provisional", display: "Provisional (probationary)", quote: "her probationary license," },
      { field: "incidents_3y", status: "PENDING", reason: "stated_once", value: "none", display: "None", quote: "no tickets, nothing." },
    ],
  },
  {
    ch: "rep", startMs: 56000, endMs: 64600, text: "Perfect, an Ohio provisional license with a clean record. Which car will she drive most? I'd list her as the primary driver on that one, it matters at claim time. And where is it parked overnight?",
    updates: [
      { field: "license_state", status: "VERIFIED", reason: "read_back", quote: "an Ohio provisional license" },
      { field: "license_status", status: "VERIFIED", reason: "read_back", quote: "Ohio provisional license" },
      { field: "incidents_3y", status: "VERIFIED", reason: "read_back", quote: "a clean record." },
    ],
  },
  {
    ch: "customer", startMs: 65200, endMs: 71000, text: "The Civic. She'll drive it every day to school. It's parked at home, zip 44107.",
    updates: [
      { field: "vehicle_assignment", status: "PENDING", reason: "stated_once", value: "veh1", display: "2021 Honda Civic", quote: "The Civic." },
      { field: "operator_type", status: "PENDING", reason: "stated_once", value: "primary", display: "Primary", quote: "every day to school." },
      { field: "garaging_zip", status: "PENDING", reason: "stated_once", value: "44107", display: "44107", quote: "zip 44107." },
    ],
  },
  {
    ch: "rep", startMs: 71600, endMs: 81400, text: "Great, so Maya as the primary driver on the 2021 Civic, kept at 44107. With a B average or better she gets the good-student discount. A lot of families also raise liability limits for a teen driver, about $11 more a month.",
    updates: [
      { field: "vehicle_assignment", status: "VERIFIED", reason: "read_back", quote: "the 2021 Civic," },
      { field: "operator_type", status: "VERIFIED", reason: "read_back", quote: "the primary driver" },
      { field: "garaging_zip", status: "VERIFIED", reason: "read_back", quote: "kept at 44107." },
    ],
  },
  {
    ch: "customer", startMs: 82000, endMs: 86800, text: "She has a 3.6 GPA. Let's keep the limits as they are for now.",
    updates: [
      { field: "good_student_discount", status: "PENDING", reason: "stated_once", value: "eligible", display: "Eligible (GPA 3.6)", quote: "She has a 3.6 GPA." },
      { field: "coverage_change", status: "PENDING", reason: "stated_once", value: "none", display: "No change (keeps 50/100/50)", quote: "keep the limits as they are for now." },
    ],
  },
  {
    ch: "rep", startMs: 87400, endMs: 90400, text: "Sounds good. When would you like Maya added to the policy?",
    updates: [
      { field: "good_student_discount", status: "VERIFIED", reason: "acknowledged", quote: "Sounds good." },
      { field: "coverage_change", status: "VERIFIED", reason: "acknowledged", quote: "Sounds good." },
    ],
  },
  {
    ch: "customer", startMs: 91000, endMs: 95400, text: "Next Friday, October 2nd. That's when she starts driving to school.",
    updates: [{ field: "effective_date", status: "PENDING", reason: "stated_once", value: "2026-10-02", display: "Fri, Oct 2, 2026", quote: "Next Friday, October 2nd." }],
  },
  {
    ch: "rep", startMs: 96000, endMs: 105800, text: "Okay, Maya, primary on the Civic, starting Friday, October 2nd. Your new premium is $142 a month, up $46 from your $96, with the good-student discount included.",
    updates: [
      { field: "effective_date", status: "VERIFIED", reason: "read_back", quote: "starting Friday, October 2nd." },
      { field: "premium_new_monthly_usd", status: "PENDING", reason: "stated_once", value: "142.00", display: "$142.00 / month", quote: "$142 a month," },
      { field: "premium_change_monthly_usd", status: "PENDING", reason: "stated_once", value: "46.00", display: "+$46.00 / month", quote: "up $46 from your $96," },
    ],
  },
  {
    ch: "customer", startMs: 106400, endMs: 109800, text: "Oof, that's a bit more than I hoped, but okay. Go ahead.",
    updates: [
      { field: "premium_new_monthly_usd", status: "VERIFIED", reason: "acknowledged", quote: "but okay." },
      { field: "premium_change_monthly_usd", status: "VERIFIED", reason: "acknowledged", quote: "but okay." },
    ],
  },
  { ch: "rep", startMs: 110400, endMs: 114200, text: "OK if my assistant finishes the paperwork? I'll stay on the line." },
  { ch: "customer", startMs: 114800, endMs: 116000, text: "Sure, go ahead." },
  { ch: "rep", startMs: 116600, endMs: 119800, text: "Great. You'll hear my assistant in just a second." },
];

export const S01_HANDOFF: CallHandoff = { lineStartMs: 110_400, lineEndMs: 114_200, acceptStartMs: 114_800, acceptEndMs: 116_000, declined: false };
export const S01_DECISION_POINT_MS = 106_500;
/** Express start: decisionPoint − 25 s, snapped back to the silence gap before turn 12. */
export const S01_EXPRESS_START_MS = 81_600;

/** The AI half's spoken lines (fixture; matches what PROMPT_V3 produces for a fully verified s01 case). */
export const S01_AI = {
  greeting:
    "Hi Priya, this is Harborview Insurance Agency's AI assistant, finishing up for Daniel, who's still on the line. I have Maya Raman, born March 14th, 2009, as the primary driver on your 2021 Honda Civic, starting Friday, October 2nd. Is all of that correct?",
  premiumDisclosure:
    "Thanks, Priya. One required disclosure before I send the paperwork: adding Maya changes your monthly premium from $96 to $142, an increase of $46 a month, starting October 2nd. Do you agree to this change?",
  premiumDisclosureText:
    "Adding Maya changes your monthly premium from $96 to $142, an increase of $46 a month, starting October 2nd. Do you agree to this change?",
  esign:
    "Thank you. May I text a secure link to your phone ending in 8207, so you can review and e-sign the change and pay today's amount? You can also ask for a paper copy.",
  esignText:
    "May I text a secure link to your phone ending in 8207, so you can review and e-sign the change and pay today's amount? You can also ask for a paper copy.",
  linkSent: "I've just texted you the link. Take your time: I'll stay on the line while you sign and pay.",
  confirmation:
    "Payment received, thank you. Maya is on your policy from Friday, October 2nd, and your confirmation number is END-48213. I've texted it to you. Is there anything else I can help with?",
  goodbye: "You're welcome, Priya. Congratulations to Maya, and drive safe. Goodbye!",
  handBack: "That's a great question for Daniel, so I'll hand you back to him now. He has everything we just covered.",
  handBackSummary:
    "Priya asked whether to raise the liability limits for Maya (advice, so it's Daniel's call). Everything else is confirmed; no payment taken yet.",
} as const;
