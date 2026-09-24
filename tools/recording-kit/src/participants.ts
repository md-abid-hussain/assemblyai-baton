/**
 * participants.ts - who gets dialed, and whether they agreed to be recorded.
 *
 * Numbers come from tools/recording-kit/participants.json (git-ignored) or straight from CLI flags.
 * A participant from the file must have consent.recording === true. Raw numbers typed on the CLI
 * need --consent-confirmed (you assert both people agreed) because there is no consent record.
 */
import { existsSync, readFileSync } from "node:fs";
import { PARTICIPANTS_PATH } from "./paths.ts";
import { cleanPhone } from "./phone.ts";

export const CONSENT_SCOPES = ["public", "metrics_only"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export interface ParticipantEntry {
  name: string;
  phone: string;
  speaks_hindi?: boolean;
  consent: {
    /** They agreed to have role-play calls recorded. Required to dial them. */
    recording: boolean;
    /** public = voice/transcript may appear in the public demo, video, repo; metrics_only = audio stays private. */
    scope: ConsentScope;
    date?: string;
    how?: string;
  };
}

export interface ParticipantsFile {
  participants: Record<string, ParticipantEntry>;
  defaults?: { rep?: string; customer?: string };
}

export interface ResolvedParticipant {
  role: "rep" | "customer";
  /** participants.json key, or "cli" when a raw number was given. */
  key: string;
  displayName: string;
  phone: string;
  consent: { recording: boolean; scope: ConsentScope | "unknown"; source: "participants.json" | "cli-flag"; date?: string; how?: string };
}

export function loadParticipantsFile(path: string = PARTICIPANTS_PATH): { file: ParticipantsFile | null; problems: string[] } {
  if (!existsSync(path)) return { file: null, problems: [] };
  let parsed: ParticipantsFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ParticipantsFile;
  } catch (e) {
    return { file: null, problems: [`participants.json is not valid JSON: ${(e as Error).message}`] };
  }
  const problems: string[] = [];
  if (!parsed.participants || typeof parsed.participants !== "object") problems.push('participants.json needs a "participants" object');
  for (const [key, p] of Object.entries(parsed.participants ?? {})) {
    if (!/^[a-z0-9_-]+$/i.test(key)) problems.push(`participant key "${key}" should be simple (letters, digits, _ or -)`);
    if (!p?.name) problems.push(`participant ${key}: name required`);
    if (!p?.phone) problems.push(`participant ${key}: phone required`);
    if (!p?.consent || typeof p.consent.recording !== "boolean") problems.push(`participant ${key}: consent.recording (true/false) required`);
    else if (!CONSENT_SCOPES.includes(p.consent.scope)) problems.push(`participant ${key}: consent.scope must be ${CONSENT_SCOPES.join(" | ")}`);
  }
  return { file: problems.length ? null : parsed, problems };
}

/**
 * Resolve "--rep" / "--customer": a participants.json key, or a raw phone number (starts with "+").
 * Falls back to participants.json defaults when the flag is omitted.
 */
export function resolveParticipant(
  role: "rep" | "customer",
  arg: string | undefined,
  file: ParticipantsFile | null,
  consentConfirmedFlag: boolean,
): ResolvedParticipant {
  const ref = arg ?? file?.defaults?.[role];
  if (!ref) {
    throw new Error(`no ${role} given: pass --${role} <participant key or +E164 number>, or set defaults.${role} in participants.json`);
  }
  if (/^[\d\s\-().]+$/.test(ref.trim())) {
    throw new Error(`--${role} "${ref}" is not E.164: start with + and the country code, e.g. +91XXXXXXXXXX (no leading 0)`);
  }
  if (ref.trim().startsWith("+")) {
    return {
      role,
      key: "cli",
      displayName: role === "rep" ? "Rep" : "Customer",
      phone: cleanPhone(ref),
      consent: { recording: consentConfirmedFlag, scope: "unknown", source: "cli-flag" },
    };
  }
  if (!file) throw new Error(`"${ref}" looks like a participant key but ${PARTICIPANTS_PATH} is missing or invalid (copy participants.example.json)`);
  const p = file.participants[ref];
  if (!p) throw new Error(`participant "${ref}" not found in participants.json (have: ${Object.keys(file.participants).join(", ")})`);
  const out: ResolvedParticipant = {
    role,
    key: ref,
    displayName: p.name,
    phone: cleanPhone(p.phone),
    consent: { recording: p.consent.recording, scope: p.consent.scope, source: "participants.json" },
  };
  if (p.consent.date) out.consent.date = p.consent.date;
  if (p.consent.how) out.consent.how = p.consent.how;
  return out;
}
