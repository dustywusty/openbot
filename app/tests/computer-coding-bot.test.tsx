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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewCodingBotPage } from "@/components/computers/coding-bot";
import { ComputerDetailPage } from "@/components/computers/local-computers";
import { queryClient } from "@/query-client";

const id = "obw-0123456789abcdef";
const originalFetch = globalThis.fetch;
const calls: { command: string; args?: Record<string, unknown> }[] = [];
let paired = false;
let durable = false;
let allowed = false;
let connected = false;
let canAllow = false;
let phase = "ready";
let codexInstalled = true;
let pending = false;
let failedChannel = false;
let agents: unknown[] = [];
let channels = 0;
let proofCount = 0;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  paired = false;
  durable = false;
  allowed = false;
  connected = false;
  canAllow = false;
  phase = "ready";
  codexInstalled = true;
  pending = false;
  failedChannel = false;
  agents = [];
  channels = 0;
  proofCount = 0;
  calls.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith("|workspace_list"))
        return [
          {
            id,
            phase,
            problem: null,
            completed: [],
            recipe: {
              name: "OpenBot",
              baseImage: "debian13",
              repository: "https://example.invalid/project.git",
              gitRef: "main",
              resources: { cpus: 4, memoryGib: 8, diskGib: 48 },
              packages: [],
              setup: [],
              verify: [],
              ports: [],
              tools: { codex: codexInstalled ? "0.163.0" : null, claude: null },
            },
          },
        ];
      if (command.endsWith("|computer_auth_status"))
        return {
          connected: connected || allowed,
          pending,
          paired,
          allowed,
          canAllow: canAllow && paired,
          attemptId: pending ? "attempt" : null,
          accountName: allowed ? "Test User" : null,
          email: null,
          expiresAt: null,
          error: null,
        };
      if (command.endsWith("|workspace_models"))
        return [
          {
            id: "test-model",
            model: "gpt-test",
            displayName: "Test model",
            description: "From the VM",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
            ],
            defaultReasoningEffort: "high",
            serviceTiers: [
              { id: "priority", name: "Fast", description: "Fast" },
            ],
            defaultServiceTier: null,
          },
        ];
      if (command.endsWith("|computer_register")) {
        paired = true;
        return { computerId: id, name: "OpenBot" };
      }
      if (command.endsWith("|workspace_logs")) return "";
      if (command.endsWith("|workspace_ports")) return [];
      if (command.endsWith("|computer_auth_allow")) {
        allowed = true;
        return null;
      }
      if (command.endsWith("|computer_disconnect")) {
        paired = false;
        durable = false;
        allowed = false;
        return null;
      }
      if (command.endsWith("|computer_auth_cancel")) {
        pending = false;
        return null;
      }
      if (command.endsWith("|computer_auth_logout")) {
        connected = false;
        allowed = false;
        return { remoteRevocationConfirmed: true, warning: null };
      }
      if (command.endsWith("|computer_auth_start")) {
        pending = true;
        return { attemptId: "attempt", expiresAt: 12345 };
      }
      throw new Error(`Unexpected command ${command}`);
    },
  };
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/desktop-computers/${id}/actor-ticket`) {
        const { purpose } = JSON.parse(String(init?.body));
        proofCount += 1;
        return Response.json(
          purpose === "status" && !paired
            ? {
                paired: false,
                canDisconnect: durable,
                ticket: null,
                expiresAt: null,
              }
            : {
                paired: true,
                canDisconnect: true,
                ticket: `${purpose}-proof-${proofCount}`,
                expiresAt: 12345,
              },
        );
      }
      if (path === "/api/desktop-computers/pair")
        return Response.json({
          ticket: "one-use-pair-ticket",
          expiresAt: 12345,
        });
      if (path === "/api/agents" && init?.method === "POST") {
        agents.push(JSON.parse(String(init.body)));
        return Response.json({ agent: { id: "coding-bot" } });
      }
      if (path === "/api/channels" && init?.method === "POST") {
        channels++;
        if (failedChannel)
          return Response.json(
            { error: "Conversation could not open." },
            { status: 500 },
          );
        return Response.json({ channel: { id: "coding-channel" } });
      }
      throw new Error(`Unexpected fetch ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
