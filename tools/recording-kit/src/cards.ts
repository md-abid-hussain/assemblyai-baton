/**
 * cards.ts - render printable role cards (one REP card + one CUSTOMER card per scenario)
 * from data/scenarios/*.json. Output: docs/role-cards.md and docs/role-cards.html.
 *
 * Each card shows only what that actor should know: the rep never sees the customer's
 * private twists (corrections, facts to hold back), the customer never sees the rating result.
 */
import type { Beat, Fact, FactField, FactValue, LoadedScenario, Scenario } from "./scenarios.ts";
import { FIELD_KIND, FIELD_LABEL } from "./scenarios.ts";
import { longDate, money, monthDayYear, signedMoney } from "./util.ts";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const ENUM_TEXT: Record<string, string> = {
  spouse: "spouse", domestic_partner: "domestic partner", child: "child", stepchild: "stepchild", parent: "parent",
  sibling: "sibling", other_relative: "other relative", non_relative_resident: "non-relative, lives in the household",
  non_relative_nonresident: "non-relative, does not live in the household", named_insured: "named insured",
  learner_permit: "learner's permit", provisional: "provisional / probationary license", full: "full license",
  primary: "primary driver", occasional: "occasional driver",
  eligible: "eligible", not_eligible: "not eligible", pending_proof: "eligible once proof is sent",
};

export function formatFact(field: FactField, value: FactValue, s: Scenario): string {
  const kind = FIELD_KIND[field];
  if (field === "driver_dob" && typeof value === "string") return monthDayYear(value);
  if (field === "effective_date" && typeof value === "string") return longDate(value);
  if (kind.t === "state" && typeof value === "string") return `${STATE_NAMES[value] ?? value} (${value})`;
  if (kind.t === "vehicle") {
    if (value === "all") return "all the household cars";
    const v = s.customer.vehicles.find((x) => x.id === value);
    return v ? `${v.year} ${v.make} ${v.model}` : String(value);
  }
  if (kind.t === "money" && typeof value === "number") return field === "premium_new_monthly_usd" ? `${money(value)} / month` : money(value);
  if (kind.t === "signed_money" && typeof value === "number") return `${signedMoney(value)} / month`;
  if (kind.t === "boolean") return value ? "yes" : "no";
  if (kind.t === "enum" && typeof value === "string") return ENUM_TEXT[value] ?? value;
  return String(value);
}

// ------------------------------------------------------------------------------------------ card model

interface CardBeat {
  n: number;
  mine: boolean;
  label: string;
  text: string;
  direction?: string;
  handoff: boolean;
}

interface Card {
  kind: "REP" | "CUSTOMER";
  heading: string;
  youAre: string[];
  sections: { title: string; lines: string[] }[];
  facts?: { label: string; say: string; watch: string }[];
  beats: CardBeat[];
  handoffBox: string[];
}

function beatsFor(s: Scenario, role: "rep" | "customer"): CardBeat[] {
  return s.talk_track.map((b: Beat) => {
    const mine = b.who === role;
    const tags = [b.handoff ? "HAND-OFF" : "", b.advice ? "ADVICE" : "", b.tail ? "TAIL" : ""].filter(Boolean);
    const who = mine ? "YOU" : role === "rep" ? "Customer" : "Rep";
    const out: CardBeat = { n: b.n, mine, label: tags.length ? `${who} [${tags.join(", ")}]` : who, text: b.beat, handoff: !!b.handoff };
    if (mine && b.direction) out.direction = b.direction;
    return out;
  });
}

function summaryLine(s: Scenario): string {
  const lang = s.language === "hinglish" ? "Hinglish" : "English";
  return `${lang} · ${s.difficulty} · aim for ${s.target_duration_s.min}-${s.target_duration_s.max} s · hand-off at beat ${s.handoff.at_beat} (~${s.handoff.approx_at_s} s)`;
}

