/**
 * contracts/ext/wp20-app.ts - the app-shell and read-model view types (TASKS §0.2: WP-local types go in ext/).
 *
 * These are the shapes the `/app` pages hand to their components. They live in `src/core` for one reason: a
 * component under `src/components/**` may never import `src/server/**` (DESIGN §3.1, enforced by
 * `tests/unit/boundaries.test.ts`), so the read models (`src/server/read-models/**`, SAAS §6.2) and the
 * presentational components have to meet on a pure type.
 *
 * Nothing here touches the DB, the network or the environment: pure data, pure functions, deterministic
 * formatting (SSR and the client must agree, so every formatter is locale- and timezone-free).
 *
 * WP22 wraps `RunListItem` / `RunDetail` / `CaseRecordView` in `RunV1` / `CaseV1` for `/api/v1` (SAAS §6.2);
 * this file is the single source of truth for the fields.
 */
import type { DisclosureKind, Evidence, FieldId, FieldStatus } from "../case";
import type { QaResult } from "../events";
import { RUN_SOURCES, type ProvenanceStrip } from "../v2/api";
import type { OrgKind, PlanId, Role } from "../v3/identity";

// ------------------------------------------------------------------------------------------------------ runs

/** `recorded | simulated | text_dry_run | published` (PLATFORM §7.6); the v2 constant is the source of truth. */
export type RunSource = (typeof RUN_SOURCES)[number];
export { RUN_SOURCES };

