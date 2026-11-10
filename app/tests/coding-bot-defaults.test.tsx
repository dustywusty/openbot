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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodingDefaultsSection } from "@/components/bot-profile/coding-defaults";
import type { AgentProfile } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { computerKeys } from "@/lib/computers/queries";

const id = "obw-0123456789abcdef";
const BOT: AgentProfile = {
  id: "coding",
  name: "Coding",
  title: "Codex",
  roleDescription: "Work locally.",
  avatarSeed: "c",
  visibility: "private",
  endpoint: null,
  builtIn: false,
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
  canEditCodingDefaults: true,
  computerId: id,
  workspaceBot: {
    workspaceId: id,
    runtime: "codex",
    model: "sol",
    effort: "high",
    speed: "fast",
    permission: "workspace-write",
  },
};
const originalFetch = globalThis.fetch;
let writes: Record<string, unknown>[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  writes = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe("plugin:openbot-desktop|workspace_models");
      expect(args).toEqual({ id });
      return [
        {
          id: "sol",
          model: "sol",
          displayName: "Sol",
          description: "Strong",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "low",
          serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
          defaultServiceTier: null,
        },
        {
          id: "luna",
          model: "luna",
          displayName: "Luna",
          description: "Quick",
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
          ],
          defaultReasoningEffort: "low",
          serviceTiers: [],
          defaultServiceTier: null,
        },
      ];
    },
  };
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("/api/agents/coding");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      return Response.json({ agent: { ...BOT, ...body } });
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
test("saving coding defaults preserves the harness and VM and clamps unsupported effort and speed", async () => {
  const conversationKey = computerKeys.conversationModel("existing-channel");
  queryClient.setQueryData(conversationKey, {
    choice: { model: "sol", effort: "high", speed: "fast" },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CodingDefaultsSection agent={BOT} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    view.getByRole("button", { name: /Model, effort, and access/ }),
  );
  await userEvent.click(await view.findByRole("combobox", { name: "Model" }));
  await userEvent.click(await view.findByRole("option", { name: "Luna" }));
  await userEvent.click(view.getByRole("combobox", { name: "VM permissions" }));
  await userEvent.click(await view.findByRole("option", { name: "Read only" }));
  await userEvent.click(view.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    name: BOT.name,
    title: BOT.title,
    roleDescription: BOT.roleDescription,
    visibility: "private",
    workspaceBot: {
      workspaceId: id,
      runtime: "codex",
      model: "luna",
      effort: "low",
      speed: "standard",
      permission: "read-only",
    },
  });
  expect(writes[0]).not.toHaveProperty("endpoint");
  await waitFor(() =>
    expect(queryClient.getQueryState(conversationKey)?.isInvalidated).toBe(
      true,
    ),
  );
});
test("the native edit verdict controls access to coding settings", () => {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CodingDefaultsSection agent={{ ...BOT, canEditCodingDefaults: false }} />
    </QueryClientProvider>,
  );
  expect(
    view.queryByRole("button", { name: /Model, effort, and access/ }),
  ).toBeNull();
  expect(writes).toHaveLength(0);
});

test("full VM access is an explicit saved choice scoped to the existing VM", async () => {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CodingDefaultsSection agent={BOT} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    view.getByRole("button", { name: /Model, effort, and access/ }),
  );
  const permissions = await view.findByRole("combobox", {
    name: "VM permissions",
  });
  expect(permissions.textContent).toContain("Read and edit project files");
  await userEvent.click(permissions);
  await userEvent.click(
    await view.findByRole("option", { name: "Full access inside VM" }),
  );
  expect(
    view.getByText(
      /Allows system package installation, Git operations, and commands throughout this VM/,
    ),
  ).toBeDefined();
  await userEvent.click(view.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.workspaceBot).toEqual({
    ...BOT.workspaceBot,
    permission: "vm-full-access",
  });
  expect(BOT.workspaceBot?.permission).toBe("workspace-write");
  expect(writes[0]).not.toHaveProperty("endpoint");
});
