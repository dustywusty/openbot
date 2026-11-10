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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotComputerAssignment } from "@/components/bot-profile/computer-assignment";
import type { AgentProfile } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

const id = "obw-0123456789abcdef";
const BOT: AgentProfile = {
  id: "reviewer",
  name: "Reviewer",
  title: "Review issues",
  roleDescription: "Review project issues.",
  avatarSeed: "r",
  visibility: "private",
  endpoint: "http://managed-openbot:8000",
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  systemOwned: false,
  canManage: true,
  mine: true,
  canAssignComputer: true,
  computerId: null,
};
const originalFetch = globalThis.fetch;
let writes: Record<string, unknown>[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  writes = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/desktop-computers")
        return Response.json({
          computers: [{ computerId: id, name: "OpenBot project" }],
        });
      if (
        String(input) === "/api/agents/reviewer" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return Response.json({ agent: { ...BOT, ...body } });
      }
      throw new Error(`Unexpected request ${String(input)}`);
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
function draw(agent: AgentProfile) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotComputerAssignment agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
test("an owned Bot can use a paired project VM without resending its managed endpoint", async () => {
  const view = draw(BOT);
  await userEvent.click(
    await view.findByRole("button", { name: /OpenBot home/ }),
  );
  await userEvent.click(await view.findByRole("combobox"));
  await userEvent.click(
    await view.findByRole("option", { name: "OpenBot project" }),
  );
  await userEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    name: BOT.name,
    title: BOT.title,
    roleDescription: BOT.roleDescription,
    visibility: "private",
    computerId: id,
  });
  expect(writes[0]).not.toHaveProperty("endpoint");
});
test("clearing assignment sends null and returns future file actions to OpenBot home", async () => {
  const view = draw({ ...BOT, computerId: id });
  await userEvent.click(
    await view.findByRole("button", { name: /OpenBot project/ }),
  );
  await userEvent.click(await view.findByRole("combobox"));
  await userEvent.click(
    await view.findByRole("option", { name: "OpenBot home" }),
  );
  await userEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.computerId).toBeNull();
});
test("the server edit verdict overrides other profile ownership flags", async () => {
  const view = draw({ ...BOT, canAssignComputer: false });
  await view.findByText("OpenBot home", { selector: "[data-slot=item-title]" });
  expect(view.queryByRole("button", { name: /OpenBot home/ })).toBeNull();
  expect(writes).toHaveLength(0);
});
