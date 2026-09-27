import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import {
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Observable } from "rxjs";
import type { CodingAgentConfig } from "../../../shared/coding-agent";
import {
  type ModelCapabilities,
  type ModelSettings,
  validateModelChoice,
} from "../../../shared/model-settings";
import { accountEnvironment, CodexClient } from "./codex-client";

export function localCodingEnabled(): boolean {
  return process.env.OPENBOT_LOCAL_AGENTS === "1";
}

export async function checkCodingFolder(
  config: CodingAgentConfig,
): Promise<CodingAgentConfig> {
  const cwd = await realpath(config.cwd);
  if (!(await stat(cwd)).isDirectory())
    throw new Error("Working folder is not a directory.");
  return { ...config, cwd };
}

type CodexModel = {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
};
type RateLimitSnapshot = {
  limitName?: string;
  limitId?: string;
  primary?: {
    usedPercent: number;
    windowDurationMins?: number;
    resetsAt?: number;
  } | null;
  secondary?: {
    usedPercent: number;
    windowDurationMins?: number;
    resetsAt?: number;
  } | null;
};

type Usage = {
  status: "available" | "unsupported" | "unavailable";
  label: string;
  updatedAt: string | null;
  windows: { label: string; usedPercent: number; resetsAt: number | null }[];
};
const emptyUsage = (label: string): Usage => ({
  status: "unsupported",
  label,
  updatedAt: null,
  windows: [],
});

// Each profile owns a process; threads on one profile keep separate CLI sessions.
const runtimes = new Map<string, CodingRuntime>();
export function codingRuntime(
  id: string,
  config: CodingAgentConfig,
): CodingRuntime {
  if (!localCodingEnabled())
    throw new Error("Local coding agents are disabled.");
  const old = runtimes.get(id);
  if (old && JSON.stringify(old.config) === JSON.stringify(config)) return old;
  old?.stop();
  if (!old && runtimes.size >= 32)
    throw new Error("Stop an unused coding profile before starting another.");
  const runtime = new CodingRuntime(config);
  runtimes.set(id, runtime);
  return runtime;
}
export function stopCodingRuntime(id: string) {
  runtimes.get(id)?.stop();
  runtimes.delete(id);
}

