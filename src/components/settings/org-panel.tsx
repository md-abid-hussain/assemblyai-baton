"use client";

/**
 * Settings → Organization (SAAS §8.4, §3.5). WP20·2.
 *
 * Rename and slug (admin+), and the three ways a workspace changes hands or ends: transfer, leave, delete.
 * All four are server-mediated (§3.8) and all four are re-checked by WP19·3's routes; this panel's contribution
 * is that it never offers what would be refused, and that each refusal it can predict is already a sentence.
 *
 * **Leaving and deleting end with a full page load, not `router.refresh()`.** Both change which org the session
 * is active in, and the client cache still holds every `/app` page rendered for the org that no longer exists.
 * A refresh would repaint the shell while the runs list underneath it still belonged to the deleted workspace.
 *
 * **The slug is sanitised as you type** rather than validated on submit. The rule ("lowercase, numbers, single
 * dashes") is easier to see happening than to read, and a field that silently fixes itself is a field nobody
 * has to be told about twice.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FormMessage, SelectField, TextField } from "@/components/auth/fields";
import { DangerPanel, Fact, FactList, Panel, Row } from "@/components/settings/bits";
import { ConfirmDialog } from "@/components/settings/controls";
import { createOrg, deleteOrg, isFailure, leaveOrg, transferOrg, updateOrg } from "@/client/app/app-api";
import { isAuthFailure, setActiveOrg } from "@/client/app/auth-actions";
import {
  formatUtcDate,
  orgNameProblem,
  sanitizeSlug,
  slugProblem,
  type OrgSettingsView,
} from "@/core/contracts/ext/wp20-app";
import { PLANS } from "@/core/contracts/v3/plans";

const KIND_LABEL: Record<OrgSettingsView["kind"], string> = {
  guest: "Guest workspace",
  personal: "Personal",
  team: "Team",
};

export interface OrgPanelProps {
  view: OrgSettingsView;
  /** How many orgs this user already owns, against `MAX_OWNED_ORGS` (SAAS §3.5: "≤ 3 owned"). */
  ownedCount: number;
  maxOwned: number;
  /** The switcher's "New organization" link lands here with `?new=1`; the dialog opens on arrival. */
  openNew?: boolean;
}

export function OrgPanel({ view, ownedCount, maxOwned, openNew = false }: OrgPanelProps) {
  return (
    <div className="space-y-5">
      <IdentityPanel view={view} />

      <Panel title="Details">
        <FactList>
          <Fact label="Kind">{KIND_LABEL[view.kind]}</Fact>
          <Fact label="Plan">{PLANS[view.plan].name}</Fact>
          <Fact label="Created">{view.createdAt ? formatUtcDate(view.createdAt) : "—"}</Fact>
          <Fact label="Members">
            {view.memberCount} {view.memberCount === 1 ? "member" : "members"}
          </Fact>
        </FactList>
      </Panel>

      <NewOrgPanel
        disabled={view.accountRequired}
        ownedCount={ownedCount}
        maxOwned={maxOwned}
        openOnMount={openNew}
      />

      {view.canTransfer || view.canLeave || view.canDelete ? (
        <DangerPanel>
          {view.canTransfer ? <TransferRow view={view} /> : null}
          {view.canLeave ? <LeaveRow view={view} /> : null}
          {view.canDelete ? <DeleteRow view={view} /> : null}
        </DangerPanel>
      ) : null}
    </div>
  );
}

function IdentityPanel({ view }: { view: OrgSettingsView }) {
  const router = useRouter();
  const [name, setName] = useState(view.name);
  const [slug, setSlug] = useState(view.slug);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const dirty = name !== view.name || slug !== view.slug;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !view.canUpdate || !dirty) return;

    const n = orgNameProblem(name);
    const s = slugProblem(slug);
    setNameError(n);
    setSlugError(s);
    setMessage(null);
    if (n || s) return;

    setPending(true);
    const res = await updateOrg(view.id, {
      ...(name !== view.name ? { name: name.trim() } : {}),
      ...(slug !== view.slug ? { slug: slug.trim() } : {}),
    });
    setPending(false);
    if (isFailure(res)) {
      setMessage({ tone: "error", text: res.message });
      return;
    }
    setMessage({ tone: "ok", text: "Saved." });
    router.refresh();
  }

  return (
    <Panel
      title="Workspace"
      description={
        view.canUpdate
          ? "The name appears in the switcher and on every invite you send."
          : "Only an owner or an admin can rename this workspace."
      }
    >
      <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
        <TextField
          id="org-name"
          label="Name"
          value={name}
          error={nameError}
          disabled={!view.canUpdate || pending}
          maxLength={80}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextField
          id="org-slug"
          label="Slug"
          value={slug}
          error={slugError}
          disabled={!view.canUpdate || pending}
          hint="Lowercase letters, numbers and single dashes."
          onChange={(e) => setSlug(sanitizeSlug(e.currentTarget.value))}
        />

        <FormMessage tone={message?.tone ?? "error"}>{message?.text}</FormMessage>

        {view.canUpdate ? (
          <button
            type="submit"
            disabled={pending || !dirty}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        ) : null}
      </form>
    </Panel>
  );
}

