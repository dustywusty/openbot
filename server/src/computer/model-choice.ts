import { randomUUID } from "node:crypto";
import type { WorkspaceBot } from "@openbot/shared/workspace-bot";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { intelligenceChannelMappings } from "../db/schema";
import {
  type DesktopComputerBroker,
  DesktopComputerRefusedError,
} from "./desktop-broker";
import type { HarnessChoice } from "./harness-agent";

const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const pick = z.strictObject({
  model: z.string().min(1).max(128).nullable(),
  effort: effort.nullable(),
  speed: z.enum(["standard", "fast"]).nullable(),
});
const guestModels = z
  .array(
    z.object({
      id: z.string().min(1).max(128),
      model: z.string().min(1).max(128),
      displayName: z.string().max(256),
      hidden: z.boolean(),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z
        .array(z.object({ reasoningEffort: effort }))
        .max(16),
      defaultReasoningEffort: effort,
      serviceTiers: z
        .array(z.object({ id: z.string().max(128) }))
        .max(16)
        .default([]),
    }),
  )
  .max(256);
type NativeModel = {
  id: string;
  label: string;
  vendor: string;
  efforts: string[];
  defaultEffort: string;
  speeds: ("standard" | "fast")[];
};
type Binding = { botId: string; settings: WorkspaceBot };
export class DesktopModelError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 503,
    readonly code?: "workspace-disconnected" | "workspace-unavailable",
  ) {
    super(message);
  }
}

