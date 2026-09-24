/**
 * Build/version marker shown by `/api/health` (no secrets; no external calls).
 * Zerops exposes the deploy's app version through env when available; otherwise the package version.
 */
export const APP_NAME = "baton";
export const APP_VERSION = "0.1.0";

export function versionString(env: Record<string, string | undefined> = {}): string {
  const build = env.ZEROPS_APP_VERSION ?? env.VERCEL_GIT_COMMIT_SHA ?? env.BUILD_ID ?? null;
  return build ? `${APP_VERSION}+${build.slice(0, 12)}` : APP_VERSION;
}
