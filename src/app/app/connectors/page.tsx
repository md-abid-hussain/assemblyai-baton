/**
 * `/app/connectors` (SAAS §8.4, §8.5). WP20·1 renders the catalog; WP20·3 wires it.
 *
 * **Why the built-ins are listed rather than stubbed.** They are genuinely ready — they ship with every relay
 * (§8.5) — so the page states what the workspace can already do today. The parts that are not wired yet (org
 * secrets over WP16's `/api/secrets`, Allowed hosts over `/api/app/connector-hosts`, the test console) say so
 * in one line each, with the plan they need. A placeholder that pretends to be a feature is worse than one
 * that names its slot.
 */
import type { Metadata } from "next";
import { CreditCardIcon, MailIcon, MessageSquareIcon, TableIcon } from "lucide-react";
import Link from "next/link";

import { Note, PageHeader, Section } from "@/components/app-shell/bits";
import { PLANS } from "@/core/contracts/v3/plans";
import { appPrincipal } from "@/server/read-models/app-guard";

export const metadata: Metadata = { title: "Connectors" };
export const dynamic = "force-dynamic";

const BUILT_INS = [
  { icon: CreditCardIcon, name: "Payment link", body: "Send a checkout link mid-call and confirm it was paid." },
  { icon: MailIcon, name: "Confirmation", body: "Email or read back a confirmation number when the case is ready." },
  { icon: MessageSquareIcon, name: "SMS to the mock phone", body: "Text the customer's handset in the demo." },
  { icon: TableIcon, name: "Lookup table", body: "Answer from a table you supply, with no code." },
] as const;

export default async function ConnectorsPage() {
  const principal = await appPrincipal("/app/connectors");
  const plan = PLANS[principal.plan];
  const httpActions = principal.plan === "pro" || principal.plan === "business";

  return (
    <div className="space-y-7">
      <PageHeader
        title="Connectors"
        description="What a relay can do while it is on the call."
      />

      <Section title="Built in" description="Ready in every relay, on every plan.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {BUILT_INS.map((c) => (
            <li key={c.name} className="bg-card flex gap-3 rounded-xl border p-4">
              <c.icon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{c.name}</p>
                <p className="text-muted-foreground text-xs text-pretty">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Call your own endpoint" description="An HTTP action posts to a URL you own, in any language.">
        <div className="bg-card space-y-2 rounded-xl border p-4">
          <p className="text-sm text-pretty">
            {httpActions
              ? "Your plan includes HTTP actions. Add one from a relay's Configure tab, then add its host to Allowed hosts."
              : `HTTP actions are a Pro feature. You are on ${plan.name}.`}
          </p>
          {httpActions ? null : (
            <Link href="/app/settings/billing" className="inline-block text-sm font-medium underline underline-offset-4">
              See plans →
            </Link>
          )}
        </div>
      </Section>

      <Section title="Secrets and allowed hosts">
        <div className="bg-card space-y-2 rounded-xl border border-dashed p-4">
          <p className="text-sm">Org secrets and the Allowed hosts list arrive in WP20·3.</p>
          <Note>
            Secrets are stored encrypted and never leave the server; a relay refers to one by name, never by
            value. Allowed hosts is the Pro+ list of the domains your HTTP actions may reach.
          </Note>
        </div>
      </Section>
    </div>
  );
}
