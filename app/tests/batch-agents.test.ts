import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { batchAgentsMutationOptions } from "@/lib/agents/mutations";
import { agentKeys } from "@/lib/agents/queries";
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test("batch deletion bounds concurrency, deduplicates IDs, and reports failures without retrying successes", async () => {
  const client = new QueryClient();
  client.setQueryData(agentKeys.list(), []);
  let active = 0;
  let peak = 0;
  const calls: { url: string; method: string | undefined }[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    active += 1;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return url.endsWith("/refused")
      ? Response.json({ error: "That Bot cannot be deleted." }, { status: 403 })
      : new Response(null, { status: 204 });
  }) as typeof fetch;
  const mutation = client
    .getMutationCache()
    .build(client, batchAgentsMutationOptions(client));
  const result = await mutation.execute({
    action: "delete",
    agentIds: [
      "one",
      "refused",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "one",
    ],
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(calls).toHaveLength(7);
  expect(calls.every((call) => call.method === "DELETE")).toBe(true);
  expect(result.completedIds.sort()).toEqual(
    ["one", "three", "four", "five", "six", "seven"].sort(),
  );
  expect(result.failures).toEqual([
    { id: "refused", message: "That Bot cannot be deleted." },
  ]);
  expect(client.getQueryState(agentKeys.list())?.isInvalidated).toBe(true);
  client.clear();
});

test("batch hide and unhide preserve the existing API semantics and encode each Bot ID", async () => {
  const client = new QueryClient();
  const calls: { url: string; method: string | undefined }[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  for (const action of ["hide", "unhide"] as const) {
    await client
      .getMutationCache()
      .build(client, batchAgentsMutationOptions(client))
      .execute({ action, agentIds: ["package/bot"] });
  }
  expect(calls).toEqual([
    { url: "/api/agents/package%2Fbot/hide", method: "POST" },
    { url: "/api/agents/package%2Fbot/unhide", method: "POST" },
  ]);
  client.clear();
});
