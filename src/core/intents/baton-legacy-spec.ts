/**
 * intents/baton-legacy-spec.ts - `LEGACY_BATON_SPEC` (PLATFORM §4.1): the `IntentSpec` of today's Baton `add_driver`
 * intent, written BY HAND over the legacy constants and functions (never built from JSON). WP14a·3.
 *
 * Its `hash` is "legacy", which the blueprint-level legacy functions (caseStateJson, disclosureText, buildSttParams)
 * read as "run the legacy code". `buildIntentSpec(data/relays/baton-add-driver.json)` must equal it on the whole parity
 * corpus (tests/unit/core/relay/parity-spec.test.ts): that equality is the field-semantics half of the parity proof.
 *
 * The spec speaks `AccountRecord`; the legacy language layer reads a `PolicyRecord`, recovered by `policyFor`.
 */
import type { FieldId } from "../contracts/case";
import type { AccountRecord } from "../contracts/v2/blueprint";
import type { IntentSpec, PhraseScope } from "../contracts/v2/relay";
import { greetingPhraseCtx } from "../compiler/greeting";
import { ENTITY_FIELDS, inputModeFor } from "../compiler/stages";
import { policyFor } from "../relay/account";
import { LEGACY_SPEC_HASH } from "../relay/spec-link";
import {
  ADVICE_RE, GREETING_PRIORITY, askPhrase, compatible, confirmPhrase, displayValue, effectiveDateInRange, mergeValues,
  normalizeField, spokenForms, targetedFields,
} from "./add-driver";
import {
  ADVICE_DOMAIN, AI_SETTABLE, FIELD_IDS, FIELD_LABEL, REP_ONLY, REQUIRED_FIELDS, SERVER_RESOLVABLE,
} from "./add-driver.fields";

const fid = (f: string): FieldId => f as FieldId;
const phraseCtx = (pc: PhraseScope) => ({ ...greetingPhraseCtx(pc.snapshot, policyFor(pc.account)), raw: pc.raw ?? null });

const spec: IntentSpec = {
  id: "add_driver",
  hash: LEGACY_SPEC_HASH,
  fieldIds: FIELD_IDS,
  required: new Set<string>(REQUIRED_FIELDS),
  repOnly: new Set<string>(REP_ONLY),
  aiSettable: AI_SETTABLE,
  adviceDomain: new Set<string>(ADVICE_DOMAIN),
  serverResolvable: new Set<string>(SERVER_RESOLVABLE),
  priority: GREETING_PRIORITY,
  entityFields: ENTITY_FIELDS as ReadonlySet<string>,
  label: (f: string) => FIELD_LABEL[fid(f)],
  normalize: (f: string, raw: string | number | boolean | null | undefined, ctx: { callDate: string; account: AccountRecord }) =>
    normalizeField(fid(f), raw, { policy: policyFor(ctx.account), callDate: ctx.callDate }),
  display: (f: string, norm: string, account: AccountRecord, raw?: string | null) => displayValue(fid(f), norm, policyFor(account), raw),
  compatible: (f: string, a: string | null, b: string | null) => compatible(fid(f), a, b),
  merge: (f: string, a: string, b: string) => mergeValues(fid(f), a, b),
  inRange: (f: string, norm: string, callDate: string) => (f === "effective_date" ? effectiveDateInRange(norm, callDate) : true),
  confirmPhrase: (f: string, value: string, pc: PhraseScope) => confirmPhrase(fid(f), value, phraseCtx(pc)),
  askPhrase: (f: string, pc: PhraseScope) => askPhrase(fid(f), phraseCtx(pc)),
  spokenForms: (f: string, value: string, account: AccountRecord) => spokenForms(fid(f), value, policyFor(account)),
  targetedFields: (sentence: string) => targetedFields(sentence),
  adviceRe: ADVICE_RE,
  inputModeFor: (next) => inputModeFor(next as Parameters<typeof inputModeFor>[0]),
};

export const LEGACY_BATON_SPEC: IntentSpec = Object.freeze(spec);
