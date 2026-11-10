import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodingModelPicker } from "@/components/channels/composer/coding-model-picker";
import type { useCodingConversationModel } from "@/lib/computers/coding-run-model";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const vmId = "obw-0123456789abcdef";
function picker(error: string, retry: () => void) {
  const model: ReturnType<typeof useCodingConversationModel> = {
    catalogue: undefined,
    value: undefined,
    speed: "standard",
    speeds: ["standard"],
    saving: false,
    error: new Error(error),
    retry: async () => {
      retry();
      return {} as never;
    },
    beforeSend: async () => {},
    choose: () => {},
    chooseSpeed: () => {},
  };
  const root = createRootRoute({ component: Outlet });
  const chat = createRoute({
    path: "/",
    getParentRoute: () => root,
    component: () => <CodingModelPicker model={model} workspaceId={vmId} />,
  });
  const workspace = createRoute({
    path: "/computers/$computerId",
    getParentRoute: () => root,
    component: () => <p>Workspace opened</p>,
  });
  return render(
    <RouterProvider
      router={createRouter({
        routeTree: root.addChildren([chat, workspace]),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      })}
    />,
  );
}

test("a disconnected model picker shows its error and opens the specific Bot workspace", async () => {
  const view = picker(
    "Reconnect this workspace in Computers, then retry.",
    () => {},
  );
  const error = await view.findByRole("alert");
  expect(error.textContent).toBe(
    "Reconnect this workspace in Computers, then retry.",
  );
  expect(view.queryByText(/Check that this workspace/)).toBeNull();
  const open = view.getByRole("button", { name: "Open workspace" });
  expect(open.getAttribute("href")).toBe(`/computers/${vmId}`);
  await userEvent.click(open);
  expect(await view.findByText("Workspace opened")).toBeTruthy();
});

test("retry remains available while the actual server failure is visible", async () => {
  let retries = 0;
  const view = picker("Couldn't reach the coding VM's model settings.", () => {
    retries += 1;
  });
  await userEvent.click(
    await view.findByRole("button", { name: "Retry model picker" }),
  );
  expect(retries).toBe(1);
  expect(view.getByRole("alert").textContent).toBe(
    "Couldn't reach the coding VM's model settings.",
  );
});
