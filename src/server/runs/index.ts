import "server-only";

import { getDb } from "../db/client";
import { getDbAuthority, getLimitsAuthority, limitsConfigFromEnv } from "../limits/index";
import { DbRunService } from "./run-service";

/** The process's RunService on the configured authority (routes #5a/#5b). */
export function getRunService(): DbRunService {
  return new DbRunService({ db: getDb(), authority: getLimitsAuthority(), dbAuthority: getDbAuthority(), cfg: limitsConfigFromEnv() });
}

export { DbRunService } from "./run-service";
export { getCallEntry, registerCallLookup, type CallLookup } from "./calls";
export { loadCaseRow, saveRunPlan } from "./case-port";