function repCard(s: Scenario): Card {
  const c = s.customer;
  const facts = Object.entries(s.facts) as [FactField, Fact][];
  const screen = [
    `Policy ${c.policy_number} · carrier ${c.carrier}`,
    `Named insured: ${c.name}, ${c.address.street}, ${c.address.city}, ${c.address.state} ${c.address.zip}`,
    `Drivers on the policy: ${c.existing_drivers.map((d) => `${d.name} (${ENUM_TEXT[d.relation] ?? d.relation})`).join("; ")}`,
    `Vehicles: ${c.vehicles.map((v) => `${v.year} ${v.make} ${v.model} (mostly ${v.primary_driver})`).join("; ")}`,
    `Current premium: ${money(c.current_premium_monthly_usd)} / month`,
  ];
  const quote = facts
    .filter(([, f]) => f.stated_by === "rep")
    .map(([name, f]) => {
      const hold = f.status_at_handoff === "MISSING" ? "  -> do NOT say this before the hand-off" : "";
      return `${FIELD_LABEL[name]}: ${formatFact(name, f.value, s)}${f.say_it ? ` (say: "${f.say_it}")` : ""}${hold}`;
    });
  const rules: string[] = [];
  for (const [name, f] of facts) {
    const label = FIELD_LABEL[name].toLowerCase();
    if (f.status_at_handoff === "MISSING" && f.missing_reason === "not_asked") rules.push(`Do NOT ask about: ${label} (skipping it is the point of this call).`);
    if (f.status_at_handoff === "MISSING" && f.missing_reason === "customer_unsure") rules.push(`Ask about ${label} once; the customer won't know it offhand - move on without it.`);
    if (f.status_at_handoff === "PENDING") rules.push(`Do NOT read back or confirm: ${label} - hand off right after it comes up.`);
    if (f.correction?.said_wrong_by === "rep") {
      rules.push(`When you read back ${label}, get it slightly wrong on purpose ("${formatFact(name, f.correction.initial_value, s)}") - the customer will correct you; then read back the right one.`);
    }
  }
  rules.push("Everything else: acknowledge or read it back before the hand-off, like a careful rep would.");
  rules.push("Start with a recorded-line notice, e.g. \"...this call is recorded for quality and training.\"");
  const advice = s.advice.map((a) => `${a.rep_says}${a.customer_decision ? `  -> outcome: ${a.customer_decision}` : ""}`);
  const h = s.handoff;
  const handoffBox = [
    `At beat ${h.at_beat} (around ${h.approx_at_s} s) say something like: "${h.line}"`,
    h.customer_response === "declines"
      ? `They will decline ("${h.customer_says}"). Say "No problem, I'll finish it with you" and do the TAIL beats yourself, then end the call.`
      : h.customer_response === "accepts_after_question"
        ? `They will ask something first ("${h.customer_says}"). Reassure them in one line, then say "you'll hear them in a second" and END THE CALL.`
        : `They will agree ("${h.customer_says}"). Say "Great - you'll hear them in a second, I'm right here" and END THE CALL.`,
  ];
  const sections = [
    { title: "On your screen (the policy)", lines: screen },
    { title: "Rating result (only say it where the talk track says)", lines: quote.length ? quote : ["(nothing to quote)"] },
    { title: "Advice you must give (in your own words)", lines: advice },
    { title: "Rules for this call", lines: rules },
  ];
  if (s.directions.rep.length) sections.push({ title: "Directions", lines: s.directions.rep });
  if (s.language_notes) sections.push({ title: "Language", lines: [s.language_notes] });
  return {
    kind: "REP",
    heading: `${s.id} · REP card · ${s.title}`,
    youAre: [
      `You are ${s.rep.name}, a licensed customer-service rep at ${s.rep.agency} (${s.rep.agency_city}, ${s.rep.agency_state}). Style: ${s.rep.style}.`,
      "You can use your own first name instead if that feels more natural.",
      summaryLine(s),
    ],
    sections,
    beats: beatsFor(s, "rep"),
    handoffBox,
  };
}

