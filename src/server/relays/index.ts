import "server-only";

import type { RateLimiter } from "../../core/contracts/services";
import { workspaceOf, type CompiledRelayView, type Blueprint, type LintIssue } from "../../core/contracts/v2";
import { requireVisitor } from "../auth/visitor";
import { getDb, type Db } from "../db/client";
import { getRateLimiter } from "../limits";
import { log } from "../log";
import type { RelayKernel } from "./kernel";
import type { Moderator } from "./moderation";
import { PgRelayRegistry, type PublicationLookup } from "./registry";
import { FsGallerySource, type GallerySource, type SeedResult } from "./seed";

/**
 * WP14b's relay service graph (one per process), like `src/server/cases/index.ts`: routes call `getRelaysDeps()`;
 * tests and later units inject parts with `setRelaysDeps({...})` (anything left out is built from the defaults).
 *
 * The gallery seed runs once per process, lazily, before the first relay request is answered (`ensureSeeded`), so a
 * fresh container serves the gallery without a manual step (PLATFORM §14 Q4: "the relay seed runs automatically at
 * start-up"). A failed seed is logged and retried on the next request; it never fails the request itself.
 */
export interface RelaysVisitor {
  visitorId: string;
  ipKey: string;
}

/** `GET /api/relays/:id/compiled`: the server's authoritative compile (PLATFORM §7.3). Wired in WP14b·2 (kernel). */
export type CompileView = (i: { relayId: string; versionId: string | null; blueprint: Blueprint; lint: LintIssue[] }) => Promise<CompiledRelayView>;

export interface RelaysDeps {
  db: Db;
  registry: PgRelayRegistry;
  requireVisitor(req: { headers: Headers }): RelaysVisitor;
  rateLimiter(): RateLimiter;
  ensureSeeded(): Promise<SeedResult | null>;
  /** null until the kernel compiler is wired (the compiled route answers 503 E_MAINTENANCE). */
  compileView: CompileView | null;
}

export interface RelaysDepsOverrides {
  db?: Db;
  kernel?: RelayKernel;
  now?: () => number;
  caps?: { softLive: number; hardLive: number; idleMs: number };
  moderator?: Moderator | null;
  publications?: PublicationLookup | null;
  gallery?: GallerySource | null;
  requireVisitor?: (req: { headers: Headers }) => RelaysVisitor;
  rateLimiter?: () => RateLimiter;
  compileView?: CompileView | null;
}

const relaysLog = log.child({ component: "relays" });

export function buildRelaysDeps(o: RelaysDepsOverrides = {}): RelaysDeps {
  const db = o.db ?? getDb();
  const registry = new PgRelayRegistry({
    db,
    ...(o.kernel ? { kernel: o.kernel } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.caps ? { caps: o.caps } : {}),
    moderator: o.moderator ?? null,
    publications: o.publications ?? null,
    gallery: o.gallery === undefined ? new FsGallerySource() : o.gallery,
  });
  let seeding: Promise<SeedResult | null> | null = null;
  return {
    db,
    registry,
    requireVisitor: o.requireVisitor ?? ((req) => requireVisitor(req)),
    rateLimiter: o.rateLimiter ?? (() => getRateLimiter()),
    compileView: o.compileView ?? null,
    ensureSeeded() {
      seeding ??= registry.seedGallery().catch((err: unknown) => {
        relaysLog.error("gallery seed failed; retrying on the next request", { err });
        seeding = null;
        return null;
      });
      return seeding;
    },
  };
}

type Holder = { deps: RelaysDeps | null };
const g = globalThis as typeof globalThis & { __batonRelays?: Holder };
const holder: Holder = (g.__batonRelays ??= { deps: null });

export function getRelaysDeps(): RelaysDeps {
  holder.deps ??= buildRelaysDeps();
  return holder.deps;
}

/** Tests and scripts: replace the graph (null = rebuild from the defaults on next use). */
export function setRelaysDeps(o: RelaysDepsOverrides | null): RelaysDeps | null {
  holder.deps = o ? buildRelaysDeps(o) : null;
  return holder.deps;
}

/** The request's workspace (`ws_<visitorId>`), from the signed visitor cookie or `x-baton-visitor` header. */
export function workspaceFor(d: RelaysDeps, req: { headers: Headers }): { visitor: RelaysVisitor; ws: string } {
  const visitor = d.requireVisitor(req);
  return { visitor, ws: workspaceOf(visitor.visitorId) };
}

export { PgRelayRegistry, stripSecrets, type PublicationLookup } from "./registry";
export { FsGallerySource, MemoryGallerySource, seedGallery, type GalleryEntry, type GallerySource, type SeedResult } from "./seed";
export { defaultRelayKernel, hasLintErrors, type RelayKernel } from "./kernel";
export { RelayError, relayRoute } from "./http";
export type { Moderator } from "./moderation";
