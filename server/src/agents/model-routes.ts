import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  type ModelSettings,
  parseModelSettings,
  validateModelChoice,
} from "../../../shared/model-settings";
import type { AppVariables } from "../auth/guards";
import type { ManagedAgentConfig } from "../config";
import {
  codingRuntime,
  localCodingEnabled,
  stopCodingRuntime,
} from "./coding-runtime";
import { createAgentFetch } from "./endpoint";
import { canManageAgent } from "./profile-policy";
import type { AgentProfileStore } from "./profile-store";
import { managedEndpointIdentity } from "./runtime-agents";

const capabilitiesSchema = z.object({
  framework: z.string().max(80),
  defaultModel: z.string().max(200).nullable(),
  customModels: z.boolean(),
  models: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(200),
        efforts: z.array(z.string().max(20)).max(10),
        defaultEffort: z.string().max(20).optional(),
      }),
    )
    .max(200),
});
const usageSchema = z.object({
  status: z.enum(["available", "unsupported", "unavailable"]),
  label: z.string().max(200),
  updatedAt: z.string().max(80).nullable(),
  windows: z
    .array(
      z.object({
        label: z.string().max(100),
        usedPercent: z.number().min(0).max(100),
        resetsAt: z.number().nullable(),
      }),
    )
    .max(20),
});

export function createModelRoutes(options: {
  store: AgentProfileStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  managed?: ManagedAgentConfig;
  allowPrivateHosts: boolean;
  allowedHosts: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const doFetch = createAgentFetch(options);
  routes.use("*", options.requireUser);
  async function readRemote(
    actor: AppVariables["actor"],
    agentId: string,
    resource: "models" | "usage",
  ) {
    const profile = await options.store.get(actor, agentId);
    if (profile?.codingAgent) {
      if (profile.ownerUserId !== actor.id || !localCodingEnabled())
        throw new Error("Local coding profile is unavailable.");
      const runtime = codingRuntime(agentId, profile.codingAgent);
      return resource === "models" ? runtime.models() : runtime.usage();
    }
    const connection = await options.store.modelConnection?.(actor, agentId);
    if (!connection) return null;
    const headers = { ...connection.headers };
    if (
      [options.managed?.endpoint, options.managed?.alsoRun].some(
        (url) =>
          url &&
          managedEndpointIdentity(url) ===
            managedEndpointIdentity(connection.endpoint),
      ) &&
      options.managed
    ) {
      headers["x-openbot-agent-token"] = options.managed.token;
    }
    // Metadata is a sibling of the AG-UI run endpoint, on the same checked origin.
    const response = await doFetch(
      new URL(`/openbot/${resource}`, connection.endpoint).toString(),
      {
        headers,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Agent metadata is unavailable.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty agent metadata.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) throw new Error("Agent metadata is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const value = JSON.parse(
      await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).text(),
    );
    return resource === "models"
      ? capabilitiesSchema.parse(value)
      : usageSchema.parse(value);
  }
  for (const resource of ["models", "usage"] as const) {
    routes.get(`/:agentId/${resource}`, async (context) => {
      const profile = await options.store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (
        !profile ||
        (resource === "usage" &&
          !canManageAgent(context.var.actor, profile) &&
          context.var.actor.role !== "admin")
      )
        return context.json({ error: "Agent not found." }, 404);
      try {
        const value = await readRemote(
          context.var.actor,
          context.req.param("agentId"),
          resource,
        );
        return context.json({ [resource]: value });
      } catch {
        return context.json(
          { error: `Could not read this agent's ${resource}.` },
          502,
        );
      }
    });
  }
  routes.post("/:agentId/runtime/stop", async (context) => {
    const profile = await options.store.get(
      context.var.actor,
      context.req.param("agentId"),
    );
    if (!profile?.codingAgent || profile.ownerUserId !== context.var.actor.id)
      return context.json({ error: "Coding profile not found." }, 404);
    stopCodingRuntime(profile.id);
    return context.json({ stopped: true });
  });
  routes.get("/:agentId/runtime", async (context) => {
    const profile = await options.store.get(
      context.var.actor,
      context.req.param("agentId"),
    );
    if (!profile?.codingAgent || profile.ownerUserId !== context.var.actor.id)
      return context.json({ error: "Coding profile not found." }, 404);
    try {
      return context.json({
        runtime: codingRuntime(profile.id, profile.codingAgent).status(),
      });
    } catch {
      return context.json(
        { error: "Local coding profiles are disabled." },
        503,
      );
    }
  });
  routes.get("/:agentId/threads/:threadId/model", async (context) => {
    const { agentId, threadId } = context.req.param();
    if (!validThread(threadId))
      return context.json({ error: "Invalid thread id." }, 400);
    if (!(await options.store.get(context.var.actor, agentId)))
      return context.json({ error: "Agent not found." }, 404);
    if (!options.store.threadModel)
      return context.json({ error: "Model preferences are unavailable." }, 503);
    return context.json({
      settings: await options.store.threadModel(
        context.var.actor,
        agentId,
        threadId,
      ),
    });
  });
  routes.put("/:agentId/threads/:threadId/model", async (context) => {
    const { agentId, threadId } = context.req.param();
    if (!validThread(threadId))
      return context.json({ error: "Invalid thread id." }, 400);
    if (!(await options.store.get(context.var.actor, agentId)))
      return context.json({ error: "Agent not found." }, 404);
    if (!options.store.threadModel)
      return context.json({ error: "Model preferences are unavailable." }, 503);
    let settings: ModelSettings;
    try {
      settings = parseModelSettings(await context.req.json());
    } catch {
      return context.json({ error: "Invalid model settings." }, 400);
    }
    try {
      const capabilities = capabilitiesSchema.parse(
        await readRemote(context.var.actor, agentId, "models"),
      );
      try {
        validateModelChoice(settings, capabilities);
      } catch (error) {
        return context.json({ error: (error as Error).message }, 400);
      }
    } catch {
      return context.json(
        { error: "This agent's model controls are unavailable." },
        503,
      );
    }
    return context.json({
      settings: await options.store.threadModel(
        context.var.actor,
        agentId,
        threadId,
        settings,
      ),
    });
  });
  return routes;
}

function validThread(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