/** A run that has not ended yet has no takeover outcome; the list still shows it. */
export const RUN_OUTCOMES = ["completed", "handed_back", "abandoned", "failed", "in_progress"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const SOURCE_LABEL: Readonly<Record<RunSource, string>> = Object.freeze({
  recorded: "Recorded",
  simulated: "Simulated",
  text_dry_run: "Text dry run",
  published: "Published",
});

/** The one-line explanation under a source badge; the provenance strip carries the full detail. */
export const SOURCE_HINT: Readonly<Record<RunSource, string>> = Object.freeze({
  recorded: "A recorded role-play call, transcribed for real.",
  simulated: "A simulated call: synthetic voices, fictional people.",
  text_dry_run: "A text-only dry run: no audio, no voice agent.",
  published: "A live call against a published agent.",
});

export const OUTCOME_LABEL: Readonly<Record<RunOutcome, string>> = Object.freeze({
  completed: "Completed",
  handed_back: "Handed back",
  abandoned: "Abandoned",
  failed: "Failed",
  in_progress: "In progress",
});

/** One row of `/app/runs` and of the overview's "recent runs". */
export interface RunListItem {
  /** The case id; also the run id everywhere in the public API (SAAS §6.2). */
  id: string;
  relayId: string | null;
  relayTitle: string;
  relayVersion: number | null;
  source: RunSource;
  outcome: RunOutcome;
  /** `cases.status`, kept separate from the takeover outcome so an un-armed run still reads honestly. */
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  aiSeconds: number | null;
  /** Verified fields / required fields at the end of the run. */
  readiness: { verified: number; requiredTotal: number } | null;
  /** `verifications.status`: a run whose QA is still `pending` shows its provisional numbers. */
  qaProvisional: boolean;
  paymentStatus: string | null;
  simulated: boolean;
}

export interface RunPage {
  items: RunListItem[];
  /** Opaque `(created_at, id)` cursor, base64url (SAAS §6.3). Null when the page is the last one. */
  nextCursor: string | null;
}

/** `/app/runs` filters. Everything is optional; an absent field means "no constraint". */
export interface RunFilter {
  relayId?: string | undefined;
  source?: RunSource | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`) in UTC. */
  since?: string | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`) in UTC; the read model widens it to the end of that day. */
  until?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

// ------------------------------------------------------------------------------------- the case record (detail)

export interface EvidenceView {
  channel: Evidence["channel"];
  startMs: number;
  endMs: number;
  quote: string;
  /** `stt_cache` | `stt_live` | `va_transcript` | … — shown as a footnote, never as a claim of liveness. */
  source: string;
}

export interface FieldRowView {
  field: FieldId;
  label: string;
  status: FieldStatus;
  /** True when the field is in conflict; the chip shows CONFLICT rather than the raw status. */
  conflict: boolean;
  /** Human-readable value (`display` when the extractor set one, else the raw value). */
  value: string | null;
  /** "acknowledged by the customer at 01:12" — WP7's `reasonText`, resolved server-side. */
  reason: string;
  evidence: EvidenceView[];
  required: boolean;
}

export interface DisclosureRowView {
  kind: DisclosureKind;
  given: boolean;
  /** From the verified QA result; null when QA has not run. */
  similarity: number | null;
  ok: boolean | null;
  missingCritical: string[];
}

/** The evidence-linked case record of SAAS §6.2 (`CaseV1`), read-only. */
export interface CaseRecordView {
  caseId: string;
  intent: string;
  stage: string | null;
  readiness: { verified: number; pending: number; missing: number; requiredTotal: number; ready: boolean };
  fields: FieldRowView[];
  disclosures: DisclosureRowView[];
  confirmationNumber: string | null;
}

export interface PaymentSummaryView {
  id: string;
  status: string;
  amountCents: number;
  totalAmountCents: number | null;
  provider: string;
  simulated: boolean;
  statusSource: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export interface RunDetail {
  run: RunListItem;
  provenance: ProvenanceStrip;
  /** `verifications.qa` when it exists, else `takeovers.metrics.provisionalQa`. */
  qa: QaResult | null;
  qaStatus: "verified" | "provisional" | "pending" | "none";
  payment: PaymentSummaryView | null;
  caseRecord: CaseRecordView | null;
  /** The Baton console for this run, when it can be replayed. */
  consoleHref: string | null;
}

// -------------------------------------------------------------------------------------------------- analytics

export interface SourceCount {
  source: RunSource;
  runs: number;
  aiMinutes: number;
}

export interface OutcomeCount {
  outcome: RunOutcome;
  runs: number;
}

/**
 * `/app/analytics`. Recorded and simulated runs are counted separately and **never blended** (SAAS §8.5,
 * PLATFORM §7.6): there is no "total success rate" field here on purpose.
 */
export interface AnalyticsView {
  totalRuns: number;
  bySource: SourceCount[];
  byOutcome: OutcomeCount[];
  firstRunAt: string | null;
  lastRunAt: string | null;
  /** How many days of history the plan keeps (`PLANS[plan].limits.analyticsDays`). */
  windowDays: number;
}

// ----------------------------------------------------------------------------------- overview (meter, relays)

export interface MinutesMeterView {
  plan: PlanId;
  usedMinutes: number;
  allowanceMinutes: number;
  byProvenance: { recorded: number; simulated: number; published: number };
  /** `YYYY-MM` of the period the numbers cover. */
  period: string;
  /**
   * Where the numbers came from. `runs` = derived from this org's runs by WP20's read model; `metered` = the
   * WP21 usage meter. The UI says so, because a derived number is not a billing number.
   */
  basis: "runs" | "metered";
}

export interface RelayCardView {
  id: string;
  slug: string;
  title: string;
  industry: string;
  flagship: boolean;
  /** Pinned into this org rather than owned by it (Baton for guest and personal orgs; SAAS §3.3 step 5). */
  pinned: boolean;
  versionCount: number;
  lintErrors: number;
  lastRunAt: string | null;
  updatedAt: string;
}

export const CHECKLIST_IDS = [
  "watch_handoff",
  "try_edit",
  "open_code",
  "publish",
  "create_account",
  "upgrade",
  "api_key",
  "webhook",
] as const;
export type ChecklistId = (typeof CHECKLIST_IDS)[number];

/** SAAS §8.3: derived from data, no new table. Each item deep-links to its screen. It is the judge path. */
export interface ChecklistItemView {
  id: ChecklistId;
  label: string;
  href: string;
  done: boolean;
  /** Shown when the item cannot be done yet (e.g. "Create an account first"). */
  blockedReason: string | null;
}

export interface OverviewData {
  checklist: ChecklistItemView[];
  meter: MinutesMeterView;
  recentRuns: RunListItem[];
  relays: RelayCardView[];
  totalRuns: number;
}

// --------------------------------------------------------------------------------------------- the app shell

export interface ViewerSummary {
  /** Null for a device-only visitor with no account at all. */
  userId: string | null;
  name: string;
  email: string | null;
  /** True for a visitor or an anonymous (guest) account: both see the guest banner. */
  isGuest: boolean;
  role: Role | null;
  plan: PlanId;
}

// ------------------------------------------------------------------------------------------------- formatting

/** `2026-09-26` → `26 Sep 2026`. UTC and locale-free, so the server and the client always agree. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `26 Sep 2026, 14:03 UTC`. */
export function formatUtcDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(iso)}, ${hh}:${mm} UTC`;
}

/** `183000` → `3:03`. Null → `—`. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Minutes with one decimal below 10, whole above: `0.4 min`, `12 min`. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, minutes);
  return m < 10 ? `${Math.round(m * 10) / 10} min` : `${Math.round(m)} min`;
}

export const secondsToMinutes = (seconds: number): number => Math.round((seconds / 60) * 100) / 100;

/** `YYYY-MM-DD` in UTC, for the date filters and the `usage` period. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** True when `s` is a plain `YYYY-MM-DD` that `Date` accepts. Used to reject junk in the query string. */
export function isUtcDay(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ------------------------------------------------------------------------------- query-string parsing (WP20)

/**
 * These two live here rather than beside the pages that use them because **a Next page module may export only
 * the page and its route config** — an extra export is a build error. They are pure and they are tested, which
 * is the reason to keep them out of a page anyway.
 */

/** One value out of a `searchParams` entry, length-capped so a junk URL cannot become a large parameter. */
export function oneParam(v: string | string[] | undefined, max = 256): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 && s.length <= max ? s : undefined;
}

/** Everything `/app/runs`'s query string is allowed to say. Anything else is dropped silently, never a 400. */
export function parseRunFilter(search: Record<string, string | string[] | undefined>): RunFilter {
  const source = oneParam(search.source);
  const since = oneParam(search.since);
  const until = oneParam(search.until);
  return {
    relayId: oneParam(search.relayId),
    source: (RUN_SOURCES as readonly string[]).includes(source ?? "") ? (source as RunSource) : undefined,
    since: isUtcDay(since) ? since : undefined,
    until: isUtcDay(until) ? until : undefined,
    cursor: oneParam(search.cursor, 512),
  };
}

/**
 * `/start?next=…`: only a same-origin path is ever followed.
 *
 * `next` arrives in a URL that anyone can hand to anyone — "click this to see my workspace" is the whole point
 * of it — so it is the textbook open-redirect vector. A value is accepted only when it is a single leading
 * slash followed by something that is not another slash or a backslash; that rejects `//evil.example` and
 * `/\evil.example`, which browsers resolve as protocol-relative URLs. Anything else becomes `/app`.
 */
export function safeNextPath(raw: string | string[] | undefined): string {
  const value = oneParam(raw, 512);
  if (value === undefined) return "/app";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  // Control characters (a CR/LF smuggled into a header or a log line) are never part of a real path.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/app";
  return value;
}

/**
 * The `/start` loop breaker (SAAS §3.3 step 2).
 *
 * `/start` sets it just before navigating back; the `/app` guard reads it. It exists because
 * `POST /api/guest/start` is allowed to come back degraded — Better Auth not configured for the deployment,
 * or the step 2 rate limit — leaving `/app` with no org. Without the marker, `/app` redirects to `/start`,
 * `/start` returns with no org, and `/app` redirects again: an infinite loop caused by a degradation the spec
 * explicitly calls non-blocking.
 *
 * It carries no authority. The worst a forged value can do is put the visitor on the read-only device
 * workspace they already had. It lives here because both a client component and a server module read it.
 */
export const START_ATTEMPT_COOKIE = "cx_start_attempt";

// ==================================================================================== WP20·2: auth + settings
//
// Everything below is the WP20·2 surface: the auth pages, Members, Organization, Profile, the audit viewer and
// the two v3.1 cards. Same rule as above — pure data and pure functions, because the read models
// (`src/server/read-models/**`) and the components (`src/components/{auth,settings}/**`) may only meet on a type.

/** The four roles as words a member reads. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = Object.freeze({
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
});

/** SAAS §3.7's matrix in one sentence each. "Members build, admins ship" is the shape to keep. */
export const ROLE_HINT: Readonly<Record<Role, string>> = Object.freeze({
  owner: "Everything, including billing, deleting the workspace and transferring it.",
  admin: "Build, publish, invite, manage members, secrets and keys. No billing changes.",
  member: "Build relays and run them. Cannot publish, invite or change secrets.",
  viewer: "Read-only: relays, runs and analytics.",
});

// ------------------------------------------------------------------------------------------ members + invites

export interface MemberRowView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
  /** The viewer's own row: it gets "You" and a Leave action instead of Remove. */
  isSelf: boolean;
  /**
   * The only owner left. The row's role select and Remove are disabled: the product must never produce an
   * ownerless org, and saying why beats a 409 from the server after the click.
   */
  isLastOwner: boolean;
}

