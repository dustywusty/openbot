import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ModelControls } from "@/components/agents/model-controls";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("changing model clears incompatible effort and errors never become zero usage", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/models"))
      return Response.json({
        models: {
          framework: "Codex",
          defaultModel: "reasoner",
          customModels: false,
          models: [
            { id: "reasoner", name: "Reasoner", efforts: ["low", "high"] },
            { id: "fast", name: "Fast", efforts: [] },
          ],
        },
      });
    if (path.endsWith("/usage"))
      return Response.json(
        { error: "Could not refresh account usage." },
        { status: 502 },
      );
    if (init?.method === "PUT") {
      const settings = JSON.parse(String(init.body));
      writes.push(settings);
      return Response.json({ settings });
    }
    return Response.json({ settings: { model: "reasoner", effort: "high" } });
  }) as typeof fetch;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={cache}>
      <ModelControls agentId="coder" threadId={crypto.randomUUID()} />
    </QueryClientProvider>,
  );
  const model = await view.findByLabelText("Conversation model");
  await waitFor(() =>
    expect((model as HTMLSelectElement).disabled).toBe(false),
  );
  fireEvent.change(model, { target: { value: "fast" } });
  await waitFor(() => expect(writes).toEqual([{ model: "fast" }]));
  await waitFor(() =>
    expect(view.queryByLabelText("Reasoning effort")).toBeNull(),
  );
  fireEvent.click(view.getByRole("button", { name: "Account usage" }));
  await view.findByText("Could not refresh account usage.");
  expect(view.queryByRole("progressbar")).toBeNull();
  cache.clear();
});
