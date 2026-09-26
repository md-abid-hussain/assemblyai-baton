"use client";
/**
 * components/studio/configure/secret-ref.tsx - the secret-reference picker (SAAS §5.5, §5.6).
 *
 * A blueprint never holds a secret. It holds `{ $secret: "sec_…" }`, and the value lives in the org's secret store
 * where the runtime resolves it — which is also why cloning a relay leaves `null` behind (`SecretRebinder`, lint
 * K2): the new org has the header but not the value, and something has to point it at one of theirs.
 *
 * That `null` is the case this control exists for. The picker offers **the ids this blueprint already references**
 * (there is no "list my secrets" endpoint in the browser yet, and inventing one would put the org's secret names
 * on a page that does not need them), plus a checked free-text box for an id the builder knows.
 *
 * It refuses to write anything that is not a `sec_<16>` id, because a typo here becomes a runtime failure on a
 * live call rather than a red squiggle.
 */
import { useState } from "react";

import { SECRET_ID_RE, pathKey, type Path } from "@/client/studio/configure";
import { useSourceActions } from "@/client/studio/use-source-store";
import type { SecretRef } from "@/core/contracts/v2/blueprint";

import { DiagnosticText, usePathDiagnostics } from "./controls";

const INPUT =
  "focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

const OTHER = "\u0000other";

export interface SecretRefControlProps {
  path: Path;
  value: SecretRef | null;
  /** Ids already used somewhere in this blueprint (`secretRefsIn`). */
  known: readonly string[];
  disabled?: boolean;
  /** "Not set" is a lint error for an HMAC secret, so the label says so where it is true. */
  emptyLabel?: string;
}

export function SecretRefControl({ path, value, known, disabled, emptyLabel = "Not set" }: SecretRefControlProps) {
  const actions = useSourceActions();
  const diagnostics = usePathDiagnostics(path, "subtree");
  const current = value?.$secret ?? null;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const options = current && !known.includes(current) ? [current, ...known] : known;
  const valid = SECRET_ID_RE.test(draft.trim());

  return (
    <div className="min-w-0">
      <select
        id={pathKey(path)}
        value={typing ? OTHER : (current ?? "")}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) {
            setTyping(true);
            return;
          }
          setTyping(false);
          actions.applyFormEdit(path, v === "" ? null : { $secret: v });
        }}
        className={INPUT}
      >
        <option value="">{emptyLabel}</option>
        {options.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
        <option value={OTHER}>Another secret id…</option>
      </select>

      {typing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            placeholder="sec_0123456789abcdef"
            aria-label="Secret id"
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            className={`${INPUT} font-mono text-xs sm:w-64`}
          />
          <button
            type="button"
            disabled={disabled || !valid}
            onClick={() => {
              actions.applyFormEdit(path, { $secret: draft.trim() });
              setTyping(false);
              setDraft("");
            }}
            className="hover:bg-accent rounded-md border px-2 py-1.5 text-xs disabled:opacity-50"
          >
            Use it
          </button>
          {draft && !valid ? (
            <span className="text-muted-foreground text-xs">A secret id is <code>sec_</code> and sixteen lowercase letters or digits.</span>
          ) : null}
        </div>
      ) : null}

      <DiagnosticText diagnostics={diagnostics} />
    </div>
  );
}
