"use client";
/**
 * components/studio/configure/handoff-section.tsx - Handoff (SAAS §5.5, WP15·2).
 *
 * The one section that is about the *product* rather than the relay: what the rep says as they pass the call, what
 * the customer has to say back, and what must already be true before the Pass button lights up at all.
 *
 * `repLinePatterns` and `acceptance.patterns` are **not** here. They are regexes, they are only used to detect the
 * line in a transcript, and a text box that silently accepts `(a+)+$` is a worse experience than a link to Code —
 * the codec runs them through `safeTest()` either way, but the place to write one is the editor.
 */
import { pathKey, type Path } from "@/client/studio/configure";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import type { Blueprint } from "@/core/contracts/v2/blueprint";

import { CheckControl, DiagnosticText, Grid, NumberControl, Row, SectionCard, TextControl, usePathDiagnostics } from "./controls";
import { CodeLink } from "./code-link";

const BASE: Path = ["handoff"];

export function HandoffSection({ editable, relayId }: { editable: boolean; relayId: string }) {
  const bp = useSource((s) => s.blueprint);
  if (!bp) return null;
  const h = bp.handoff;
  const at = (...keys: (string | number)[]): Path => [...BASE, ...keys];

  return (
    <SectionCard
      id="handoff"
      title="Handoff"
      blurb="The line the rep says, and what has to be true before they can pass the call."
      path={BASE}
    >
      <Row label="The rep's line" path={at("repLine")} match="exact" hint="Said out loud by the rep. The simulator listens for it, and the video quotes it.">
        <TextControl path={at("repLine")} value={h.repLine} disabled={!editable} rows={2} maxLength={200} />
      </Row>

      <Grid>
        <Row label="What the customer says back" path={at("acceptance", "phrase")} match="exact" hint="The acceptance. Anything close enough counts.">
          <TextControl path={at("acceptance", "phrase")} value={h.acceptance.phrase} disabled={!editable} maxLength={100} />
        </Row>
        <Row label="What the assistant says handing back" path={at("repReturnLine")} match="exact" hint="Spoken when it hands the call back to the rep.">
          <TextControl path={at("repReturnLine")} value={h.repReturnLine} disabled={!editable} maxLength={200} />
        </Row>
      </Grid>

      <Grid>
        <CheckControl
          path={at("autoBaton")}
          value={h.autoBaton}
          label="Pass the baton automatically"
          disabled={!editable}
          hint="Arms as soon as the rep's line and the acceptance are both heard. Off means the rep presses Pass."
        />
        <Row label="Earliest the rep may pass" path={at("allowedWhen", "minCallSeconds")} match="exact" hint="Seconds into the call. 0 means straight away.">
          <NumberControl path={at("allowedWhen", "minCallSeconds")} value={h.allowedWhen.minCallSeconds} disabled={!editable} min={0} max={600} step={5} />
        </Row>
      </Grid>

      <RequireVerified bp={bp} editable={editable} />

      <p className="text-muted-foreground text-xs">
        The patterns that recognise these two lines in a transcript are regular expressions, so they live in{" "}
        <CodeLink relayId={relayId} path={at("repLinePatterns")}>Code</CodeLink>.
      </p>
    </SectionCard>
  );
}

/**
 * `handoff.allowedWhen.requireVerified`: the fields the Pass button waits for.
 *
 * A checkbox list rather than a multi-select, because the answer to "why is Pass still grey" has to be readable at
 * a glance. The whole array is written on every change — it is a list of ids with no comments of its own to lose.
 */
function RequireVerified({ bp, editable }: { bp: Blueprint; editable: boolean }) {
  const actions = useSourceActions();
  const path: Path = [...BASE, "allowedWhen", "requireVerified"];
  const diagnostics = usePathDiagnostics(path);
  const selected = bp.handoff.allowedWhen.requireVerified;
  const atLimit = selected.length >= 8;

  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium">Verified before the rep may pass</legend>
      <p className="text-muted-foreground mb-2 text-xs">
        Up to eight. The Pass button stays disabled until every one of these is verified on the call.
      </p>
      {bp.fields.length === 0 ? (
        <p className="text-muted-foreground text-sm">No fields to require yet.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {bp.fields.map((f) => {
            const checked = selected.includes(f.id);
            return (
              <li key={f.id}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    id={`${pathKey(path)}-${f.id}`}
                    checked={checked}
                    disabled={!editable || (!checked && atLimit)}
                    onChange={(e) =>
                      actions.applyFormEdit(
                        path,
                        e.target.checked ? [...selected, f.id] : selected.filter((id) => id !== f.id),
                      )
                    }
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{f.label}</span>
                    {f.setBy === "ai_allowed" ? (
                      <span className="text-muted-foreground block text-xs">The assistant may set this one, so requiring it can block the pass.</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <DiagnosticText diagnostics={diagnostics} />
    </fieldset>
  );
}
