/**
 * The Studio's one source of truth (SAAS §5.5), against the WP15 acceptance list.
 *
 * The store is deliberately framework-free, so these tests drive it the way the Code tab and the Configure forms
 * do — `setText`, `applyFormEdit`, `saveNow` — and assert the rules that are easy to regress: a syntax error must
 * not blank the forms, a zod-invalid text must never be sent to the server, and a 409 must not lose the local text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSourceStore, diagnosticCounts, formsUsable, LOCAL_DRAFT_PREFIX, savedStateLabel, type SaveOutcome,
  type SourceStore,
} from "@/client/studio/source-store";
import type { Blueprint } from "@/core/contracts/v2";
import { serialize, validateSource } from "@/core/relay-code";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The one blueprint that is on `main` as a file: WP23 generates it from the Baton gallery JSON. */
const BATON_YAML = readFileSync(`${ROOT}/examples/relays/baton-add-driver.yaml`, "utf8");

const blueprintOf = (text: string): Blueprint => {
  const { blueprint } = validateSource(text);
  if (!blueprint) throw new Error("fixture does not validate");
  return blueprint;
};

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

interface Harness {
  store: SourceStore;
  saves: { text: string; expectedRev: number }[];
  storage: FakeStorage;
}

function harness(opts: { text?: string; outcome?: (n: number) => SaveOutcome; readOnly?: boolean; storage?: FakeStorage | null } = {}): Harness {
  const saves: Harness["saves"] = [];
  const storage = opts.storage === null ? null : (opts.storage ?? new FakeStorage());
  const store = createSourceStore({
    relayId: "rl_test",
    text: opts.text ?? BATON_YAML,
    format: "yaml",
    rev: 3,
    readOnly: opts.readOnly ?? false,
    flagship: false,
    deps: {
      save: async (i) => {
        saves.push({ text: i.text, expectedRev: i.expectedRev });
        return opts.outcome ? opts.outcome(saves.length) : { ok: true, rev: i.expectedRev + 1, hash: "server-hash" };
      },
      storage,
      // Timers off: every test drives the parse and the save explicitly, except the debounce test below.
      parseDebounceMs: 0,
      autosaveIdleMs: 0,
    },
  });
  return { store, saves, storage: storage ?? new FakeStorage() };
}

