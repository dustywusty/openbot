import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  batchAgentsMutationOptions,
  type BatchAgentAction,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

export function BotBatchActions({
  agents,
  selected,
  setSelected,
  onBusy,
  personal,
}: {
  agents: AgentProfile[];
  selected: Set<string>;
  setSelected: (ids: Set<string>) => void;
  onBusy: (busy: boolean) => void;
  personal: boolean;
}) {
  const batch = useMutation(batchAgentsMutationOptions(queryClient));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failures, setFailures] = useState<
    { id: string; name: string; message: string }[]
  >([]);
  useEffect(() => {
    onBusy(batch.isPending);
  }, [batch.isPending, onBusy]);
  const selectedBots = agents.filter((agent) => selected.has(agent.id));
  const deletable = selectedBots.filter((agent) => agent.canManage);
  const hideable = selectedBots.filter(
    (agent) => !agent.hidden && !agent.assignedToMe,
  );
  const showable = selectedBots.filter(
    (agent) => agent.hidden && !agent.assignedToMe,
  );
  const selectable = agents.filter(
    (agent) => agent.canManage || !agent.assignedToMe,
  );
  const allSelected =
    selectable.length > 0 &&
    selectable.every((agent) => selected.has(agent.id));
  const perform = async (action: BatchAgentAction, targets: AgentProfile[]) => {
    setFailures([]);
    const result = await batch.mutateAsync({
      action,
      agentIds: targets.map((agent) => agent.id),
    });
    const completed = new Set(result.completedIds);
    setSelected(new Set([...selected].filter((id) => !completed.has(id))));
    setFailures(
      result.failures.map((failure) => ({
        id: failure.id,
        name: targets.find((agent) => agent.id === failure.id)?.name ?? "Bot",
        message: failure.message,
      })),
    );
    if (result.failures.length === 0) setConfirmDelete(false);
  };
  const errors = failures.length ? (
    <ul className="text-sm text-destructive" role="alert">
      {failures.map((failure) => (
        <li key={failure.id}>
          {failure.name}: {failure.message}
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <>
      <section className="mt-8 flex flex-col gap-3" aria-label="Edit Bots">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={batch.isPending || !selectable.length}
            onClick={() => {
              setSelected(
                allSelected
                  ? new Set()
                  : new Set(selectable.map((agent) => agent.id)),
              );
              setFailures([]);
            }}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </Button>
          <span className="text-sm text-muted-foreground" role="status">
            {selectedBots.length} selected
          </span>
          {hideable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={batch.isPending}
              onClick={() => void perform("hide", hideable)}
            >
              {batch.isPending && batch.variables?.action === "hide"
                ? "Hiding…"
                : `Hide (${hideable.length})`}
            </Button>
          )}
          {showable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={batch.isPending}
              onClick={() => void perform("unhide", showable)}
            >
              {batch.isPending && batch.variables?.action === "unhide"
                ? "Unhiding…"
                : `Unhide (${showable.length})`}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={batch.isPending || !deletable.length}
            onClick={() => {
              setFailures([]);
              setConfirmDelete(true);
            }}
          >
            {batch.isPending && batch.variables?.action === "delete"
              ? "Deleting…"
              : `Delete (${deletable.length})`}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Select Bots below. Built-in Bots can be hidden; only Bots you can
          manage can be deleted.
        </p>
        {!confirmDelete && errors}
      </section>
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!batch.isPending) setConfirmDelete(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deletable.length}{" "}
              {deletable.length === 1 ? "Bot" : "Bots"}?
            </DialogTitle>
            <DialogDescription>
              {personal
                ? "You can still read your conversations with them, but they can't reply. You can't undo this."
                : "These Bots are deleted for everyone. You can't undo this."}
              {selectedBots.length > deletable.length
                ? ` ${selectedBots.length - deletable.length} other selected ${selectedBots.length - deletable.length === 1 ? "Bot cannot" : "Bots cannot"} be deleted and will stay.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <ul className="list-disc pl-5 text-sm">
              {deletable.map((agent) => (
                <li key={agent.id}>{agent.name}</li>
              ))}
            </ul>
            {errors}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={batch.isPending}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={batch.isPending || !deletable.length}
              onClick={() => void perform("delete", deletable)}
            >
              {batch.isPending ? "Deleting…" : "Delete selected"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
