import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { createDesktopComputerBroker } from "./desktop-broker";
import { createDesktopComputerRoutes } from "./desktop-routes";

const computerId = "obw-0123456789abcdef";
function fixture(
  extra: Partial<Parameters<typeof createDesktopComputerBroker>[0]> = {},
) {
  let time = 1000;
  const broker = createDesktopComputerBroker({
    canDispatch: async () => true,
    now: () => time,
    ...extra,
  });
  const pairing = broker.createPairingTicket("alice");
  broker.register(pairing.ticket, { computerId, name: "OpenBot" });
  return {
    broker,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const input = {
  actorId: "alice",
  botId: "coder",
  computerId,
  threadId: "thread-1",
  runId: "run-1",
  action: { kind: "run_command" as const, command: "pwd" },
};

describe("desktop Computer ownership and operation delivery", () => {
  test("workspace disconnection revokes only its current owner's pairing and cancels its work", async () => {
    const { broker } = fixture();
    const otherId = "obw-fedcba9876543210";
    const ticket = broker.createPairingTicket("alice");
    broker.register(ticket.ticket, { computerId: otherId, name: "Other" });
    const binding = {
      computerId,
      ownerUserId: "alice",
      connectionId: broker.connectionId,
    };
    try {
      const task = await broker.dispatch(input);
      const other = await broker.dispatch({ ...input, computerId: otherId });
      expect(() =>
        broker.unregister({ ...binding, ownerUserId: "bob" }),
      ).toThrow("not available");
      expect(() =>
        broker.unregister({ ...binding, connectionId: crypto.randomUUID() }),
      ).toThrow("connection changed");
      expect(broker.list("alice")).toHaveLength(2);
      broker.unregister(binding);
      await expect(task.completion).rejects.toThrow("disconnected");
      expect(broker.list("alice")).toEqual([
        { computerId: otherId, name: "Other" },
      ]);
      expect(broker.poll().cancellations).toContain(task.operationId);
      expect(broker.poll().operations).toEqual([]);
      await expect(broker.dispatch(input)).rejects.toThrow("not available");
      expect(() => broker.unregister(binding)).not.toThrow();
      broker.cancel("alice", other.operationId);
      await expect(other.completion).rejects.toThrow("stopped");
      const reassignment = broker.createPairingTicket("bob");
      broker.register(reassignment.ticket, { computerId, name: "New owner" });
      expect(() => broker.unregister(binding)).toThrow("not available");
      expect(broker.list("bob")).toHaveLength(1);
    } finally {
      broker.dispose();
    }
  });
  test("pairing is single-use, owner-bound and expires", () => {
    const { broker, advance } = fixture();
    try {
      expect(broker.list("alice")).toEqual([{ computerId, name: "OpenBot" }]);
      expect(broker.list("bob")).toEqual([]);
      const ticket = broker.createPairingTicket("bob");
      expect(() =>
        broker.register(ticket.ticket, { computerId, name: "Stolen" }),
      ).toThrow("another person");
      const once = broker.createPairingTicket("alice");
      broker.register(once.ticket, { computerId, name: "Renamed" });
      expect(() =>
        broker.register(once.ticket, { computerId, name: "Again" }),
      ).toThrow("already used");
      const expired = broker.createPairingTicket("alice");
      advance(300_001);
      expect(() =>
        broker.register(expired.ticket, { computerId, name: "Late" }),
      ).toThrow("expired");
    } finally {
      broker.dispose();
    }
  });

  test("dispatch requires both computer ownership and bot authorization", async () => {
    const { broker } = fixture({
      canDispatch: async ({ botId }) => botId === "coder",
    });
    try {
      await expect(
        broker.dispatch({ ...input, actorId: "bob" }),
      ).rejects.toThrow("not available");
      await expect(
        broker.dispatch({ ...input, botId: "unavailable" }),
      ).rejects.toThrow("cannot use");
      expect(broker.poll().operations).toEqual([]);
    } finally {
      broker.dispose();
    }
  });

  test("lease redelivery retains id and ordered event retries have no duplicate effects", async () => {
    const { broker, advance } = fixture();
    const seen: string[] = [];
    try {
      const task = await broker.dispatch({
        ...input,
        onEvent: (event) => seen.push(event.type),
      });
      const first = broker.poll();
      expect(first.operations[0]?.operationId).toBe(task.operationId);
      expect(broker.poll().operations).toEqual([]);
      advance(15_001);
      expect(broker.poll().operations[0]?.operationId).toBe(task.operationId);
      expect(
        broker.acceptEvents({
          operationId: task.operationId,
          events: [
            {
              sequence: 2,
              event: { type: "output", stream: "stdout", text: "ignored gap" },
            },
          ],
        }),
      ).toEqual({ acceptedSequence: 0, finished: false });
      const events = [
        { sequence: 1, event: { type: "started" as const } },
        {
          sequence: 2,
          event: {
            type: "output" as const,
            stream: "stdout" as const,
            text: "/workspace/project",
          },
        },
      ];
      broker.acceptEvents({ operationId: task.operationId, events });
      broker.acceptEvents({ operationId: task.operationId, events });
      expect(seen).toEqual(["started", "output"]);
      const final = {
        operationId: task.operationId,
        events: [
          { sequence: 3, event: { type: "completed" as const, exitCode: 0 } },
        ],
      };
      expect(broker.acceptEvents(final)).toEqual({
        acceptedSequence: 3,
        finished: true,
      });
      expect(broker.acceptEvents(final)).toEqual({
        acceptedSequence: 3,
        finished: true,
      });
      await expect(task.completion).resolves.toEqual({
        type: "completed",
        exitCode: 0,
      });
      expect(broker.poll().operations).toEqual([]);
    } finally {
      broker.dispose();
    }
  });

  test("owner cancellation interrupts a long turn and rejects late output", async () => {
    const { broker } = fixture();
    const seen: string[] = [];
    try {
      const task = await broker.dispatch({
        ...input,
        onEvent: (event) => seen.push(event.type),
      });
      expect(() => broker.cancel("bob", task.operationId)).toThrow(
        "not available",
      );
      broker.cancel("alice", task.operationId);
      await expect(task.completion).rejects.toThrow("stopped");
      expect(broker.poll().cancellations).toEqual([task.operationId]);
      expect(
        broker.acceptEvents({
          operationId: task.operationId,
          events: [
            {
              sequence: 1,
              event: { type: "output", stream: "stdout", text: "late" },
            },
          ],
        }).finished,
      ).toBe(true);
      expect(seen).toEqual([]);
      broker.acceptEvents({
        operationId: task.operationId,
        events: [
          { sequence: 1, event: { type: "failed", message: "Stopped" } },
        ],
      });
      expect(broker.poll().cancellations).toEqual([]);
    } finally {
      broker.dispose();
    }
  });

  test("run deadlines exceed delivery leases and expiry queues cancellation", async () => {
    const { broker, advance } = fixture();
    try {
      const task = await broker.dispatch(input);
      advance(120_001);
      expect(broker.poll().operations[0]?.operationId).toBe(task.operationId);
      advance(30 * 60_000);
      expect(broker.poll().cancellations).toEqual([task.operationId]);
      await expect(task.completion).rejects.toThrow("expired");
    } finally {
      broker.dispose();
    }
  });

  test("aborting an operation propagates cancellation without a webview", async () => {
    const { broker } = fixture();
    try {
      const controller = new AbortController();
      const task = await broker.dispatch({
        ...input,
        signal: controller.signal,
      });
      controller.abort();
      await expect(task.completion).rejects.toThrow("stopped");
      expect(broker.poll().cancellations).toEqual([task.operationId]);
    } finally {
      broker.dispose();
    }
  });

  test("guest actions reject path escapes and host-shaped RPC fields", async () => {
    const { broker } = fixture();
    try {
      for (const path of [
        "/Users/alice/.ssh/id_ed25519",
        "../secret",
        "a/../../secret",
      ]) {
        await expect(
          broker.dispatch({ ...input, action: { kind: "read_file", path } }),
        ).rejects.toThrow();
      }
      await expect(
        broker.dispatch({
          ...input,
          action: {
            ...input.action,
            hostPath: "/Users/alice",
          } as typeof input.action,
        }),
      ).rejects.toThrow();
      expect(broker.poll().operations).toEqual([]);
    } finally {
      broker.dispose();
    }
  });

  test("cancellation stays available across a delayed desktop reconnect", async () => {
    const { broker, advance } = fixture();
    try {
      const task = await broker.dispatch(input);
      broker.cancel("alice", task.operationId);
      await expect(task.completion).rejects.toThrow("stopped");
      advance(5 * 60_000);
      expect(broker.poll().cancellations).toEqual([task.operationId]);
    } finally {
      broker.dispose();
    }
  });

  test("untrusted native output is bounded before notifying the consumer", async () => {
    const { broker } = fixture();
    let delivered = 0;
    try {
      const task = await broker.dispatch({
        ...input,
        onEvent: () => {
          delivered += 1;
        },
      });
      const text = "x".repeat(65_536);
      for (let sequence = 1; sequence <= 129; sequence += 1) {
        broker.acceptEvents({
          operationId: task.operationId,
          events: [
            { sequence, event: { type: "output", stream: "stdout", text } },
          ],
        });
      }
      await expect(task.completion).rejects.toThrow("too much output");
      expect(delivered).toBeLessThan(129);
      expect(broker.poll().cancellations).toEqual([task.operationId]);
    } finally {
      broker.dispose();
    }
  });
});

describe("desktop Computer route authentication", () => {
  test("native routes require desktop bearer; user routes use signed-in actor", async () => {
    const { broker } = fixture();
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      const id = context.req.header("x-test-user");
      if (!id) return context.json({ error: "Sign in" }, 401);
      context.set("actor", { id, email: `${id}@example.com`, role: "user" });
      await next();
    };
    const app = new Hono().route(
      "/computers",
      createDesktopComputerRoutes({
        broker,
        desktopToken: "desktop-secret",
        requireUser,
      }),
    );
    try {
      expect((await app.request("/computers/desktop/next")).status).toBe(401);
      expect(
        (
          await app.request("/computers/desktop/next", {
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("/computers/desktop/next", {
            headers: { authorization: "Bearer desktop-secret" },
          })
        ).status,
      ).toBe(200);
      expect((await app.request("/computers")).status).toBe(401);
      const other = await app.request("/computers", {
        headers: { "x-test-user": "bob" },
      });
      expect(await other.json()).toEqual({ computers: [] });
      const pairing = await app.request("/computers/pair", {
        method: "POST",
        headers: { "x-test-user": "alice" },
      });
      const { ticket } = (await pairing.json()) as { ticket: string };
      const body = JSON.stringify({
        ticket,
        computer: { computerId, name: "OpenBot" },
      });
      expect(
        (
          await app.request("/computers/desktop/register", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-user": "alice",
            },
            body,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("/computers/desktop/register", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer desktop-secret",
            },
            body,
          })
        ).status,
      ).toBe(200);
      const task = await broker.dispatch(input);
      const cancel = await app.request(
        `/computers/operations/${task.operationId}/cancel`,
        { method: "POST", headers: { "x-test-user": "bob" } },
      );
      expect(cancel.status).toBe(409);
      broker.cancel("alice", task.operationId);
      await expect(task.completion).rejects.toThrow("stopped");
      const disconnectBody = JSON.stringify({
        computerId,
        ownerUserId: "alice",
        connectionId: broker.connectionId,
      });
      expect(
        (
          await app.request("/computers/desktop/unregister", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-user": "alice",
            },
            body: disconnectBody,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("/computers/desktop/unregister", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer desktop-secret",
            },
            body: disconnectBody,
          })
        ).status,
      ).toBe(200);
      expect(broker.list("alice")).toEqual([]);
    } finally {
      broker.dispose();
    }
  });
});
