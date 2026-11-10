import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { BotRoster } from "@/components/bots/bot-roster";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bots roster: one list of every Bot a person can reach, replacing the Bots, Agents and Team
 * Bots screens. The harness is this repository's: `GlobalRegistrator` around the file, `cleanup`
 * after each test, a `QueryClient` per test with `retry: false`, and `fetch` stubbed per test.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(originalDefaults);
});

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/**
 * Serves the visible roster, the hidden roster, and an empty attention list, with nothing found by
 * check-ins and no tasks.
 */
function serving(
  visible: AgentProfile[],
  hidden: AgentProfile[],
  attention: Record<string, unknown>[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/attention"))
      return Response.json({ bots: attention, lastPingId: null });
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions: [] });
    if (url === "/api/tasks") return Response.json({ tasks: [] });
    if (url.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({
      agents: url.includes("hidden=true") ? hidden : visible,
    });
  }) as unknown as typeof fetch;
}

const originalDefaults = queryClient.getDefaultOptions();
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
});

function draw(editing = false, Page?: ComponentType) {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (Page ? <Page /> : <BotRoster editing={editing} />),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("sections read Pinned, Yours, Shared with you, and each Bot appears once", async () => {
  serving(
    [
      bot({ id: "favourite", name: "Favourite", pinned: true }),
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "theirs", name: "Theirs", mine: false, canManage: false }),
    ],
    [],
  );
  const view = draw();
  expect(await view.findByText("Theirs")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["Pinned", "Yours", "Shared with you"]);
  expect(view.getAllByText("Favourite")).toHaveLength(1);
});

test("a row opens the Bot's own page", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  const row = (await view.findByText("Mine")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/mine");
});

test("with every Bot of yours pinned, Yours says so instead of claiming none", async () => {
  serving([bot({ id: "favourite", name: "Favourite", pinned: true })], []);
  const view = draw();
  expect(await view.findByText("Your Bots are all pinned above.")).toBeTruthy();
  expect(
    view.queryByText("You don't have any Bots yet. Create one with New Bot."),
  ).toBeNull();
});

test("a hidden Bot is under Hidden, folded until asked for, and its row opens its page", async () => {
  serving(
    [bot({ id: "mine", name: "Mine" })],
    [bot({ id: "tucked", name: "Tucked", hidden: true })],
  );
  const view = draw();
  expect(await view.findByText("Hidden")).toBeTruthy();
  expect(view.queryByText("Tucked")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show" }));
  const row = view.getByText("Tucked").closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/tucked");
});

test("with nothing hidden there is no Hidden section", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  expect(await view.findByText("Mine")).toBeTruthy();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(true))?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByText("Hidden")).toBeNull();
});

test("a roster that never loaded says so, not that you have no Bots", async () => {
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(
    view.queryByText("You don't have any Bots yet. Create one with New Bot."),
  ).toBeNull();
});

test("a failed refetch keeps the roster it already had, not the error", async () => {
  queryClient.setQueryData(agentKeys.list(false), [
    bot({ id: "mine", name: "Mine" }),
  ]);
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    ),
  );
  expect(view.getByText("Mine")).toBeTruthy();
  expect(
    view.queryByText("Couldn't load your Bots. Reload the page."),
  ).toBeNull();
});

test("a Bot with something waiting stays in its own section, with its count", async () => {
  serving(
    [
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "waiting", name: "Waiting", mine: false }),
    ],
    [],
    [
      {
        agentId: "waiting",
        name: "Waiting",
        questions: 1,
        approvals: 1,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
        items: 0,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
    ],
  );
  const view = draw();
  expect(await view.findByText("2")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  // What it waits on is on the Needs you board, by name; the Bot itself stays where it is.
  expect(headings).toEqual(["Yours", "Shared with you"]);
  expect(view.getAllByText("Waiting")).toHaveLength(1);
});

