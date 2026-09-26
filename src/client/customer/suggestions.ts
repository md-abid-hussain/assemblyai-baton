/**
 * client/customer/suggestions.ts - WHAT the customer can say: the §5.15 suggested-reply engine (WP14a's pure
 * `suggestReplies`) bound to the audio that actually exists (clips.ts).
 *
 * Two shapes of relay meet here:
 *   - a Baton take, whose truthful phrases come from the scenario truth in the committed chip pack, and
 *   - a simulated call, whose AI half is pre-voiced as `aiClips` keyed by suggestion kind (PLATFORM §7.5 step 5),
 *     including the extra `answer:<field>` clip of each "Try an edit" preset.
 * For a sim the clip's own text wins: a chip must read exactly what the judge is about to hear. Phrases with no
 * clip are dropped, because `/api/tts` is cut and nothing may be spoken that was never generated.
 */
import "client-only";

import type { CaseState, FieldId, PaymentStatus, PolicyRecord, Stage } from "@/core/contracts/case";
import type { Suggestion } from "@/core/contracts/services";
import type { IntentSpec } from "@/core/contracts/v2/relay";
import { classifyAgentText, suggestReplies, type AgentTextClass } from "@/core/compiler/suggest";

import type { ClipIndex, CustomerClipRef } from "./clips";

/** A suggestion the page can actually play: `clip` is the resolved 24 kHz source. */
export interface CustomerSuggestion extends Suggestion {
  clip: CustomerClipRef | null;
  /** The field the agent's last sentence targeted, when it had one (the sim clip key). */
  field: FieldId | null;
}

export interface SuggestionInput {
  lastAgentText: string;
  /** Earlier spoken replies of this AI half, oldest first (the loop breaker counts asks). */
  history: readonly string[];
  snapshot: Pick<CaseState, "fields">;
  truth: Partial<Record<FieldId, string>>;
  stage: Stage | null;
  paymentStatus: PaymentStatus | null;
  policy: PolicyRecord;
  offerTry: boolean;
  index: ClipIndex;
  /** Non-Baton relays use WP14a's generic engine. */
  spec?: IntentSpec;
}

/** At most this many chips reach the store (the console renders the first four). */
export const MAX_SUGGESTIONS = 6;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** Which pre-voiced sim clip answers this classification (PLATFORM §7.5 step 5). */
export function kindForClass(c: AgentTextClass): Suggestion["kind"] | null {
  switch (c.kind) {
    case "esign_consent":
    case "disclosure_premium":
      return "consent";
    case "anything_else":
      return "close";
    case "confirm":
      return "confirm";
    case "ask":
      return "answer";
    default:
      return null;
  }
}

/** A chip whose text and audio both come from a clip (the sim path's targeted answer). */
function fromClip(kind: Suggestion["kind"], clip: CustomerClipRef, field: FieldId | null): CustomerSuggestion {
  return { id: `${kind}:${slug(clip.text)}`, text: clip.text, audioUrl: clip.url, voice: clip.voice, kind, clip, field };
}

export interface SuggestionSet {
  items: CustomerSuggestion[];
  /** The classification the chips were built from: the runner's `isRequest` and the sim clip key come from it. */
  cls: AgentTextClass;
}

export function buildSuggestions(i: SuggestionInput): SuggestionSet {
  const ctx = {
    lastAgentText: i.lastAgentText,
    snapshot: i.snapshot,
    truth: i.truth,
    stage: i.stage,
    paymentStatus: i.paymentStatus,
    policy: i.policy,
    history: i.history,
    offerTry: i.offerTry,
  };
  const cls = classifyAgentText(i.lastAgentText, ctx, i.spec);
  const field = cls.field;

  const resolve = (s: Suggestion): CustomerClipRef | null => i.index.byKind(s.kind, field) ?? i.index.byText(s.text);
  const out: CustomerSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: CustomerSuggestion) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  for (const s of suggestReplies(ctx, i.spec)) {
    const clip = resolve(s);
    push(clip ? fromClip(s.kind, clip, field) : { ...s, clip: null, field });
  }

  // The sim path: the scenario truth is not on the page, so `suggestReplies` cannot phrase the answer. The
  // pre-voiced clip for this classification is the answer - put it first, ahead of the "I'm not sure" placeholder.
  const targetedKind = kindForClass(cls);
  const targeted = targetedKind ? i.index.byKind(targetedKind, field) : null;
  if (targeted && out[0] && out[0].clip === null) {
    const chip = fromClip(targetedKind as Suggestion["kind"], targeted, field);
    const rest = out.slice(1).filter((s) => s.id !== chip.id);
    out.length = 0;
    seen.clear();
    push(chip);
    for (const s of rest) push(s);
  }

  const playable = out.filter((s) => s.clip !== null);
  // An index that resolved nothing at all (no pack committed yet) still shows the texts: the judge sees what the
  // customer would say, and `play()` reports the missing clip instead of pretending.
  return { items: (playable.length ? playable : out).slice(0, MAX_SUGGESTIONS), cls };
}
