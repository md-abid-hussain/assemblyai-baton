/**
 * components/marketing/rich-text.tsx - renders WP13's `RichText` (P§12, `contracts/ext/wp13-content.ts`).
 *
 * The copy is `Inline[]` rather than markdown precisely so a renderer never parses anything: a `{strong}` part is
 * a product term, a `{code}` part is an API name, and a plain string is a plain string. No `dangerouslySetInnerHTML`
 * anywhere on the marketing surface.
 */
import type { Inline, RichText } from "@/core/contracts/ext/wp13-content";

export function InlinePart({ part }: { part: Inline }) {
  if (typeof part === "string") return <>{part}</>;
  if ("strong" in part) return <strong className="font-semibold">{part.strong}</strong>;
  return <code className="bg-muted rounded px-1 py-0.5 text-[0.9em]">{part.code}</code>;
}

export function Rich({ text }: { text: RichText }) {
  return (
    <>
      {text.map((part, i) => (
        <InlinePart key={i} part={part} />
      ))}
    </>
  );
}
