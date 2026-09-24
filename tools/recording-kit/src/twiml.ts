/**
 * twiml.ts - the inline TwiML sent with the create-call request (no public server needed).
 *
 * Flow (research/15 §1.2): Twilio calls party A (parent leg). When A answers they hear the recording
 * notice, then <Dial> calls party B (child leg) and bridges them, recording both legs into one
 * two-channel file: channel 1 = parent = party A, channel 2 = child = party B.
 */

export const RECORDING_NOTICE =
  "This practice call is being recorded for the Baton hackathon project. Connecting you to your role-play partner now.";
export const END_MESSAGE = "The role-play call has ended. Goodbye.";

/** Hard cap on the bridged conversation, seconds (Dial timeLimit). */
export const MAX_TIME_LIMIT_S = 300;
export const MIN_TIME_LIMIT_S = 60;
/** How long party B's phone may ring before <Dial> gives up. */
export const DIAL_RING_TIMEOUT_S = 30;
/** How long party A's phone may ring (create-call Timeout). */
export const PARENT_RING_TIMEOUT_S = 30;
/** Extra seconds allowed on the parent leg beyond timeLimit (notice + B ringing); create-call TimeLimit. */
export const PARENT_EXTRA_S = 75;
/** Twilio's inline Twiml parameter limit (research/15 §1.1). */
export const TWIML_MAX_CHARS = 4000;

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export interface TwimlOptions {
  /** E.164 number bridged in by <Dial> (becomes recording channel 2). */
  partyB: string;
  /** Your Twilio number (shown to party B). */
  callerId: string;
  timeLimitS: number;
}

export function buildTwiml(o: TwimlOptions): string {
  if (!Number.isInteger(o.timeLimitS) || o.timeLimitS < MIN_TIME_LIMIT_S || o.timeLimitS > MAX_TIME_LIMIT_S) {
    throw new Error(`timeLimit must be an integer between ${MIN_TIME_LIMIT_S} and ${MAX_TIME_LIMIT_S} seconds`);
  }
  const say = (text: string) => `<Say voice="alice" language="en-US">${xmlEscape(text)}</Say>`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Pause length="1"/>` +
    say(RECORDING_NOTICE) +
    `<Dial record="record-from-answer-dual" timeLimit="${o.timeLimitS}" timeout="${DIAL_RING_TIMEOUT_S}" callerId="${xmlEscape(o.callerId)}">` +
    `<Number>${xmlEscape(o.partyB)}</Number>` +
    `</Dial>` +
    say(END_MESSAGE) +
    `</Response>`;
  if (xml.length > TWIML_MAX_CHARS) throw new Error(`TwiML is ${xml.length} chars; Twilio's inline limit is ${TWIML_MAX_CHARS}`);
  return xml;
}

/** Indented copy for printing (the compact form is what gets sent). */
export function prettyTwiml(xml: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const part of xml.replace(/></g, ">\n<").split("\n")) {
    const closing = part.startsWith("</");
    const leaf = part.startsWith("<?") || part.endsWith("/>") || /^<[^/][^>]*>.*<\/[^>]+>$/.test(part);
    if (closing) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + part);
    if (!closing && !leaf) depth += 1;
  }
  return out.join("\n");
}
