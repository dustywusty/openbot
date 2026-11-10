import { expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { DesktopComputerOperation } from "@openbot/shared/desktop-computer";
import type { WorkspaceBot } from "@openbot/shared/workspace-bot";
import { createDesktopComputerBroker } from "../src/computer/desktop-broker";
import { DesktopHarnessAgent } from "../src/computer/harness-agent";

const computerId = "obw-0123456789abcdef";
const settings: WorkspaceBot = {
  workspaceId: computerId,
  runtime: "codex",
  model: "bot-default",
  effort: "medium",
  speed: "standard",
  permission: "workspace-write",
};
const input = (runId = "run-one"): RunAgentInput => ({
  threadId: "conversation-thread",
  runId,
  state: {},
  tools: [],
  context: [],
  forwardedProps: {
    actorId: "forged-owner",
    computerId: "obw-ffffffffffffffff",
    model: "forged-model",
  },
  messages: [
    { id: "old", role: "user", content: "Old task" },
    { id: "answer", role: "assistant", content: "Old answer" },
    {
      id: "latest",
      role: "user",
      content: [
        { type: "text", text: "Inspect" },
        { type: "text", text: "the project" },
      ],
    },
  ],
});

function fixture(
  choice?: () => Promise<{ model: string; effort: "high"; speed: "fast" }>,
) {
  const broker = createDesktopComputerBroker({
    canDispatch: async ({ actorId, botId }) =>
      actorId === "owner" && botId === "coder",
  });
  broker.register(broker.createPairingTicket("owner").ticket, {
    computerId,
    name: "Test VM",
  });
  const agent = new DesktopHarnessAgent({
    actorId: "owner",
    botId: "coder",
    name: "Project Coder",
    settings,
    instructions: "Keep work local.",
    broker,
    choice,
  });
  return { broker, agent };
}

function start(agent: DesktopHarnessAgent, run = input()) {
  const events: BaseEvent[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const subscription = agent
    .run(run)
    .subscribe({ next: (event) => events.push(event), complete: finish });
  return { events, completed, subscription };
}

async function operation(
  broker: ReturnType<typeof createDesktopComputerBroker>,
): Promise<DesktopComputerOperation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const next = broker.poll().operations[0];
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The harness did not dispatch its desktop operation.");
}

test("the real broker carries trusted run identity and server-selected settings, and only assistant output becomes AG-UI text", async () => {
  const { broker, agent } = fixture(async () => ({
    model: "selected-model",
    effort: "high",
    speed: "fast",
  }));
  try {
    const run = start(agent);
    const job = await operation(broker);
    expect(job).toMatchObject({
      actorId: "owner",
      botId: "coder",
      computerId,
      threadId: "conversation-thread",
      runId: "run-one",
      action: {
        kind: "harness_turn",
        runtime: "codex",
        prompt: "Inspect\nthe project",
        developerInstructions: "Keep work local.",
        model: "selected-model",
        effort: "high",
        speed: "fast",
        permission: "workspace-write",
      },
    });
    broker.acceptEvents({
      operationId: job.operationId,
      events: [
        {
          sequence: 1,
          event: {
            type: "output",
            stream: "stdout",
            text: "private tool output",
          },
        },
        {
          sequence: 2,
          event: {
            type: "output",
            stream: "stderr",
            text: "private diagnostics",
          },
        },
        {
          sequence: 3,
          event: {
            type: "output",
            stream: "reasoning",
            text: "private reasoning",
          },
        },
        {
          sequence: 4,
          event: { type: "output", stream: "assistant", text: "Changed " },
        },
        {
          sequence: 5,
          event: { type: "output", stream: "assistant", text: "the project." },
        },
        {
          sequence: 6,
          event: {
            type: "completed",
            exitCode: 0,
            result: { text: "Do not duplicate this fallback" },
          },
        },
      ],
    });
    await run.completed;
    expect(run.events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(run.events[0]).toMatchObject({
      threadId: "conversation-thread",
      runId: "run-one",
    });
    expect(run.events[1]).toMatchObject({
      role: "assistant",
      name: "Project Coder",
      messageId: "desktop-run-one",
    });
    expect(
      run.events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => (event as { delta?: string }).delta)
        .join(""),
    ).toBe("Changed the project.");
    expect(JSON.stringify(run.events)).not.toContain("private");
    expect(broker.poll().cancellations).toEqual([]);
  } finally {
    broker.dispose();
  }
});

test("nonstreamed completion text is delivered, but failed desktop work never reports RUN_FINISHED", async () => {
  for (const failed of [false, true]) {
    const { broker, agent } = fixture();
    try {
      const run = start(agent);
      const job = await operation(broker);
      expect(job.action).toMatchObject({
        model: "bot-default",
        effort: "medium",
        speed: "standard",
      });
      broker.acceptEvents({
        operationId: job.operationId,
        events: [
          {
            sequence: 1,
            event: failed
              ? {
                  type: "failed",
                  message: "Connect ChatGPT in the desktop app.",
                }
              : {
                  type: "completed",
                  exitCode: 0,
                  result: { text: "Verified successfully." },
                },
          },
        ],
      });
      await run.completed;
      expect(run.events.at(-1)?.type).toBe(
        failed ? EventType.RUN_ERROR : EventType.RUN_FINISHED,
      );
      if (failed) {
        expect(run.events.at(-1)).toMatchObject({
          message: "Connect ChatGPT in the desktop app.",
          code: "DESKTOP_COMPUTER_FAILED",
        });
        expect(
          run.events.some((event) => event.type === EventType.RUN_FINISHED),
        ).toBe(false);
      } else
        expect(
          run.events.find(
            (event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
          ),
        ).toMatchObject({ delta: "Verified successfully." });
    } finally {
      broker.dispose();
    }
  }
});

test("nonzero exit closes a streamed assistant message and reports the stopped turn", async () => {
  const { broker, agent } = fixture();
  try {
    const run = start(agent);
    const job = await operation(broker);
    broker.acceptEvents({
      operationId: job.operationId,
      events: [
        {
          sequence: 1,
          event: {
            type: "output",
            stream: "assistant",
            text: "Partial answer",
          },
        },
        { sequence: 2, event: { type: "completed", exitCode: 7 } },
      ],
    });
    await run.completed;
    expect(run.events.slice(-2).map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_ERROR,
    ]);
    expect(
      run.events.some((event) => event.type === EventType.RUN_FINISHED),
    ).toBe(false);
  } finally {
    broker.dispose();
  }
});

test("unsupported attachments and empty tasks stop before any guest operation is queued", async () => {
  for (const content of [
    "  ",
    [{ type: "binary", mimeType: "image/png", data: "fixture" }],
  ]) {
    const { broker, agent } = fixture();
    try {
      const run = start(agent, {
        ...input(),
        messages: [{ id: "task", role: "user", content }],
      } as RunAgentInput);
      await run.completed;
      expect(run.events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(broker.poll().operations).toEqual([]);
    } finally {
      broker.dispose();
    }
  }
});

test("aborting a cloned harness cancels only its own operation and rejects late assistant output", async () => {
  const { broker, agent } = fixture();
  try {
    const original = start(agent);
    const first = await operation(broker);
    const clone = agent.clone();
    const secondRun = start(clone, input("run-two"));
    const second = await operation(broker);
    clone.abortRun();
    await secondRun.completed;
    expect(broker.poll().cancellations).toEqual([second.operationId]);
    broker.acceptEvents({
      operationId: second.operationId,
      events: [
        {
          sequence: 1,
          event: { type: "output", stream: "assistant", text: "Late" },
        },
      ],
    });
    expect(secondRun.events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
    ]);
    broker.acceptEvents({
      operationId: first.operationId,
      events: [
        {
          sequence: 1,
          event: { type: "completed", result: { text: "Original finished." } },
        },
      ],
    });
    await original.completed;
    expect(original.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  } finally {
    broker.dispose();
  }
});

test("unsubscribing cancels queued desktop work even without a webview", async () => {
  const { broker, agent } = fixture();
  try {
    const run = start(agent);
    const job = await operation(broker);
    run.subscription.unsubscribe();
    expect(broker.poll().cancellations).toEqual([job.operationId]);
    expect(run.events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
    ]);
  } finally {
    broker.dispose();
  }
});

test("cancellation while resolving the server's choice never queues a later guest turn", async () => {
  let choose!: (value: {
    model: string;
    effort: "high";
    speed: "fast";
  }) => void;
  const choice = new Promise<{ model: string; effort: "high"; speed: "fast" }>(
    (resolve) => {
      choose = resolve;
    },
  );
  const { broker, agent } = fixture(() => choice);
  try {
    const run = start(agent);
    agent.abortRun();
    choose({ model: "selected-model", effort: "high", speed: "fast" });
    await run.completed;
    expect(broker.poll().operations).toEqual([]);
    expect(run.events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
    ]);
  } finally {
    broker.dispose();
  }
});
