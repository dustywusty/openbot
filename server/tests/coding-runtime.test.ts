import { expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { CodexClient } from "../src/agents/codex-client";
import { CodingRuntime } from "../src/agents/coding-runtime";

function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<Parameters<CodexClient["listen"]>[0]>();
  let sequence = 0;
  let pause = false;
  const client = {
    ready: Promise.resolve(),
    closed: false,
    listen(listener: Parameters<CodexClient["listen"]>[0]) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      this.closed = true;
    },
    async request<T>(method: string, raw: unknown): Promise<T> {
      const params = (raw ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      let response: unknown = {};
      if (method === "model/list")
        response = {
          data: [
            {
              model: "a",
              displayName: "A",
              isDefault: true,
              defaultReasoningEffort: "low",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
            },
            {
              model: "b",
              displayName: "B",
              isDefault: false,
              defaultReasoningEffort: "low",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
            },
          ],
          nextCursor: null,
        };
      if (method === "account/read")
        response = { account: { type: "chatgpt" } };
      if (method === "thread/start")
        response = { thread: { id: `native-${++sequence}` } };
      if (method === "turn/start") {
        const threadId = String(params.threadId);
        response = { turn: { id: `turn-${threadId}` } };
        if (!pause)
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({
                method: "item/agentMessage/delta",
                params: {
                  threadId,
                  itemId: `message-${threadId}`,
                  delta: threadId,
                },
              });
              listener({
                method: "turn/completed",
                params: { threadId, turn: { status: "completed" } },
              });
            }
          });
      }
      return response as T;
    },
  } as unknown as CodexClient;
  const runtime = new CodingRuntime(
    { framework: "codex", cwd: "/tmp", permission: "read-only", defaults: {} },
    () => client,
  );
  const input: RunAgentInput = {
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    messages: [{ id: "user", role: "user", content: "test" }],
    context: [],
    tools: [],
    state: {},
    forwardedProps: {},
  };
  return {
    runtime,
    calls,
    input,
    pause: () => {
      pause = true;
    },
  };
}

test("concurrent native threads keep separate output and model choices, and defaults reset explicitly", async () => {
  const { runtime, calls, input } = fixture();
  const a: BaseEvent[] = [],
    b: BaseEvent[] = [];
  const signal = new AbortController().signal;
  await Promise.all([
    runtime.run(
      "thread-a",
      input,
      { model: "b", effort: "high" },
      "role",
      (event) => a.push(event),
      signal,
    ),
    runtime.run(
      "thread-b",
      input,
      {},
      "role",
      (event) => b.push(event),
      signal,
    ),
  ]);
  expect(JSON.stringify(a)).toContain("native-1");
  expect(JSON.stringify(a)).not.toContain("native-2");
  expect(JSON.stringify(b)).toContain("native-2");
  expect(JSON.stringify(b)).not.toContain("native-1");
  await runtime.run("thread-a", input, {}, "role", () => {}, signal);
  const turns = calls.filter((call) => call.method === "turn/start");
  expect(turns[0]?.params).toMatchObject({ model: "b", effort: "high" });
  expect(turns[2]?.params).toMatchObject({
    threadId: "native-1",
    model: "a",
    effort: "low",
  });
  expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(
    2,
  );
  expect(runtime.status().activeRuns).toBe(0);
  runtime.stop();
});

test("Stop interrupts the active native turn and releases the conversation", async () => {
  const { runtime, calls, input, pause } = fixture();
  pause();
  const controller = new AbortController();
  const outcome = runtime
    .run("thread-a", input, {}, "role", () => {}, controller.signal)
    .catch((error: Error) => error);
  for (
    let tick = 0;
    tick < 20 && !calls.some((call) => call.method === "turn/start");
    tick++
  )
    await Bun.sleep(1);
  controller.abort();
  expect(((await outcome) as Error).message).toBe("Turn stopped.");
  expect(
    calls.find((call) => call.method === "turn/interrupt")?.params,
  ).toEqual({ threadId: "native-1", turnId: "turn-native-1" });
  expect(runtime.status().activeRuns).toBe(0);
  runtime.stop();
});
