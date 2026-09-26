import "server-only";

/**
 * `src/server/read-models` (SAAS §6.2). WP20·1.
 *
 * One read path for the runs, cases, relays and org data that both `/app/**` (WP20) and `/api/v1/**` (WP22)
 * show. The rule that makes this worth a barrel: **a page never writes its own query.** Two queries for the same
 * rows means two places a tenancy fix has to land, and one of them will be missed.
 */
export {
  decodeAuditCursor, distinctActions, encodeAuditCursor, loadAudit, metadataDetail,
} from "./audit";
export { CasesReadModel, caseRecordOf, casesReadModel, reasonSentence } from "./cases";
export { loadClaimCard } from "./claim";
export { RunDetailReadModel, provenanceOf, qaStatusOf, runDetailReadModel } from "./detail";
export {
  OverviewReadModel, RECENT_RUNS, checklistFrom, meterFrom, overviewReadModel, type ChecklistSignals,
} from "./overview";
export {
  activeOrgOf, hasOrgDirectory, legacyOrgSummary, orgSummariesFor, planLabel, setOrgDirectory, viewerOf,
  type OrgDirectory,
} from "./orgs";
export { inviteLink, loadMembers, roleOptions } from "./members";
export { loadInvite } from "./invite";
export { loadOrgSettings, ownedOrgCount } from "./org-settings";
export { currentSessionId, loadProfile } from "./profile";
export { RelaysReadModel, relaysReadModel } from "./relays";
export {
  DEFAULT_LIMIT, MAX_LIMIT, RunsReadModel, decodeCursor, encodeCursor, qaOf, runsReadModel,
} from "./runs";
export { loadShell, type ShellData } from "./shell";
export { casesHaveOrgId, casesOrgFilter, relayWorkspaceOf, resetSchemaProbe, visitorIdOfWorkspace } from "./tenant";
