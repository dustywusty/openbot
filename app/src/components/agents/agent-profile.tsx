import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQueryOptions } from "@/lib/agents/queries";
import { effortLabel } from "@/lib/models/effort";
import {
  codingPermissionDescription,
  codingPermissionLabel,
} from "@/lib/computers/coding-permissions";
import {
  codingConversationModelQueryOptions,
  pairedDesktopVmsQueryOptions,
} from "@/lib/computers/desktop-queries";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3">
        <Skeleton className="size-20 shrink-0 rounded-full" />
        <div className="flex w-full flex-col items-center gap-1.5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </header>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * Who this coworker is, beside a conversation with it.
 *
 * A card, not a control panel: the panel answers "who am I talking to" — avatar, name, role — and
 * everything that changes the coworker lives in its own dialog, opened from the one button here.
 * It used to duplicate that dialog's whole surface (edit form, tokens, grants, delete), which made
 * two places to maintain and a sidebar that scrolled past the conversation it sat beside.
 */
export function AgentProfile({
  agentId,
  footer,
  channelId,
}: {
  agentId: string;
  channelId?: string;
  /** What the panel offers about the conversation rather than the Bot, below a separator. */
  footer?: ReactNode;
}) {
  /** The full dialog, opened over the chat rather than navigating away from it. */
  const navigate = useNavigate();
  const agent = useQuery(agentQueryOptions(agentId));
  const coding = useQuery(
    codingConversationModelQueryOptions(
      channelId ?? "",
      !!channelId && !!agent.data?.workspaceBot,
    ),
  );
  const vms = useQuery({
    ...pairedDesktopVmsQueryOptions(),
    enabled: !!agent.data?.computerId || !!agent.data?.workspaceBot,
  });

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Couldn't load this Bot.
      </p>
    );
  }

  const profile = agent.data;
  const choice = coding.data?.choice;
  const effectiveModel =
    choice?.model ??
    profile.workspaceBot?.model ??
    coding.data?.catalogue.default;
  const modelLabel =
    coding.data?.catalogue.models.find((model) => model.id === effectiveModel)
      ?.label ??
    effectiveModel ??
    "Harness default";
  const effectiveEffort = choice
    ? (choice.effort ??
      coding.data?.catalogue.models.find((model) => model.id === effectiveModel)
        ?.defaultEffort)
    : profile.workspaceBot?.effort;
  const vmName = vms.data?.find(
    (vm) =>
      vm.computerId ===
      (profile.computerId ?? profile.workspaceBot?.workspaceId),
  )?.name;

  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <AbstractAvatar
          name={profile.name}
          seed={profile.avatarSeed}
          size={80}
        />
        <div className="flex w-full flex-col items-center gap-0.5">
          <h1 className="w-full text-balance text-2xl font-semibold leading-tight tracking-tight">
            {profile.name}
          </h1>
          {profile.title && (
            <p className="w-full text-balance text-sm text-muted-foreground">
              {profile.title}
            </p>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">
          <Tag>{profile.visibility === "private" ? "Private" : "Public"}</Tag>
          {profile.systemOwned ? <Tag>System owned</Tag> : null}
        </div>
      </header>

      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What it does
        </h2>
        <p className="text-sm whitespace-pre-wrap text-pretty">
          {profile.roleDescription}
        </p>
      </section>

      {profile.workspaceBot ? (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Coding setup
          </h2>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Harness</dt>
              <dd>
                {profile.workspaceBot.runtime === "codex"
                  ? "Codex"
                  : "Claude Code"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">
                {choice ? "Model" : "Default model"}
              </dt>
              <dd className="break-all text-right">{modelLabel}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">
                {choice ? "Thinking effort" : "Default effort"}
              </dt>
              <dd>
                {effectiveEffort
                  ? effortLabel(effectiveEffort)
                  : "Model default"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Speed</dt>
              <dd>
                {(choice?.speed ?? profile.workspaceBot.speed) === "fast"
                  ? "Fast"
                  : "Standard"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">VM access</dt>
              <dd>{codingPermissionLabel(profile.workspaceBot.permission)}</dd>
            </div>
          </dl>
          {coding.error ? (
            <p className="text-sm text-muted-foreground">
              Current conversation settings are unavailable. Showing the Bot's
              defaults.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {codingPermissionDescription(profile.workspaceBot.permission)}
          </p>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/computers/$computerId"
                params={{ computerId: profile.workspaceBot.workspaceId }}
              />
            }
          >
            {vmName ? `Open ${vmName}` : "Open project VM"}
          </Button>
        </section>
      ) : null}
      {!profile.workspaceBot && profile.computerId ? (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Computer
          </h2>
          <p className="text-sm">
            File and command tools run in {vmName ?? "its assigned project VM"}.
          </p>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/computers/$computerId"
                params={{ computerId: profile.computerId }}
              />
            }
          >
            {vmName ? `Open ${vmName}` : "Open project VM"}
          </Button>
        </section>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          className="w-full text-sm!"
          onClick={() =>
            void navigate({ search: { agent: agentId }, to: "/channel/new" })
          }
        >
          New conversation
        </Button>
        <Button
          className="w-full text-sm!"
          render={(props) => (
            <Link {...props} params={{ agentId }} to="/bots/$agentId" />
          )}
          variant="outline"
        >
          Open {profile.name}
        </Button>
      </div>
      {footer ? (
        <>
          <Separator />
          {footer}
        </>
      ) : null}
    </div>
  );
}