export interface InviteRowView {
  id: string;
  email: string;
  role: Role;
  /**
   * The absolute `<APP_URL>/accept-invite/<id>` (SAAS §3.6); the page only copies it.
   *
   * **Optional because it is a credential**, mirroring `InvitationView.link` in `v3/identity.ts`: present only
   * for a caller holding `member:invite`. Everyone with `member:read` still sees the row — who, what role, who
   * invited them, when it expires — but not the URL that joins the org. Render the copy control on presence;
   * never rebuild the URL from `id` on the client.
   */
  link?: string;
  expiresAt: string;
  invitedBy: string;
  expired: boolean;
}

/** Settings to Members and invites (SAAS §8.4). Every permission is resolved server-side by `can()`. */
export interface MembersView {
  orgId: string;
  orgName: string;
  plan: PlanId;
  members: MemberRowView[];
  invitations: InviteRowView[];
  /** Members plus pending invites, against `PLANS[plan].limits.seats` (SAAS §4.1). */
  seatsUsed: number;
  seatLimit: number;
  canInvite: boolean;
  canManage: boolean;
  /** Roles the viewer may hand out — never above their own (SAAS §3.7). */
  assignable: readonly Role[];
  /**
   * The viewer's own role. The page needs it for one rule the permission matrix states in a footnote rather
   * than in a permission: **an admin may never change or remove an owner** (§3.7). `member:manage` is true for
   * both roles, so without this the page would offer an admin a control the route is about to refuse.
   */
  viewerRole: Role | null;
  /**
   * The viewer is a guest. Inviting needs an account (§3.3), so the form renders for real and is disabled
   * behind the §8.5 upgrade card rather than replaced by an error.
   */
  accountRequired: boolean;
  viewerUserId: string | null;
}