function customerCard(s: Scenario): Card {
  const c = s.customer;
  const facts = Object.entries(s.facts) as [FactField, Fact][];
  const h = s.handoff;
  const factRows = facts
    .filter(([, f]) => f.stated_by === "customer")
    .map(([name, f]) => {
      const watch: string[] = [];
      if (f.correction?.said_wrong_by === "rep") watch.push(`The rep will read it back wrong ("${formatFact(name, f.correction.initial_value, s)}") - correct them: ${f.correction.how}`);
      else if (f.correction) watch.push(`Say it WRONG first ("${formatFact(name, f.correction.initial_value, s)}"), then correct it: ${f.correction.how}`);
      if (f.status_at_handoff === "MISSING" && f.missing_reason === "customer_unsure") {
        watch.push("If the rep asks, say you don't know it offhand (\"I'd have to look that up\"). Don't give it in this call.");
      } else if (f.status_at_handoff === "MISSING") {
        watch.push(h.after === "rep_finishes_tail" ? "Don't mention it before the hand-off. Give it only if the rep asks later." : "Don't mention it at all in this call (the rep won't ask).");
      }
      if (f.status_at_handoff === "PENDING") watch.push("Bring it up only right before the hand-off (see your beats).");
      // f.note is eval-facing (it can contain the answer to a MISSING fact), so it never goes on a card.
      const say = f.missing_reason === "customer_unsure" ? "(you don't know this offhand)" : (f.say_it ?? formatFact(name, f.value, s));
      return { label: FIELD_LABEL[name], say, watch: watch.join(" ") || "-" };
    });
  const sections = [
    {
      title: "Your policy (you roughly know this)",
      lines: [
        `Policy number ${c.policy_number}${c.policy_number_say_it ? ` - say it like "${c.policy_number_say_it}"` : ""} · ${c.carrier}`,
        `Address: ${c.address.street}, ${c.address.city}, ${c.address.state} ${c.address.zip}`,
        `Drivers today: ${c.existing_drivers.map((d) => `${d.name} (${ENUM_TEXT[d.relation] ?? d.relation})`).join("; ")}`,
        `Cars: ${c.vehicles.map((v) => `${v.year} ${v.make} ${v.model} (mostly ${v.primary_driver})`).join("; ")}`,
        `You pay about ${money(c.current_premium_monthly_usd)} a month now.`,
      ],
    },
  ];
  if (s.directions.customer.length) sections.push({ title: "Directions", lines: s.directions.customer });
  if (s.language_notes) sections.push({ title: "Language", lines: [s.language_notes] });
  return {
    kind: "CUSTOMER",
    heading: `${s.id} · CUSTOMER card · ${s.title}`,
    youAre: [`You are ${c.name}. ${c.persona}`, summaryLine(s)],
    sections,
    facts: factRows,
    beats: beatsFor(s, "customer"),
    handoffBox: [
      `Around ${h.approx_at_s} s the rep will ask something like: "${h.line}"`,
      `You answer: "${h.customer_says}"`,
      h.after === "rep_finishes_tail" ? "Then the rep finishes the call with you (follow your TAIL beats)." : "Then the rep ends the call - that's the end of the recording.",
    ],
  };
}

// ------------------------------------------------------------------------------------------ markdown

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function cardMd(card: Card): string {
  const out: string[] = [`### ${card.heading}`, "", ...card.youAre.map((l) => `> ${l}`), ""];
  for (const sec of card.sections) {
    out.push(`**${sec.title}**`, "", ...sec.lines.map((l) => `- ${l}`), "");
  }
  if (card.facts) {
    out.push("**Facts you know (say them naturally when asked)**", "", "| What | Say it like | Watch out |", "|---|---|---|");
    for (const f of card.facts) out.push(`| ${mdEscape(f.label)} | ${mdEscape(f.say)} | ${mdEscape(f.watch)} |`);
    out.push("");
  }
  out.push("**Talk track (loose beats - use your own words)**", "");
  for (const b of card.beats) {
    const text = b.mine ? `**${b.label}:** ${b.text}` : `${b.label}: ${b.text}`;
    out.push(`${b.n}. ${b.handoff ? "★ " : ""}${text}${b.direction ? ` _(${b.direction})_` : ""}`);
  }
  out.push("", "**Hand-off**", "", ...card.handoffBox.map((l) => `- ${l}`), "");
  return out.join("\n");
}

export function renderCardsMarkdown(list: LoadedScenario[]): string {
  const head = [
    "# Baton role cards",
    "",
    "_Generated by `tools/recording-kit` (`kit cards`) from `data/scenarios/*.json`. Do not edit by hand - edit the JSON and regenerate._",
    "",
    "Give the REP card to whoever plays the agency rep and the CUSTOMER card to whoever plays the customer. The beats are a loose guide, not a script: say things your own way. The printable version is `docs/role-cards.html` (one card per page).",
    "",
    indexMd(list),
    "",
  ];
  const body = list.flatMap(({ scenario: s }) => [`## ${s.id} - ${s.title}`, "", cardMd(repCard(s)), cardMd(customerCard(s)), "---", ""]);
  return [...head, ...body].join("\n");
}

function twists(s: Scenario): string {
  const skip = new Set(["baseline", "teen", "college", "spouse", "partner", "parent", "sibling", "stepchild", "other_relative", "non_relative", "hinglish"]);
  return s.tags.filter((t) => !skip.has(t)).join(", ") || "-";
}

