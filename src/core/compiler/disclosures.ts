/**
 * compiler/disclosures.ts - the disclosure texts the agent must read verbatim (DESIGN §5.8; SAMPLE, not legal
 * advice), their critical tokens for the verbatim check (§5.13), and the premium / due-today resolution used by the
 * `get_disclosure` handler (WP6).
 */
import type { CaseState, DisclosureKind, PolicyRecord } from "../contracts/case";
import { daysInMonth, dayNumber, ymd } from "../case/dates";
import { firstNameOf, licenseAdjective, vehicleLabelOf } from "../intents/add-driver";
import { spokenChars, spokenDate, spokenMoney } from "./spoken";

export interface DisclosureCtx {
  snapshot: Pick<CaseState, "fields">;
  policy: PolicyRecord;
  /** The resolved new monthly premium, normalized ("142.00"): a VERIFIED rep quote, else the rating tool. */
  monthlyUsd: string;
  /** The resolved amount due today, normalized ("23.40"). Equals Polar's tax-inclusive total_amount. */
  dueTodayUsd: string;
}

export interface DisclosureText {
  kind: DisclosureKind;
  text: string;
  /** Tokens the verbatim check requires in the spoken window (§5.8). */
  criticalTokens: string[];
}

/** The phrase `DISCLOSURE_TAX_SUFFIX=1` adds after `{dueToday}` (§5.8 "Tax"), and to the critical tokens. */
export const TAX_SUFFIX = "plus any applicable tax";

const valueOf = (s: Pick<CaseState, "fields">, f: keyof CaseState["fields"]): string | null => s.fields[f]?.value ?? null;

/**
 * `disclosureText(kind, ctx, {taxSuffix})` → `{text, criticalTokens}` (§5.8).
 * - premium_change: critical = monthly, dueToday, the date, the driver's first name (+ the tax phrase when on);
 * - esign_consent: critical = the last 4 digits (spaced), "electronically", "paper copy".
 */
export function disclosureText(kind: DisclosureKind, ctx: DisclosureCtx, opts: { taxSuffix?: boolean } = {}): DisclosureText {
  const monthly = spokenMoney(ctx.monthlyUsd);
  const dueToday = spokenMoney(ctx.dueTodayUsd);
  if (kind === "esign_consent") {
    const last4 = spokenChars(ctx.policy.phoneOnFileLast4);
    return {
      kind,
      text: `I'll text a secure link to the number on file ending in ${last4}, so you can review and sign this change electronically and pay the ${dueToday}. You can ask for a paper copy instead, and you can withdraw consent to electronic documents at any time. Is it OK if I text you that link now?`,
      criticalTokens: [last4, "electronically", "paper copy"],
    };
  }
  const name = valueOf(ctx.snapshot, "driver_full_name");
  const d = name ? firstNameOf(name) : "the new driver";
  const lic = valueOf(ctx.snapshot, "license_status");
  const veh = valueOf(ctx.snapshot, "vehicle_assignment");
  const date = valueOf(ctx.snapshot, "effective_date");
  const as = lic ? `as a ${licenseAdjective(lic)} driver` : "as a driver";
  const on = veh ? (veh === "all" ? " on all your vehicles" : ` on the ${vehicleLabelOf(ctx.policy, veh)}`) : "";
  const dateSpoken = date ? spokenDate(date) : null;
  const starting = dateSpoken ? `, starting ${dateSpoken}` : "";
  const due = opts.taxSuffix ? `${dueToday} ${TAX_SUFFIX}` : dueToday;
  const text = `Here's the change. We're adding ${d} ${as}${on}${starting}. Your new premium is ${monthly} a month, and ${due} is due today, prorated for the rest of this billing period. The change is subject to the terms of your policy. Would you like me to go ahead?`;
  const criticalTokens = [monthly, dueToday, ...(dateSpoken ? [dateSpoken] : []), d, ...(opts.taxSuffix ? [TAX_SUFFIX] : [])];
  return { kind, text, criticalTokens };
}

/**
 * The premium for the disclosure (§5.8 `get_disclosure`): a VERIFIED rep-quoted `premium_new_monthly_usd`, else the
 * rating tool (`scenario.rating.newMonthlyUsd`, labelled "rating tool").
 */
export function resolvePremium(snapshot: Pick<CaseState, "fields">, ratingNewMonthlyUsd: number): { monthlyUsd: string; source: "rep_quote" | "rating_tool" } {
  const p = snapshot.fields.premium_new_monthly_usd;
  if (p && p.status === "VERIFIED" && p.source === "rep" && p.value !== null) return { monthlyUsd: p.value, source: "rep_quote" };
  return { monthlyUsd: ratingNewMonthlyUsd.toFixed(2), source: "rating_tool" };
}

/** Minimum amount due today (§5.8). */
export const MIN_DUE_TODAY_USD = 0.5;

/**
 * Due today (§5.8): the rep-quoted `amount_due_today_usd` (VERIFIED from the rep), else the scenario's value, else
 * the prorated difference to the end of the calendar month of the effective date:
 * `(new − current) × daysLeft / daysInMonth` (daysLeft counts the effective day itself), min $0.50, to cents.
 */
export function resolveDueToday(i: {
  snapshot: Pick<CaseState, "fields">;
  newMonthlyUsd: string;
  currentMonthlyUsd: number;
  scenarioDueTodayUsd?: number | null;
  /** Used when effective_date is unknown. */
  callDate: string;
}): { dueTodayUsd: string; source: "rep_quote" | "scenario" | "prorated" } {
  const q = i.snapshot.fields.amount_due_today_usd;
  if (q && q.status === "VERIFIED" && q.source === "rep" && q.value !== null) return { dueTodayUsd: q.value, source: "rep_quote" };
  if (i.scenarioDueTodayUsd !== null && i.scenarioDueTodayUsd !== undefined) return { dueTodayUsd: i.scenarioDueTodayUsd.toFixed(2), source: "scenario" };
  const eff = i.snapshot.fields.effective_date?.value;
  const from = eff && dayNumber(eff) !== null ? eff : i.callDate;
  const { y, m, d } = ymd(from);
  const dim = daysInMonth(y, m);
  const daysLeft = dim - d + 1;
  const raw = (Number(i.newMonthlyUsd) - i.currentMonthlyUsd) * (daysLeft / dim);
  const cents = Math.max(Math.round(raw * 100), Math.round(MIN_DUE_TODAY_USD * 100));
  return { dueTodayUsd: (cents / 100).toFixed(2), source: "prorated" };
}
