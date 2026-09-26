"use client";
/**
 * components/studio/configure/greeting-section.tsx - Greeting & voice (SAAS §5.5, WP15·2).
 *
 * The first thing the customer hears after the baton, and the only part of a relay with a hard budget: lint G2
 * fails a greeting that does not fit `maxWords`, because a greeting is *spoken* and forty words is already
 * fourteen seconds of someone waiting to find out who they are talking to.
 *
 * **The counter counts the rendered greeting, not the template.** `{clause.wrap}` is one word in the box and eight
 * in the ear, and a droppable clause may not be spoken at all. So the number comes from the Preview compile that
 * the store already has — the same one lint measures — and the form shows it per canned state rather than
 * inventing a second, cheaper count that would disagree with the badge in the top bar.
 */
import { wordBudgetTone, type Path } from "@/client/studio/configure";
import { greetingFor, CANNED_STATE_LABEL } from "@/client/studio/preview";
import { useSource } from "@/client/studio/use-source-store";
import { CANNED_STATES, VA_VOICES, type CannedState } from "@/core/contracts/v2";
import { cn } from "@/lib/utils";
import { useState } from "react";

import { Grid, NumberControl, Row, SectionCard, SelectControl, TextControl } from "./controls";
import { CodeLink } from "./code-link";

const BASE: Path = ["playbook", "greeting"];

export function GreetingSection({ editable, relayId }: { editable: boolean; relayId: string }) {
  const bp = useSource((s) => s.blueprint);
  if (!bp) return null;
  const g = bp.playbook.greeting;
  const at = (...keys: (string | number)[]): Path => [...BASE, ...keys];

  return (
    <SectionCard
      id="greeting"
      title="Greeting &amp; voice"
      blurb="The first thing the customer hears after the baton."
      path={BASE}
      actions={<WordBudget maxWords={g.maxWords} />}
    >
      <Grid>
        <Row label="Voice" path={["playbook", "voice"]} match="exact" hint="The Voice Agent voice this relay speaks in.">
          <SelectControl path={["playbook", "voice"]} value={bp.playbook.voice} options={VA_VOICES} disabled={!editable} />
        </Row>
        <Row label="Word budget" path={at("maxWords")} match="exact" hint="20–40. Roughly a third of a second per word.">
          <NumberControl path={at("maxWords")} value={g.maxWords} disabled={!editable} min={20} max={40} />
        </Row>
      </Grid>

      <Row
        label="Opening"
        path={at("opening")}
        match="exact"
        hint="Must say it is an AI assistant, not a person, and that the call is recorded — compliance C1 checks for it."
      >
        <TextControl path={at("opening")} value={g.opening} disabled={!editable} rows={2} maxLength={2400} />
      </Row>

      <Row label="What it says it is doing" path={at("summary")} match="exact" hint="May be one or more {clause.id} references, so long lines can be dropped to fit the budget.">
        <TextControl path={at("summary")} value={g.summary} disabled={!editable} rows={2} maxLength={2400} />
      </Row>

      <Row label="How to opt out" path={at("optOut")} match="exact" hint="Offered to a customer who would rather keep talking to a person.">
        <TextControl path={at("optOut")} value={g.optOut} disabled={!editable} rows={2} maxLength={2400} />
      </Row>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">The first question</legend>
        <p className="text-muted-foreground mb-2 text-xs">
          Which one it asks depends on what the rep already captured, so all three are written here.
        </p>
        <div className="space-y-4">
          <Row label="Something to confirm" path={at("next", "confirm")} match="exact">
            <TextControl path={at("next", "confirm")} value={g.next.confirm} disabled={!editable} maxLength={2400} />
          </Row>
          <Row label="Something still missing" path={at("next", "ask")} match="exact">
            <TextControl path={at("next", "ask")} value={g.next.ask} disabled={!editable} maxLength={2400} />
          </Row>
          <Row label="Nothing left to collect" path={at("next", "ready")} match="exact">
            <TextControl path={at("next", "ready")} value={g.next.ready} disabled={!editable} maxLength={2400} />
          </Row>
        </div>
      </fieldset>

      <GreetingCounter maxWords={g.maxWords} />

      {g.clauses.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          This greeting has {g.clauses.length} droppable {g.clauses.length === 1 ? "clause" : "clauses"} (
          {g.clauses.map((c) => c.id).join(", ")}), edited in{" "}
          <CodeLink relayId={relayId} path={at("clauses")}>Code</CodeLink>.
        </p>
      ) : null}
    </SectionCard>
  );
}

const WordBudget = ({ maxWords }: { maxWords: number }) => (
  <span className="text-muted-foreground text-xs">≤ {maxWords} words · ≈ {Math.round(maxWords * 0.34)}s</span>
);

/**
 * The rendered greeting for one canned state, with its word count against the budget.
 *
 * `preview` is null only while the text does not compile; the counter then says so rather than showing a stale
 * number, because a stale number here is exactly the thing that makes someone ship a 14-second greeting.
 */
function GreetingCounter({ maxWords }: { maxWords: number }) {
  const preview = useSource((s) => s.preview);
  const [state, setState] = useState<CannedState>("nothing");
  const greeting = preview ? greetingFor(preview, state) : null;
  const tone = greeting ? wordBudgetTone(greeting.wordCount, maxWords) : "ok";

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-semibold tracking-wide uppercase">As spoken</span>
        <div className="flex flex-wrap gap-1">
          {CANNED_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                state === s ? "bg-primary text-primary-foreground border-transparent" : "hover:bg-accent",
              )}
            >
              {CANNED_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        {greeting ? (
          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
              tone === "over" && "bg-destructive/10 text-destructive",
              tone === "close" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
              tone === "ok" && "text-muted-foreground",
            )}
          >
            {greeting.wordCount} / {maxWords} words · {greeting.estSeconds}s
          </span>
        ) : null}
      </div>
      <p className="px-3 py-2 text-sm">
        {greeting ? greeting.text : <span className="text-muted-foreground">Showing nothing: the relay does not compile right now.</span>}
      </p>
    </div>
  );
}