/** Choices use the existing per-owner conversation row; CLI sessions remain private on the desktop. */
export function createDesktopModelChoices(deps: {
  database: Database;
  broker: DesktopComputerBroker;
  binding: (actor: AgentActor, channelId: string) => Promise<Binding | null>;
}) {
  const cache = new Map<string, { until: number; models: NativeModel[] }>();
  const provider = (binding: Binding) =>
    `desktop:${binding.botId}:${binding.settings.workspaceId}:${binding.settings.runtime}`;
  async function catalogue(
    actorId: string,
    binding: Binding,
    threadId: string,
  ) {
    const key = `${actorId}:${provider(binding)}`;
    // A catalogue cache must not hide a lost pairing after a desktop/server restart.
    // Other people's registrations and absent registrations have the same answer.
    if (
      !deps.broker
        .list(actorId)
        .some(
          (computer) => computer.computerId === binding.settings.workspaceId,
        )
    ) {
      cache.delete(key);
      throw new DesktopModelError(
        "This workspace is disconnected. Open Computers, pair it with OpenBot, and start its VM.",
        503,
        "workspace-disconnected",
      );
    }
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.models;
    let response: Awaited<
      Awaited<ReturnType<DesktopComputerBroker["dispatch"]>>["completion"]
    >;
    try {
      const operation = await deps.broker.dispatch({
        actorId,
        botId: binding.botId,
        computerId: binding.settings.workspaceId,
        threadId,
        runId: randomUUID(),
        timeoutMs: 45_000,
        action: { kind: "models", runtime: binding.settings.runtime },
      });
      response = await operation.completion;
    } catch (error) {
      if (!(error instanceof DesktopComputerRefusedError)) throw error;
      cache.delete(key);
      throw new DesktopModelError(
        "The workspace could not list its coding models. Open Computers, start its VM, and check its connection.",
        503,
        "workspace-unavailable",
      );
    }
    const parsed = guestModels.safeParse(response.result);
    if (!parsed.success)
      throw new DesktopModelError(
        "The VM could not list its coding models. Start it and try again.",
        503,
      );
    const models: NativeModel[] = parsed.data
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
        id: entry.model,
        label: entry.displayName,
        vendor: "openai",
        efforts: entry.supportedReasoningEfforts.map(
          (item) => item.reasoningEffort,
        ),
        defaultEffort: entry.defaultReasoningEffort,
        speeds: entry.serviceTiers.some((tier) => tier.id === "priority")
          ? ["standard", "fast"]
          : ["standard"],
      }));
    // Keep the guest's default first if the Bot has not chosen a model.
    const guestDefault = parsed.data.find(
      (entry) => entry.isDefault && !entry.hidden,
    )?.model;
    models.sort(
      (a, b) => Number(b.id === guestDefault) - Number(a.id === guestDefault),
    );
    if (!models.length)
      throw new DesktopModelError("The VM did not offer a coding model.", 503);
    if (cache.size >= 128) cache.clear();
    cache.set(key, { until: Date.now() + 30_000, models });
    return models;
  }
  async function row(actorId: string, channelId: string) {
    const [found] = await deps.database
      .select({
        saved: intelligenceChannelMappings.modelSelection,
        threadId: intelligenceChannelMappings.threadId,
      })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.userId, actorId),
          eq(intelligenceChannelMappings.channelId, channelId),
        ),
      )
      .limit(1);
    if (!found)
      throw new DesktopModelError("Couldn't find that conversation.", 404);
    return found;
  }
  async function resolve(actor: AgentActor, channelId: string) {
    const binding = await deps.binding(actor, channelId);
    if (!binding)
      throw new DesktopModelError(
        "This conversation is not tied to a coding VM you own.",
        403,
      );
    const mapping = await row(actor.id, channelId);
    const models = await catalogue(actor.id, binding, mapping.threadId);
    const defaultModel =
      models.find((model) => model.id === binding.settings.model) ?? models[0];
    const saved =
      mapping.saved?.provider === provider(binding) ? mapping.saved : null;
    const selected =
      models.find((model) => model.id === saved?.model) ?? defaultModel;
    const selectedEffort = saved?.effort ?? binding.settings.effort;
    const selectedSpeed = saved?.speed ?? binding.settings.speed;
    const choice: HarnessChoice = {
      model: selected.id,
      effort: (selectedEffort && selected.efforts.includes(selectedEffort)
        ? selectedEffort
        : selected.defaultEffort) as HarnessChoice["effort"],
      speed:
        selectedSpeed === "fast" && selected.speeds.includes("fast")
          ? "fast"
          : "standard",
    };
    return {
      binding,
      mapping,
      catalogue: {
        provider: "openai" as const,
        source: "chatgpt" as const,
        exposure: "all" as const,
        default: defaultModel.id,
        models,
        choosable: true,
      },
      choice,
    };
  }
  return {
    async read(actor: AgentActor, channelId: string) {
      const result = await resolve(actor, channelId);
      return { catalogue: result.catalogue, choice: result.choice };
    },
    async save(actor: AgentActor, channelId: string, input: HarnessChoice) {
      const chosen = pick.safeParse(input);
      if (!chosen.success)
        throw new DesktopModelError(
          "Choose a supported model, effort, and speed.",
          400,
        );
      const current = await resolve(actor, channelId);
      const model = current.catalogue.models.find(
        (entry) =>
          entry.id === (chosen.data.model ?? current.catalogue.default),
      );
      if (
        !model ||
        (chosen.data.effort && !model.efforts.includes(chosen.data.effort)) ||
        (chosen.data.speed === "fast" && !model.speeds.includes("fast"))
      )
        throw new DesktopModelError(
          "That VM model does not support the chosen settings.",
          400,
        );
      await deps.database
        .update(intelligenceChannelMappings)
        .set({
          modelSelection: {
            provider: provider(current.binding),
            ...chosen.data,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actor.id),
            eq(intelligenceChannelMappings.channelId, channelId),
          ),
        );
      return this.read(actor, channelId);
    },
    async forRun(
      actor: AgentActor,
      botId: string,
      threadId: string,
    ): Promise<HarnessChoice> {
      const [mapping] = await deps.database
        .select({ channelId: intelligenceChannelMappings.channelId })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actor.id),
            eq(intelligenceChannelMappings.threadId, threadId),
          ),
        )
        .limit(1);
      if (!mapping)
        throw new DesktopModelError(
          "This coding turn needs its own conversation.",
          404,
        );
      const result = await resolve(actor, mapping.channelId);
      if (result.binding.botId !== botId)
        throw new DesktopModelError(
          "That coding Bot does not own this conversation.",
          403,
        );
      return result.choice;
    },
  };
}
export type DesktopModelChoices = ReturnType<typeof createDesktopModelChoices>;
export function createDesktopModelRoutes(
  choices: DesktopModelChoices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.onError((error, context) =>
    error instanceof DesktopModelError
      ? context.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          error.status,
        )
      : context.json(
          { error: "Couldn't reach the coding VM's model settings." },
          503,
        ),
  );
  routes.get("/:channelId/desktop-model", requireUser, async (context) =>
    context.json(
      await choices.read(context.var.actor, context.req.param("channelId")),
    ),
  );
  routes.put("/:channelId/desktop-model", requireUser, async (context) => {
    const input = pick.safeParse(await context.req.json().catch(() => null));
    if (!input.success)
      return context.json(
        { error: "Choose a supported model, effort, and speed." },
        400,
      );
    return context.json(
      await choices.save(
        context.var.actor,
        context.req.param("channelId"),
        input.data,
      ),
    );
  });
  return routes;
}
