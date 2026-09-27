import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  type AgentProfile,
  agentCapabilitiesQueryOptions,
} from "@/lib/agents/queries";
import { client } from "@/lib/client";
import type { CodingAgentConfig } from "../../../../shared/coding-agent";
import type { ModelCapabilities } from "../../../../shared/model-settings";

export function CodingAgentCreator() {
  const capabilities = useQuery(agentCapabilitiesQueryOptions());
  const [open, setOpen] = useState(false);
  if (!capabilities.data?.localCodingAvailable) return null;
  return (
    <div className="my-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">Coding agents on this Mac</h3>
          <p className="text-sm text-muted-foreground">
            Run Codex and Claude side by side with separate profiles and
            folders.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add coding agent"}
        </Button>
      </div>
      {open && <CodingProfileEditor onSaved={() => setOpen(false)} />}
    </div>
  );
}

export function CodingProfileEditor({
  profile,
  onSaved,
}: {
  profile?: AgentProfile;
  onSaved?: () => void;
}) {
  const fieldId = useId();
  const cache = useQueryClient();
  const [name, setName] = useState(profile?.name ?? "");
  const [role, setRole] = useState(
    profile?.roleDescription ??
      "Help me understand, edit, and review code in this working folder.",
  );
  const [config, setConfig] = useState<CodingAgentConfig>(
    profile?.codingAgent ?? {
      framework: "codex",
      cwd: "",
      permission: "read-only",
      defaults: {},
    },
  );
  const models = useQuery({
    queryKey: ["agent-models", profile?.id],
    queryFn: () =>
      client<ModelCapabilities | null>(
        `/api/agents/${profile?.id}/models`,
        "models",
      ),
    enabled: Boolean(profile),
    retry: false,
    staleTime: 60_000,
  });
  const runtime = useQuery({
    queryKey: ["coding-runtime", profile?.id],
    queryFn: () =>
      client<{ running: boolean; activeRuns: number }>(
        `/api/agents/${profile?.id}/runtime`,
        "runtime",
      ),
    enabled: Boolean(profile),
    refetchInterval: 5000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () =>
      client<AgentProfile>(
        profile ? `/api/agents/${profile.id}` : "/api/agents",
        "agent",
        {
          method: profile ? "PATCH" : "POST",
          body: {
            name,
            title:
              config.framework === "codex"
                ? "Codex coding agent"
                : "Claude coding agent",
            roleDescription: role,
            visibility: "private",
            codingAgent: config,
          },
        },
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["agents"] });
      if (profile) {
        await cache.invalidateQueries({
          queryKey: ["agent-models", profile.id],
        });
      }
      onSaved?.();
    },
  });
  const stop = useMutation({
    mutationFn: () =>
      client(`/api/agents/${profile?.id}/runtime/stop`, { method: "POST" }),
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: ["coding-runtime", profile?.id] }),
  });
  const selected = models.data?.models.find(
    (model) =>
      model.id === (config.defaults.model ?? models.data?.defaultModel),
  );
  const field =
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20";
  return (
    <form
      className="mt-2 flex flex-col gap-5 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label className="grid min-w-0 gap-2">
        Name
        <input
          className={field}
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Codex · OpenBot"
        />
      </label>
      <label htmlFor={`${fieldId}-framework`} className="grid min-w-0 gap-2">
        Framework
        <NativeSelect
          id={`${fieldId}-framework`}
          disabled={Boolean(profile)}
          value={config.framework}
          onChange={(event) =>
            setConfig({
              ...config,
              framework: event.target.value as CodingAgentConfig["framework"],
              defaults: {},
            })
          }
        >
          <option value="codex">Codex (ChatGPT account)</option>
          <option value="claude">Claude Agent SDK (Claude Code account)</option>
        </NativeSelect>
      </label>
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
        {config.framework === "codex"
          ? "Uses the account signed in with codex login. Codex must be installed on this Mac."
          : "Uses your local Claude Code sign-in. File reading and editing are supported; shell commands are not enabled in this profile."}{" "}
        OpenBot’s deployment API keys are not passed to this process.
      </p>
      <label className="grid min-w-0 gap-2">
        Working folder
        <input
          className={field}
          required
          value={config.cwd}
          onChange={(event) =>
            setConfig({ ...config, cwd: event.target.value })
          }
          placeholder="/Users/you/projects/my-project"
        />
      </label>
      <label htmlFor={`${fieldId}-permission`} className="grid min-w-0 gap-2">
        Permissions
        <NativeSelect
          id={`${fieldId}-permission`}
          value={config.permission}
          onChange={(event) =>
            setConfig({
              ...config,
              permission: event.target.value as CodingAgentConfig["permission"],
            })
          }
        >
          <option value="read-only">Read only</option>
          <option value="workspace-write">Allow edits in this folder</option>
        </NativeSelect>
      </label>
      <label className="grid min-w-0 gap-2">
        Instructions
        <textarea
          rows={3}
          className={field}
          required
          maxLength={1000}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      {models.data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label htmlFor={`${fieldId}-model`} className="grid min-w-0 gap-2">
            Default model
            <NativeSelect
              id={`${fieldId}-model`}
              value={config.defaults.model ?? ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  defaults: event.target.value
                    ? { model: event.target.value }
                    : {},
                })
              }
            >
              <option value="">Framework default</option>
              {models.data.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor={`${fieldId}-effort`} className="grid min-w-0 gap-2">
            Default effort
            <NativeSelect
              id={`${fieldId}-effort`}
              value={config.defaults.effort ?? ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  defaults: {
                    ...(config.defaults.model
                      ? { model: config.defaults.model }
                      : {}),
                    ...(event.target.value
                      ? { effort: event.target.value }
                      : {}),
                  },
                })
              }
            >
              <option value="">Framework default</option>
              {selected?.efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      )}
      {models.isError && (
        <p role="alert" className="text-destructive">
          Could not read models. Check the CLI installation and account sign-in.
        </p>
      )}
      {profile && (
        <p className="text-muted-foreground">
          {runtime.isError
            ? "Runtime status unavailable"
            : runtime.data?.activeRuns
              ? `${runtime.data.activeRuns} active turn(s)`
              : runtime.data?.running
                ? "Runtime ready"
                : "Starts when you send a message"}
        </p>
      )}
      {(save.error || stop.error) && (
        <p role="alert" className="text-destructive">
          {save.error?.message ?? stop.error?.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          type="submit"
          disabled={save.isPending || Boolean(runtime.data?.activeRuns)}
        >
          {save.isPending
            ? "Saving…"
            : profile
              ? "Save profile"
              : "Create coding agent"}
        </Button>
        {profile && (
          <Button
            type="button"
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            Stop runtime
          </Button>
        )}
      </div>
      {save.isSuccess && (
        <p role="status">
          Profile saved. Open a conversation from its agent card.
        </p>
      )}
    </form>
  );
}
