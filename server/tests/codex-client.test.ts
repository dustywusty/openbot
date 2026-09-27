import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexClient } from "../src/agents/codex-client";

function fixture() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.emit("exit", 0);
      return true;
    },
  });
  const sent: { id?: number | string; method?: string; error?: unknown }[] = [];
  process.stdin.on("data", (data) => {
    for (const line of data.toString().trim().split("\n"))
      sent.push(JSON.parse(line));
  });
  const client = new CodexClient(
    "/tmp",
    () => process as unknown as ChildProcessWithoutNullStreams,
  );
  const reply = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  reply({ id: sent[0]!.id, result: {} });
  return { client, process, sent, reply };
}
describe("Codex process protocol", () => {
  test("correlates concurrent requests and refuses approval requests", async () => {
    const { client, sent, reply } = fixture();
    await client.ready;
    const models = client.request("model/list");
    const usage = client.request("account/rateLimits/read");
    reply({
      id: sent.find((row) => row.method === "account/rateLimits/read")!.id,
      result: { used: 42 },
    });
    reply({
      id: sent.find((row) => row.method === "model/list")!.id,
      result: { models: 2 },
    });
    expect(await models).toEqual({ models: 2 });
    expect(await usage).toEqual({ used: 42 });
    reply({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    await Bun.sleep(1);
    expect(sent.find((row) => row.id === "approval-1")!.error).toBeDefined();
    client.stop();
  });
  test("stopping rejects pending work and broadcasts process closure", async () => {
    const { client } = fixture();
    await client.ready;
    let closed = false;
    client.listen((event) => {
      closed ||= event.method === "openbot/closed";
    });
    const waiting = client.request("model/list");
    client.stop();
    await expect(waiting).rejects.toThrow("Codex stopped");
    expect(closed).toBe(true);
    await expect(client.request("model/list")).rejects.toThrow("stopped");
  });
});
