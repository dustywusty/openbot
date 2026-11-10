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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** No lifecycle operation lives here. The native controller owns deletion and its safety verdict. */
export function DeleteWorkspaceDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
  pending,
  blockedReason,
  error,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (confirmation: string) => void;
  pending: boolean;
  /** An authoritative native refusal, including running VMs and active worker operations. */
  blockedReason: string | null;
  error?: string | null;
}) {
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (open) setConfirmation("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the workspace's VM, project files,
            installed packages, and tools. You cannot undo this.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <p className="mb-4 text-sm">
            Your Bots and conversations stay in OpenBot. They will no longer be
            able to use this workspace.
          </p>
          <Field>
            <FieldLabel htmlFor="delete-workspace-name">
              Workspace name
            </FieldLabel>
            <FieldDescription>
              Type {name} to confirm deletion.
            </FieldDescription>
            <Input
              id="delete-workspace-name"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending}
            />
          </Field>
          {blockedReason && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {blockedReason}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending || !!blockedReason || confirmation !== name}
            onClick={() => onConfirm(confirmation)}
          >
            {pending ? "Deleting…" : "Delete workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
