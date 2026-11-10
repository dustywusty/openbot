import { IconChevronRight, IconCpu } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { WorkspaceBot } from "@openbot/shared/workspace-bot";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { setCodingBotDefaultsMutationOptions } from "@/lib/computers/desktop-mutations";
import { computerModelsQueryOptions } from "@/lib/computers/desktop-queries";
import { desktopShell } from "@/lib/desktop/shell";
import {
  CODING_PERMISSIONS,
  codingPermissionDescription,
  codingPermissionLabel,
  isCodingPermission,
} from "@/lib/computers/coding-permissions";
import { effortLabel } from "@/lib/models/effort";
import { queryClient } from "@/query-client";

export function CodingDefaultsSection({ agent }: { agent: AgentProfile }) {
  const [editing, setEditing] = useState(false);
  const config = agent.workspaceBot;
  if (!config) return null;
  return (
    <PageSection
      title="Coding defaults"
      description="Used when a conversation has no settings of its own. Changes affect future turns; an active turn keeps its current settings."
    >
      <PageRows>
        <Item
          size="sm"
          render={
            agent.canEditCodingDefaults && config.runtime === "codex" ? (
              <button type="button" onClick={() => setEditing(true)} />
            ) : undefined
          }
        >
          <ItemMedia variant="icon">
            <IconCpu />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Model, effort, and access</ItemTitle>
            <ItemDescription>
              {config.model ?? "Harness default"} ·{" "}
              {config.effort ? effortLabel(config.effort) : "Model default"} ·{" "}
              {config.speed === "fast" ? "Fast" : "Standard"} ·{" "}
              {codingPermissionLabel(config.permission)}
            </ItemDescription>
          </ItemContent>
          {agent.canEditCodingDefaults && config.runtime === "codex" && (
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          )}
        </Item>
      </PageRows>
      {editing && (
        <CodingDefaultsDialog
          agent={agent}
          config={config}
          onClose={() => setEditing(false)}
        />
      )}
    </PageSection>
  );
}
function CodingDefaultsDialog({
  agent,
  config,
  onClose,
}: {
  agent: AgentProfile;
  config: WorkspaceBot;
  onClose: () => void;
}) {
  const models = useQuery(computerModelsQueryOptions(config.workspaceId, true));
  const save = useMutation(setCodingBotDefaultsMutationOptions(queryClient));
  const [modelId, setModelId] = useState(config.model ?? "");
  const [effort, setEffort] = useState<string | null>(config.effort);
  const [speed, setSpeed] = useState<"standard" | "fast">(
    config.speed ?? "standard",
  );
  const [permission, setPermission] = useState(config.permission);
  const visible = models.data?.filter((model) => !model.hidden) ?? [];
  const selected =
    visible.find((model) => model.model === modelId) ??
    visible.find((model) => model.isDefault) ??
    visible[0];
  const supportedEffort = selected?.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === effort,
  )
    ? effort
    : (selected?.defaultReasoningEffort ?? null);
  const fast =
    selected?.serviceTiers.some((tier) => tier.id === "priority") ?? false;
  const supportedSpeed = fast ? speed : "standard";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Coding defaults for {agent.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {!desktopShell() ? (
            <p className="text-sm text-muted-foreground">
              Open this Bot in OpenBot Desktop to choose models installed in its
              VM.
            </p>
          ) : models.isPending ? null : models.error ? (
            <div className="grid gap-3">
              <p role="alert" className="text-sm text-destructive">
                {models.error.message}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void models.refetch()}
              >
                Retry model discovery
              </Button>
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/computers/$computerId"
                    params={{ computerId: config.workspaceId }}
                  />
                }
              >
                Open workspace
              </Button>
            </div>
          ) : !selected ? (
            <p className="text-sm text-muted-foreground">
              Codex did not return any available models.
            </p>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bot-coding-model">Model</FieldLabel>
                <Select
                  value={selected.model}
                  disabled={save.isPending}
                  onValueChange={(value) => {
                    if (value) {
                      setModelId(value);
                      const next = visible.find(
                        (model) => model.model === value,
                      );
                      setEffort(next?.defaultReasoningEffort ?? null);
                      if (
                        !next?.serviceTiers.some(
                          (tier) => tier.id === "priority",
                        )
                      )
                        setSpeed("standard");
                    }
                  }}
                >
                  <SelectTrigger id="bot-coding-model">
                    <SelectValue>{selected.displayName}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {visible.map((model) => (
                      <SelectItem key={model.model} value={model.model}>
                        {model.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{selected.description}</FieldDescription>
              </Field>
              {!!selected.supportedReasoningEfforts.length && (
                <Field>
                  <FieldLabel htmlFor="bot-coding-effort">
                    Thinking effort
                  </FieldLabel>
                  <Select
                    value={supportedEffort}
                    disabled={save.isPending}
                    onValueChange={setEffort}
                  >
                    <SelectTrigger id="bot-coding-effort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {selected.supportedReasoningEfforts.map((option) => (
                        <SelectItem
                          key={option.reasoningEffort}
                          value={option.reasoningEffort}
                        >
                          {effortLabel(option.reasoningEffort)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="bot-coding-speed">Speed</FieldLabel>
                <Select
                  value={supportedSpeed}
                  disabled={save.isPending}
                  onValueChange={(value) => {
                    if (value === "standard" || value === "fast")
                      setSpeed(value);
                  }}
                >
                  <SelectTrigger id="bot-coding-speed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    {fast && <SelectItem value="fast">Fast</SelectItem>}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {fast
                    ? "Choose a supported service tier for this model."
                    : "This model supports standard speed."}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-coding-permission">
                  VM permissions
                </FieldLabel>
                <Select
                  value={permission}
                  disabled={save.isPending}
                  onValueChange={(value) => {
                    if (isCodingPermission(value)) setPermission(value);
                  }}
                >
                  <SelectTrigger id="bot-coding-permission">
                    <SelectValue>
                      {codingPermissionLabel(permission)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CODING_PERMISSIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {codingPermissionDescription(permission)}
                </FieldDescription>
              </Field>
            </FieldGroup>
          )}
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
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              save.isPending ||
              models.isPending ||
              !!models.error ||
              !selected ||
              !desktopShell()
            }
            onClick={() => {
              if (!selected || models.isPending || models.error) return;
              void save
                .mutateAsync({
                  agent,
                  defaults: {
                    model: selected.model,
                    effort: supportedEffort as WorkspaceBot["effort"],
                    speed: supportedSpeed,
                    permission,
                  },
                })
                .then(onClose)
                .catch(() => undefined);
            }}
          >
            {save.isPending ? "Saving…" : "Save defaults"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
