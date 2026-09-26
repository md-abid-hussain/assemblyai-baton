"use client";
/**
 * components/studio/configure/code-link.tsx - "Edit in Code →" (SAAS §5.5).
 *
 * The half of Configure that is honest about its own limits. Listening, QA, extraction, compliance, the case JSON
 * and the prompt template have no form, and §5.5 asks for them to be *listed* with a jump rather than hidden: a
 * builder who cannot find the keyterms anywhere in Configure has no way to learn that the relay has any.
 *
 * The link carries the path in the fragment, in the same `#P<path>` shape the Code tab already reads for a
 * diagnostic's `#L<line>:<col>` — the Code tab resolves a path to a range with the codec, because a path survives
 * an edit and a line number does not.
 */
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { pathHash, type Path } from "@/client/studio/code-target";
import { cn } from "@/lib/utils";

/** `["playbook","greeting"]` → `/app/relays/<id>/code#Pplaybook.greeting`. */
export function codePathHref(relayId: string, path: Path): string {
  return `/app/relays/${encodeURIComponent(relayId)}/code${pathHash(path)}`;
}

export function CodeLink({
  relayId, path, children, className,
}: { relayId: string; path: Path; children?: ReactNode; className?: string }) {
  return (
    <Link href={codePathHref(relayId, path)} className={cn("hover:text-foreground underline underline-offset-2", className)}>
      {children ?? "Edit in Code"}
    </Link>
  );
}

/** One row of the "no form, on purpose" list. */
export function CodeOnlyRow({ relayId, title, path, why }: { relayId: string; title: string; path: Path; why: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">{why}</span>
      <CodeLink relayId={relayId} path={path} className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        Edit in Code <ArrowRight aria-hidden className="size-3" />
      </CodeLink>
    </li>
  );
}