export class CodingRuntime {
  private codex?: CodexClient;
  private active = new Map<string, AbortController>();
  private sessions = new Map<string, string>();
  private catalog?: { at: number; value: ModelCapabilities };
  constructor(
    readonly config: CodingAgentConfig,
    private createCodex: (cwd: string) => CodexClient = (cwd) =>
      new CodexClient(cwd),
  ) {}
  status() {
    return {
      activeRuns: this.active.size,
      running:
        Boolean(this.codex && !this.codex.closed) || this.active.size > 0,
    };
  }
  stop() {
    for (const run of this.active.values()) run.abort();
    this.codex?.stop();
    this.codex = undefined;
    this.sessions.clear();
    this.catalog = undefined;
  }
  private async client() {
    if (!this.codex || this.codex.closed) {
      this.codex = this.createCodex(this.config.cwd);
      this.sessions.clear();
    }
    await this.codex.ready;
    return this.codex;
  }
  private async inspectClaude<T>(
    read: (agent: Query) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    // Initialization performs no model turn. Hold input open until metadata is read.
    async function* idle(): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((done) => {
        if (controller.signal.aborted) done();
        else
          controller.signal.addEventListener("abort", () => done(), {
            once: true,
          });
      });
    }
    const agent = query({
      prompt: idle(),
      options: {
        cwd: this.config.cwd,
        env: accountEnvironment(),
        abortController: controller,
        tools: [],
        settingSources: [],
      },
    });
    try {
      return await read(agent);
    } finally {
      clearTimeout(timer);
      controller.abort();
      agent.close();
    }
  }
  async models(): Promise<ModelCapabilities> {
    if (this.catalog && Date.now() - this.catalog.at < 60_000)
      return this.catalog.value;
    let value: ModelCapabilities;
    if (this.config.framework === "codex") {
      const client = await this.client();
      const rows: CodexModel[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: CodexModel[]; nextCursor: string | null } =
          await client.request("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          });
        rows.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor && rows.length < 200);
      value = {
        framework: "Codex",
        defaultModel:
          this.config.defaults.model ??
          rows.find((row) => row.isDefault)?.model ??
          rows[0]?.model ??
          null,
        customModels: false,
        models: rows.map((row) => ({
          id: row.model,
          name: row.displayName,
          defaultEffort: row.defaultReasoningEffort,
          efforts: row.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
        })),
      };
    } else {
      value = await this.inspectClaude(async (agent) => {
        const rows = await agent.supportedModels();
        return {
          framework: "Claude Agent SDK",
          defaultModel: this.config.defaults.model ?? "default",
          customModels: false,
          models: rows.map((row) => ({
            id: row.value,
            name: row.displayName,
            efforts: row.supportedEffortLevels ?? [],
          })),
        };
      });
    }
    this.catalog = { at: Date.now(), value };
    return value;
  }
  async usage(): Promise<Usage> {
    if (this.config.framework === "codex") {
      const client = await this.client();
      const { account } = await client.request<{
        account: { type: string } | null;
      }>("account/read", { refreshToken: false });
      if (account?.type !== "chatgpt")
        return emptyUsage(
          "Sign in to Codex with a ChatGPT account to see plan limits.",
        );
      const data = await client.request<{
        rateLimits: RateLimitSnapshot;
        rateLimitsByLimitId?: Record<string, RateLimitSnapshot>;
      }>("account/rateLimits/read");
      const snapshots = data.rateLimitsByLimitId
        ? Object.values(data.rateLimitsByLimitId)
        : [data.rateLimits];
      const windows: Usage["windows"] = [];
      for (const snapshot of snapshots)
        for (const key of ["primary", "secondary"] as const) {
          const window = snapshot?.[key];
          if (window && typeof window.usedPercent === "number")
            windows.push({
              label: `${snapshot.limitName ?? snapshot.limitId ?? "Codex"} · ${window.windowDurationMins ?? key} minutes`,
              usedPercent: window.usedPercent,
              resetsAt: window.resetsAt ?? null,
            });
        }
      return {
        status: "available",
        label: "ChatGPT plan usage reported by Codex",
        updatedAt: new Date().toISOString(),
        windows,
      };
    }
    return this.inspectClaude(async (agent) => {
      // Pinned SDK's experimental read-only /usage API. Missing support is visible.
      const account = await agent.accountInfo();
      if (account.tokenSource === "none")
        return emptyUsage("Sign in to Claude Code to see account usage.");
      const data =
        await agent.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        });
      if (!data.rate_limits_available || !data.rate_limits)
        return emptyUsage("This Claude account does not expose plan usage.");
      const windows: Usage["windows"] = [];
      for (const [key, window] of Object.entries(data.rate_limits)) {
        if (
          window &&
          typeof window === "object" &&
          "utilization" in window &&
          typeof window.utilization === "number"
        ) {
          const resetsAt =
            "resets_at" in window && typeof window.resets_at === "string"
              ? Date.parse(window.resets_at) / 1000
              : null;
          windows.push({
            label: key.replaceAll("_", " "),
            usedPercent: window.utilization,
            resetsAt:
              resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
          });
        }
      }
      return {
        status: "available",
        label: "Claude plan usage (experimental SDK interface)",
        updatedAt: new Date().toISOString(),
        windows,
      };
    });
  }
  async run(
    key: string,
    input: RunAgentInput,
    settings: ModelSettings,
    role: string,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ) {
    if (this.active.has(key))
      throw new Error("This conversation already has a running turn.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.active.set(key, controller);
    try {
      const choice = { ...this.config.defaults, ...settings };
      // Choosing a different model does not carry the profile model's effort to it.
      if (
        settings.model &&
        settings.model !== this.config.defaults.model &&
        !settings.effort
      )
        delete choice.effort;
      const catalog = await this.models();
      choice.model ??= catalog.defaultModel ?? undefined;
      if (this.config.framework === "codex")
        choice.effort ??= catalog.models.find(
          (model) => model.id === choice.model,
        )?.defaultEffort;
      validateModelChoice(choice, catalog);
      controller.signal.throwIfAborted();
      if (this.config.framework === "codex")
        await this.runCodex(key, input, choice, role, emit, controller.signal);
      else await this.runClaude(key, input, choice, role, emit, controller);
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(key);
    }
  }
  private async runCodex(
    key: string,
    input: RunAgentInput,
    settings: ModelSettings,
    role: string,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ) {
    const client = await this.client();
    const { account } = await client.request<{
      account: { type: string } | null;
    }>("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt")
      throw new Error(
        "Run codex login and choose your ChatGPT account. This profile does not use API billing.",
      );
    let threadId = this.sessions.get(key);
    const fresh = !threadId;
    if (!threadId) {
      const started = await client.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: this.config.cwd,
          approvalPolicy: "never",
          sandbox:
            this.config.permission === "read-only"
              ? "read-only"
              : "workspace-write",
          developerInstructions: role,
          ...(settings.model ? { model: settings.model } : {}),
        },
      );
      threadId = started.thread.id;
      this.sessions.set(key, started.thread.id);
    }
    const text = conversationPrompt(input, fresh);
    let turnId: string | undefined;
    const messageIds = new Set<string>();
    await new Promise<void>((done, reject) => {
      const end = (error?: Error) => {
        off();
        signal.removeEventListener("abort", abort);
        error ? reject(error) : done();
      };
      const abort = () => {
        if (turnId)
          void client
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => {});
        end(new Error("Turn stopped."));
      };
      const off = client.listen(({ method, params }) => {
        if (method === "openbot/closed") {
          end(new Error("Codex stopped."));
          return;
        }
        if (params.threadId !== threadId) return;
        if (
          method === "item/agentMessage/delta" &&
          params.itemId &&
          typeof params.delta === "string"
        ) {
          if (!messageIds.has(params.itemId)) {
            messageIds.add(params.itemId);
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId: params.itemId,
              role: "assistant",
            } as BaseEvent);
          }
          emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: params.itemId,
            delta: params.delta,
          } as BaseEvent);
        }
        if (
          method === "item/completed" &&
          params.item?.id &&
          messageIds.delete(params.item.id)
        )
          emit({
            type: EventType.TEXT_MESSAGE_END,
            messageId: params.item.id,
          } as BaseEvent);
        if (method === "turn/completed") {
          for (const messageId of messageIds)
            emit({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
          end(
            params.turn?.status === "completed"
              ? undefined
              : new Error(
                  params.turn?.status === "interrupted"
                    ? "Turn stopped."
                    : "Codex could not complete the turn.",
                ),
          );
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void client
        .request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [{ type: "text", text }],
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.effort ? { effort: settings.effort } : {}),
        })
        .then((result) => {
          turnId = result.turn.id;
          if (signal.aborted)
            void client
              .request("turn/interrupt", { threadId, turnId })
              .catch(() => {});
        }, end);
    });
  }
  private async runClaude(
    key: string,
    input: RunAgentInput,
    settings: ModelSettings,
    role: string,
    emit: (event: BaseEvent) => void,
    controller: AbortController,
  ) {
    const account = await this.inspectClaude((agent) => agent.accountInfo());
    if (!account.subscriptionType || account.apiKeySource)
      throw new Error(
        "Sign in to Claude Code with claude auth login. This profile requires a Claude subscription and does not use API billing.",
      );
    controller.signal.throwIfAborted();
    const session = this.sessions.get(key);
    let releaseInput = () => {};
    const readyForInput = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await readyForInput;
      if (controller.signal.aborted) return;
      yield {
        type: "user",
        message: { role: "user", content: conversationPrompt(input, !session) },
        parent_tool_use_id: null,
        session_id: session ?? "",
      };
    }
    const agent = query({
      prompt: prompt(),
      options: {
        cwd: this.config.cwd,
        env: accountEnvironment(),
        abortController: controller,
        settingSources: [],
        ...(session ? { resume: session } : {}),
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort
          ? {
              effort: settings.effort as
                | "low"
                | "medium"
                | "high"
                | "xhigh"
                | "max",
            }
          : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: role },
        // File-only tools until OpenBot has an interactive shell approval surface.
        tools:
          this.config.permission === "read-only"
            ? ["Read", "Glob", "Grep"]
            : ["Read", "Glob", "Grep", "Edit", "Write"],
        permissionMode: "default",
        canUseTool: async (tool, args) => {
          if (
            this.config.permission === "workspace-write" &&
            ["Edit", "Write"].includes(tool) &&
            typeof args.file_path === "string"
          ) {
            const target = resolve(this.config.cwd, args.file_path);
            const actual = await realpath(target).catch(async () =>
              resolve(await realpath(dirname(target)), basename(target)),
            );
            if (actual.startsWith(`${this.config.cwd}${sep}`))
              return { behavior: "allow", updatedInput: args };
          }
          return {
            behavior: "deny",
            message: "This tool is outside the profile's permissions.",
          };
        },
      },
    });
    try {
      await agent.applyFlagSettings({
        model: settings.model ?? null,
        effortLevel:
          (settings.effort as
            | "low"
            | "medium"
            | "high"
            | "xhigh"
            | "max"
            | undefined) ?? null,
      });
      releaseInput();
      for await (const message of agent) {
        if (message.type === "system" && message.subtype === "init")
          this.sessions.set(key, message.session_id);
        if (message.type === "assistant") {
          if (message.error)
            throw new Error(
              "Claude could not answer. Check your Claude Code sign-in and selected model.",
            );
          for (const block of message.message.content)
            if (block.type === "text" && block.text) {
              const messageId = crypto.randomUUID();
              emit({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              } as BaseEvent);
              emit({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: block.text,
              } as BaseEvent);
              emit({
                type: EventType.TEXT_MESSAGE_END,
                messageId,
              } as BaseEvent);
            }
        }
        if (message.type === "result" && message.is_error)
          throw new Error(
            "Claude could not complete this turn. Check its account and folder permissions.",
          );
      }
    } finally {
      controller.abort();
      releaseInput();
      agent.close();
    }
  }
}

