import { IconChevronRight, IconDeviceDesktop } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentProfile } from "@/lib/agents/queries";
import { setBotComputerMutationOptions } from "@/lib/computers/desktop-mutations";
import { pairedDesktopVmsQueryOptions } from "@/lib/computers/desktop-queries";
import { queryClient } from "@/query-client";

/** Uses the server's edit verdict and owner-filtered VM list; no ownership policy lives in React. */
export function BotComputerAssignment({ agent }: { agent: AgentProfile }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(agent.computerId ?? "home");
  const vms = useQuery({
    ...pairedDesktopVmsQueryOptions(),
    enabled: !!agent.canAssignComputer || !!agent.computerId,
  });
  const save = useMutation(setBotComputerMutationOptions(queryClient));
  const assigned = vms.data?.find((vm) => vm.computerId === agent.computerId);
  const summary = agent.workspaceBot
    ? "Its coding harness runs in this project VM."
    : agent.computerId
      ? `${assigned?.name ?? "Assigned project VM"} · File and command tools run here.`
      : "OpenBot home · Uses OpenBot's existing runtime.";
  return (
    <PageSection
      title="Computer"
      description="A coding conversation and background Bots can work on the same project VM. Changing this assignment moves future file and command actions."
    >
      <PageRows>
        <Item
          size="sm"
          render={
            agent.canAssignComputer ? (
              <button
                type="button"
                onClick={() => {
                  setSelected(agent.computerId ?? "home");
                  save.reset();
                  setOpen(true);
                }}
              />
            ) : undefined
          }
        >
          <ItemMedia variant="icon">
            <IconDeviceDesktop />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              {agent.computerId
                ? (assigned?.name ?? "Project VM")
                : "OpenBot home"}
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              {summary}
            </ItemDescription>
          </ItemContent>
          {agent.canAssignComputer ? (
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          ) : agent.computerId ? (
            <ItemActions>
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/computers/$computerId"
                    params={{ computerId: agent.computerId }}
                  />
                }
              >
                Open VM
              </Button>
            </ItemActions>
          ) : null}
        </Item>
      </PageRows>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!save.isPending) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Computer for {agent.name}</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="bot-project-vm">
                File and command tools
              </FieldLabel>
              <FieldDescription>
                Choose one of your paired VMs, or use OpenBot home. The Bot
                keeps its existing model and instructions.
              </FieldDescription>
              {vms.isPending ? null : vms.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {vms.error.message}
                </p>
              ) : (
                <Select
                  value={selected}
                  onValueChange={(value) => {
                    if (value) setSelected(value);
                  }}
                  disabled={save.isPending}
                >
                  <SelectTrigger id="bot-project-vm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="home">OpenBot home</SelectItem>
                    {!!agent.computerId && !assigned && (
                      <SelectItem value={agent.computerId} disabled>
                        Assigned VM is not paired
                      </SelectItem>
                    )}
                    {vms.data?.map((vm) => (
                      <SelectItem key={vm.computerId} value={vm.computerId}>
                        {vm.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {vms.data?.length === 0 && (
                <FieldDescription>
                  Pair a project VM from Computers to make it available here.
                </FieldDescription>
              )}
            </Field>
            {save.error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {save.error.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                save.isPending ||
                (selected !== "home" &&
                  !vms.data?.some((vm) => vm.computerId === selected))
              }
              onClick={() => {
                void save
                  .mutateAsync({
                    agent,
                    computerId: selected === "home" ? null : selected,
                  })
                  .then(() => setOpen(false))
                  .catch(() => undefined);
              }}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
