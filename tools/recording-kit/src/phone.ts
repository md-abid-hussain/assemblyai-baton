/**
 * phone.ts - E.164 validation, masking and per-call cost estimates.
 *
 * Rates come from research/15-twilio-recording.md §3 (India rates and recording fee are
 * primary-verified on twilio.com). The +1 rate is an approximation that was NOT verified in research.
 */

export const E164 = /^\+[1-9]\d{7,14}$/;

/** Strip the separators people type ("+91 98765-43210" -> "+919876543210"). Never adds a "+". */
export function cleanPhone(raw: string): string {
  return raw.trim().replace(/[\s\-().]/g, "");
}

export type Region = "IN" | "NANP" | "OTHER";

export function regionOf(n: string): Region {
  if (n.startsWith("+91")) return "IN";
  if (n.startsWith("+1")) return "NANP";
  return "OTHER";
}

/** Indian mobiles are +91 followed by 10 digits starting 6-9. */
export const isIndianMobile = (n: string): boolean => /^\+91[6-9]\d{9}$/.test(n);
/** NANP 555-0100..0199 numbers are reserved for fiction (used in examples/tests). */
export const isFictionalNanp = (n: string): boolean => /^\+1\d{3}55501\d{2}$/.test(n);

/** "+919876543210" -> "+91 ******3210". */
export function maskPhone(n: string | null | undefined): string {
  if (!n) return "<none>";
  if (n.length < 8) return "***";
  const cc = n.startsWith("+91") ? "+91" : n.startsWith("+1") ? "+1" : n.slice(0, 3);
  return `${cc} ${"*".repeat(Math.max(0, n.length - cc.length - 4))}${n.slice(-4)}`;
}

export interface PhoneCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Hard rules before a number may be dialed:
 *  - must be E.164 (a leading "+", country code, no spaces after cleaning)
 *  - India: exactly 10 digits after +91; landlines allowed with a warning (higher rate)
 *  - +1: exactly 10 digits; fictional 555-01xx numbers refused for real calls
 *  - any other country refused unless allowIntl (cost and geo-permissions were only checked for IN/US)
 */
export function checkDialable(n: string, opts: { allowIntl: boolean; realCall: boolean; label: string }): PhoneCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!E164.test(n)) {
    errors.push(`${opts.label}: not an E.164 number (write it as +<country code><number>, e.g. +91XXXXXXXXXX)`);
    return { ok: false, errors, warnings };
  }
  const region = regionOf(n);
  if (region === "IN") {
    if (!/^\+91\d{10}$/.test(n)) errors.push(`${opts.label}: Indian numbers need exactly 10 digits after +91`);
    else if (!isIndianMobile(n)) warnings.push(`${opts.label}: looks like an Indian landline (billed at $0.0699/min instead of $0.0496/min)`);
  } else if (region === "NANP") {
    if (!/^\+1\d{10}$/.test(n)) errors.push(`${opts.label}: +1 numbers need exactly 10 digits after +1`);
    else if (isFictionalNanp(n)) {
      if (opts.realCall) errors.push(`${opts.label}: ${maskPhone(n)} is a fictional 555-01xx placeholder; put the real number in participants.json`);
      else warnings.push(`${opts.label}: fictional 555-01xx placeholder (fine for --dry-run only)`);
    }
  } else if (!opts.allowIntl) {
    errors.push(`${opts.label}: only +91 (India) and +1 numbers are allowed by default; pass --allow-intl if you really mean it`);
  } else {
    warnings.push(`${opts.label}: country outside IN/US - rate unknown, check Twilio pricing and geo permissions`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const RATES_USD = {
  /** research/15 §3.1, twilio.com/en-us/voice/pricing/in (primary) */
  IN_mobile_per_min: 0.0496,
  IN_landline_per_min: 0.0699,
  /** APPROXIMATE, not verified in research - check twilio.com/en-us/voice/pricing/us */
  NANP_per_min: 0.014,
  /** research/15 §3.2 (primary): recording fee per recorded minute */
  recording_per_min: 0.0025,
  /** research/15 §3.2 (primary): storage per recorded minute per month while kept at Twilio */
  storage_per_min_month: 0.0005,
};

export function ratePerMin(n: string): { rate: number; verified: boolean } {
  const r = regionOf(n);
  if (r === "IN") return { rate: isIndianMobile(n) ? RATES_USD.IN_mobile_per_min : RATES_USD.IN_landline_per_min, verified: true };
  if (r === "NANP") return { rate: RATES_USD.NANP_per_min, verified: false };
  return { rate: 0.1, verified: false };
}

export interface CostEstimate {
  parentMin: number;
  childMin: number;
  recordingMin: number;
  usd: number;
  verified: boolean;
}

/**
 * Twilio bills each leg per started minute (research/15 §3.3).
 * Parent leg (party A) = pre-bridge time (notice + party B ringing) + bridged talk time.
 * Child leg (party B) = bridged talk time. Recording = bridged talk time.
 */
export function estimateCost(partyA: string, partyB: string, bridgedS: number, preBridgeS: number): CostEstimate {
  const parentMin = Math.max(1, Math.ceil((preBridgeS + bridgedS) / 60));
  const childMin = Math.max(1, Math.ceil(bridgedS / 60));
  const recordingMin = Math.max(1, Math.ceil(bridgedS / 60));
  const a = ratePerMin(partyA);
  const b = ratePerMin(partyB);
  const usd = parentMin * a.rate + childMin * b.rate + recordingMin * RATES_USD.recording_per_min;
  return { parentMin, childMin, recordingMin, usd: Math.round(usd * 10000) / 10000, verified: a.verified && b.verified };
}
