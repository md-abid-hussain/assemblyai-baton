"use client";
/**
 * client/studio/api.ts - the Studio's calls to `/api/relays/**` (WP14b's routes; `requests/wp14b-to-wp15.md`).
 *
 * **Two save paths, one caller.** SAAS §5.5 saves the *source* through `PUT /api/relays/:id/source`, which is
 * WP14b·4's route and lands after this unit (TASKS-v3 §7 WP15·1: "Save uses `PUT /api/relays/:id/draft` until
 * WP14b·4's `/source` lands, then `/source`"). Rather than ship a switch someone has to remember to flip, `saveSource`
 * **probes once per page load**: it tries `/source`, and a 404/405 - the only two answers a missing route gives -
 * makes it fall back to `/draft { blueprint, expectedRev }` for the rest of the session. When WP14b·4 merges, the
 * Studio starts preserving comments server-side with no edit here, and until then a YAML file's comments survive
 * only in the browser's `localStorage` mirror. That difference is recorded in `docs/notes/wp15.md`.
 *
 * The `bvid` cookie is set by `src/proxy.ts` on the first page load, so same-origin `fetch` already carries the
 * workspace; `x-baton-visitor` is only needed where cookies are blocked, and the Studio does not handle that case
 * (it is `/call/**`'s problem, DESIGN §4.3).
 */
import "client-only";

import type { Blueprint, ListRelaysResponse, RelayDetail } from "@/core/contracts/v2";
import { serialize, yamlSchemaHeader, type SourceFormat } from "@/core/relay-code";

import type { SaveOutcome } from "./source-store";

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
  conflict?: unknown;
  rev?: unknown;
}

async function readError(res: Response): Promise<StudioApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    /* a non-JSON error page */
  }
  const code = typeof body.error?.code === "string" ? body.error.code : `HTTP_${res.status}`;
  const message = typeof body.error?.message === "string" ? body.error.message : res.statusText || "Request failed.";
  return new StudioApiError(res.status, code, message);
}

const JSON_HEADERS = { "content-type": "application/json" };

export interface StudioApiOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class StudioApi {
  private readonly f: typeof fetch;
  private readonly base: string;
  /** null = not probed yet; "source" / "draft" once we know. */
  private savePath: "source" | "draft" | null = null;

  constructor(o: StudioApiOptions = {}) {
    this.f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.base = o.baseUrl ?? "";
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  async list(): Promise<ListRelaysResponse> {
    const res = await this.f(this.url("/api/relays"), { headers: JSON_HEADERS });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as ListRelaysResponse;
  }

  async get(relayId: string): Promise<RelayDetail> {
    const res = await this.f(this.url(`/api/relays/${encodeURIComponent(relayId)}`), { headers: JSON_HEADERS });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as RelayDetail;
  }

  async create(body: { kind: "blank"; industry: string } | { kind: "clone"; relayId: string } | { kind: "blueprint"; blueprint: unknown; origin: "draft" | "user" }): Promise<RelayDetail> {
    const res = await this.f(this.url("/api/relays"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as RelayDetail;
  }

  /** `POST /api/relays/:id/versions`: content-addressed, so an unchanged draft returns the existing version. */
  async snapshot(relayId: string): Promise<{ versionId: string; version: number; hash: string; created: boolean }> {
    const res = await this.f(this.url(`/api/relays/${encodeURIComponent(relayId)}/versions`), { method: "POST", headers: JSON_HEADERS, body: "{}" });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as { versionId: string; version: number; hash: string; created: boolean };
  }

  /**
   * The store's `save` port. A 409 comes back as `{conflict: true}` **with their text**, which the diff prompt needs
   * and which `/draft` does not return - so on a conflict we read the relay back and serialize its draft.
   */
  save = async (i: { relayId: string; format: SourceFormat; text: string; blueprint: Blueprint; expectedRev: number }): Promise<SaveOutcome> => {
    if (this.savePath === null || this.savePath === "source") {
      const res = await this.f(this.url(`/api/relays/${encodeURIComponent(i.relayId)}/source`), {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ source: { format: i.format, text: i.text }, expectedRev: i.expectedRev }),
      });
      if (res.status === 404 || res.status === 405) {
        this.savePath = "draft";
      } else {
        this.savePath = "source";
        return this.outcome(res, i);
      }
    }
    const res = await this.f(this.url(`/api/relays/${encodeURIComponent(i.relayId)}/draft`), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ blueprint: i.blueprint, expectedRev: i.expectedRev }),
    });
    return this.outcome(res, i);
  };

  private async outcome(res: Response, i: { relayId: string; format: SourceFormat }): Promise<SaveOutcome> {
    if (res.ok) {
      const body = (await res.json()) as { rev?: unknown; hash?: unknown };
      return {
        ok: true,
        rev: typeof body.rev === "number" ? body.rev : 0,
        hash: typeof body.hash === "string" ? body.hash : null,
      };
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { rev?: unknown };
      const rev = typeof body.rev === "number" ? body.rev : 0;
      return { ok: false, conflict: true, rev, theirText: await this.theirText(i.relayId, i.format) };
    }
    const err = await readError(res);
    return { ok: false, message: err.message, ...(err.code === "E_READ_ONLY" ? { readOnly: true } : {}) };
  }

  /** The other side of a 409, as text, for the Monaco diff prompt. `null` when it cannot be read. */
  private async theirText(relayId: string, format: SourceFormat): Promise<string | null> {
    try {
      const detail = await this.get(relayId);
      return sourceOf(detail.draft, format);
    } catch {
      return null;
    }
  }
}

/**
 * The relay's source as text. Until `GET /api/relays/:id/source` exists, this is what a read returns (`stored:
 * false` in `RelaySourceView` terms): the canonical blueprint serialized by the codec.
 */
export function sourceOf(blueprint: Blueprint, format: SourceFormat, schemaUrl?: string): string {
  return serialize(blueprint, format, format === "yaml" && schemaUrl ? { header: yamlSchemaHeader(schemaUrl) } : {});
}

/** `<slug>.yaml` / `<slug>.json` for the Download button. */
export const downloadName = (slug: string, format: SourceFormat): string => `${slug || "relay"}.${format}`;
