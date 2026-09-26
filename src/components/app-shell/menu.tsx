"use client";

/**
 * The shell's dropdown primitives (SAAS §8.2). WP20.
 *
 * A thin, local wrapper over Radix's dropdown menu. It lives here rather than in `src/components/ui` because
 * `ui/**` is WP12's shadcn surface and this is shell furniture: the org switcher and the user menu are the only
 * two callers, and both want the same width, the same item height and the same check mark.
 */
import { CheckIcon } from "lucide-react";
import { DropdownMenu as Primitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;

export function MenuContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground z-50 min-w-56 overflow-hidden rounded-lg border p-1 shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn("cx-eyebrow px-2 pt-2 pb-1", className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />;
}

export function MenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof Primitive.Item> & { inset?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none select-none",
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

/** An item that shows whether it is the current choice — the org switcher's rows. */
export function MenuRadioItem({
  checked,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Item> & { checked: boolean }) {
  return (
    <MenuItem className={cn("pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        {checked ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
      </span>
      {children}
    </MenuItem>
  );
}
