import { describe, expect, test } from "bun:test";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { createDesktopComputerBroker } from "../src/computer/desktop-broker";
import { createDesktopComputerExecution } from "../src/computer/desktop-execution";
import { botSeat, personSeat } from "../src/computer/computer-key";
import { personBrowserId } from "../src/browser/person";

type Profile = Pick<
  AgentProfile,
  "ownerUserId" | "visibility" | "systemOwned" | "workspaceBot" | "computerId"
>;
const id = "obw-0123456789abcdef";
const profile: Profile = {
  ownerUserId: "alice",
  visibility: "private",
  systemOwned: false,
  computerId: id,
};
function fixture(value: Profile | null = profile) {
  const broker = createDesktopComputerBroker({ canDispatch: async () => true });
  broker.register(broker.createPairingTicket("alice").ticket, {
    computerId: id,
    name: "Project",
  });
  const reads: Array<{ actor: AgentActor; botId: string }> = [];
  let ownerReads = 0;
  const execution = createDesktopComputerExecution({
    broker,
    profiles: {
      get: async (actor, botId) => {
        reads.push({ actor, botId });
        return value;
      },
    },
    botOwnership: async () => {
      ownerReads++;
      return { ownerUserId: "alice" };
    },
  });
  return { broker, execution, reads, ownerReads: () => ownerReads };
}

describe("desktop Computer execution adapter", () => {
  test("an ordinary unassigned browser Bot works without an explicit action actor", async () => {
    const view = fixture({ ...profile, computerId: null });
    try {
      expect(
        await view.execution.resolve(personSeat("alice", "helper")),
      ).toBeNull();
      expect(view.reads[0]?.actor.id).toBe("alice");
      expect(view.ownerReads()).toBe(0);
    } finally {
      view.broker.dispose();
    }
  });
  test("a person's browser bypasses Bot lookup and desktop ownership entirely", async () => {
    const view = fixture(null);
    try {
      expect(
        await view.execution.resolve(botSeat(personBrowserId("alice"))),
      ).toBeNull();
      expect(view.reads).toEqual([]);
      expect(view.ownerReads()).toBe(0);
    } finally {
      view.broker.dispose();
    }
  });
  test("person and isolated Bot seats resolve their authoritative owners", async () => {
    const view = fixture();
    try {
      expect(
        await view.execution.resolve(personSeat("alice", "helper")),
      ).toEqual({ computerId: id });
      expect(await view.execution.resolve(botSeat("helper"))).toEqual({
        computerId: id,
      });
      expect(view.ownerReads()).toBe(1);
      expect(view.reads.map((read) => read.actor.id)).toEqual([
        "alice",
        "alice",
      ]);
    } finally {
      view.broker.dispose();
    }
  });
  test("another action actor cannot replace a person's seat identity", async () => {
    const view = fixture();
    try {
      await expect(
        view.execution.resolve(personSeat("alice", "helper"), { id: "bob" }),
      ).rejects.toThrow("not available");
      expect(view.reads).toEqual([]);
    } finally {
      view.broker.dispose();
    }
  });
  test("public, system, foreign-owned and malformed assignments refuse instead of returning unassigned", async () => {
    for (const changed of [
      { ...profile, visibility: "public" as const },
      { ...profile, systemOwned: true },
      { ...profile, ownerUserId: "bob" },
      { ...profile, computerId: "../../host" },
    ]) {
      const view = fixture(changed);
      try {
        await expect(
          view.execution.resolve(personSeat("alice", "helper")),
        ).rejects.toThrow("not connected");
      } finally {
        view.broker.dispose();
      }
    }
  });
  test("a saved native coding assignment falls back to its workspace ID", async () => {
    const view = fixture({
      ...profile,
      computerId: null,
      workspaceBot: {
        workspaceId: id,
        runtime: "codex",
        model: null,
        effort: null,
        speed: null,
        permission: "read-only",
      },
    });
    try {
      expect(
        await view.execution.resolve(personSeat("alice", "helper")),
      ).toEqual({ computerId: id });
    } finally {
      view.broker.dispose();
    }
  });
  test("an unpaired VM or a deleted Bot refuses without a fallback target", async () => {
    const view = fixture({ ...profile, computerId: "obw-fedcba9876543210" });
    try {
      await expect(
        view.execution.resolve(personSeat("alice", "helper")),
      ).rejects.toThrow("not connected");
    } finally {
      view.broker.dispose();
    }
    const deleted = fixture(null);
    try {
      await expect(
        deleted.execution.resolve(personSeat("alice", "helper")),
      ).rejects.toThrow("not available");
    } finally {
      deleted.broker.dispose();
    }
  });
  test("dispatch binds identity and conversation, aggregates ordered output and forwards cancellation", async () => {
    const view = fixture();
    let time = 100;
    const execution = createDesktopComputerExecution({
      broker: view.broker,
      profiles: { get: async () => profile },
      botOwnership: async () => ({ ownerUserId: "alice" }),
      context: () => ({ threadId: "conversation", runId: "run" }),
      now: () => time,
    });
    try {
      const controller = new AbortController();
      const pending = execution.execute({
        computerId: id,
        botId: "helper",
        actor: { id: "alice", initiator: { kind: "routine", id: "daily" } },
        action: { kind: "run_command", command: "bun test" },
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      // Dispatch performs an async authorization check before queueing.
      await Promise.resolve();
      await Promise.resolve();
      const operation = view.broker.poll().operations[0];
      expect(operation).toBeDefined();
      if (!operation) throw new Error("No operation queued");
      expect(operation).toMatchObject({
        computerId: id,
        actorId: "alice",
        botId: "helper",
        threadId: "conversation",
        runId: "run",
        action: { kind: "run_command", command: "bun test" },
      });
      view.broker.acceptEvents({
        operationId: operation.operationId,
        events: [
          {
            sequence: 1,
            event: { type: "output", stream: "stdout", text: "one" },
          },
          {
            sequence: 2,
            event: { type: "output", stream: "stderr", text: "warning" },
          },
          {
            sequence: 3,
            event: { type: "output", stream: "stdout", text: "two" },
          },
          {
            sequence: 4,
            event: {
              type: "output",
              stream: "assistant",
              text: "not shell output",
            },
          },
          {
            sequence: 5,
            event: { type: "completed", exitCode: 0, result: { proof: true } },
          },
        ],
      });
      time = 125;
      expect(await pending).toEqual({
        exitCode: 0,
        result: { proof: true },
        stdout: "onetwo",
        stderr: "warning",
        elapsedMs: 25,
      });
      const cancelled = execution.execute({
        computerId: id,
        botId: "helper",
        actor: { id: "alice" },
        action: { kind: "run_command", command: "sleep 60" },
        signal: controller.signal,
      });
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      await expect(cancelled).rejects.toThrow("stopped");
      expect(view.broker.poll().cancellations.length).toBe(1);
    } finally {
      view.broker.dispose();
    }
  });
});
