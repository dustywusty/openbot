import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCodingConversationModel } from "@/lib/computers/coding-run-model";
import { queryClient } from "@/query-client";

const originalFetch = globalThis.fetch;
let choice = {
  model: "sol",
  effort: "high",
  speed: "fast" as "standard" | "fast",
};
let writes: unknown[] = [];
let finish: ((response: Response) => void) | undefined;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  choice = { model: "sol", effort: "high", speed: "fast" };
  writes = [];
  finish = undefined;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("/api/channels/coding-channel/desktop-model");
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Response.json({
        catalogue: {
          provider: "openai",
          source: "chatgpt",
          exposure: "all",
          default: "sol",
          choosable: true,
          models: [
            {
              id: "sol",
              label: "Sol",
              efforts: ["low", "high"],
              defaultEffort: "low",
              speeds: ["standard", "fast"],
            },
            {
              id: "luna",
              label: "Luna",
              efforts: ["low"],
              defaultEffort: "low",
              speeds: ["standard"],
            },
          ],
        },
        choice,
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
function hook() {
  return renderHook(() => useCodingConversationModel("coding-channel", true), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
test("native model changes wait for persistence before the next turn and clamp unsupported Fast", async () => {
  const view = hook();
  await waitFor(() =>
    expect(view.result.current.value).toEqual({ model: "sol", effort: "high" }),
  );
  act(() => view.result.current.choose({ model: "luna", effort: null }));
  let sent = false;
  const send = view.result.current.beforeSend().then(() => {
    sent = true;
  });
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    model: "luna",
    effort: "low",
    speed: "standard",
  });
  expect(sent).toBe(false);
  choice = { model: "luna", effort: "low", speed: "standard" };
  await act(async () => {
    finish?.(Response.json({ choice }));
    await send;
  });
  expect(sent).toBe(true);
  await waitFor(() => expect(view.result.current.value?.model).toBe("luna"));
});
test("a refused model save prevents a waiting send from using the old choice", async () => {
  const view = hook();
  await waitFor(() => expect(view.result.current.value).toBeDefined());
  act(() => view.result.current.chooseSpeed("standard"));
  const waiting = view.result.current.beforeSend();
  // Attach the refusal handler before releasing the synthetic response.
  const verdict = waiting.then(
    () => "sent",
    (error) => error.message,
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  await act(async () => {
    finish?.(Response.json({ error: "VM is stopped." }, { status: 409 }));
  });
  expect(await verdict).toBe("VM is stopped.");
});
