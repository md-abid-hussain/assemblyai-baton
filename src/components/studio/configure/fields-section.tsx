"use client";
/**
 * components/studio/configure/fields-section.tsx - Case fields (SAAS §5.5, WP15·2).
 *
 * The table a relay is mostly made of: what the assistant has to end the call holding. Columns are the ones §5.5
 * names — label, id, type, required, set by, examples, enum values — plus **Move up / Move down** buttons, because
 * §5.5 removed drag-to-reorder and buttons are also the only reorder a keyboard and a screen reader can both use.
 *
 * Two things here are less obvious than they look:
 *
 *  - **"Add field" is a preset, not an empty row.** A `BlueprintField` has twenty keys; a blank one would fail zod
 *    on the spot and block Save. `newFieldFromPreset` fills the sixteen mechanical ones from WP17's own type table
 *    (`client/studio/field-presets.ts`), so the new row is valid the moment it appears.
 *  - **Changing the type rewrites six keys, in one edit.** A date turned into money keeps a date normalizer and a
 *    "the sixth of October" read-back unless the mechanical half moves with it (`typeChangeEdits`).
 */
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { appendEdit, moveTarget, removeEdit, swapEdits, type Path } from "@/client/studio/configure";
import { FIELD_PRESETS, FIELD_TYPE_OPTIONS, newFieldFromPreset, typeChangeEdits, type FieldType } from "@/client/studio/field-presets";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import { SET_BY_LABEL } from "@/client/studio/overview";
import { Button } from "@/components/ui/button";
import type { Blueprint, BlueprintField } from "@/core/contracts/v2/blueprint";
import { cn } from "@/lib/utils";

import {
  CheckControl, CsvListControl, DiagnosticText, Grid, NumberControl, Row, SectionCard, SelectControl, TextControl,
  usePathDiagnostics,
} from "./controls";

const BASE: Path = ["fields"];

/** Every id anywhere in the blueprint: lint L1 requires them unique across fields, stages, disclosures and connectors. */
function allIds(bp: Blueprint): string[] {
  return [
    ...bp.fields.map((f) => f.id),
    ...bp.values.map((v) => v.id),
    ...bp.playbook.stages.map((s) => s.id),
    ...bp.playbook.disclosures.map((d) => d.id),
    ...bp.connectors.map((c) => c.id),
    ...bp.connectors.flatMap((c) => ("toolName" in c ? [c.toolName] : [])),
  ];
}

