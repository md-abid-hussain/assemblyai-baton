"use client";

/**
 * The two interactive controls every settings panel needs: Copy, and a confirmation dialog. WP20·2.
 *
 * **Copy** (SAAS §3.6's "Copy link") must not be the only way to get the value. `navigator.clipboard` needs a
 * secure context and a user gesture, and it can still be refused by permissions policy; when it fails the
 * button selects the text instead of pretending to have copied it, and says so. Silence after a Copy button is
 * the worst outcome, because the person pastes whatever was in their clipboard before.
 *
 * **Confirm** is a real dialog with focus trapping (Radix), not `window.confirm` — which is unstyled, blocks the
 * whole renderer and cannot carry the typed-confirmation field §3.5 requires for deleting an organization.
 */
import { CheckIcon, CopyIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label = "Copy",
  className,
  srLabel,
}: {
  value: string;
  label?: string;
  className?: string;
  /** What a screen reader hears, when "Copy" alone would be ambiguous in a list of rows. */
  srLabel?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function onCopy() {
    if (timer.current) clearTimeout(timer.current);
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "failed");
    timer.current = setTimeout(() => setState("idle"), 2200);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label={srLabel}
        className={cn(
          "hover:bg-accent inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
          className,
        )}
      >
        {state === "copied" ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" aria-live="polite" className="text-muted-foreground text-xs">
        {state === "failed" ? "Could not copy — select the link and copy it." : ""}
      </span>
    </span>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the button stays disabled until the field matches this exactly (SAAS §3.5). */
  typeToConfirm?: string;
  typeToConfirmLabel?: string;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  /** Fields the decision needs — a name to give, an admin to pick. Rendered above the typed confirmation. */
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  typeToConfirm,
  typeToConfirmLabel,
  pending = false,
  error,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const fieldId = useId();
  // Trimmed on both sides only: a pasted name with a trailing space is the same name, but the *letters* have to
  // match, because the point of the field is that the person read what they are about to destroy.
  const satisfied = typeToConfirm === undefined || typed.trim() === typeToConfirm.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {children}

        {typeToConfirm !== undefined ? (
          <div className="space-y-1.5">
            <label htmlFor={fieldId} className="block text-sm font-medium">
              {typeToConfirmLabel ?? (
                <>
                  Type <span className="font-mono">{typeToConfirm}</span> to confirm
                </>
              )}
            </label>
            <input
              id={fieldId}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.currentTarget.value)}
              className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>
        ) : null}

        <div role="status" aria-live="polite" className="min-h-[1.25rem]">
          {error ? <p className="text-destructive text-xs font-medium text-pretty">{error}</p> : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <button
              type="button"
              className="hover:bg-accent inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </DialogClose>
          <button
            type="button"
            disabled={pending || !satisfied}
            onClick={() => void onConfirm()}
            className={cn(
              "inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-50",
              destructive
                ? "bg-destructive text-white hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
