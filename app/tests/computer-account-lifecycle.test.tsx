import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { authKeys } from "@/lib/auth/queries";
import { synchronizeComputerOwner } from "@/lib/computers/account-lifecycle";
import { ComputerAccountSync } from "@/lib/computers/account-sync";
import { connectComputerChatGptMutationOptions } from "@/lib/computers/desktop-mutations";
import { computerAuthQueryOptions } from "@/lib/computers/desktop-queries";
import { computerKeys } from "@/lib/computers/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;
let originalIpc: PropertyDescriptor | undefined;
let originalEvents: PropertyDescriptor | undefined;
const vm = "obw-0123456789abcdef";
beforeAll(() => {
  GlobalRegistrator.register();
  originalIpc = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  originalEvents = Object.getOwnPropertyDescriptor(
    window,
    "__TAURI_EVENT_PLUGIN_INTERNALS__",
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  if (originalIpc)
    Object.defineProperty(window, "__TAURI_INTERNALS__", originalIpc);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  if (originalEvents)
    Object.defineProperty(
      window,
      "__TAURI_EVENT_PLUGIN_INTERNALS__",
      originalEvents,
    );
  else Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
function fetchWith(handler: (init?: RequestInit) => Promise<Response>) {
  global.fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => handler(init),
    { preconnect: originalFetch.preconnect },
  );
}
function nativeWith(
  handler: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  callback?: (callback: (event: unknown) => void) => void,
) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      transformCallback: (cb: (event: unknown) => void) => {
        callback?.(cb);
        return 7;
      },
      invoke: handler,
    },
  });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    configurable: true,
    value: { unregisterListener: () => {} },
  });
}

test("every status read obtains a fresh proof and caches only the redacted native result", async () => {
  let minted = 0;
  const tickets: unknown[] = [];
  fetchWith(async (init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ purpose: "status" });
    return Response.json({
      paired: true,
      ticket: `one-use-${++minted}`,
      expiresAt: 1000,
    });
  });
  nativeWith(async (_command, args) => {
    tickets.push(args.ticket);
    return { paired: true, accountName: "Own account" };
  });
  await queryClient.fetchQuery(computerAuthQueryOptions(vm));
  await queryClient.fetchQuery(computerAuthQueryOptions(vm));
  expect(tickets).toEqual(["one-use-1", "one-use-2"]);
  expect(
    JSON.stringify(queryClient.getQueryData(computerKeys.desktopAuth(vm))),
  ).not.toContain("one-use");
});

test("an owner switch cancels and removes the previous account's Computer data", async () => {
  const cache = new QueryClient();
  await synchronizeComputerOwner(cache, "alice");
  cache.setQueryData(computerKeys.desktopAuth(vm), { accountName: "Alice" });
  cache.setQueryData(computerKeys.pairedDesktopVms(), [{ computerId: vm }]);
  cache.setQueryData(computerKeys.conversationModel("channel"), {
    privateChoice: true,
  });
  let finish!: (value: string) => void;
  const pending = cache
    .fetchQuery({
      queryKey: [...computerKeys.all, "slow"],
      queryFn: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    })
    .catch(() => undefined);
  await synchronizeComputerOwner(cache, "bob");
  finish("Alice's late identity");
  await pending;
  expect(cache.getQueriesData({ queryKey: computerKeys.all })).toEqual([]);
});

test("status rejects a late native identity after the OpenBot owner changes", async () => {
  await synchronizeComputerOwner(queryClient, "status-first-owner");
  fetchWith(async () =>
    Response.json({ paired: true, ticket: "status-proof", expiresAt: 1000 }),
  );
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  nativeWith(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
        entered();
      }),
  );
  // Invoke the real query function without React Query's cancellation masking its result.
  const options = computerAuthQueryOptions(vm);
  const pending = options.queryFn!({
    signal: new AbortController().signal,
  } as never);
  await started;
  await synchronizeComputerOwner(queryClient, "status-next-owner");
  finish({ paired: true, accountName: "Previous owner's identity" });
  await expect(pending).rejects.toThrow("account changed");
});

test("sign-out removes native Computer identity without revoking background pairing", async () => {
  const cache = new QueryClient();
  await synchronizeComputerOwner(cache, "signed-in");
  cache.setQueryData(computerKeys.desktopAuth(vm), {
    accountName: "Private name",
  });
  let nativeCalls = 0;
  nativeWith(async () => {
    nativeCalls++;
    return null;
  });
  const mutation = signOutMutationOptions(cache);
  await mutation.onSuccess?.(undefined, undefined, undefined, {} as never);
  expect(cache.getQueryData(computerKeys.desktopAuth(vm))).toBeUndefined();
  expect(nativeCalls).toBe(0);
});

test("a pending account action cannot use its proof after the OpenBot owner changes", async () => {
  await synchronizeComputerOwner(queryClient, "first-owner");
  let finish!: (value: Response) => void;
  fetchWith(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let nativeCalls = 0;
  nativeWith(async () => {
    nativeCalls++;
    return {};
  });
  const action = connectComputerChatGptMutationOptions(queryClient).mutationFn!(
    vm,
    {} as never,
  );
  await synchronizeComputerOwner(queryClient, "next-owner");
  finish(
    Response.json({ paired: true, ticket: "outdated-proof", expiresAt: 1000 }),
  );
  await expect(action).rejects.toThrow("account changed");
  expect(nativeCalls).toBe(0);
});

test("pairing events coalesce model refreshes without any model-account operation", async () => {
  let event!: (event: unknown) => void;
  const commands: string[] = [];
  nativeWith(
    async (command) => {
      commands.push(command);
      return 3;
    },
    (callback) => {
      event = callback;
    },
  );
  const invalidated: unknown[] = [];
  const invalidate = spyOn(queryClient, "invalidateQueries").mockImplementation(
    async (filters) => {
      invalidated.push(filters?.queryKey);
    },
  );
  try {
    const view = render(<ComputerAccountSync />);
    await waitFor(() => expect(commands).toContain("plugin:event|listen"));
    await act(async () => {
      for (let index = 0; index < 3; index++)
        event({ payload: { computerId: vm } });
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(invalidated).toEqual([computerKeys.all]);
    expect(
      commands.filter((command) => command.includes("computer_auth")),
    ).toEqual([]);
    view.unmount();
    await waitFor(() => expect(commands).toContain("plugin:event|unlisten"));
  } finally {
    invalidate.mockRestore();
  }
});

test("a current-user change also clears owner caches inside an already-open app", async () => {
  await synchronizeComputerOwner(queryClient, "old-owner");
  queryClient.setQueryData(computerKeys.desktopAuth(vm), {
    accountName: "Old identity",
  });
  render(<ComputerAccountSync />);
  act(() =>
    queryClient.setQueryData(authKeys.currentUser(), { id: "new-owner" }),
  );
  expect(
    queryClient.getQueryData(computerKeys.desktopAuth(vm)),
  ).toBeUndefined();
});

test("mount synchronizes the already-loaded account before relying on later identity events", async () => {
  await synchronizeComputerOwner(queryClient, "earlier-owner");
  queryClient.setQueryData(computerKeys.desktopAuth(vm), {
    accountName: "Earlier identity",
  });
  queryClient.setQueryData(authKeys.currentUser(), { id: "current-owner" });
  render(<ComputerAccountSync />);
  expect(
    queryClient.getQueryData(computerKeys.desktopAuth(vm)),
  ).toBeUndefined();
});