// ----------------------------------------------------------------------------------------------- the org page

export interface TransferTargetView {
  userId: string;
  name: string;
  email: string;
}

/** Settings to Organization (SAAS §8.4, §3.5). */
export interface OrgSettingsView {
  id: string;
  name: string;
  slug: string;
  kind: OrgKind;
  plan: PlanId;
  createdAt: string | null;
  memberCount: number;
  ownerCount: number;
  canUpdate: boolean;
  canDelete: boolean;
  /** Owner only, and only when there is an admin to transfer to (SAAS §3.5). */
  canTransfer: boolean;
  /** Any member except the last owner (SAAS §3.5). */
  canLeave: boolean;
  transferTargets: TransferTargetView[];
  accountRequired: boolean;
}

// ------------------------------------------------------------------------------------------------- the profile

/**
 * One active session (SAAS §8.4, §3.10). **No IP address, raw or otherwise** — §10.5 keeps raw IPs out of
 * everything the product shows, and a device label plus a date is what a person actually needs to recognise a
 * session they should revoke.
 */
export interface SessionRowView {
  id: string;
  createdAt: string;
  expiresAt: string;
  device: string;
  current: boolean;
}

export interface ProfileView {
  userId: string | null;
  name: string;
  email: string | null;
  createdAt: string | null;
  isGuest: boolean;
  /** `credential` (email + password), `github`, ... — the provider ids of the linked accounts. */
  providers: string[];
  hasPassword: boolean;
  sessions: SessionRowView[];
}

// -------------------------------------------------------------------------------------------------- audit log

export interface AuditRowView {
  id: string;
  occurredAt: string;
  actorType: "user" | "guest" | "api_key" | "system";
  /** Frozen at write time (SAAS §9), so a rename or a deletion never rewrites history. */
  actorLabel: string;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  /** Metadata rendered as `key=value` pairs, already filtered to the safe keys. */
  detail: string | null;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  since?: string;
  until?: string;
  cursor?: string;
}

export interface AuditPage {
  rows: AuditRowView[];
  nextCursor: string | null;
  /** `PLANS[plan].limits.auditRetentionDays`, for the retention note the page is required to show. */
  retentionDays: number;
  /** The distinct actions present in this org's log, for the filter select. Never the whole vocabulary. */
  actions: string[];
  filter: AuditFilter;
}

export const AUDIT_PAGE_SIZE = 50;

/** `member.role_changed` to `Member role changed`. Deterministic, so SSR and the client agree. */
export function auditActionLabel(action: string): string {
  const dot = action.indexOf(".");
  const subject = dot < 0 ? action : action.slice(0, dot);
  const rest = dot < 0 ? "" : action.slice(dot + 1).replace(/_/g, " ");
  const noun = subject === "apikey" ? "API key" : subject === "org" ? "Organization" : subject;
  const head = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
  return rest ? `${head} ${rest}` : head;
}

