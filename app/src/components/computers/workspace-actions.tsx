import { IconDots, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteWorkspaceMutationOptions } from "@/lib/computers/desktop-mutations";
import { queryClient } from "@/query-client";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog";

/** Native deletion is available only in the matching desktop build. Mounted by its workspace page. */
export function WorkspaceActions({
  id,
  name,
  phase,
  busy,
}: {
  id: string;
  name: string;
  phase: string;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(deleteWorkspaceMutationOptions(queryClient));
  const navigate = useNavigate();
  // These are presentation guards. Native code also checks actual VM state and active usage.
  const stopped = ["created", "stopped", "failed"].includes(phase);
  const blockedReason = busy
    ? "Wait for the current workspace operation to finish."
    : !stopped
      ? "Stop this workspace before deleting it."
      : null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Workspace actions"
              disabled={busy || remove.isPending}
            />
          }
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              disabled={!!blockedReason}
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              <IconTrash />
              Delete workspace…
            </DropdownMenuItem>
            {blockedReason && (
              <DropdownMenuLabel>{blockedReason}</DropdownMenuLabel>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteWorkspaceDialog
        name={name}
        open={confirming}
        onOpenChange={setConfirming}
        pending={remove.isPending}
        blockedReason={blockedReason}
        error={remove.error?.message}
        onConfirm={() => {
          void remove
            .mutateAsync(id)
            .then(async () => {
              setConfirming(false);
              await navigate({ to: "/computers" });
            })
            .catch(() => undefined);
        }}
      />
    </>
  );
}
