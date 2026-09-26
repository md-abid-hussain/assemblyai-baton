import "server-only";

/**
 * `PgRelaySourceStore` — relay-as-code over the `0002_saas` source columns (SAAS §5.2, §14). WP14b·4.
 *
 * The canonical blueprint stays `relays.draft` (jsonb) and the version hash stays `sha256(canonicalJson(bp))`, so
 * **a comment-only or formatting-only edit never creates a version**. What this store adds is the author's exact
 * text beside it:
 *
 *   - `relays.draft_source` / `draft_source_format` — the draft's text, ≤ 256 KiB (the codec enforces the cap);
 *   - `relay_versions.source` / `source_format`     — the text as it stood when the version was snapshotted.
 *
 * A read returns the stored text with `stored: true`; when nothing is stored (a relay written through the forms or
 * the v2 JSON API, or a gallery relay seeded from JSON) it serializes the canonical draft and says `stored: false`,
 * which is what lets the Code tab open on any relay rather than only on relays that were authored as code.
 *
 * **Tenancy.** Every method takes `ws` and resolves the row through the registry's `findRow`/`accessOf`/`ownRow`,
 * so a foreign id is a 404 and a readable-but-not-writable one (gallery, someone's unlisted relay) is `E_READ_ONLY`
 * — the same answers the rest of `/api/relays/**` gives, decided in one place (SAAS §10.1 rule 2).
 *
 * **Save semantics** (§5.2, §6.2): syntax/zod/credential errors do not save (`invalid`, with diagnostics carrying
 * ranges); **lint errors do save**, because lint blocks Test and Publish, not Save (P§3.4). A stale `expectedRev`
 * is a conflict, never a silent overwrite, and the conflict answer carries the current rev and hash so the Studio
 * can offer a diff.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Blueprint } from "../../core/contracts/v2";
import type {
  CodeDiagnostic,
  RelaySource,
  RelaySourceStore,
  RelaySourceView,
  SourceFormat,
} from "../../core/contracts/v3";
import {
  CodecError,
  MAX_SOURCE_BYTES,
  convert,
  serialize,
  sniffFormat,
  validateSource,
  yamlSchemaHeader,
} from "../../core/relay-code";
import { relays, relayVersions } from "../db/schema";
import { log } from "../log";
import { RelayError } from "./http";
import type { PgRelayRegistry } from "./registry";

const storeLog = log.child({ component: "relay-source" });

type Json = Record<string, unknown>;

export interface PgRelaySourceStoreOptions {
  registry: PgRelayRegistry;
  now?: () => number;
  /** `<APP_URL>/schemas/blueprint-2.0.json` for the generated YAML header; omitted when `APP_URL` is unset. */
  appUrl?: () => string | undefined;
}

/** The `# yaml-language-server:` header a generated YAML file carries, so an IDE validates it offline (§5.2). */
export function headerFor(format: SourceFormat, appUrl: string | undefined): string[] | undefined {
  if (format !== "yaml") return undefined;
  const base = appUrl?.trim().replace(/\/+$/, "");
  return base ? yamlSchemaHeader(`${base}/schemas/blueprint-2.0.json`) : undefined;
}

/**
 * Render a blueprint as source text. Used when nothing was stored, and when a caller asks for the other format:
 * converting the stored text keeps YAML comments on the YAML→YAML path and loses them going to JSON, which is what
 * `convert` documents.
 */
function render(blueprint: Blueprint, format: SourceFormat, appUrl: string | undefined): string {
  const header = headerFor(format, appUrl);
  return serialize(blueprint, format, header ? { header } : {});
}

