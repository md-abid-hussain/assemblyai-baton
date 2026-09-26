"use client";
/**
 * components/studio/configure/connectors-section.tsx - Connectors (SAAS §5.5, §5.6, WP15·2).
 *
 * What the assistant can actually *do*. Seven kinds, each with its own fields, so this is a typed form per type
 * rather than one generic property sheet — a payment link has an amount and a disclosure it waits for, and an
 * HTTP action has a URL, a signature secret and a list of the response keys that may reach the agent.
 *
 * Three things are deliberate:
 *
 *  - **Only "Add HTTP action" adds anything.** §5.5 names it and nothing else, and the built-in kinds are not
 *    interchangeable skeletons: a payment link needs a named money value that the relay may not have. The other
 *    kinds are edited here and created in Code or by a template.
 *  - **It is a Pro and Business capability** (§5.6), read from `PLANS`. Where there is no plan layer at all the
 *    button is shown, because `null` means "this deployment has no plans", not "the cheapest one".
 *  - **`responsePick` is the security-relevant field on the page**, so it is labelled by what it does — only those
 *    keys reach the assistant — rather than by its key name.
 */
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  CONNECTOR_TYPE_LABELS, appendEdit, canAddHttpAction, newHttpAction, removeEdit, secretRefsIn, type Path,
} from "@/client/studio/configure";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import { Button } from "@/components/ui/button";
import type { Blueprint, Connector } from "@/core/contracts/v2/blueprint";
import type { PlanId } from "@/core/contracts/v3/identity";
import { cn } from "@/lib/utils";

import {
  CheckControl, CsvListControl, DiagnosticText, Grid, NumberControl, Row, SectionCard, SelectControl, TextControl,
  usePathDiagnostics,
} from "./controls";
import { CodeLink } from "./code-link";
import { SecretRefControl } from "./secret-ref";

const BASE: Path = ["connectors"];