function page(detail = false) {
  const root = createRootRoute({ component: Outlet });
  const start = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () =>
      detail ? <ComputerDetailPage id={id} /> : <NewCodingBotPage id={id} />,
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    component: () => <p>Normal Bot conversation</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([start, chat]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}
test("opening setup never starts OAuth; pairing precedes an explicit Continue click", async () => {
  const view = page();
  const pair = await view.findByRole("button", { name: "Pair VM" });
  expect(
    calls.some((call) => call.command.endsWith("|computer_auth_start")),
  ).toBe(false);
  expect(
    (
      view.getByRole("button", {
        name: "Continue with ChatGPT",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(pair);
  await waitFor(() =>
    expect(
      (
        view.getByRole("button", {
          name: "Continue with ChatGPT",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(
    calls.find((call) => call.command.endsWith("|computer_register"))?.args,
  ).toEqual({ id, ticket: "one-use-pair-ticket" });
  await userEvent.click(
    view.getByRole("button", { name: "Continue with ChatGPT" }),
  );
  await view.findByRole("button", { name: "Cancel sign-in" });
  expect(
    calls.filter((call) => call.command.endsWith("|computer_auth_start")),
  ).toHaveLength(1);
});
test("creation saves native model defaults and retries a failed channel without duplicating the Bot", async () => {
  paired = true;
  allowed = true;
  failedChannel = true;
  const view = page();
  const create = await view.findByRole("button", {
    name: "Create Bot and open chat",
  });
  await waitFor(() =>
    expect((create as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.submit(create.closest("form")!);
  await view.findByRole("button", { name: "Open conversation" });
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    visibility: "private",
    workspaceBot: {
      workspaceId: id,
      runtime: "codex",
      model: "gpt-test",
      effort: "high",
      speed: "standard",
      permission: "workspace-write",
    },
  });
  expect(JSON.stringify(agents[0])).not.toContain("access_token");
  expect(channels).toBe(1);
  failedChannel = false;
  await userEvent.click(
    view.getByRole("button", { name: "Open conversation" }),
  );
  await view.findByText("Normal Bot conversation");
  expect(view.router.state.location.pathname).toBe("/channel/coding-channel");
  expect(agents).toHaveLength(1);
  expect(channels).toBe(2);
});

test("an existing workspace reconnects without creating another Bot or conversation", async () => {
  connected = true;
  canAllow = true;
  const view = page(true);
  await userEvent.click(await view.findByRole("button", { name: "Pair VM" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Allow this VM" }),
  );
  await view.findByText(/Connected as Test User/);
  expect(
    calls.filter((call) => call.command.endsWith("|computer_auth_allow")),
  ).toEqual([
    {
      command: "plugin:openbot-desktop|computer_auth_allow",
      args: { id, ticket: expect.stringMatching(/^allow-proof-/) },
    },
  ]);
  expect(
    calls.some((call) => call.command.endsWith("|computer_auth_start")),
  ).toBe(false);
  expect(agents).toHaveLength(0);
  expect(channels).toBe(0);
});
test("a stopped workspace without Codex can pair for ordinary Bots without ChatGPT", async () => {
  phase = "stopped";
  codexInstalled = false;
  const view = page(true);
  await userEvent.click(await view.findByRole("button", { name: "Pair VM" }));
  await view.findByText("This VM is paired with your account.");
  expect(view.queryByText("ChatGPT", { exact: true })).toBeNull();
  expect(
    view.queryByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeNull();
  expect(
    calls.some(
      (call) =>
        call.command.endsWith("|computer_auth_start") ||
        call.command.endsWith("|computer_auth_allow"),
    ),
  ).toBe(false);
  expect(agents).toHaveLength(0);
});

test("an unpaired current account never queries or displays saved native ChatGPT identity", async () => {
  connected = true;
  allowed = true;
  const view = page(true);
  await view.findByRole("button", { name: "Pair VM" });
  expect(view.queryByText(/Connected as Test User/)).toBeNull();
  expect(
    calls.some((call) => call.command.endsWith("|computer_auth_status")),
  ).toBe(false);
});

test("disconnect workspace uses its actor proof and does not log out ChatGPT", async () => {
  paired = true;
  allowed = true;
  const view = page(true);
  await userEvent.click(
    await view.findByRole("button", { name: "Disconnect workspace" }),
  );
  await view.findByRole("button", { name: "Pair VM" });
  expect(
    calls.find((call) => call.command.endsWith("|computer_disconnect"))?.args,
  ).toEqual({ id, ticket: expect.stringMatching(/^disconnect-proof-/) });
  expect(
    calls.some((call) => call.command.endsWith("|computer_auth_logout")),
  ).toBe(false);
});

test("disconnect ChatGPT uses its actor proof while leaving workspace pairing intact", async () => {
  paired = true;
  allowed = true;
  const view = page(true);
  await userEvent.click(
    await view.findByRole("button", { name: "Disconnect ChatGPT" }),
  );
  await view.findByRole("button", { name: "Continue with ChatGPT" });
  expect(view.getByText("This VM is paired with your account.")).toBeTruthy();
  expect(
    calls.find((call) => call.command.endsWith("|computer_auth_logout"))?.args,
  ).toEqual({ id, ticket: expect.stringMatching(/^logout-proof-/) });
  expect(
    calls.some((call) => call.command.endsWith("|computer_disconnect")),
  ).toBe(false);
});

test("a saved offline workspace can be revoked without reading model account identity", async () => {
  paired = false;
  durable = true;
  const view = page(true);
  await view.findByText("This workspace is disconnected from OpenBot.");
  expect(view.getByRole("button", { name: "Pair VM" })).toBeTruthy();
  await userEvent.click(
    view.getByRole("button", { name: "Disconnect workspace" }),
  );
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: "Disconnect workspace" }),
    ).toBeNull(),
  );
  expect(
    calls.some((call) => call.command.endsWith("|computer_auth_status")),
  ).toBe(false);
  expect(
    calls.find((call) => call.command.endsWith("|computer_disconnect"))?.args,
  ).toMatchObject({ id, ticket: expect.stringMatching(/^disconnect-proof-/) });
});
