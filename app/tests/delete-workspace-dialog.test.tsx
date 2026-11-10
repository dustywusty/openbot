import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { queryClient } from "@/query-client";
import { WorkspaceActions } from "@/components/computers/workspace-actions";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteWorkspaceDialog } from "@/components/computers/delete-workspace-dialog";
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
test("workspace deletion requires the exact name and explains retained conversations", async () => {
  const confirmations: string[] = [];
  const view = render(
    <DeleteWorkspaceDialog
      name="OpenBot project"
      open
      onOpenChange={() => {}}
      onConfirm={(name) => confirmations.push(name)}
      pending={false}
      blockedReason={null}
    />,
  );
  expect(view.getByText(/Your Bots and conversations stay/)).toBeDefined();
  const button = view.getByRole("button", {
    name: "Delete workspace",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.type(view.getByLabelText("Workspace name"), "OpenBot");
  expect(button.disabled).toBe(true);
  await userEvent.type(view.getByLabelText("Workspace name"), " project");
  expect(button.disabled).toBe(false);
  await userEvent.click(button);
  expect(confirmations).toEqual(["OpenBot project"]);
});
test("a native running or active-operation refusal blocks deletion even with the correct name", async () => {
  const confirmations: string[] = [];
  const view = render(
    <DeleteWorkspaceDialog
      name="Project"
      open
      onOpenChange={() => {}}
      onConfirm={(name) => confirmations.push(name)}
      pending={false}
      blockedReason="Stop this VM and finish its active work before deleting it."
    />,
  );
  await userEvent.type(view.getByLabelText("Workspace name"), "Project");
  const button = view.getByRole("button", {
    name: "Delete workspace",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.click(button);
  expect(confirmations).toHaveLength(0);
});

test("the confirmed action deletes only the selected workspace and then leaves its detail page", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return null;
    },
  };
  const root = createRootRoute({ component: Outlet });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <WorkspaceActions
        id="obw-0123456789abcdef"
        name="Project A"
        phase="stopped"
        busy={false}
      />
    ),
  });
  const computers = createRoute({
    getParentRoute: () => root,
    path: "/computers",
    component: () => <p>Computer list</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([detail, computers]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    await view.findByRole("button", { name: "Workspace actions" }),
  );
  await userEvent.click(
    await view.findByRole("menuitem", { name: "Delete workspace…" }),
  );
  expect(calls).toHaveLength(0);
  await userEvent.type(view.getByLabelText("Workspace name"), "Project A");
  await userEvent.click(view.getByRole("button", { name: "Delete workspace" }));
  await view.findByText("Computer list");
  expect(calls).toEqual([
    {
      command: "plugin:openbot-desktop|workspace_delete",
      args: { id: "obw-0123456789abcdef" },
    },
  ]);
});

test("a running workspace cannot open the destructive confirmation", async () => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <WorkspaceActions
          id="obw-0123456789abcdef"
          name="Project A"
          phase="ready"
          busy={false}
        />
      ),
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    await view.findByRole("button", { name: "Workspace actions" }),
  );
  const remove = await view.findByRole("menuitem", {
    name: "Delete workspace…",
  });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(remove);
  expect(view.queryByRole("dialog")).toBeNull();
});