/** The stored text in the format the caller asked for, falling back to a re-serialize if the convert fails. */
function asFormat(text: string, from: SourceFormat, to: SourceFormat | undefined, blueprint: Blueprint | null, appUrl: string | undefined): { text: string; format: SourceFormat; stored: boolean } {
  if (!to || to === from) return { text, format: from, stored: true };
  try {
    return { text: convert(text, to), format: to, stored: true };
  } catch (err) {
    // A stored text that no longer converts is a bug upstream, not a reason to fail the read: fall back to the
    // canonical blueprint and say `stored: false`, which the Code tab already renders as "generated".
    storeLog.warn("stored source could not be converted; serializing the canonical draft", { from, to, err });
    return blueprint ? { text: render(blueprint, to, appUrl), format: to, stored: false } : { text, format: from, stored: true };
  }
}

export class PgRelaySourceStore implements RelaySourceStore {
  private readonly registry: PgRelayRegistry;
  private readonly now: () => number;
  private readonly appUrl: () => string | undefined;

  constructor(o: PgRelaySourceStoreOptions) {
    this.registry = o.registry;
    this.now = o.now ?? Date.now;
    this.appUrl = o.appUrl ?? (() => process.env.APP_URL);
  }

  private get db() {
    return this.registry.db;
  }

  /**
   * The draft's source, or one version's. `null` when `ws` cannot see the relay at all — the route turns that into
   * a 404, so a foreign id and a nonexistent id are indistinguishable (SAAS §10.1 rule 2, §11 cross-tenant suite).
   */
  async get(relayId: string, ws: string, opts: { version?: number; format?: SourceFormat } = {}): Promise<RelaySourceView | null> {
    const row = await this.registry.findRow(relayId);
    if (!row || this.registry.accessOf(row, ws) === "none") return null;
    const appUrl = this.appUrl();

    if (opts.version !== undefined) {
      const [v] = await this.db
        .select({
          version: relayVersions.version,
          blueprint: relayVersions.blueprint,
          hash: relayVersions.blueprintHash,
          source: relayVersions.source,
          format: relayVersions.sourceFormat,
        })
        .from(relayVersions)
        .where(and(eq(relayVersions.relayId, row.id), eq(relayVersions.version, opts.version)))
        .limit(1);
      if (!v) return null;
      const parsed = this.registry.kernel.parse(v.blueprint);
      const blueprint = parsed.blueprint;
      const out = v.source
        ? asFormat(v.source, v.format ?? sniffFormat(v.source), opts.format, blueprint, appUrl)
        : blueprint
          ? { text: render(blueprint, opts.format ?? "yaml", appUrl), format: opts.format ?? "yaml", stored: false }
          : null;
      if (!out) throw new RelayError("E_LINT", "This version no longer parses; its source cannot be rendered.", { lint: parsed.issues });
      return { relayId: row.id, version: v.version, rev: row.draftRev, hash: v.hash, ...out };
    }

    const parsed = this.registry.kernel.parse(row.draft);
    const blueprint = parsed.blueprint;
    const hash = blueprint ? this.registry.kernel.hash(blueprint) : "";
    const out = row.draftSource
      ? asFormat(row.draftSource, row.draftSourceFormat ?? sniffFormat(row.draftSource), opts.format, blueprint, appUrl)
      : blueprint
        ? { text: render(blueprint, opts.format ?? "yaml", appUrl), format: opts.format ?? "yaml", stored: false }
        : null;
    if (!out) throw new RelayError("E_LINT", "This draft no longer parses; save it again first.", { lint: parsed.issues });
    return { relayId: row.id, version: null, rev: row.draftRev, hash, ...out };
  }

