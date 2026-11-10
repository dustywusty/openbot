import { expect, test } from "bun:test";
import type { WorkspaceBot } from "@openbot/shared/workspace-bot";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createDesktopComputerBroker,
  type DesktopComputerBroker,
} from "../src/computer/desktop-broker";
import {
  createDesktopModelChoices,
  createDesktopModelRoutes,
} from "../src/computer/model-choice";
import type { Database } from "../src/db/client";

const vm = "obw-0123456789abcdef";
const initialSettings: WorkspaceBot = {
  workspaceId: vm,
  runtime: "codex",
  model: null,
  effort: "high",
  speed: "fast",
  permission: "workspace-write",
};
type Saved = {
  provider: string;
  model?: string | null;
  effort?: string | null;
  speed?: string | null;
} | null;
type Mapping = {
  userId: string;
  channelId: string;
  threadId: string;
  saved: Saved;
};
const catalogue = [
  {
    id: "slow",
    model: "slow",
    displayName: "Slow",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    defaultReasoningEffort: "low",
    serviceTiers: [],
  },
  {
    id: "hidden",
    model: "hidden",
    displayName: "Hidden",
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    defaultReasoningEffort: "low",
    serviceTiers: [],
  },
  {
    id: "fast",
    model: "fast",
    displayName: "Fast",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "high" },
    ],
    defaultReasoningEffort: "low",
    serviceTiers: [{ id: "priority" }],
  },
];

/** This fake applies the actual Drizzle WHERE predicates, including their actor constraint.
 * It needs no PostgreSQL service and never touches the user's installed database. */