export function ConnectorsSection({ editable, plan, relayId }: { editable: boolean; plan: PlanId | null; relayId: string }) {
  const bp = useSource((s) => s.blueprint);
  const actions = useSourceActions();
  const [open, setOpen] = useState<string | null>(null);
  if (!bp) return null;
  const list = bp.connectors;
  const mayAddHttp = canAddHttpAction(plan);

  const addHttp = () => {
    const taken = [...list.map((c) => c.id), ...list.flatMap((c) => ("toolName" in c ? [c.toolName] : []))];
    const c = newHttpAction(taken);
    actions.applyFormEdits([appendEdit(BASE, list, c)]);
    setOpen(c.id);
  };

  return (
    <SectionCard
      id="connectors"
      title="Connectors"
      blurb="What the assistant can actually do: links, documents, messages, your endpoints."
      path={BASE}
      actions={
        editable ? (
          <Button type="button" size="sm" variant="outline" disabled={!mayAddHttp} onClick={addHttp}>
            <Plus aria-hidden className="size-4" /> Add HTTP action
          </Button>
        ) : null
      }
    >
      {!mayAddHttp ? (
        <p className="text-muted-foreground text-xs">
          HTTP actions call your own endpoint, and they are a Pro feature. Everything else on this page works on
          every plan.
        </p>
      ) : null}

      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">No connectors. The assistant can still collect and confirm, but it cannot do anything else.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((c, i) => (
            <ConnectorCard
              key={`${c.id}-${i}`}
              bp={bp}
              index={i}
              editable={editable}
              relayId={relayId}
              expanded={open === c.id}
              onToggle={() => setOpen(open === c.id ? null : c.id)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ConnectorCard({
  bp, index, editable, relayId, expanded, onToggle,
}: { bp: Blueprint; index: number; editable: boolean; relayId: string; expanded: boolean; onToggle: () => void }) {
  const actions = useSourceActions();
  const diagnostics = usePathDiagnostics([...BASE, index]);
  const c = bp.connectors[index];
  if (!c) return null;

  const at = (...keys: (string | number)[]): Path => [...BASE, index, ...keys];
  const dependents = bp.playbook.stages.filter((s) => s.exit.kind === "connector_succeeded" && s.exit.connector === c.id);

  const remove = () => {
    const warning = dependents.length
      ? ` The ${dependents.map((s) => s.label || s.id).join(" and ")} stage would be left waiting for a connector that no longer exists.`
      : "";
    if (window.confirm(`Remove "${c.label || c.id}"?${warning}`)) actions.applyFormEdits([removeEdit(BASE, index)]);
  };

  return (
    <li className={cn("rounded-lg border", diagnostics.some((d) => d.severity === "error") && "border-destructive/50")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="hover:bg-accent focus-visible:ring-ring/50 -ml-1 min-w-0 flex-1 rounded-md px-1 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="block truncate text-sm font-medium">{c.label || c.id}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {CONNECTOR_TYPE_LABELS[c.type]}
            {"toolName" in c ? ` · ${c.toolName}` : ""}
          </span>
        </button>
        <Button type="button" size="icon" variant="ghost" className="text-destructive size-7" disabled={!editable}
          aria-label={`Remove ${c.label || c.id}`} onClick={remove}>
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>

      {!expanded ? <div className="px-3 pb-2"><DiagnosticText diagnostics={diagnostics} /></div> : null}

      {expanded ? (
        <div className="space-y-4 border-t px-3 py-3">
          <Grid>
            <Row label="Name" path={at("label")} match="exact" hint="Shown on the console.">
              <TextControl path={at("label")} value={c.label} disabled={!editable} maxLength={60} />
            </Row>
            <Row label="Id" path={at("id")} match="exact">
              <TextControl path={at("id")} value={c.id} disabled={!editable} maxLength={40} mono />
            </Row>
          </Grid>

          {"toolName" in c ? (
            <>
              <Row label="Tool name" path={at("toolName")} match="exact" hint="What the assistant calls. Tick it in a stage's tool list to let it.">
                <TextControl path={at("toolName")} value={c.toolName} disabled={!editable} maxLength={40} mono />
              </Row>
              <Row label="When to use it" path={at("description")} match="exact" hint="The assistant reads this to decide whether to call it. Be specific about when NOT to.">
                <TextControl path={at("description")} value={c.description} disabled={!editable} rows={3} maxLength={400} />
              </Row>
            </>
          ) : null}

          <ConnectorBody connector={c} bp={bp} index={index} editable={editable} relayId={relayId} />
        </div>
      ) : null}
    </li>
  );
}

/** The type-specific half. One branch per `ConnectorSchema` member, so a new kind is a compile error here. */
function ConnectorBody({
  connector, bp, index, editable, relayId,
}: { connector: Connector; bp: Blueprint; index: number; editable: boolean; relayId: string }) {
  const at = (...keys: (string | number)[]): Path => [...BASE, index, ...keys];
  const known = secretRefsIn(bp.connectors);
  const disclosures = bp.playbook.disclosures;
  const moneyValues = bp.values.filter((v) => v.type === "money");

  switch (connector.type) {
    case "payment_link":
      return (
        <>
          <Grid cols={3}>
            <Row label="Provider" path={at("provider")} match="exact" hint="The sandbox charges nothing.">
              <SelectControl path={at("provider")} value={connector.provider} options={["polar_sandbox", "mock"] as const}
                labels={{ polar_sandbox: "Polar (sandbox)", mock: "Mock" }} disabled={!editable} />
            </Row>
            <Row label="Amount" path={at("amount")} match="exact" hint="A named money value.">
              <SelectControl path={at("amount")} value={connector.amount}
                options={moneyValues.length ? moneyValues.map((v) => v.id) : [connector.amount]} disabled={!editable} />
            </Row>
            <Row label="Then ask for a signature" path={at("esign")} match="exact">
              <CheckControl path={at("esign")} value={connector.esign} label="Send a document to sign too" disabled={!editable} />
            </Row>
          </Grid>
          <SmsTemplate path={at("smsTemplate")} value={connector.smsTemplate} editable={editable} />
          <DisclosureGate path={at("requiresDisclosure")} value={connector.requiresDisclosure} disclosures={disclosures} editable={editable} />
        </>
      );

    case "esign_mock":
      return (
        <>
          <Row label="Document title" path={at("documentTitle")} match="exact">
            <TextControl path={at("documentTitle")} value={connector.documentTitle} disabled={!editable} maxLength={2400} />
          </Row>
          <SmsTemplate path={at("smsTemplate")} value={connector.smsTemplate} editable={editable} />
          <DisclosureGate path={at("requiresDisclosure")} value={connector.requiresDisclosure} disclosures={disclosures} editable={editable} />
        </>
      );

    case "sms_mock":
      return (
        <>
          <SmsTemplate path={at("template")} value={connector.template} editable={editable} />
          <ParamsNote relayId={relayId} path={at("params")} />
        </>
      );

    case "confirmation":
      return (
        <>
          <Row label="Waits for" path={at("requires")} match="exact" hint="Connector ids that must have succeeded first, comma separated.">
            <CsvListControl path={at("requires")} value={connector.requires} disabled={!editable} max={3}
              placeholder={bp.connectors.filter((x) => x.id !== connector.id).map((x) => x.id).join(", ")} />
          </Row>
          <SmsTemplate path={at("smsTemplate")} value={connector.smsTemplate} editable={editable} />
        </>
      );

    case "lookup_table":
      return (
        <>
          <Grid cols={3}>
            <Row label="Table" path={at("table")} match="exact">
              <TextControl path={at("table")} value={connector.table} disabled={!editable} maxLength={40} mono />
            </Row>
            <Row label="Key column" path={at("keyColumn")} match="exact">
              <TextControl path={at("keyColumn")} value={connector.keyColumn} disabled={!editable} maxLength={40} mono />
            </Row>
            <Row label="Format" path={at("format")} match="exact">
              <SelectControl path={at("format")} value={connector.format} options={["csv", "json"] as const} disabled={!editable} />
            </Row>
          </Grid>
          <p className="text-muted-foreground text-xs">
            The table's rows are {connector.data.length.toLocaleString()} characters of {connector.format.toUpperCase()}, edited in{" "}
            <CodeLink relayId={relayId} path={at("data")}>Code</CodeLink>.
          </p>
        </>
      );

    case "completion_webhook":
      return (
        <>
          <Row label="Your URL" path={at("url")} match="exact" hint="HTTPS only. We sign every delivery.">
            <TextControl path={at("url")} value={connector.url} disabled={!editable} maxLength={300} mono />
          </Row>
          <Row label="What to send" path={at("include")} match="exact" hint="case, qa, payment — comma separated, at least one.">
            <CsvListControl path={at("include")} value={connector.include} disabled={!editable} max={3} placeholder="case, qa" />
          </Row>
          <div>
            <span className="mb-1 block text-sm font-medium">Signing secret</span>
            <SecretRefControl path={at("hmacSecret")} value={connector.hmacSecret} known={known} disabled={!editable}
              emptyLabel="Not set — a cloned relay drops it, and lint K2 asks for it back" />
          </div>
        </>
      );

    case "http_action":
      return (
        <>
          <Grid cols={3}>
            <Row label="Method" path={at("method")} match="exact">
              <SelectControl path={at("method")} value={connector.method} options={["POST", "GET"] as const} disabled={!editable} />
            </Row>
            <Row label="Give up after" path={at("timeoutMs")} match="exact" hint="Milliseconds, 500–5000.">
              <NumberControl path={at("timeoutMs")} value={connector.timeoutMs} disabled={!editable} min={500} max={5000} step={100} />
            </Row>
            <Row label="Changes something" path={at("sideEffect")} match="exact">
              <CheckControl path={at("sideEffect")} value={connector.sideEffect} label="Has a side effect" disabled={!editable}
                hint="Then it may only be called in an act or close stage." />
            </Row>
          </Grid>

          <Row label="Your endpoint" path={at("url")} match="exact" hint="HTTPS on port 443. Private and loopback addresses are refused at call time.">
            <TextControl path={at("url")} value={connector.url} disabled={!editable} maxLength={300} mono />
          </Row>

          <Row
            label="What the assistant may see back"
            path={at("responsePick")}
            match="exact"
            hint="Dotted paths into your JSON response, comma separated. Nothing else reaches the assistant, whatever you return."
          >
            <CsvListControl path={at("responsePick")} value={connector.responsePick} disabled={!editable} max={8} placeholder="status, booking.reference" />
          </Row>

          <div>
            <span className="mb-1 block text-sm font-medium">Signing secret</span>
            <p className="text-muted-foreground mb-1 text-xs">
              We send <code>X-Changeover-Signature: v1=…</code> over the timestamp and the body. Your endpoint verifies it.
            </p>
            <SecretRefControl path={at("hmacSecret")} value={connector.hmacSecret} known={known} disabled={!editable}
              emptyLabel="Not set — unsigned requests" />
          </div>

          <HttpHeaders connector={connector} index={index} known={known} editable={editable} />
          <ParamsNote relayId={relayId} path={at("params")} />
        </>
      );
  }
}

const SmsTemplate = ({ path, value, editable }: { path: Path; value: string; editable: boolean }) => (
  <Row label="Text message" path={path} match="exact" hint="The link itself is appended by the runtime, never by this template.">
    <TextControl path={path} value={value} disabled={!editable} rows={2} maxLength={2400} />
  </Row>
);

const ParamsNote = ({ relayId, path }: { relayId: string; path: Path }) => (
  <p className="text-muted-foreground text-xs">
    The arguments the assistant passes are a JSON Schema object, edited in{" "}
    <CodeLink relayId={relayId} path={path}>Code</CodeLink>.
  </p>
);

function DisclosureGate({
  path, value, disclosures, editable,
}: { path: Path; value: string | null; disclosures: Blueprint["playbook"]["disclosures"]; editable: boolean }) {
  const actions = useSourceActions();
  const diagnostics = usePathDiagnostics(path, "exact");
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-sm font-medium">Refused until a disclosure is accepted</span>
      <select
        aria-label="Required disclosure"
        value={value ?? ""}
        disabled={!editable}
        onChange={(e) => actions.applyFormEdit(path, e.target.value === "" ? null : e.target.value)}
        className="focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">No disclosure required</option>
        {disclosures.map((d) => (
          <option key={d.id} value={d.id}>{d.title || d.id}</option>
        ))}
      </select>
      <DiagnosticText diagnostics={diagnostics} />
    </div>
  );
}

/**
 * Up to four request headers. A value is a plain string **or** a secret reference, so the row carries a small
 * kind switch: picking "A secret" writes `null` first, which is the state lint K2 is about, and the picker
 * underneath is then the only way to fill it.
 */
function HttpHeaders({
  connector, index, known, editable,
}: { connector: Extract<Connector, { type: "http_action" }>; index: number; known: readonly string[]; editable: boolean }) {
  const actions = useSourceActions();
  const base: Path = [...BASE, index, "headers"];
  const headers = connector.headers;

  return (
    <fieldset>
      <div className="flex items-center justify-between">
        <legend className="text-sm font-medium">Headers</legend>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!editable || headers.length >= 4}
          onClick={() => actions.applyFormEdits([appendEdit(base, headers, { name: "X-Api-Key", value: null })])}
        >
          <Plus aria-hidden className="size-4" /> Add header
        </Button>
      </div>
      {headers.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">None. The signature headers are added for you.</p>
      ) : (
        <ul className="mt-2 space-y-3">
          {headers.map((h, hi) => {
            const isSecret = h.value === null || typeof h.value === "object";
            return (
              <li key={`${h.name}-${hi}`} className="rounded-md border p-2">
                <div className="flex flex-wrap items-end gap-2">
                  <Row label="Name" path={[...base, hi, "name"]} match="exact" className="flex-1">
                    <TextControl path={[...base, hi, "name"]} value={h.name} disabled={!editable} maxLength={40} mono />
                  </Row>
                  <div className="min-w-0">
                    <span className="mb-1 block text-sm font-medium">Value</span>
                    <select
                      aria-label={`How the ${h.name} header gets its value`}
                      value={isSecret ? "secret" : "plain"}
                      disabled={!editable}
                      onChange={(e) => actions.applyFormEdit([...base, hi, "value"], e.target.value === "secret" ? null : "")}
                      className="focus-visible:ring-ring/50 rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="plain">Plain text</option>
                      <option value="secret">A secret</option>
                    </select>
                  </div>
                  <Button type="button" size="icon" variant="ghost" className="text-destructive size-9" disabled={!editable}
                    aria-label={`Remove the ${h.name} header`} onClick={() => actions.applyFormEdits([removeEdit(base, hi)])}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </div>
                <div className="mt-2">
                  {isSecret ? (
                    <SecretRefControl
                      path={[...base, hi, "value"]}
                      value={typeof h.value === "object" ? h.value : null}
                      known={known}
                      disabled={!editable}
                      emptyLabel="Not set — cloning dropped it (lint K2)"
                    />
                  ) : (
                    <TextControl path={[...base, hi, "value"]} value={String(h.value ?? "")} disabled={!editable} maxLength={200} mono />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