test("a Bot's check-in items are counted in the words the badge and Needs you use", async () => {
  serving(
    [bot({ id: "scout", name: "Scout", mine: false })],
    [],
    [
      {
        agentId: "scout",
        name: "Scout",
        questions: 0,
        approvals: 0,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
        items: 2,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
    ],
  );
  const view = draw();
  expect(await view.findByText("2 things need you")).toBeTruthy();
  expect(view.container.textContent).not.toContain("suggestion");
});

test("personal edition labels starter Bots as included with OpenBot", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "personal",
  });
  serving(
    [bot({ id: "starter", name: "Starter", mine: false, systemOwned: true })],
    [],
  );
  const view = draw();
  await view.findByText("Starter");
  expect(
    view.getByRole("heading", { name: "Included with OpenBot" }),
  ).toBeTruthy();
  expect(view.queryByText("Shared with you")).toBeNull();
});

test("Edit selects visible and hidden Bots, and delete targets only manageable Bots after confirmation", async () => {
  serving(
    [
      bot({ id: "mine", name: "Mine" }),
      bot({
        id: "included",
        name: "Included",
        systemOwned: true,
        canManage: false,
        mine: false,
      }),
    ],
    [bot({ id: "hidden", name: "Hidden Bot", hidden: true })],
  );
  const view = draw(true);
  expect(
    await view.findByRole("checkbox", { name: "Select Hidden Bot" }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Select all" }));
  expect(view.getByRole("status").textContent).toBe("3 selected");
  expect(
    view.getByRole("button", { name: "Delete (2)" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Delete (2)" }));
  expect(await view.findByRole("dialog")).toBeTruthy();
  expect(view.getByRole("heading", { name: "Delete 2 Bots?" })).toBeTruthy();
  expect(view.getByText(/1 other selected Bot cannot be deleted/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(
    view
      .getByRole("checkbox", { name: "Select Mine" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("Edit leaves assigned protected Bots unselectable and Select all skips them", async () => {
  serving(
    [
      bot({ id: "mine", name: "Mine" }),
      bot({
        id: "assigned",
        name: "Assigned",
        assignedToMe: true,
        canManage: false,
        mine: false,
      }),
    ],
    [],
  );
  const view = draw(true);
  await view.findByRole("checkbox", { name: "Select Mine" });
  expect(
    view
      .getByRole("checkbox", { name: "Select Assigned" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Select all" }));
  expect(view.getByRole("status").textContent).toBe("1 selected");
  fireEvent.click(view.getByRole("button", { name: "Deselect all" }));
  expect(view.getByRole("status").textContent).toBe("0 selected");
});

test("the header opens Edit, deletion waits for confirmation, and a partial failure retries only the failed Bot", async () => {
  const visible = [
    bot({ id: "first", name: "First" }),
    bot({
      id: "included",
      name: "Included",
      canManage: false,
      mine: false,
      systemOwned: true,
    }),
  ];
  const hidden = [bot({ id: "second", name: "Second", hidden: true })];
  serving(visible, hidden);
  const reads = global.fetch;
  const deleted: string[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refusedOnce = false;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method !== "DELETE") return reads(input, init);
    const id = path.split("/").at(-1) ?? "";
    deleted.push(id);
    await pending;
    if (id === "second" && !refusedOnce) {
      refusedOnce = true;
      return Response.json(
        { error: "Could not delete this Bot. Try again." },
        { status: 503 },
      );
    }
    for (const list of [visible, hidden]) {
      const index = list.findIndex((agent) => agent.id === id);
      if (index >= 0) list.splice(index, 1);
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const search = spyOn(BotsRoute, "useSearch").mockImplementation(
    (() => ({})) as never,
  );
  try {
    const user = userEvent.setup({ document });
    const view = draw(false, BotsRoute.options.component as ComponentType);
    expect(
      (await view.findByText("First")).closest("a")?.getAttribute("href"),
    ).toBe("/bots/first");
    await user.click(view.getByRole("button", { name: "Bots actions" }));
    await user.click(await view.findByRole("menuitem", { name: "Edit list" }));
    await view.findByRole("checkbox", { name: "Select Second" });
    fireEvent.click(view.getByRole("button", { name: "Select all" }));
    expect(view.getByRole("status").textContent).toBe("3 selected");
    fireEvent.click(view.getByRole("button", { name: "Delete (2)" }));
    let dialog = await view.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["First", "Second"]);
    expect(deleted).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(deleted).toEqual([]);
    expect(view.getByRole("status").textContent).toBe("3 selected");

    fireEvent.click(view.getByRole("button", { name: "Delete (2)" }));
    dialog = await view.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete selected" }),
    );
    await waitFor(() => expect(deleted).toHaveLength(2));
    expect(
      view.getByText("Done").closest("button")?.hasAttribute("disabled"),
    ).toBe(true);
    // The modal correctly hides the page from accessibility queries. Inspect these underlying
    // controls only to prove that the pending operation also disables them outside the modal.
    expect(
      view.container
        .querySelector('[aria-label="Select Included"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    release();
    expect((await view.findByRole("alert")).textContent).toContain(
      "Second: Could not delete this Bot. Try again.",
    );
    expect(
      view.container.querySelector('[aria-label="Select First"]'),
    ).toBeNull();
    expect(
      view.container
        .querySelector('[aria-label="Select Second"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      view.container
        .querySelector('[aria-label="Select Included"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(dialog).getByRole("heading", { name: "Delete 1 Bot?" }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Second", "Second: Could not delete this Bot. Try again."]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete selected" }),
    );
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(deleted).toEqual(["first", "second", "second"]);
    expect(view.queryByRole("checkbox", { name: "Select Second" })).toBeNull();
    expect(view.getByRole("status").textContent).toBe("1 selected");
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(view.queryByRole("checkbox")).toBeNull();
    expect(view.getByText("Included").closest("a")?.getAttribute("href")).toBe(
      "/bots/included",
    );
    await user.click(view.getByRole("button", { name: "Bots actions" }));
    await user.click(await view.findByRole("menuitem", { name: "Edit list" }));
    expect(view.getByRole("status").textContent).toBe("0 selected");
  } finally {
    release();
    search.mockRestore();
  }
});

test("bulk Hide and Unhide use each Bot's existing rules and preserve other selected Bots", async () => {
  const visible = [
    bot({
      id: "included",
      name: "Included",
      canManage: false,
      mine: false,
      systemOwned: true,
    }),
    bot({ id: "assigned", name: "Assigned", assignedToMe: true }),
    bot({
      id: "protected",
      name: "Protected",
      canManage: false,
      mine: false,
      assignedToMe: true,
    }),
  ];
  const hidden = [bot({ id: "hidden", name: "Hidden Bot", hidden: true })];
  serving(visible, hidden);
  const reads = global.fetch;
  const writes: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method !== "POST") return reads(input, init);
    writes.push(path);
    const [, , , id, action] = path.split("/");
    const source = action === "hide" ? visible : hidden;
    const destination = action === "hide" ? hidden : visible;
    const index = source.findIndex((agent) => agent.id === id);
    if (index < 0)
      return Response.json({ error: "Unknown Bot" }, { status: 404 });
    const [agent] = source.splice(index, 1);
    destination.push({ ...agent, hidden: action === "hide" });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const view = draw(true);
  await view.findByRole("checkbox", { name: "Select Hidden Bot" });
  fireEvent.click(view.getByRole("button", { name: "Select all" }));
  expect(view.getByRole("status").textContent).toBe("3 selected");
  fireEvent.click(view.getByRole("button", { name: "Hide (1)" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("2 selected"),
  );
  expect(
    view
      .getByRole("checkbox", { name: "Select Included" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Unhide (1)" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("1 selected"),
  );
  expect(writes).toEqual([
    "/api/agents/included/hide",
    "/api/agents/hidden/unhide",
  ]);
  expect(
    view
      .getByRole("checkbox", { name: "Select Assigned" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    view
      .getByRole("checkbox", { name: "Select Hidden Bot" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(view.queryByRole("button", { name: /^Hide \(/ })).toBeNull();
  expect(view.queryByRole("button", { name: /^Unhide \(/ })).toBeNull();
});