function NewOrgPanel({
  disabled,
  ownedCount,
  maxOwned,
  openOnMount,
}: {
  disabled: boolean;
  ownedCount: number;
  maxOwned: number;
  openOnMount: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // `?new=1` comes from the switcher. Opening in an effect rather than from the initial state keeps the server
  // and the first client render identical, which is what hydration compares.
  useEffect(() => {
    if (openOnMount) setOpen(true);
  }, [openOnMount]);

  const atCap = ownedCount >= maxOwned;
  const blocked = disabled || atCap;

  async function onCreate() {
    const problem = orgNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const res = await createOrg(name.trim());
    if (isFailure(res)) {
      setPending(false);
      setError(res.message);
      return;
    }
    // Make it the one you are looking at. A new workspace you then have to go and find is a worse outcome than
    // one extra call, and a failure here is not a failure of the create — the org exists either way.
    const switched = await setActiveOrg(res.id);
    if (isAuthFailure(switched)) {
      setPending(false);
      setError(switched.message);
      return;
    }
    window.location.assign("/app");
  }

  return (
    <Panel
      title="New workspace"
      description={
        disabled
          ? "Creating another workspace needs an account."
          : `A separate set of relays, runs, members and billing. You own ${ownedCount} of ${maxOwned}.`
      }
      actions={
        <button
          type="button"
          disabled={blocked}
          onClick={() => setOpen(true)}
          className="hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-50"
        >
          New organization
        </button>
      }
    >
      {atCap && !disabled ? (
        <p className="text-muted-foreground text-xs text-pretty">
          You already own {maxOwned} workspaces, which is the limit. Delete or transfer one to create another.
        </p>
      ) : null}

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setName("");
            setError(null);
          }
        }}
        title="New organization"
        description="Name it after the team or the client it is for. You can rename it later."
        confirmLabel="Create workspace"
        pending={pending}
        error={error}
        onConfirm={onCreate}
      >
        <TextField
          id="new-org-name"
          label="Workspace name"
          value={name}
          maxLength={80}
          autoFocus
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </ConfirmDialog>
    </Panel>
  );
}

function TransferRow({ view }: { view: OrgSettingsView }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(view.transferTargets[0]?.userId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const target = view.transferTargets.find((t) => t.userId === userId);

  async function onTransfer() {
    if (!userId) return;
    setPending(true);
    setError(null);
    const res = await transferOrg(view.id, userId);
    setPending(false);
    if (isFailure(res)) {
      setError(res.message);
      return;
    }
    setOpen(false);
    // You are an admin here now, so half the controls on this page have to disappear.
    router.refresh();
  }

  return (
    <Row
      title="Transfer ownership"
      body="Hand this workspace to an admin. You stay as an admin; they take over billing and deletion."
      action={
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors"
          >
            Transfer
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Transfer ownership"
            description={
              target
                ? `${target.name} becomes the owner of ${view.name}. You become an admin and can no longer delete the workspace or change billing.`
                : "Pick the admin who should own this workspace."
            }
            confirmLabel="Transfer ownership"
            destructive
            pending={pending}
            error={error}
            onConfirm={onTransfer}
          >
            <SelectField
              id="transfer-target"
              label="New owner"
              value={userId}
              onChange={(e) => setUserId(e.currentTarget.value)}
            >
              {view.transferTargets.map((t) => (
                <option key={t.userId} value={t.userId}>
                  {t.name} ({t.email})
                </option>
              ))}
            </SelectField>
          </ConfirmDialog>
        </>
      }
    />
  );
}

function LeaveRow({ view }: { view: OrgSettingsView }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    setPending(true);
    setError(null);
    const res = await leaveOrg(view.id);
    if (isFailure(res)) {
      setPending(false);
      setError(res.message);
      return;
    }
    window.location.assign("/app");
  }

  return (
    <Row
      title="Leave this workspace"
      body="You lose access to its relays, runs and settings. Anything you built stays with the workspace."
      action={
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-destructive hover:bg-destructive/10 inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors"
          >
            Leave
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={`Leave ${view.name}?`}
            description="You will need a new invitation to come back."
            confirmLabel="Leave workspace"
            destructive
            pending={pending}
            error={error}
            onConfirm={onLeave}
          />
        </>
      }
    />
  );
}

function DeleteRow({ view }: { view: OrgSettingsView }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setPending(true);
    setError(null);
    const res = await deleteOrg(view.id, view.name);
    if (isFailure(res)) {
      setPending(false);
      setError(res.message);
      return;
    }
    window.location.assign("/app");
  }

  return (
    <Row
      title="Delete this workspace"
      body="Published relays are unpublished, API keys stop working, webhook endpoints are disabled and every relay is deleted. The audit log is kept for 30 days."
      action={
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="bg-destructive inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-white transition-colors hover:opacity-90"
          >
            Delete
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={`Delete ${view.name}?`}
            description={`This cannot be undone. ${view.memberCount > 1 ? `All ${view.memberCount} members lose access immediately.` : ""}`}
            confirmLabel="Delete workspace"
            destructive
            typeToConfirm={view.name}
            pending={pending}
            error={error}
            onConfirm={onDelete}
          />
        </>
      }
    />
  );
}