function fixture(actualBroker?: DesktopComputerBroker) {
  const rows: Mapping[] = [
    {
      userId: "alice",
      channelId: "conversation",
      threadId: "alice-thread",
      saved: null,
    },
    {
      userId: "bob",
      channelId: "conversation",
      threadId: "bob-thread",
      saved: null,
    },
  ];
  const dialect = new PgDialect();
  const matched = (where: SQL) => {
    const query = dialect.sqlToQuery(where);
    return rows.filter((row) =>
      (
        [
          ["user_id", "userId"],
          ["channel_id", "channelId"],
          ["thread_id", "threadId"],
        ] as const
      ).every(([column, key]) => {
        const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(query.sql);
        return !match || row[key] === query.params[Number(match[1]) - 1];
      }),
    );
  };
  const writes: { modelSelection: Saved; updatedAt: Date }[] = [];
  const database = {
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({
          limit: async (limit: number) => matched(where).slice(0, limit),
        }),
      }),
    }),
    update: () => ({
      set: (value: { modelSelection: Saved; updatedAt: Date }) => ({
        where: async (where: SQL) => {
          writes.push(value);
          for (const row of matched(where)) row.saved = value.modelSelection;
        },
      }),
    }),
  } as unknown as Database;
  let settings = { ...initialSettings };
  let rawModels: unknown = catalogue;
  let allowed = true;
  let boundBot = "coder";
  const dispatched: Parameters<DesktopComputerBroker["dispatch"]>[0][] = [];
  const broker =
    actualBroker ??
    ({
      list: () => [
        { computerId: vm, name: "VM" },
        { computerId: "obw-fedcba9876543210", name: "Another VM" },
      ],
      dispatch: async (
        input: Parameters<DesktopComputerBroker["dispatch"]>[0],
      ) => {
        dispatched.push(input);
        return {
          operationId: "model-operation",
          completion: Promise.resolve({
            type: "completed",
            exitCode: 0,
            result: rawModels,
          }),
        };
      },
    } as unknown as DesktopComputerBroker);
  const choices = createDesktopModelChoices({
    database,
    broker,
    binding: async (actor, channelId) =>
      allowed &&
      (!actualBroker || actor.id === "alice") &&
      channelId === "conversation"
        ? { botId: boundBot, settings }
        : null,
  });
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const id = context.req.header("x-test-user");
    if (!id) return context.json({ error: "Sign in first." }, 401);
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };
  const app = new Hono().route(
    "/api/channels",
    createDesktopModelRoutes(choices, guard),
  );
  const request = (method = "GET", body?: unknown, actor = "alice") =>
    app.request("/api/channels/conversation/desktop-model", {
      method,
      headers: {
        ...(actor ? { "x-test-user": actor } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    choices,
    rows,
    writes,
    dispatched,
    request,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setModels: (value: unknown) => {
      rawModels = value;
    },
    setSettings: (value: WorkspaceBot) => {
      settings = value;
    },
    setBot: (value: string) => {
      boundBot = value;
    },
  };
}
const alice = { id: "alice", role: "user" as const };

test("the guest default leads the catalogue, hidden models disappear, and effort/speed choices come from the guest", async () => {
  const f = fixture();
  const result = await f.choices.read(alice, "conversation");
  expect(result.catalogue.default).toBe("fast");
  expect(result.catalogue.models.map((model) => model.id)).toEqual([
    "fast",
    "slow",
  ]);
  expect(result.catalogue.models[0]).toMatchObject({
    efforts: ["low", "high"],
    speeds: ["standard", "fast"],
  });
  expect(result.catalogue.models[1]).toMatchObject({
    efforts: ["low"],
    speeds: ["standard"],
  });
  expect(result.choice).toEqual({
    model: "fast",
    effort: "high",
    speed: "fast",
  });
  expect(f.dispatched[0]).toMatchObject({
    actorId: "alice",
    botId: "coder",
    computerId: vm,
    threadId: "alice-thread",
    timeoutMs: 45_000,
    action: { kind: "models", runtime: "codex" },
  });
});

test("picks persist on only the owner's mapping and are the settings used for that owner's run", async () => {
  const f = fixture();
  const pick = { model: "slow", effort: "low", speed: "standard" } as const;
  const saved = await f.choices.save(alice, "conversation", pick);
  expect(saved.choice).toEqual(pick);
  expect(f.rows[0]?.saved).toEqual({
    provider: `desktop:coder:${vm}:codex`,
    ...pick,
  });
  expect(f.rows[1]?.saved).toBeNull();
  expect(await f.choices.forRun(alice, "coder", "alice-thread")).toEqual(pick);
  await expect(
    f.choices.forRun({ id: "bob", role: "user" }, "coder", "alice-thread"),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    f.choices.forRun(alice, "another-bot", "alice-thread"),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.dispatched).toHaveLength(1);
});

test("unsupported, hidden, and impossible model combinations are rejected before any write", async () => {
  for (const input of [
    { model: "not-offered", effort: null, speed: null },
    { model: "hidden", effort: null, speed: null },
    { model: "slow", effort: "high", speed: "standard" },
    { model: "slow", effort: "low", speed: "fast" },
    { model: "fast", effort: "ultra", speed: "standard" },
  ]) {
    const f = fixture();
    const response = await f.request("PUT", input);
    expect(response.status).toBe(400);
    expect(f.writes).toEqual([]);
  }
});

test("null settings inherit Bot defaults; a VM change or another provider cannot reuse the old pick", async () => {
  const f = fixture();
  await f.choices.save(alice, "conversation", {
    model: "slow",
    effort: "low",
    speed: "standard",
  });
  expect(
    (
      await f.choices.save(alice, "conversation", {
        model: null,
        effort: null,
        speed: null,
      })
    ).choice,
  ).toEqual({ model: "fast", effort: "high", speed: "fast" });
  f.rows[0]!.saved = {
    provider: "openai",
    model: "slow",
    effort: "low",
    speed: "standard",
  };
  expect((await f.choices.read(alice, "conversation")).choice).toEqual({
    model: "fast",
    effort: "high",
    speed: "fast",
  });
  f.rows[0]!.saved = {
    provider: `desktop:coder:${vm}:codex`,
    model: "slow",
    effort: "low",
    speed: "standard",
  };
  f.setSettings({ ...initialSettings, workspaceId: "obw-fedcba9876543210" });
  expect((await f.choices.read(alice, "conversation")).choice).toEqual({
    model: "fast",
    effort: "high",
    speed: "fast",
  });
  expect(f.dispatched).toHaveLength(2);
});

test("the short catalogue cache is isolated by both owner and Bot identity", async () => {
  const f = fixture();
  await f.choices.read(alice, "conversation");
  await f.choices.read(alice, "conversation");
  await f.choices.read({ id: "bob", role: "user" }, "conversation");
  f.setBot("other-coder");
  await f.choices.read(alice, "conversation");
  expect(
    f.dispatched.map(({ actorId, botId, threadId }) => ({
      actorId,
      botId,
      threadId,
    })),
  ).toEqual([
    { actorId: "alice", botId: "coder", threadId: "alice-thread" },
    { actorId: "bob", botId: "coder", threadId: "bob-thread" },
    { actorId: "alice", botId: "other-coder", threadId: "alice-thread" },
  ]);
});

test("routes require an authenticated owner and reject client identity/provider overrides", async () => {
  const f = fixture();
  expect((await f.request("GET", undefined, "")).status).toBe(401);
  expect(
    (
      await f.request("PUT", {
        model: null,
        effort: null,
        speed: null,
        actorId: "bob",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("PUT", {
        model: null,
        effort: null,
        speed: null,
        provider: "openai",
      })
    ).status,
  ).toBe(400);
  expect(f.dispatched).toEqual([]);
  f.setAllowed(false);
  expect((await f.request()).status).toBe(403);
  expect(f.dispatched).toEqual([]);
  expect(f.writes).toEqual([]);
});

async function nextModelOperation(broker: DesktopComputerBroker) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const operation = broker.poll().operations[0];
    if (operation) return operation;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("No model request reached the registered desktop.");
}

test("a real broker restart gives owner-safe reconnect guidance and pairing recovers the picker without stale cache", async () => {
  const previous = createDesktopComputerBroker({
    canDispatch: async () => true,
  });
  previous.register(previous.createPairingTicket("alice").ticket, {
    computerId: vm,
    name: "Previous VM",
  });
  previous.dispose();
  const broker = createDesktopComputerBroker({ canDispatch: async () => true });
  const f = fixture(broker);
  const unavailable = {
    error:
      "This workspace is disconnected. Open Computers, pair it with OpenBot, and start its VM.",
    code: "workspace-disconnected",
  };
  try {
    expect(broker.list("alice")).toEqual([]);
    const disconnected = await f.request();
    expect(disconnected.status).toBe(503);
    expect(await disconnected.json()).toEqual(unavailable);
    const save = await f.request("PUT", {
      model: null,
      effort: null,
      speed: null,
    });
    expect(save.status).toBe(503);
    expect(f.writes).toEqual([]);
    expect((await f.request("GET", undefined, "bob")).status).toBe(403);
    broker.register(broker.createPairingTicket("bob").ticket, {
      computerId: vm,
      name: "Bob's private project",
    });
    expect(await (await f.request()).json()).toEqual(unavailable);
    broker.unregister({
      computerId: vm,
      ownerUserId: "bob",
      connectionId: broker.connectionId,
    });
    broker.register(broker.createPairingTicket("alice").ticket, {
      computerId: vm,
      name: "Alice's VM",
    });
    const recovered = f.request();
    const operation = await nextModelOperation(broker);
    broker.acceptEvents({
      operationId: operation.operationId,
      events: [
        {
          sequence: 1,
          event: { type: "completed", exitCode: 0, result: catalogue },
        },
      ],
    });
    const response = await recovered;
    expect(response.status).toBe(200);
    expect((await response.json()).choice.model).toBe("fast");
    broker.unregister({
      computerId: vm,
      ownerUserId: "alice",
      connectionId: broker.connectionId,
    });
    expect(await (await f.request()).json()).toEqual(unavailable);
    broker.register(broker.createPairingTicket("alice").ticket, {
      computerId: vm,
      name: "Alice's VM",
    });
    const refreshed = f.request();
    const freshOperation = await nextModelOperation(broker);
    broker.acceptEvents({
      operationId: freshOperation.operationId,
      events: [
        {
          sequence: 1,
          event: {
            type: "completed",
            exitCode: 0,
            result: catalogue.map((model) => ({
              ...model,
              displayName: "Fresh catalogue",
            })),
          },
        },
      ],
    });
    expect((await (await refreshed).json()).catalogue.models[0].label).toBe(
      "Fresh catalogue",
    );
  } finally {
    broker.dispose();
  }
});

test("native broker failures give safe start/connection guidance and a retry can recover", async () => {
  const broker = createDesktopComputerBroker({ canDispatch: async () => true });
  broker.register(broker.createPairingTicket("alice").ticket, {
    computerId: vm,
    name: "VM",
  });
  const f = fixture(broker);
  try {
    const pending = f.request();
    const operation = await nextModelOperation(broker);
    broker.acceptEvents({
      operationId: operation.operationId,
      events: [
        {
          sequence: 1,
          event: {
            type: "failed",
            message: "raw-native-secret-and-private-path",
          },
        },
      ],
    });
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "The workspace could not list its coding models. Open Computers, start its VM, and check its connection.",
      code: "workspace-unavailable",
    });
    const retry = f.request();
    const retried = await nextModelOperation(broker);
    broker.acceptEvents({
      operationId: retried.operationId,
      events: [
        {
          sequence: 1,
          event: { type: "completed", exitCode: 0, result: catalogue },
        },
      ],
    });
    expect((await retry).status).toBe(200);
  } finally {
    broker.dispose();
  }
});

test("a missing mapping and an invalid or empty guest listing fail closed", async () => {
  const missing = fixture();
  expect((await missing.request("GET", undefined, "outsider")).status).toBe(
    404,
  );
  expect(missing.dispatched).toEqual([]);
  for (const models of [
    [],
    [{ id: "incomplete" }],
    [{ ...catalogue[0], hidden: true }],
  ]) {
    const f = fixture();
    f.setModels(models);
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(f.writes).toEqual([]);
  }
});