/** Everything the audit page's query string is allowed to say. Junk is dropped, never a 400. */
export function parseAuditFilter(search: Record<string, string | string[] | undefined>): AuditFilter {
  const since = oneParam(search.since);
  const until = oneParam(search.until);
  return {
    actor: oneParam(search.actor, 200),
    action: oneParam(search.action, 64),
    since: isUtcDay(since) ? since : undefined,
    until: isUtcDay(until) ? until : undefined,
    cursor: oneParam(search.cursor, 512),
  };
}

// ------------------------------------------------------------------------------------------------ invitations

export type InviteStatus = "pending" | "accepted" | "expired" | "canceled" | "unknown";

/**
 * What `/accept-invite/[id]` shows, including to a signed-out visitor (SAAS §3.6).
 *
 * The email is carried twice on purpose. `emailMasked` is what the card *displays*, because a link that leaks
 * would otherwise also hand over the invitee's address to whoever found it; `emailPrefill` is what the sign-up
 * form's field is set to, which §3.6 asks for and which the holder of the link needs to create the account the
 * invitation is actually for. Better Auth still refuses an accept whose session email differs, so neither value
 * is what makes the invitation safe.
 */
export interface InviteCardView {
  id: string;
  orgName: string;
  role: Role;
  emailMasked: string;
  emailPrefill: string;
  expiresAt: string;
  status: InviteStatus;
}

/** `ada.lovelace@example.com` to `ad********@example.com`, with dots. Never reversible. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${"•".repeat(Math.max(3, Math.min(10, local.length - head.length)))}${domain}`;
}

// --------------------------------------------------------------------------------- the shared-device claim card

/** SAAS §2.6 R1. `offer` is false when there is nothing claimable or the pair already declined. */
export interface ClaimCardView {
  offer: boolean;
  orgName: string;
  cases: number;
  relays: number;
  drafts: number;
}

/** "2 relays, 1 run" — the counts the card names, in the spec's own order, pluralised and never "0 x". */
export function claimCountsSentence(v: Pick<ClaimCardView, "cases" | "relays" | "drafts">): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(v.relays, "relay", "relays");
  add(v.cases, "run", "runs");
  add(v.drafts, "draft", "drafts");
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// -------------------------------------------------------------------------------------------- form validation
//
// These run in the browser for the instant message and again on the server, which owns the decision. They exist
// here so the two can never disagree about what "too short" means.

/** SAAS §3.2. */
export const PASSWORD_MIN_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length === 0) return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `At least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > 128) return "At most 128 characters.";
  return null;
}

/**
 * Deliberately permissive: one `@`, something on each side, no spaces. A stricter pattern rejects addresses that
 * are valid, and with `EMAIL_MODE=off` there is no confirmation mail to be the real authority.
 */
export function emailProblem(email: string): string | null {
  const v = email.trim();
  if (v.length === 0) return "Enter an email address.";
  if (v.length > 254) return "That address is too long.";
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) return "That does not look like an email address.";
  return null;
}

export function orgNameProblem(name: string): string | null {
  const v = name.trim();
  if (v.length === 0) return "Enter a workspace name.";
  if (v.length > 80) return "At most 80 characters.";
  return null;
}

/** Lowercase, `a-z0-9-`, no leading, trailing or doubled dashes. The same shape WP19's `slugify` produces. */
export function slugProblem(slug: string): string | null {
  const v = slug.trim();
  if (v.length === 0) return "Enter a slug.";
  if (v.length < 3) return "At least 3 characters.";
  if (v.length > 48) return "At most 48 characters.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) return "Lowercase letters, numbers and single dashes only.";
  return null;
}

/** What the slug field does as you type, so the rule is visible instead of being a rejection afterwards. */
export const sanitizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/**
 * A user-agent string as a short device label ("Chrome on Windows").
 *
 * It is a heuristic and it is allowed to be wrong; the date beside it is what identifies a session in practice.
 * Order matters: Edge and Opera both claim Chrome, and Chrome claims Safari, so the most specific wins.
 */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua || ua.trim().length === 0) return "Unknown device";
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua)
      ? "Opera"
      : /\bFirefox\//.test(ua)
        ? "Firefox"
        : /\bChrome\/|\bCriOS\//.test(ua)
          ? "Chrome"
          : /\bSafari\//.test(ua)
            ? "Safari"
            : null;
  const os = /\bWindows\b/.test(ua)
    ? "Windows"
    : /\b(iPhone|iPad|iPod)\b/.test(ua)
      ? "iOS"
      : /\bAndroid\b/.test(ua)
        ? "Android"
        : /\bMac OS X\b|\bMacintosh\b/.test(ua)
          ? "macOS"
          : /\bLinux\b/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
