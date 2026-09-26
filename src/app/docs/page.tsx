/**
 * `/docs` (WP7b·2 owns the real thing).
 *
 * **A placeholder, and it says so.** The app shell's top bar links here from every `/app` page, and until the
 * QA-FIX pass that link answered Next's generic 404 — the same class of defect as the missing landing page, and
 * visible from every screen a judge opens. WP7b·2 replaces this file wholesale.
 *
 * Nothing here invents documentation: it points at the things that genuinely exist today (the published
 * blueprint schema, the Studio, the honest-limits list on `/`) and names what has not shipped.
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "Docs · Changeover" },
  description: "Where the Changeover documentation lives while the docs site is being built.",
  robots: { index: false, follow: true },
};

const LINKS: readonly { href: string; label: string; body: string }[] = [
  { href: "/", label: "How a relay runs", body: "Shadow, pass the baton, prove it — with the honest limits, on the landing page." },
  { href: "/app/relays", label: "The Studio", body: "Open a relay, edit its blueprint as YAML or JSON, and watch the compiled preview change." },
  { href: "/schemas/blueprint-2.0.json", label: "The blueprint JSON Schema", body: "Published and stable: the Studio's editor and the CLI validate against this exact document." },
];

export default function DocsPage() {
  return (
    <main className="bg-background text-foreground min-h-dvh px-4 py-14 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-2">
          <Link href="/" className="text-muted-foreground text-sm underline underline-offset-4">
            Changeover
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
          <p className="text-muted-foreground text-sm text-pretty">
            The documentation site is still being written. The API reference (<code>/docs/api</code>), the guides
            and the changelog arrive with WP7b·2 and WP22. Everything below exists today.
          </p>
        </header>

        <ul className="space-y-3">
          {LINKS.map((l) => (
            <li key={l.href} className="border-border rounded-xl border p-4">
              <a href={l.href} className="text-sm font-semibold underline underline-offset-4">
                {l.label}
              </a>
              <p className="text-muted-foreground mt-1 text-sm text-pretty">{l.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
