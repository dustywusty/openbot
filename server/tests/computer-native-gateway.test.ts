import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import {
  createComputerGateway,
  type NativeComputerExecution,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import { parseAgentInput } from "../src/agents/routes";
import { runForDuplicate } from "../src/agents/profile-store";

const id = "obw-0123456789abcdef";
const actor = {
  id: "alice",
  initiator: { kind: "routine" as const, id: "routine-1" },
};
const seat = personSeat(actor.id, "maintainer");
const permissive: ActionPolicy = { mode: "enforce", allow: ["true"], deny: [] };
function fixture(
  options: {
    policy?: ActionPolicy;
    native?: Partial<NativeComputerExecution>;
    approval?: () => void;
  } = {},
) {
  let http = 0;
  const events: AuditEventInput[] = [];
  const executions: Parameters<NativeComputerExecution["execute"]>[0][] = [];
  const native: NativeComputerExecution = {
    resolve: async () => ({ computerId: id }),
    execute: async (input) => {
      executions.push(input);
      const result =
        input.action.kind === "read_file"
          ? { content: "project notes" }
          : input.action.kind === "write_file"
            ? { written: 5 }
            : input.action.kind === "list_files"
              ? {
                  entries: [
                    { name: "package.json", directory: false, bytes: 12 },
                  ],
                }
              : null;
      return {
        result,
        exitCode: 0,
        stdout: "proof passed",
        stderr: "",
        elapsedMs: 5,
      };
    },
    ...options.native,
  };
  const provider: ComputerProvider = {
    name: "test",
    isolation: "shared",
    locate: async () => {
      http++;
      return "http://computer.test";
    },
    status: async () => ({ botId: seat.botId, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
  };
  const gateway = createComputerGateway({
    provider,
    policy: () => options.policy ?? permissive,
    auditStore: {
      insert: async (event) => {
        events.push(event);
      },
    },
    fetchImpl: async () => {
      http++;
      throw new Error("unexpected HTTP fallback");
    },
    nativeExecution: native,
    approvalGate: async () => {
      options.approval?.();
      return undefined;
    },
  });
  return { gateway, executions, events, http: () => http };
}

describe("existing Computer tools on a desktop VM", () => {
  test("routine shell passes approval and audit before native dispatch, retaining owner identity", async () => {
    const order: string[] = [];
    const view = fixture({
      approval: () => order.push("approval"),
      native: {
        execute: async (input) => {
          order.push("execute");
          expect(view.events.length).toBeGreaterThan(0);
          expect(input.actor).toEqual(actor);
          expect(input.botId).toBe(seat.botId);
          expect(input.computerId).toBe(id);
          return {
            exitCode: 0,
            stdout: "tests passed",
            stderr: "",
            elapsedMs: 2,
          };
        },
      },
    });
    const result = await view.gateway.runCommand(seat, actor, {
      command: "git checkout -b fix-issue && bun test",
    });
    expect(order).toEqual(["approval", "execute"]);
    expect(result.stdout).toBe("tests passed");
    expect(result.untrusted).toBeDefined();
    expect(view.http()).toBe(0);
    expect(JSON.stringify(view.events)).toContain("routine-1");
  });
  test("policy refusal never dispatches and still records the refused action", async () => {
    const view = fixture({
      policy: { ...permissive, deny: ['intent == "run_command"'] },
    });
    await expect(
      view.gateway.runCommand(seat, actor, { command: "git commit -am fix" }),
    ).rejects.toThrow();
    expect(view.executions).toHaveLength(0);
    expect(view.events).toHaveLength(1);
    expect(view.http()).toBe(0);
  });
  test("files preserve existing tool result shapes and reads remain untrusted", async () => {
    const view = fixture();
    expect(await view.gateway.listFiles(seat, actor, { path: "src" })).toEqual({
      path: "src",
      entries: [{ path: "src/package.json", kind: "file", bytes: 12 }],
      truncated: false,
    });
    const read = await view.gateway.readFile(seat, actor, { path: "notes.md" });
    expect(read.text).toBe("project notes");
    expect(read.untrusted).toBeDefined();
    expect(
      await view.gateway.writeFile(seat, actor, {
        path: "notes.md",
        contents: "notes",
        append: true,
      }),
    ).toEqual({ path: "notes.md", bytes: 5, appended: true });
    expect(view.http()).toBe(0);
  });
  test("revoked assignment and mismatched actor fail without HTTP fallback", async () => {
    const revoked = fixture({
      native: {
        resolve: async () => {
          throw new Error("Computer grant revoked");
        },
      },
    });
    await expect(
      revoked.gateway.runCommand(seat, actor, { command: "pwd" }),
    ).rejects.toThrow("revoked");
    expect(revoked.http()).toBe(0);
    expect(revoked.executions).toHaveLength(0);
    const view = fixture();
    await expect(
      view.gateway.readFile(seat, { id: "bob" }, { path: "notes.md" }),
    ).rejects.toThrow("not available");
    expect(view.http()).toBe(0);
    expect(view.executions).toHaveLength(0);
  });
  test("browser operations on a VM refuse explicitly instead of controlling another Computer", async () => {
    const view = fixture();
    await expect(view.gateway.screenshot(seat)).rejects.toThrow(
      "Browser control is not available",
    );
    await expect(
      view.gateway.navigate(seat, actor, "https://example.com"),
    ).rejects.toThrow("Browser control is not available");
    expect(view.http()).toBe(0);
    expect(view.executions).toHaveLength(0);
  });
  test("Stop cancellation reaches the same native shell operation", async () => {
    const controller = new AbortController();
    const view = fixture({
      native: {
        execute: async (input) => {
          expect(input.signal).toBe(controller.signal);
          controller.abort();
          if (input.signal?.aborted) throw new Error("Stopped");
          return { stdout: "", stderr: "", elapsedMs: 0 };
        },
      },
    });
    await expect(
      view.gateway.runCommand(
        seat,
        actor,
        { command: "sleep 60" },
        controller.signal,
      ),
    ).rejects.toThrow("Stopped");
    expect(view.http()).toBe(0);
  });
});

describe("private Bot Computer assignment", () => {
  const input = {
    name: "Maintainer",
    title: "Project maintenance",
    roleDescription: "Fix issues and verify changes before committing locally.",
    visibility: "private",
  };
  test("validates VM identifiers and rejects public or externally hosted assignment", () => {
    expect(parseAgentInput({ ...input, computerId: id }).ok).toBe(true);
    for (const change of [
      { computerId: "../../host" },
      { computerId: id, visibility: "public" },
      { computerId: id, endpoint: "https://remote.example/agent" },
    ])
      expect(parseAgentInput({ ...input, ...change }).ok).toBe(false);
    const cleared = parseAgentInput({ ...input, computerId: null });
    expect(cleared.ok && cleared.value.computerId).toBeNull();
  });
  test("duplicating an ordinary Bot retains its Computer without changing runtime", () => {
    expect(
      runForDuplicate(
        {
          type: "built_in",
          configuration: {
            systemPrompt: "Maintain the project",
            computerId: id,
          },
        },
        undefined,
      ),
    ).toEqual({
      type: "built_in",
      configuration: { systemPrompt: "Maintain the project", computerId: id },
    });
  });
});
