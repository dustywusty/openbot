import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDialog } from "@/components/agents/agent-dialog";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";

/**
 * Editing the connection of a coworker somebody hosts: its endpoint and the key it sits behind.
 *
 * The routes are the server's own, mounted behind `fetch` the way `agent-dialog-built-in-edit`
 * mounts them, so the endpoint checks and the key parsing are the real ones. Only the store is a
 * fake, recording what the route asked it to write. The connection test is answered by hand,
 * because the real one dials the address.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ENDPOINT = "https://agents.example.test/ag-ui";
const MOVED = "https://elsewhere.example.test/ag-ui";

const owner = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];
/** Every connection test, as the browser sent it. */
let tests: Record<string, unknown>[] = [];

beforeEach(() => {
  updates = [];
  tests = [];
});

function serve(options: {
  hasAuth: boolean;
  actor?: { id: string; email: string; role: "user" | "admin" };
}) {
  const actor = options.actor ?? owner;
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    visibility: "public",
    ownerUserId: owner.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: ENDPOINT,
    hasAuth: options.hasAuth,
    hasCallbackToken: false,
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      const { endpoint, auth, ...rest } = value as {
        endpoint?: string;
        auth?: unknown;
      };
      profile = {
        ...profile,
        ...rest,
        endpoint: endpoint ?? profile.endpoint,
        hasAuth: profile.hasAuth || auth !== undefined,
      };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(store, auth);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      if (path === "/api/agents/test-connection") {
        tests.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, events: ["RUN_STARTED"] });
      }
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId="expenses" onClose={() => {}} open />
      ),
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  return { view, user, queryClient };
}

async function openConnection({ view, user }: ReturnType<typeof draw>) {
  // The sidebar is drawn for both layouts, so the section name appears twice.
  const [section] = await view.findAllByRole("button", { name: "Connection" });
  if (!section) throw new Error("no Connection section in the sidebar");
  await user.click(section);
  await view.findByText(ENDPOINT);
}

async function startEditing(drawn: ReturnType<typeof draw>) {
  await openConnection(drawn);
  await drawn.user.click(
    drawn.view.getByRole("button", { name: "Edit connection" }),
  );
}

test("the endpoint can be moved together with a new key", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  const endpoint = view.getByLabelText("Agent endpoint");
  await user.clear(endpoint);
  await user.type(endpoint, MOVED);
  await user.type(view.getByLabelText("New key"), "Bearer new-secret");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "public",
    endpoint: MOVED,
    auth: { header: "Authorization", value: "Bearer new-secret" },
  });
  // Back to the summary, drawing the new address, and the typed key is nowhere on the page.
  await view.findByText(MOVED);
  expect(view.baseElement.innerHTML).not.toContain("new-secret");
});

test("the key alone can be replaced, keeping the endpoint", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  await user.type(view.getByLabelText("New key"), "Bearer rotated");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    endpoint: ENDPOINT,
    auth: { header: "Authorization", value: "Bearer rotated" },
  });
});

test("a blank key leaves the stored key alone", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  // The key field never opens holding anything: the stored key is write-only.
  expect((view.getByLabelText("New key") as HTMLInputElement).value).toBe("");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]?.endpoint).toBe(ENDPOINT);
  expect(updates[0]?.auth).toBeUndefined();
});

test("moving the endpoint without the key is refused before anything is sent", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  const endpoint = view.getByLabelText("Agent endpoint");
  await user.clear(endpoint);
  await user.type(endpoint, MOVED);
  await user.click(view.getByRole("button", { name: "Save" }));

  expect((await view.findByRole("alert")).textContent).toContain(
    "Enter the key for the new endpoint",
  );
  expect(updates).toHaveLength(0);
});

test("a coworker with no key can be moved without one", async () => {
  serve({ hasAuth: false });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  const endpoint = view.getByLabelText("Agent endpoint");
  await user.clear(endpoint);
  await user.type(endpoint, MOVED);
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ endpoint: MOVED });
  expect(updates[0]?.auth).toBeUndefined();
});

test("an address that is not a web address is refused under the field", async () => {
  serve({ hasAuth: false });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  const endpoint = view.getByLabelText("Agent endpoint");
  await user.clear(endpoint);
  await user.type(endpoint, "ftp://agents.example.test");
  await user.click(view.getByRole("button", { name: "Save" }));

  expect((await view.findByRole("alert")).textContent).toContain(
    "http:// or https://",
  );
  expect(updates).toHaveLength(0);
});

test("the server's refusal is shown and nothing is closed over it", async () => {
  serve({ hasAuth: false });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  // A private address, which this deployment's own endpoint check refuses.
  const endpoint = view.getByLabelText("Agent endpoint");
  await user.clear(endpoint);
  await user.type(endpoint, "http://127.0.0.1:9000/ag-ui");
  await user.click(view.getByRole("button", { name: "Save" }));

  await view.findByRole("alert");
  expect(updates).toHaveLength(0);
  expect(view.getByLabelText("Agent endpoint")).toBeTruthy();
});

test("Test dials the typed endpoint with the typed key only", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  await user.click(view.getByRole("button", { name: "Test" }));
  await view.findByText("It answered: RUN_STARTED");
  expect(tests[0]).toEqual({ endpoint: ENDPOINT });

  await user.type(view.getByLabelText("New key"), "Bearer typed");
  await user.click(view.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(tests).toHaveLength(2));
  expect(tests[1]).toEqual({
    endpoint: ENDPOINT,
    headers: { Authorization: "Bearer typed" },
  });
});

test("Cancel forgets a typed key", async () => {
  serve({ hasAuth: true });
  const drawn = draw();
  const { view, user } = drawn;
  await startEditing(drawn);

  await user.type(view.getByLabelText("New key"), "Bearer abandoned");
  await user.click(view.getByRole("button", { name: "Cancel" }));
  await user.click(view.getByRole("button", { name: "Edit connection" }));

  expect((view.getByLabelText("New key") as HTMLInputElement).value).toBe("");
  expect(updates).toHaveLength(0);
});

test("somebody who may not manage the coworker sees the connection and cannot edit it", async () => {
  serve({
    hasAuth: true,
    actor: { id: "colleague", email: "colleague@example.test", role: "user" },
  });
  const drawn = draw();
  await openConnection(drawn);

  expect(
    drawn.view.queryByRole("button", { name: "Edit connection" }),
  ).toBeNull();
  expect(drawn.view.getByText(/^Set\./)).toBeTruthy();
});
