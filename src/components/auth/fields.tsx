/**
 * The form primitives the auth pages and the settings panels share. WP20·2.
 *
 * Deliberately plain: a label, an input and one error line, wired together by id so the error is announced
 * rather than merely coloured. This repo has no form library and does not need one for six forms — what it
 * needs is that every one of them makes the same three promises:
 *
 *  - the label is a real `<label for>`, so the hit area includes the text at 390 px;
 *  - an invalid field sets `aria-invalid` **and** `aria-describedby`, so the message is read out;
 *  - the error region is `role="status"`/`aria-live`, so a message that appears after a failed submit reaches
 *    a screen reader without the focus moving.
 *
 * No hooks, no `"use client"`: these render inside client forms and inside server-rendered panels alike.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

export function TextField({
  id,
  label,
  hint,
  error,
  className,
  ...props
}: React.ComponentProps<"input"> & { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string | null }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs text-pretty">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          error && "border-destructive",
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-destructive text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  id,
  label,
  hint,
  className,
  children,
  ...props
}: React.ComponentProps<"select"> & { id: string; label: React.ReactNode; hint?: React.ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        aria-describedby={hintId}
        className={cn(
          "border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-2.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one place a form reports that the *submit* failed, as opposed to a field being wrong.
 *
 * `role="status"` rather than `role="alert"`: an alert interrupts whatever the screen reader is saying, and a
 * message the user provoked by pressing a button does not need to interrupt anything.
 */
export function FormMessage({ tone, children }: { tone: "error" | "ok"; children?: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="min-h-[1.25rem]">
      {children ? (
        <p
          className={cn(
            "text-xs font-medium text-pretty",
            tone === "error" ? "text-destructive" : "text-success",
          )}
        >
          {children}
        </p>
      ) : null}
    </div>
  );
}
