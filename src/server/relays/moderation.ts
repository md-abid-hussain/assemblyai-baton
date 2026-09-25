import "server-only";

import type { Blueprint } from "../../core/contracts/v2";

/**
 * Moderation of stranger-authored relay text (PLATFORM §7.4, P14): once per version, before its first Test run or
 * Publish; the result is stored in `relay_versions.moderation`. WP14b·1 provides the port and the text selection; the
 * OpenAI `omni-moderation-latest` implementation (free endpoint, through the OpenAI client and ledger) is WP14b·2.
 */
export interface Moderator {
  check(text: string): Promise<{ flagged: boolean; categories: string[] }>;
}

/**
 * The author-written text a version speaks or shows: title, tagline, org names, greeting, disclosures, persona, stage
 * goals, SMS templates, the handoff lines. One string, one line per item, de-duplicated.
 */
export function moderationText(bp: Blueprint): string {
  const out: string[] = [bp.meta.title, bp.meta.tagline, bp.meta.intent.summary];
  for (const s of bp.context.samples) out.push(s.org.name);
  const g = bp.playbook.greeting;
  out.push(g.opening, g.summary, ...g.clauses.map((c) => c.text), g.optOut, g.next.confirm, g.next.ask, g.next.ready);
  for (const d of bp.playbook.disclosures) out.push(d.title, d.text);
  out.push(bp.playbook.persona.tone, ...bp.playbook.persona.extraRules);
  if (bp.playbook.promptTemplate) out.push(bp.playbook.promptTemplate);
  for (const st of bp.playbook.stages) out.push(st.goal);
  for (const c of bp.connectors) {
    if ("smsTemplate" in c) out.push(c.smsTemplate);
    if (c.type === "sms_mock") out.push(c.template);
    if (c.type === "esign_mock") out.push(c.documentTitle);
  }
  out.push(bp.handoff.repLine, bp.handoff.repReturnLine);
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].join("\n");
}
