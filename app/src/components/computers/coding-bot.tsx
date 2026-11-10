import {
  parseWorkspaceBot,
  type WorkspaceBot,
} from "@openbot/shared/workspace-bot";
import {
  IconBrandOpenai,
  IconCode,
  IconDeviceDesktop,
  IconPlus,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageCard,
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import {
  CODING_PERMISSIONS,
  codingPermissionDescription,
  codingPermissionLabel,
  isCodingPermission,
} from "@/lib/computers/coding-permissions";
import {
  allowComputerChatGptMutationOptions,
  cancelComputerChatGptMutationOptions,
  connectComputerChatGptMutationOptions,
  disconnectComputerChatGptMutationOptions,
  disconnectWorkspaceMutationOptions,
  pairDesktopComputerMutationOptions,
} from "@/lib/computers/desktop-mutations";
import {
  computerAuthQueryOptions,
  computerModelsQueryOptions,
  localVmsQueryOptions,
} from "@/lib/computers/desktop-queries";
import { desktopShell } from "@/lib/desktop/shell";
import { effortLabel } from "@/lib/models/effort";
import { queryClient } from "@/query-client";

/** Both detail and creation screens share the same native account/grant verdicts. */
export function ComputerCodingSection({
  id,
  ready,
  hasCodex,
}: {
  id: string;
  ready: boolean;
  hasCodex: boolean;
}) {
  return (
    <PageSection
      title="Coding Bots"
      description="Direct Codex from a normal Bot conversation. Its commands and project files stay in this VM."
    >
      {!hasCodex ? (
        <PageEmpty icon={IconCode} title="Codex is not installed">
          This VM's recipe does not include Codex. Choose it when creating a VM
          to use a coding Bot.
        </PageEmpty>
      ) : !ready ? (
        <PageEmpty icon={IconCode} title="Start this VM first">
          Start the VM before creating a coding Bot.
        </PageEmpty>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconCode />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Codex</ItemTitle>
              <ItemDescription>
                Choose its default model, thinking effort, and project
                permissions.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                size="sm"
                render={
                  <Link
                    to="/computers/$computerId/new-bot"
                    params={{ computerId: id }}
                  />
                }
              >
                <IconPlus />
                New coding Bot
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

export function ComputerSignIn({
  id,
  codingEnabled = true,
}: {
  id: string;
  codingEnabled?: boolean;
}) {
  const auth = useQuery(computerAuthQueryOptions(id));
  const pair = useMutation(pairDesktopComputerMutationOptions(queryClient));
  const connect = useMutation(
    connectComputerChatGptMutationOptions(queryClient),
  );
  const allow = useMutation(allowComputerChatGptMutationOptions(queryClient));
  const cancel = useMutation(cancelComputerChatGptMutationOptions(queryClient));
  const disconnect = useMutation(
    disconnectComputerChatGptMutationOptions(queryClient),
  );
  const disconnectWorkspace = useMutation(
    disconnectWorkspaceMutationOptions(queryClient),
  );
  const busy =
    pair.isPending ||
    connect.isPending ||
    allow.isPending ||
    cancel.isPending ||
    disconnect.isPending ||
    disconnectWorkspace.isPending;
  const problem =
    pair.error ||
    connect.error ||
    allow.error ||
    cancel.error ||
    disconnect.error ||
    disconnectWorkspace.error ||
    auth.error;
  return (
    <PageSection
      title="Connection"
      description={
        codingEnabled
          ? "Pair this workspace with your OpenBot account. ChatGPT credentials stay in your desktop credential manager; coding turns receive a temporary access token."
          : "Pair this workspace with your OpenBot account so your Bots can use its file and command tools."
      }
    >
      {auth.isPending ? null : auth.error ? null : !auth.data ? null : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconDeviceDesktop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>OpenBot account</ItemTitle>
              <ItemDescription>
                {auth.data.paired
                  ? "This VM is paired with your account."
                  : auth.data.canDisconnect
                    ? "This workspace is disconnected from OpenBot."
                    : "Pair this VM so your Bots can work here."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {auth.data.canDisconnect ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => disconnectWorkspace.mutate(id)}
                >
                  {disconnectWorkspace.isPending
                    ? "Disconnecting…"
                    : "Disconnect workspace"}
                </Button>
              ) : null}
              {!auth.data.paired ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => pair.mutate(id)}
                >
                  {pair.isPending ? "Pairing…" : "Pair VM"}
                </Button>
              ) : null}
            </ItemActions>
          </Item>
          {codingEnabled && (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBrandOpenai />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>ChatGPT</ItemTitle>
                  <ItemDescription>
                    {auth.data.pending
                      ? "Finish signing in in your browser, then return here."
                      : auth.data.allowed
                        ? `Connected${auth.data.accountName || auth.data.email ? ` as ${auth.data.accountName || auth.data.email}` : ""}. This VM may use your plan.`
                        : auth.data.canAllow
                          ? "Your account is connected. Allow this VM to use it for coding turns."
                          : "Connect your ChatGPT account to use Codex here."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {auth.data.pending && auth.data.attemptId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (auth.data.attemptId)
                          cancel.mutate({ id, attemptId: auth.data.attemptId });
                      }}
                    >
                      Cancel sign-in
                    </Button>
                  ) : auth.data.allowed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => disconnect.mutate(id)}
                    >
                      {disconnect.isPending
                        ? "Disconnecting…"
                        : "Disconnect ChatGPT"}
                    </Button>
                  ) : auth.data.canAllow ? (
                    <Button
                      size="sm"
                      disabled={busy || !auth.data.paired}
                      onClick={() => allow.mutate(id)}
                    >
                      {allow.isPending ? "Allowing…" : "Allow this VM"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy || !auth.data.paired}
                      onClick={() => connect.mutate(id)}
                    >
                      {connect.isPending
                        ? "Opening sign-in…"
                        : "Continue with ChatGPT"}
                    </Button>
                  )}
                </ItemActions>
              </Item>
            </>
          )}
        </PageRows>
      )}
      {(problem || (codingEnabled && auth.data?.error)) && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {problem?.message || auth.data?.error}
        </p>
      )}
      {disconnect.data?.warning && (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {disconnect.data.warning}
        </p>
      )}
    </PageSection>
  );
}