function conversationPrompt(input: RunAgentInput, fresh: boolean): string {
  const messages = input.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const chosen = fresh
    ? messages
    : messages.slice(
        messages.findLastIndex((message) => message.role === "user"),
      );
  return chosen
    .map(
      (message) =>
        `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`,
    )
    .join("\n\n");
}

export class LocalCodingAgent extends AbstractAgent {
  private controller?: AbortController;
  constructor(
    private profile: {
      id: string;
      name: string;
      config: CodingAgentConfig;
      role: string;
      owner: string;
      modelForThread: (threadId: string) => Promise<ModelSettings>;
    },
  ) {
    super({ agentId: profile.id, description: profile.name });
  }
  clone(): LocalCodingAgent {
    return new LocalCodingAgent(this.profile);
  }
  abortRun() {
    this.controller?.abort();
    super.abortRun();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.controller = controller;
      const emit = (event: BaseEvent) => subscriber.next(event);
      emit({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      void (async () => {
        try {
          const settings = await this.profile.modelForThread(input.threadId);
          await codingRuntime(this.profile.id, this.profile.config).run(
            `${this.profile.owner}:${input.threadId}`,
            input,
            settings,
            this.profile.role,
            emit,
            controller.signal,
          );
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
        } catch (error) {
          emit({
            type: EventType.RUN_ERROR,
            message:
              error instanceof Error ? error.message : "Coding agent failed.",
          } as BaseEvent);
        } finally {
          subscriber.complete();
        }
      })();
      return () => controller.abort();
    });
  }
}