function indexMd(list: LoadedScenario[]): string {
  const rows = list.map(({ scenario: s }) =>
    `| ${s.id} | ${mdEscape(s.title)} | ${s.language} | ${s.target_duration_s.min}-${s.target_duration_s.max} s | ${s.handoff.customer_response} | ${mdEscape(twists(s))} | ${s.casting.customer}${s.casting.hindi_needed ? ", Hindi" : ""} |`,
  );
  return ["| ID | Scenario | Lang | Length | Hand-off | Twists | Customer actor |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

// ------------------------------------------------------------------------------------------ html

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cardHtml(card: Card, s: Scenario): string {
  const secs = card.sections.map((sec) => `<h3>${esc(sec.title)}</h3><ul>${sec.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`).join("");
  const facts = card.facts
    ? `<h3>Facts you know (say them naturally when asked)</h3><div class="scroll"><table><thead><tr><th>What</th><th>Say it like</th><th>Watch out</th></tr></thead><tbody>${card.facts
        .map((f) => `<tr><td>${esc(f.label)}</td><td><b>${esc(f.say)}</b></td><td>${esc(f.watch)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  const beats = `<h3>Talk track (loose beats, your own words)</h3><ol class="beats">${card.beats
    .map(
      (b) =>
        `<li class="${b.mine ? "mine" : "theirs"}${b.handoff ? " handoff" : ""}"><span class="who">${esc(b.label)}</span> ${esc(b.text)}${b.direction ? ` <i>(${esc(b.direction)})</i>` : ""}</li>`,
    )
    .join("")}</ol>`;
  return `<section class="card ${card.kind === "REP" ? "rep" : "cust"}">
<header><div class="badge">${card.kind}</div><h2>${esc(s.id)} · ${esc(s.title)}</h2></header>
<div class="youare">${card.youAre.map((l) => `<p>${esc(l)}</p>`).join("")}</div>
<div class="handoff-box"><b>Hand-off</b><ul>${card.handoffBox.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>
${secs}${facts}${beats}
</section>`;
}

export function renderCardsHtml(list: LoadedScenario[]): string {
  const index = list
    .map(
      ({ scenario: s }) =>
        `<tr><td>${esc(s.id)}</td><td>${esc(s.title)}</td><td>${esc(s.language)}</td><td>${s.target_duration_s.min}-${s.target_duration_s.max} s</td><td>${esc(s.handoff.customer_response)}</td><td>${esc(twists(s))}</td><td>${esc(s.casting.customer)}${s.casting.hindi_needed ? ", Hindi" : ""}</td></tr>`,
    )
    .join("");
  const cards = list.map(({ scenario: s }) => cardHtml(repCard(s), s) + cardHtml(customerCard(s), s)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baton role cards</title>
<style>
  :root { --ink:#1d2330; --muted:#5b6475; --line:#d9dde5; --rep:#1f5fbf; --cust:#b4461f; --hand:#fff4d6; --bg:#ffffff; }
  * { box-sizing: border-box; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin: 0; padding: 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .note { color: var(--muted); margin: 0 0 12px; max-width: 70ch; }
  .scroll { overflow-x: auto; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #f3f5f8; }
  .card { border: 2px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 16px 0; break-after: page; page-break-after: always; max-width: 900px; }
  .card.rep { border-color: var(--rep); } .card.cust { border-color: var(--cust); }
  header { display: flex; gap: 10px; align-items: center; }
  header h2 { font-size: 17px; margin: 0; }
  .badge { font-weight: 700; color: #fff; border-radius: 6px; padding: 2px 8px; font-size: 12px; letter-spacing: .04em; }
  .rep .badge { background: var(--rep); } .cust .badge { background: var(--cust); }
  .youare p { margin: 4px 0; } .youare p:first-child { font-weight: 600; }
  h3 { font-size: 14px; margin: 12px 0 4px; }
  ul { margin: 2px 0 6px 18px; padding: 0; } li { margin: 2px 0; }
  .handoff-box { background: var(--hand); border-radius: 8px; padding: 6px 10px; margin: 8px 0; }
  .beats li.theirs { color: var(--muted); }
  .beats li.mine .who { font-weight: 700; }
  .beats li.handoff { background: var(--hand); border-radius: 4px; }
  .who { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; margin-right: 4px; }
  @media print { body { padding: 0; font-size: 12px; } .card { border-width: 1px; margin: 0; } .index { break-after: page; page-break-after: always; } }
</style></head>
<body>
<div class="index">
<h1>Baton role cards</h1>
<p class="note">Generated from data/scenarios/*.json by the recording kit (kit cards). One REP card and one CUSTOMER card per scenario, each on its own printed page. Beats are a loose guide: use your own words. Everything here is fictional.</p>
<div class="scroll"><table><thead><tr><th>ID</th><th>Scenario</th><th>Lang</th><th>Length</th><th>Hand-off</th><th>Twists</th><th>Customer actor</th></tr></thead><tbody>${index}</tbody></table></div>
</div>
${cards}
</body></html>
`;
}