describe("source store", () => {
  it("compiles the preview from the initial text", () => {
    const { store } = harness();
    const s = store.getState();
    expect(s.blueprint).not.toBeNull();
    expect(s.preview).not.toBeNull();
    expect(s.preview!.greetings.length).toBeGreaterThan(0);
    expect(s.preview!.prompts.length).toBeGreaterThan(0);
    expect(s.hash).toBe(s.preview!.hash);
    expect(s.status).toBe("clean");
  });

  it("a syntax error keeps the last valid blueprint but makes the forms read-only", () => {
    const { store } = harness();
    const before = store.getState().blueprint;
    store.getState().setText("meta: [unclosed\n");
    const s = store.getState();
    expect(s.blueprint).toBe(before); // the forms still have something to show…
    expect(formsUsable(s)).toBe(false); // …and are not allowed to edit it
    expect(s.status).toBe("invalid");
    expect(s.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("never sends a zod-invalid text to the server", async () => {
    const { store, saves } = harness();
    store.getState().setText("meta:\n  schema: changeover.blueprint/2.0\n");
    await store.getState().saveNow();
    expect(saves).toEqual([]);
    expect(store.getState().status).toBe("invalid");
    expect(savedStateLabel(store.getState())).toMatch(/^Unsaved: \d+ errors? to fix$/);
  });

  it("saves a valid edit and reports the new rev", async () => {
    const { store, saves } = harness();
    const bp = blueprintOf(BATON_YAML);
    store.getState().setText(serialize({ ...bp, meta: { ...bp.meta, title: "Renamed" } }, "yaml"));
    await store.getState().saveNow();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.expectedRev).toBe(3);
    expect(store.getState().rev).toBe(4);
    expect(store.getState().status).toBe("saved");
    expect(store.getState().serverHash).toBe("server-hash");
  });

  it("a form edit goes through applyEdit and keeps YAML comments", () => {
    const yaml = `# a comment that must survive\n${BATON_YAML}`;
    const { store } = harness({ text: yaml });
    store.getState().applyFormEdit(["meta", "title"], "Edited through the forms");
    const s = store.getState();
    expect(s.text.startsWith("# a comment that must survive")).toBe(true);
    expect(s.blueprint?.meta.title).toBe("Edited through the forms");
  });

  it("a form edit is refused while the code has a syntax error", () => {
    const { store } = harness();
    store.getState().setText("meta: [unclosed\n");
    const broken = store.getState().text;
    store.getState().applyFormEdit(["meta", "title"], "nope");
    expect(store.getState().text).toBe(broken);
  });

  it("a 409 keeps the local text and offers both sides", async () => {
    const { store } = harness({
      outcome: () => ({ ok: false, conflict: true, rev: 9, theirText: "meta:\n  title: theirs\n" }),
    });
    const bp = blueprintOf(BATON_YAML);
    const mine = serialize({ ...bp, meta: { ...bp.meta, title: "Mine" } }, "yaml");
    store.getState().setText(mine);
    await store.getState().saveNow();
    expect(store.getState().status).toBe("conflict");
    expect(store.getState().text).toBe(mine);
    expect(store.getState().conflict).toEqual({ theirText: "meta:\n  title: theirs\n", theirRev: 9 });

    store.getState().resolveConflict("mine");
    expect(store.getState().rev).toBe(9); // their rev, so the next save is accepted
    expect(store.getState().text).toBe(mine);
    expect(store.getState().status).toBe("dirty");
  });

  it("'take theirs' replaces the text and goes clean", async () => {
    const theirs = serialize(blueprintOf(BATON_YAML), "yaml");
    const { store } = harness({ outcome: () => ({ ok: false, conflict: true, rev: 9, theirText: theirs }) });
    store.getState().setText(`# mine\n${BATON_YAML}`);
    await store.getState().saveNow();
    store.getState().resolveConflict("theirs");
    expect(store.getState().text).toBe(theirs);
    expect(store.getState().rev).toBe(9);
    expect(store.getState().status).toBe("clean");
  });

  it("mirrors the unsaved text per viewer and offers it back", () => {
    const storage = new FakeStorage();
    const { store } = harness({ storage });
    store.getState().setText(`# unsaved\n${BATON_YAML}`);
    const key = `${LOCAL_DRAFT_PREFIX}rl_test`;
    expect(storage.getItem(key)).not.toBeNull();

    const reopened = createSourceStore({
      relayId: "rl_test",
      text: BATON_YAML,
      rev: 3,
      deps: { save: async () => ({ ok: true, rev: 4, hash: null }), storage, parseDebounceMs: 0, autosaveIdleMs: 0 },
    });
    expect(reopened.getState().restorable).toBe(`# unsaved\n${BATON_YAML}`);
    reopened.getState().restoreLocal();
    expect(reopened.getState().text).toBe(`# unsaved\n${BATON_YAML}`);
  });

  it("survives a storage that throws (a private window)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createSourceStore({
      relayId: "rl_test",
      text: BATON_YAML,
      rev: 1,
      deps: { save: async () => ({ ok: true, rev: 2, hash: null }), storage: throwing, parseDebounceMs: 0, autosaveIdleMs: 0 },
    });
    expect(store.getState().restorable).toBeNull();
    expect(() => store.getState().setText(`# x\n${BATON_YAML}`)).not.toThrow();
  });

  it("a read-only store ignores edits", () => {
    const { store, saves } = harness({ readOnly: true });
    const before = store.getState().text;
    store.getState().setText("anything");
    expect(store.getState().text).toBe(before);
    expect(saves).toEqual([]);
  });

  it("the YAML ⇄ JSON toggle round-trips the blueprint", () => {
    const { store } = harness();
    const yamlHash = store.getState().hash;
    store.getState().setFormat("json");
    expect(store.getState().format).toBe("json");
    expect(store.getState().text.trimStart().startsWith("{")).toBe(true);
    expect(store.getState().hash).toBe(yamlHash); // a formatting-only change never changes the hash
    store.getState().setFormat("yaml");
    expect(store.getState().hash).toBe(yamlHash);
  });

  describe("debounce and autosave", () => {
    beforeEach(() => vi.useFakeTimers());

    it("re-parses 150 ms after the last keystroke and autosaves after 2 s of idle", async () => {
      const saves: string[] = [];
      const store = createSourceStore({
        relayId: "rl_test",
        text: BATON_YAML,
        rev: 1,
        deps: {
          save: async (i) => {
            saves.push(i.text);
            return { ok: true, rev: 2, hash: null };
          },
          storage: null,
        },
      });
      const bp = blueprintOf(BATON_YAML);
      const next = serialize({ ...bp, meta: { ...bp.meta, title: "Debounced" } }, "yaml");

      store.getState().setText(next.slice(0, 20));
      store.getState().setText(next);
      expect(store.getState().blueprint?.meta.title).not.toBe("Debounced"); // not parsed yet

      await vi.advanceTimersByTimeAsync(150);
      expect(store.getState().blueprint?.meta.title).toBe("Debounced");
      expect(saves).toEqual([]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(saves).toEqual([next]);
      vi.useRealTimers();
    });
  });
});

describe("diagnosticCounts", () => {
  it("separates blocking errors from lint errors", () => {
    const counts = diagnosticCounts([
      { source: "schema", code: "S", severity: "error", path: [], message: "", range: null },
      { source: "lint", code: "L", severity: "error", path: [], message: "", range: null },
      { source: "codec", code: "W", severity: "warn", path: [], message: "", range: null },
    ]);
    expect(counts).toEqual({ errors: 2, warnings: 1, blocking: 1 });
  });
});