export function NewCodingBotPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const vms = useQuery(localVmsQueryOptions());
  const vm = vms.data?.find((entry) => entry.id === id);
  const ready = vm?.phase === "ready" && !!vm.recipe.tools.codex;
  const auth = useQuery(computerAuthQueryOptions(id));
  const models = useQuery(computerModelsQueryOptions(id, ready));
  const visibleModels = models.data?.filter((entry) => !entry.hidden) ?? [];
  const [modelId, setModelId] = useState("");
  const selected =
    visibleModels.find((entry) => entry.model === modelId) ??
    visibleModels.find((entry) => entry.isDefault) ??
    visibleModels[0];
  const [effort, setEffort] = useState<string | null>(null);
  const [speed, setSpeed] = useState<"standard" | "fast">("standard");
  const [permission, setPermission] =
    useState<WorkspaceBot["permission"]>("workspace-write");
  const [problem, setProblem] = useState("");
  const [createdBotId, setCreatedBotId] = useState<string | null>(null);
  const createBot = useMutation(createAgentMutationOptions(queryClient));
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const busy = createBot.isPending || createChannel.isPending;
  const openConversation = async (botId: string) => {
    const channel = await createChannel.mutateAsync([botId]);
    await navigate({
      to: "/channel/$channelId",
      params: { channelId: channel.id },
    });
  };
  return (
    <PageShell
      title="New coding Bot"
      description={
        vm
          ? `Codex will work on ${vm.recipe.name} inside its VM. You direct it through normal Bot conversations.`
          : "Connect Codex to a VM and choose its defaults."
      }
      backButton={{
        label: vm?.recipe.name ?? "Computer",
        linkProps: { to: "/computers/$computerId", params: { computerId: id } },
      }}
    >
      {!desktopShell() ? (
        <PageEmpty icon={IconDeviceDesktop} title="Open OpenBot Desktop">
          Coding VMs are managed by the desktop app.
        </PageEmpty>
      ) : vms.isPending ? null : vms.error ? (
        <p role="alert" className="text-sm text-destructive">
          {vms.error.message}
        </p>
      ) : !vm ? (
        <PageEmpty title="VM not found">Choose a VM from Computers.</PageEmpty>
      ) : !ready ? (
        <PageEmpty icon={IconCode} title="Start a VM with Codex">
          Return to this VM and start it. Its recipe must include Codex.
        </PageEmpty>
      ) : (
        <>
          <ComputerSignIn id={id} />
          <PageSection
            title="Bot defaults"
            description="These settings are saved with the Bot. Project access applies to this VM."
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !selected || !auth.data?.allowed) return;
                const fields = new FormData(event.currentTarget);
                setProblem("");
                void (async () => {
                  if (createdBotId) {
                    await openConversation(createdBotId);
                    return;
                  }
                  const bot = await createBot.mutateAsync({
                    name: String(fields.get("name") ?? "").trim(),
                    title: `Codex · ${vm.recipe.name}`.slice(0, 120),
                    roleDescription: String(
                      fields.get("instructions") ?? "",
                    ).trim(),
                    visibility: "private",
                    workspaceBot: parseWorkspaceBot({
                      workspaceId: id,
                      runtime: "codex",
                      model: selected.model,
                      effort: effort ?? selected.defaultReasoningEffort ?? null,
                      speed,
                      permission,
                    }),
                  });
                  setCreatedBotId(bot.id);
                  await openConversation(bot.id);
                })().catch((error: unknown) =>
                  setProblem(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
              }}
            >
              <PageCard
                footer={
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <Link
                          to="/computers/$computerId"
                          params={{ computerId: id }}
                        />
                      }
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      type="submit"
                      disabled={busy || !selected || !auth.data?.allowed}
                    >
                      {createBot.isPending
                        ? "Creating…"
                        : createChannel.isPending
                          ? "Opening conversation…"
                          : createdBotId
                            ? "Open conversation"
                            : "Create Bot and open chat"}
                    </Button>
                  </>
                }
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="coding-bot-name">Name</FieldLabel>
                    <Input
                      id="coding-bot-name"
                      name="name"
                      required
                      maxLength={80}
                      defaultValue={`${vm.recipe.name} · Codex`.slice(0, 80)}
                      disabled={!!createdBotId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="coding-bot-instructions">
                      Instructions
                    </FieldLabel>
                    <FieldDescription>
                      What this Bot should do in the project, including any
                      review or commit rules.
                    </FieldDescription>
                    <Textarea
                      id="coding-bot-instructions"
                      name="instructions"
                      maxLength={1000}
                      rows={4}
                      required
                      disabled={!!createdBotId}
                      defaultValue="Work on this project using Codex. Follow the project's instructions, explain changes, and run the relevant checks. Keep changes local; do not push branches or create pull requests."
                    />
                  </Field>
                  {models.isPending ? null : models.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {models.error.message}
                    </p>
                  ) : !visibleModels.length ? (
                    <p className="text-sm text-muted-foreground">
                      Codex did not return any available models.
                    </p>
                  ) : (
                    <>
                      <Field>
                        <FieldLabel htmlFor="coding-bot-model">
                          Model
                        </FieldLabel>
                        <Select
                          value={selected?.model ?? ""}
                          disabled={!!createdBotId}
                          onValueChange={(value) => {
                            if (value) {
                              setModelId(value);
                              setEffort(null);
                              setSpeed("standard");
                            }
                          }}
                        >
                          <SelectTrigger id="coding-bot-model">
                            <SelectValue>{selected?.displayName}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {visibleModels.map((model) => (
                              <SelectItem key={model.model} value={model.model}>
                                {model.displayName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          {selected?.description}
                        </FieldDescription>
                      </Field>
                      {!!selected?.supportedReasoningEfforts.length && (
                        <Field>
                          <FieldLabel htmlFor="coding-bot-effort">
                            Thinking effort
                          </FieldLabel>
                          <Select
                            disabled={!!createdBotId}
                            value={effort ?? selected.defaultReasoningEffort}
                            onValueChange={(value) => setEffort(value)}
                          >
                            <SelectTrigger id="coding-bot-effort">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {selected.supportedReasoningEfforts.map(
                                (option) => (
                                  <SelectItem
                                    key={option.reasoningEffort}
                                    value={option.reasoningEffort}
                                  >
                                    {effortLabel(option.reasoningEffort)}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                      {!!selected?.serviceTiers.some(
                        (tier) => tier.id === "priority",
                      ) && (
                        <Field>
                          <FieldLabel htmlFor="coding-bot-speed">
                            Speed
                          </FieldLabel>
                          <Select
                            disabled={!!createdBotId}
                            value={speed}
                            onValueChange={(value) => {
                              if (value === "standard" || value === "fast")
                                setSpeed(value);
                            }}
                          >
                            <SelectTrigger id="coding-bot-speed">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="standard">Standard</SelectItem>
                              <SelectItem value="fast">Fast</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </>
                  )}
                  <Field>
                    <FieldLabel htmlFor="coding-bot-access">
                      VM permissions
                    </FieldLabel>
                    <Select
                      disabled={!!createdBotId}
                      value={permission}
                      onValueChange={(value) => {
                        if (isCodingPermission(value)) setPermission(value);
                      }}
                    >
                      <SelectTrigger id="coding-bot-access">
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
                      <IconShieldLock className="mr-1 inline size-3.5" />
                      {codingPermissionDescription(permission)}
                    </FieldDescription>
                  </Field>
                  {!auth.data?.allowed && (
                    <p className="text-sm text-muted-foreground">
                      Connect ChatGPT and allow this VM before creating its
                      coding Bot.
                    </p>
                  )}
                  {problem && (
                    <p role="alert" className="text-sm text-destructive">
                      {createdBotId ? "Your Bot was created. " : ""}
                      {problem}
                    </p>
                  )}
                </FieldGroup>
              </PageCard>
            </form>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
