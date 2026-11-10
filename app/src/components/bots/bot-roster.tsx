import {
  IconBolt,
  IconChevronRight,
  IconPlus,
  IconShare,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { BotBatchActions } from "./bot-batch-actions";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Every Bot the person can reach, in the one place they are listed: what needs the person first,
 * then pinned, then their own, then the ones shared with them, and the ones they hid folded away at
 * the end.
 *
 * Needs you is where the sidebar's badge leads, so it holds everything behind that number in one
 * card: the Bots with a question, an approval or a stalled hand-off (answered on the Bot's page),
 * the tasks started from check-ins, and what every Bot's check-ins found, each row naming its Bot.
 *
 * This replaces three screens (Bots, Agents and Team Bots) that listed the same Bots three ways.
 */
type Selection = {
  editing: boolean;
  selected: Set<string>;
  toggle: (id: string) => void;
  busy: boolean;
};
const SelectionContext = createContext<Selection | null>(null);

export function BotRoster({
  editing = false,
  onBusyChange,
}: {
  editing?: boolean;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const updateBusy = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusyChange?.(value);
    },
    [onBusyChange],
  );
  useEffect(() => {
    if (!editing) setSelected(new Set());
  }, [editing]);
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  if (agents.isPending) return null;
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load your Bots. Reload the page.
      </p>
    );
  }
  // Every Bot stays in its own section; what it waits on is on the board above, by name.
  const { pinned, yours, shared } = groupRoster(agents.data);
  const yoursPinned = pinned.some((agent) => agent.mine);

  const all = [
    ...new Map(
      [...agents.data, ...(hidden.data ?? [])].map((agent) => [
        agent.id,
        agent,
      ]),
    ).values(),
  ];
  const available = new Set(all.map((agent) => agent.id));
  const activeSelection = new Set(
    [...selected].filter((id) => available.has(id)),
  );
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <SelectionContext.Provider
      value={{ editing, selected: activeSelection, toggle, busy }}
    >
      {editing && (
        <BotBatchActions
          agents={all}
          selected={activeSelection}
          setSelected={setSelected}
          onBusy={updateBusy}
          personal={personal}
        />
      )}
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      <PageSection title="Yours">
        {yours.length ? (
          <RosterRows agents={yours} byId={byId} />
        ) : (
          <PageEmpty
            action={
              yoursPinned ? undefined : (
                <Button
                  render={(props) => (
                    <Link {...props} search={{ new: true }} to="/bots" />
                  )}
                  size="sm"
                  variant="outline"
                >
                  <IconPlus />
                  New Bot
                </Button>
              )
            }
            icon={IconBolt}
            title={yoursPinned ? "All pinned" : "No Bots yet"}
          >
            {yoursPinned
              ? "Your Bots are all pinned above."
              : "Bots you create show up here."}
          </PageEmpty>
        )}
      </PageSection>
      {shared.length > 0 || !personal ? (
        <PageSection
          title={personal ? "Included with OpenBot" : "Shared with you"}
        >
          {shared.length ? (
            <RosterRows agents={shared} byId={byId} />
          ) : (
            <PageEmpty icon={IconShare} title="Nothing shared yet">
              Bots somebody shares with you show up here.
            </PageEmpty>
          )}
        </PageSection>
      ) : null}
      <DoneTasks done={list.done} />
      {hidden.data?.length ? (
        <HiddenSection agents={hidden.data} byId={byId} personal={personal} />
      ) : null}
    </SelectionContext.Provider>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives. The personal edition has
 * nobody else with a list, so it doesn't say only theirs changed.
 */
function HiddenSection({
  agents,
  byId,
  personal,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
  personal: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selection = useContext(SelectionContext);
  return (
    <PageSection
      action={
        selection?.editing ? undefined : (
          <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
            {open ? "Hide" : "Show"}
          </Button>
        )
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`}
      title="Hidden"
    >
      {open || selection?.editing ? (
        <RosterRows agents={agents} byId={byId} />
      ) : null}
    </PageSection>
  );
}

function RosterRows({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  return (
    <PageRows>
      {agents.map((agent, index) => (
        <Fragment key={agent.id}>
          {index > 0 ? <Separator /> : null}
          <RosterRow agent={agent} state={byId.get(agent.id)} />
        </Fragment>
      ))}
    </PageRows>
  );
}

/**
 * One Bot, opening its page. The count is everything from it that waits on the person, its
 * check-in items and tasks included, so a Bot whose items are listed under Needs you still says so
 * wherever it sits.
 */
function RosterRow({
  agent,
  state,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
}) {
  const selection = useContext(SelectionContext);
  const summary = state
    ? [state.paused ? "Paused" : "", attentionSummary(state)]
        .filter(Boolean)
        .join(" · ")
    : "";
  const waiting = state ? waitingOnYou(state) : 0;
  return (
    <Item
      render={
        selection?.editing ? undefined : (
          <Link params={{ agentId: agent.id }} to="/bots/$agentId" />
        )
      }
      size="sm"
    >
      <ItemMedia>
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={28} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {selection?.editing ? (
            <label
              className="cursor-pointer"
              htmlFor={`select-bot-${agent.id}`}
            >
              <span className="sr-only">Select </span>
              {agent.name}
            </label>
          ) : (
            agent.name
          )}
        </ItemTitle>
        <ItemDescription>{summary || agent.title}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {waiting > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
            {waiting}
          </span>
        ) : null}
        {selection?.editing ? (
          <Checkbox
            id={`select-bot-${agent.id}`}
            aria-label={`Select ${agent.name}`}
            checked={selection.selected.has(agent.id)}
            disabled={
              selection.busy ||
              (agent.assignedToMe === true && !agent.canManage)
            }
            onCheckedChange={() => selection.toggle(agent.id)}
          />
        ) : (
          <IconChevronRight className="size-4 text-muted-foreground" />
        )}
      </ItemActions>
    </Item>
  );
}
