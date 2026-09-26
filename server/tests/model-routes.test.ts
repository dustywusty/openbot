import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ModelSettings } from "../../shared/model-settings";
import { createModelRoutes } from "../src/agents/model-routes";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";

test("model routes validate before saving and keep account usage private", async () => {
  const saved = new Map<string, ModelSettings>();
  const metadataRequests: { url: string; headers: Headers }[] = [];
  const profile = {
    id: "agent",
    ownerUserId: "owner",
    visibility: "public",
    systemOwned: false,
    deletedAt: null,
  };
  const store = {
    get: async (_actor: unknown, id: string) =>
      id === "agent" ? profile : null,
    modelConnection: async () => ({
      endpoint: "https://agent.example.test/run",
    }),
    threadModel: async (
      actor: { id: string },
      id: string,
      thread: string,
      settings?: ModelSettings,
    ) => {
      const key = `${actor.id}:${id}:${thread}`;
      if (settings) saved.set(key, settings);
      return saved.get(key) ?? {};
    },
  } as unknown as AgentProfileStore;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createModelRoutes({
      store,
      allowedHosts: new Set(["agent.example.test"]),
      allowPrivateHosts: false,
      managed: {
        endpoint: new URL("https://agent.example.test/run/"),
        token: "test-only-secret",
      },
      requireUser: async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-user") ?? "owner",
          email: "test@example.test",
          role: "user",
        });
        await next();
      },
      fetchImpl: (async (url, init) => {
        metadataRequests.push({
          url: String(url),
          headers: new Headers(init?.headers),
        });
        return Response.json({
          framework: "Test",
          defaultModel: "model-a",
          customModels: false,
          models: [
            { id: "model-a", name: "A", efforts: ["low", "high"] },
            { id: "model-b", name: "B", efforts: [] },
          ],
        });
      }) as typeof fetch,
    }),
  );
  const path = `/agent/threads/${crypto.randomUUID()}/model`;
  const put = (body: unknown) =>
    app.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await put({ model: "model-b", effort: "high" })).status).toBe(400);
  expect(saved.size).toBe(0);
  expect((await put({ model: "model-a", effort: "low" })).status).toBe(200);
  expect(await (await app.request(path)).json()).toEqual({
    settings: { model: "model-a", effort: "low" },
  });
  expect(
    await (
      await app.request(path, { headers: { "x-user": "someone-else" } })
    ).json(),
  ).toEqual({ settings: {} });
  expect(
    (
      await app.request("/agent/usage", {
        headers: { "x-user": "someone-else" },
      })
    ).status,
  ).toBe(404);
  expect((await put({ apiKey: "not-accepted" })).status).toBe(400);
  expect((await app.request("/missing/models")).status).toBe(404);
  expect(metadataRequests[0]?.headers.get("x-openbot-agent-token")).toBe(
    "test-only-secret",
  );
  expect(metadataRequests[0]?.url).toBe(
    "https://agent.example.test/openbot/models",
  );
});
