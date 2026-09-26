import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { client } from "@/lib/client";
import type {
  ModelCapabilities,
  ModelSettings,
} from "../../../../shared/model-settings";

type AccountUsage = {
  status: "available" | "unsupported" | "unavailable";
  label: string;
  updatedAt: string | null;
  windows: { label: string; usedPercent: number; resetsAt: number | null }[];
};

export function ModelControls({
  agentId,
  threadId,
  busy = false,
}: {
  agentId: string;
  threadId: string;
  busy?: boolean;
}) {
  const cache = useQueryClient();
  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const path = `${base}/threads/${encodeURIComponent(threadId)}/model`;
  const settingsKey = ["conversation-model", agentId, threadId];
  const models = useQuery({
    queryKey: ["agent-models", agentId],
    queryFn: () => client<ModelCapabilities | null>(`${base}/models`, "models"),
    staleTime: 60_000,
    retry: false,
  });
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => client<ModelSettings>(path, "settings"),
    retry: false,
  });
  const [showUsage, setShowUsage] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const usage = useQuery({
    queryKey: ["agent-usage", agentId],
    queryFn: () => client<AccountUsage | null>(`${base}/usage`, "usage"),
    enabled: showUsage,
    staleTime: 30_000,
    retry: false,
  });
  const save = useMutation({
    mutationKey: ["save-model", agentId, threadId],
    mutationFn: (value: ModelSettings) =>
      client<ModelSettings>(path, "settings", { method: "PUT", body: value }),
    onSuccess: (value) => cache.setQueryData(settingsKey, value),
  });
  const current = settings.data ?? {};
  const selected = current.model ?? models.data?.defaultModel;
  const selectedOption = models.data?.models.find(
    (model) => model.id === selected,
  );
  const disabled = busy || save.isPending || !settings.data;
  return (
    <div className="border-b px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {models.data ? (
          <>
            <span className="text-muted-foreground">
              {models.data.framework}
            </span>
            <label className="flex items-center gap-1">
              Model
              <select
                aria-label="Conversation model"
                className="rounded border bg-background px-2 py-1"
                disabled={disabled}
                value={current.model ?? ""}
                onChange={(event) =>
                  save.mutate(
                    event.target.value ? { model: event.target.value } : {},
                  )
                }
              >
                <option value="">
                  Agent default
                  {models.data.defaultModel
                    ? ` (${models.data.defaultModel})`
                    : ""}
                </option>
                {models.data.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
                {current.model && !selectedOption && (
                  <option value={current.model}>{current.model}</option>
                )}
              </select>
            </label>
            {(selectedOption?.efforts.length ?? 0) > 0 && (
              <label className="flex items-center gap-1">
                Effort
                <select
                  aria-label="Reasoning effort"
                  className="rounded border bg-background px-2 py-1"
                  disabled={disabled}
                  value={current.effort ?? ""}
                  onChange={(event) =>
                    save.mutate({
                      ...(current.model ? { model: current.model } : {}),
                      ...(event.target.value
                        ? { effort: event.target.value }
                        : {}),
                    })
                  }
                >
                  <option value="">Agent default</option>
                  {selectedOption?.efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {models.data.customModels && (
              <details>
                <summary className="cursor-pointer">Other model</summary>
                <form
                  className="flex gap-2 py-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (customModel.trim())
                      save.mutate({ model: customModel.trim() });
                  }}
                >
                  <input
                    aria-label="Model identifier"
                    className="rounded border bg-background px-2"
                    maxLength={200}
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder="Model identifier"
                  />
                  <button
                    type="submit"
                    disabled={disabled || !customModel.trim()}
                  >
                    Apply
                  </button>
                </form>
              </details>
            )}
            <span className="text-muted-foreground">
              {save.isPending ? "Saving…" : "Applies to the next turn"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {models.isPending
              ? "Loading model controls…"
              : models.isError
                ? "Model controls unavailable"
                : "This agent does not expose model controls"}
          </span>
        )}
        <button
          type="button"
          className="ml-auto underline underline-offset-2"
          aria-expanded={showUsage}
          onClick={() => setShowUsage(!showUsage)}
        >
          Account usage
        </button>
      </div>
      {(save.error || settings.error) && (
        <p className="pt-2 text-destructive" role="alert">
          {save.error?.message ?? settings.error?.message}
        </p>
      )}
      {showUsage && (
        <div className="mt-2 rounded border p-3" aria-live="polite">
          {usage.isPending ? (
            "Loading account usage…"
          ) : usage.isError ? (
            <span>
              Could not refresh account usage.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void usage.refetch()}
              >
                Retry
              </button>
            </span>
          ) : !usage.data ? (
            "This agent does not expose account usage."
          ) : (
            <>
              <p>{usage.data.label}</p>
              {usage.data.status === "available" &&
                usage.data.windows.map((window) => (
                  <div key={window.label} className="mt-2">
                    <div className="flex justify-between">
                      <span>{window.label}</span>
                      <span>{window.usedPercent}% used</span>
                    </div>
                    <progress
                      className="w-full"
                      max={100}
                      value={window.usedPercent}
                      aria-label={window.label}
                    />
                    {window.resetsAt !== null && (
                      <p className="text-muted-foreground">
                        Resets{" "}
                        {new Date(window.resetsAt * 1000).toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
              {usage.data.updatedAt && (
                <p className="mt-2 text-muted-foreground">
                  Updated {new Date(usage.data.updatedAt).toLocaleString()}
                </p>
              )}
              <button
                type="button"
                disabled={usage.isFetching}
                className="mt-2 underline"
                onClick={() => void usage.refetch()}
              >
                Refresh
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