export function FieldsSection({ editable }: { editable: boolean }) {
  const bp = useSource((s) => s.blueprint);
  const actions = useSourceActions();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!bp) return null;
  const fields = bp.fields;

  const move = (index: number, direction: "up" | "down") => {
    const to = moveTarget(fields.length, index, direction);
    if (to === null) return;
    actions.applyFormEdits(swapEdits(BASE, fields, index, to));
  };

  const add = (type: FieldType, label: string) => {
    setAdding(false);
    const field = newFieldFromPreset({ type, label, taken: allIds(bp), index: fields.length });
    actions.applyFormEdits([appendEdit(BASE, fields, field)]);
    setOpen(field.id);
  };

  return (
    <SectionCard
      id="fields"
      title="Case fields"
      blurb="What the assistant has to end the call holding. The order here is the order it works through them."
      path={BASE}
      actions={
        editable ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <Plus aria-hidden className="size-4" /> Add field
          </Button>
        ) : null
      }
    >
      {adding ? (
        <ul className="grid gap-2 rounded-lg border p-2 sm:grid-cols-2" aria-label="Field presets">
          {FIELD_PRESETS.map((p) => (
            <li key={p.type}>
              <button
                type="button"
                onClick={() => add(p.type, p.label)}
                className="hover:bg-accent focus-visible:ring-ring/50 w-full rounded-md px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="text-muted-foreground block text-xs">{p.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {fields.length === 0 ? (
        <p className="text-muted-foreground text-sm">No fields yet. A relay needs at least one.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {fields.map((f, i) => (
            <FieldRow
              key={`${f.id}-${i}`}
              field={f}
              index={i}
              count={fields.length}
              editable={editable}
              expanded={open === f.id}
              onToggle={() => setOpen(open === f.id ? null : f.id)}
              onMove={move}
              onRemove={() => actions.applyFormEdits([removeEdit(BASE, i)])}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function FieldRow({
  field, index, count, editable, expanded, onToggle, onMove, onRemove,
}: {
  field: BlueprintField;
  index: number;
  count: number;
  editable: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const actions = useSourceActions();
  const at = (key: string): Path => [...BASE, index, key];
  const diagnostics = usePathDiagnostics([...BASE, index]);
  const rowId = `field-${index}`;

  return (
    <li className={cn(diagnostics.some((d) => d.severity === "error") && "bg-destructive/5")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`${rowId}-body`}
          className="hover:bg-accent focus-visible:ring-ring/50 -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          {expanded ? <ChevronUp aria-hidden className="size-4 shrink-0" /> : <ChevronDown aria-hidden className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{field.label}</span>
            <span className="text-muted-foreground block truncate font-mono text-xs">{field.id}</span>
          </span>
        </button>
        <span className="text-muted-foreground hidden text-xs sm:inline">{field.type}</span>
        <span className="text-muted-foreground hidden text-xs md:inline">{SET_BY_LABEL[field.setBy]}</span>
        {field.required ? <span className="bg-muted rounded-full px-2 py-0.5 text-xs">Required</span> : null}
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!editable || index === 0}
            aria-label={`Move ${field.label} up`}
            onClick={() => onMove(index, "up")}
          >
            <ChevronUp aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!editable || index === count - 1}
            aria-label={`Move ${field.label} down`}
            onClick={() => onMove(index, "down")}
          >
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-destructive size-7"
            disabled={!editable || count <= 1}
            aria-label={`Remove ${field.label}`}
            onClick={() => {
              if (window.confirm(`Remove the field "${field.label}"? Anything that references ${field.id} will report a lint error.`)) onRemove();
            }}
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </span>
      </div>

      {!expanded ? <div className="px-3 pb-2"><DiagnosticText diagnostics={diagnostics} /></div> : null}

      {expanded ? (
        <div id={`${rowId}-body`} className="space-y-4 border-t px-3 py-3">
          <Grid>
            <Row label="Label" path={at("label")} hint="What a person calls it.">
              <TextControl path={at("label")} value={field.label} disabled={!editable} maxLength={60} />
            </Row>
            <Row label="Id" path={at("id")} hint="Used in templates as {f.id}. Renaming it does not rename the references.">
              <TextControl path={at("id")} value={field.id} disabled={!editable} maxLength={40} mono />
            </Row>
          </Grid>

          <Row label="Description" path={at("description")} hint="The extractor reads this line, and so does the assistant.">
            <TextControl path={at("description")} value={field.description} disabled={!editable} rows={2} maxLength={300} />
          </Row>

          <Grid cols={3}>
            <Row label="Type" path={at("type")} match="exact" hint="Also sets how the value is normalized and read back.">
              <SelectControl
                path={at("type")}
                value={field.type}
                options={FIELD_TYPE_OPTIONS}
                disabled={!editable}
                onPick={(t) => actions.applyFormEdits(typeChangeEdits(index, t, field))}
              />
            </Row>
            <Row label="Set by" path={at("setBy")} match="exact" hint="Who may state it.">
              <SelectControl
                path={at("setBy")}
                value={field.setBy}
                options={["rep_only", "ai_allowed", "rep_or_customer"] as const}
                labels={SET_BY_LABEL}
                disabled={!editable}
              />
            </Row>
            <Row label="Capture priority" path={[...at("capture"), "priority"]} match="exact" hint="Lower is captured first.">
              <NumberControl path={[...at("capture"), "priority"]} value={field.capture.priority} disabled={!editable} min={0} max={99} />
            </Row>
          </Grid>

          <Grid>
            <CheckControl path={at("required")} value={field.required} label="Required" disabled={!editable} hint="The call is not finished until it is verified." />
            <CheckControl
              path={at("adviceDomain")}
              value={field.adviceDomain}
              label="A decision the rep makes"
              disabled={!editable}
              hint="The assistant reads it and never raises or changes it."
            />
          </Grid>

          <Row label="Examples" path={at("examples")} hint="Up to four, comma separated. The extractor sees them.">
            <CsvListControl path={at("examples")} value={field.examples} disabled={!editable} placeholder="Maya Ortiz, Sam Dhar" max={4} />
          </Row>

          {field.type === "enum" ? <EnumValues field={field} index={index} editable={editable} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function EnumValues({ field, index, editable }: { field: BlueprintField; index: number; editable: boolean }) {
  const actions = useSourceActions();
  const values = field.enumValues ?? [];
  const base: Path = [...BASE, index, "enumValues"];
  return (
    <div>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Choices</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!editable || values.length >= 20}
          onClick={() =>
            actions.applyFormEdits([
              appendEdit(base, values, {
                value: `option_${values.length + 1}`,
                label: `Option ${values.length + 1}`,
                synonyms: [],
                spokenForms: [`option ${values.length + 1}`],
              }),
            ])
          }
        >
          <Plus aria-hidden className="size-4" /> Add choice
        </Button>
      </div>
      <ul className="mt-2 space-y-2">
        {values.map((v, vi) => (
          <li key={`${v.value}-${vi}`} className="flex flex-wrap items-end gap-2">
            <Row label="Value" path={[...base, vi, "value"]} className="flex-1">
              <TextControl path={[...base, vi, "value"]} value={v.value} disabled={!editable} mono maxLength={40} />
            </Row>
            <Row label="Said as" path={[...base, vi, "label"]} className="flex-1">
              <TextControl path={[...base, vi, "label"]} value={v.label} disabled={!editable} maxLength={60} />
            </Row>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-destructive size-9"
              disabled={!editable || values.length <= 1}
              aria-label={`Remove the choice ${v.label}`}
              onClick={() => actions.applyFormEdits([removeEdit(base, vi)])}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
