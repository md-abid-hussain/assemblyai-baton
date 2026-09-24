"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type CheckState = "pending" | "pass" | "fail";
interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}
interface Violation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
}
export interface CspProbeResult {
  done: boolean;
  ok: boolean;
  checks: Check[];
  violations: Violation[];
  csp: string | null;
}

declare global {
  interface Window {
    __cspProbe?: CspProbeResult;
  }
}

const PROCESSOR = `
class BatonCspProbe extends AudioWorkletProcessor {
  process() { return true; }
}
registerProcessor("baton-csp-probe", BatonCspProbe);
`;

const INITIAL: Check[] = [
  { id: "header", label: "Content-Security-Policy header present", state: "pending", detail: "" },
  { id: "worklet", label: "AudioWorklet module from a Blob URL", state: "pending", detail: "" },
  { id: "worker", label: "Worker from a Blob URL", state: "pending", detail: "" },
  { id: "connect", label: "fetch /api/health (connect-src 'self')", state: "pending", detail: "" },
  { id: "violations", label: "No CSP violations reported", state: "pending", detail: "" },
];

async function runChecks(violations: Violation[]): Promise<{ checks: Check[]; csp: string | null }> {
  const checks = INITIAL.map((c) => ({ ...c }));
  const set = (id: string, state: CheckState, detail: string) => {
    const c = checks.find((x) => x.id === id);
    if (c) {
      c.state = state;
      c.detail = detail;
    }
  };

  // 1. Header on this very page.
  let csp: string | null = null;
  try {
    const res = await fetch(window.location.href, { method: "GET", cache: "no-store" });
    csp = res.headers.get("content-security-policy");
    set("header", csp ? "pass" : "fail", csp ? `${csp.length} chars` : "missing");
  } catch (e) {
    set("header", "fail", String(e));
  }

  // 2. AudioWorklet from a Blob URL (the engine's loading path, DESIGN §7.6).
  let ctx: AudioContext | null = null;
  const workletUrl = URL.createObjectURL(new Blob([PROCESSOR], { type: "application/javascript" }));
  try {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "baton-csp-probe");
    node.disconnect();
    set("worklet", "pass", `sampleRate ${ctx.sampleRate} Hz, state ${ctx.state}`);
  } catch (e) {
    set("worklet", "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  } finally {
    URL.revokeObjectURL(workletUrl);
    await ctx?.close().catch(() => undefined);
  }

  // 3. A Blob-URL Worker (worker-src blob:).
  const workerUrl = URL.createObjectURL(new Blob(["self.onmessage = (e) => self.postMessage(e.data * 2);"], { type: "application/javascript" }));
  try {
    const w = new Worker(workerUrl);
    const answer = await new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("worker timeout")), 3000);
      w.onmessage = (e) => {
        clearTimeout(t);
        resolve(e.data);
      };
      w.onerror = (e) => {
        clearTimeout(t);
        reject(new Error(e.message || "worker error"));
      };
      w.postMessage(21);
    });
    w.terminate();
    set("worker", answer === 42 ? "pass" : "fail", `answer ${String(answer)}`);
  } catch (e) {
    set("worker", "fail", e instanceof Error ? e.message : String(e));
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  // 4. Same-origin fetch.
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    set("connect", "pass", `HTTP ${r.status}`);
  } catch (e) {
    set("connect", "fail", String(e));
  }

  // 5. Give late violation events a moment to arrive.
  await new Promise((r) => setTimeout(r, 300));
  set(
    "violations",
    violations.length === 0 ? "pass" : "fail",
    violations.length === 0 ? "none" : violations.map((v) => `${v.directive} ← ${v.blockedURI}`).join("; "),
  );
  return { checks, csp };
}

export function CspProbe() {
  const violations = useRef<Violation[]>([]);
  const [result, setResult] = useState<CspProbeResult>({ done: false, ok: false, checks: INITIAL, violations: [], csp: null });

  useEffect(() => {
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      violations.current.push({ directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile });
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    return () => document.removeEventListener("securitypolicyviolation", onViolation);
  }, []);

  const run = useCallback(async () => {
    violations.current = [];
    setResult({ done: false, ok: false, checks: INITIAL, violations: [], csp: null });
    const { checks, csp } = await runChecks(violations.current);
    const next: CspProbeResult = {
      done: true,
      ok: checks.every((c) => c.state === "pass"),
      checks,
      violations: [...violations.current],
      csp,
    };
    window.__cspProbe = next;
    setResult(next);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="mt-6 space-y-4" data-testid="csp-probe" data-done={result.done} data-ok={result.ok}>
      <div className="flex items-center gap-3">
        <Badge variant={!result.done ? "secondary" : result.ok ? "default" : "destructive"}>
          {!result.done ? "running…" : result.ok ? "PASS" : "FAIL"}
        </Badge>
        <Button size="sm" variant="outline" onClick={() => void run()}>
          Run again
        </Button>
      </div>
      <ul className="divide-y rounded-lg border">
        {result.checks.map((c) => (
          <li key={c.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm" data-check={c.id} data-state={c.state}>
            <span>{c.label}</span>
            <span className={c.state === "fail" ? "text-destructive" : "text-muted-foreground"}>
              {c.state}
              {c.detail ? ` · ${c.detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {result.csp && (
        <pre className="bg-muted overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap" data-testid="csp-header">
          {result.csp.split("; ").join(";\n")}
        </pre>
      )}
    </section>
  );
}
