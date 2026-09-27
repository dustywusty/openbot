import { IconChevronDown, IconGauge, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
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
  const fieldId = useId();
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
    <div className="border-b border-border/60 bg-background px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {models.data ? (
          <>
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              {models.data.framework}
            </span>
            <label
              htmlFor={`${fieldId}-model`}
              className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
            >
              Model
              <NativeSelect
                id={`${fieldId}-model`}
                aria-label="Conversation model"
                className="h-8 max-w-[240px] text-xs text-foreground"
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
              </NativeSelect>
            </label>
            {(selectedOption?.efforts.length ?? 0) > 0 && (
              <label
                htmlFor={`${fieldId}-effort`}
                className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
              >
                Effort
                <NativeSelect
                  id={`${fieldId}-effort`}
                  aria-label="Reasoning effort"
                  className="h-8 max-w-[240px] text-xs text-foreground"
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
                </NativeSelect>
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
            <span className="text-xs text-muted-foreground">
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto gap-2 text-muted-foreground"
          aria-expanded={showUsage}
          onClick={() => setShowUsage(!showUsage)}
        >
          <IconGauge className="size-3.5" />
          Account usage
          <IconChevronDown
            className={`size-3.5 transition-transform ${showUsage ? "rotate-180" : ""}`}
          />
        </Button>
      </div>
      {(save.error || settings.error) && (
        <p className="pt-2 text-destructive" role="alert">
          {save.error?.message ?? settings.error?.message}
        </p>
      )}
      {showUsage && (
        <div
          className="mt-3 max-w-xl rounded-xl border border-border/60 bg-card p-4 text-xs"
          aria-live="polite"
        >
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
              <p className="font-medium text-foreground">{usage.data.label}</p>
              {usage.data.status === "available" &&
                usage.data.windows.map((window) => (
                  <div key={window.label} className="mt-4 space-y-2">
                    <div className="flex justify-between">
                      <span>{window.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {window.usedPercent}% used
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={window.usedPercent}
                      aria-label={window.label}
                      className="h-1.5 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${window.usedPercent}%` }}
                      />
                    </div>
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={usage.isFetching}
                className="-ml-2 mt-2 text-muted-foreground"
                onClick={() => void usage.refetch()}
              >
                <IconRefresh className="size-3" />
                Refresh
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