  /**
   * Save the author's text as the draft. The canonical blueprint and the lint come from the same `validateSource`
   * the Studio and the CLI run, so the server is authoritative without a second parser.
   */
  async save(
    relayId: string,
    ws: string,
    source: RelaySource,
    expectedRev: number,
    via: "studio" | "api" | "cli",
  ): Promise<
    | { ok: true; rev: number; hash: string; diagnostics: CodeDiagnostic[] }
    | { ok: false; conflict: true; rev: number; hash: string }
    | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }
  > {
    const row = await this.registry.ownRow(relayId, ws);
    const { blueprint, hash, diagnostics } = validateSource(source.text, source.format);
    if (!blueprint || !hash) return { ok: false, invalid: true, diagnostics };

    // The `lint` column and the v2 responses keep speaking `LintIssue[]`, so it comes from the same kernel parse
    // `saveDraft` uses rather than from a translation of the codec's richer diagnostics: one source of truth for
    // what the Studio's Test button and the publish gate will see.
    const lint = this.registry.kernel.parse(blueprint).issues;
    const now = new Date(this.now());
    const [u] = await this.db
      .update(relays)
      .set({
        draft: blueprint as unknown as Json,
        draftRev: sql`${relays.draftRev} + 1`,
        draftSource: source.text,
        draftSourceFormat: source.format,
        lint,
        title: blueprint.meta.title,
        updatedAt: now,
        lastUsedAt: now,
      })
      .where(and(eq(relays.id, row.id), eq(relays.draftRev, expectedRev), isNull(relays.deletedAt)))
      .returning({ rev: relays.draftRev });

    if (u) {
      storeLog.info("relay source saved", { relayId: row.id, rev: u.rev, via, diagnostics: diagnostics.length });
      return { ok: true, rev: u.rev, hash, diagnostics };
    }

    const [cur] = await this.db.select({ rev: relays.draftRev, draft: relays.draft }).from(relays).where(eq(relays.id, row.id));
    const currentParsed = cur ? this.registry.kernel.parse(cur.draft) : null;
    return {
      ok: false,
      conflict: true,
      rev: cur?.rev ?? row.draftRev,
      hash: currentParsed?.blueprint ? this.registry.kernel.hash(currentParsed.blueprint) : hash,
    };
  }

  /** Create a relay from a file (the CLI's first `push`, the Studio's Import). The text is kept verbatim. */
  async create(
    ws: string,
    source: RelaySource,
    via: "studio" | "api" | "cli",
  ): Promise<{ ok: true; relayId: string } | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }> {
    const { blueprint, diagnostics } = validateSource(source.text, source.format);
    if (!blueprint) return { ok: false, invalid: true, diagnostics };
    const detail = await this.registry.create(ws, { kind: "blueprint", blueprint, origin: "user" });
    await this.db
      .update(relays)
      .set({ draftSource: source.text, draftSourceFormat: source.format })
      .where(eq(relays.id, detail.id));
    storeLog.info("relay created from source", { relayId: detail.id, via, format: source.format });
    return { ok: true, relayId: detail.id };
  }

  /**
   * Keep a version's text beside its blueprint. Called after `snapshotVersion` created a row: the version records
   * the text **as it stood at snapshot time**, so a later draft edit never rewrites history. A snapshot that
   * deduplicated onto an existing version leaves that version's source alone.
   */
  async captureVersionSource(relayId: string, versionId: string, created: boolean): Promise<void> {
    if (!created) return;
    const [row] = await this.db
      .select({ source: relays.draftSource, format: relays.draftSourceFormat })
      .from(relays)
      .where(eq(relays.id, relayId));
    if (!row?.source) return;
    await this.db
      .update(relayVersions)
      .set({ source: row.source, sourceFormat: row.format })
      .where(and(eq(relayVersions.id, versionId), isNull(relayVersions.source)));
  }
}

export { CodecError };

/**
 * The `PUT /api/relays/:id/source` body (SAAS §6.2). It lives here rather than in `contracts/v3` because the v3
 * contracts are frozen at C3 and carry only the shapes; this is the server's own request validator. The byte cap
 * is the codec's `MAX_SOURCE_BYTES`, checked again here so an oversized body is refused before it is parsed.
 */
export const SaveSourceRequestSchema = z.object({
  source: z.object({
    format: z.enum(["yaml", "json"]),
    text: z.string().max(MAX_SOURCE_BYTES, `The file is larger than ${MAX_SOURCE_BYTES} bytes (256 KiB).`),
  }),
  expectedRev: z.number().int().nonnegative(),
});
export type SaveSourceRequest = z.infer<typeof SaveSourceRequestSchema>;
