import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  WorkspaceSkillDetails,
  WorkspaceSkillPicker,
} from "@/components/computers/workspace-skills";
import { createWorkspaceMutationOptions } from "@/lib/computers/desktop-mutations";
import type {
  VmRecipe,
  WorkspaceSkillSnapshot,
} from "@/lib/computers/desktop-queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;
let originalIpc: PropertyDescriptor | undefined;
beforeAll(() => {
  GlobalRegistrator.register();
  originalIpc = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  if (originalIpc)
    Object.defineProperty(window, "__TAURI_INTERNALS__", originalIpc);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const snapshot: WorkspaceSkillSnapshot = {
  id: "skill-one",
  slug: "review-code",
  name: "Review code",
  description: "Check a local change.",
  instructions: "Use the current review instructions.",
  origin: "yours",
  sha256: "b".repeat(64),
};
const recipe: VmRecipe = {
  baseImage: "debian13",
  name: "Project",
  repository: "https://example.com/project.git",
  gitRef: "main",
  resources: { cpus: 2, memoryGib: 4, diskGib: 32 },
  packages: [],
  tools: { codex: null, claude: null },
  setup: [],
  verify: [],
  ports: [],
};
function fetchWith(
  handler: (input: string, init?: RequestInit) => Promise<Response>,
) {
  global.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
}
function Picker() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <WorkspaceSkillPicker
      selected={selected}
      onChange={setSelected}
      disabled={false}
    />
  );
}
function nativeWith(calls: unknown[]) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      transformCallback: () => 1,
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        return {
          id: "obw-0123456789abcdef",
          recipe,
          phase: "created",
          problem: null,
          completed: [],
        };
      },
    },
  });
}

test("skill picker enforces 16 selections and lets a person free a slot", async () => {
  fetchWith(async (url) => {
    expect(url).toBe("/api/desktop-computers/skills");
    return Response.json({
      skills: Array.from({ length: 17 }, (_, index) => ({
        ...snapshot,
        slug: `skill-${index}`,
        name: `Skill ${index}`,
      })),
    });
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Picker />
    </QueryClientProvider>,
  );
  await userEvent.click(view.getByRole("button", { name: "Choose skills" }));
  await view.findByRole("checkbox", { name: "Skill 0" });
  for (let index = 0; index < 16; index++)
    await userEvent.click(
      view.getByRole("checkbox", { name: `Skill ${index}` }),
    );
  expect(view.getByText("16 of 16 selected")).toBeTruthy();
  expect(
    view
      .getByRole("checkbox", { name: "Skill 16" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.click(view.getByRole("checkbox", { name: "Skill 0" }));
  await userEvent.click(view.getByRole("checkbox", { name: "Skill 16" }));
  expect(view.getByText("16 of 16 selected")).toBeTruthy();
  expect(
    view
      .getByRole("checkbox", { name: "Skill 16" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("workspace creation freezes server instructions instead of trusting stale recipe copies", async () => {
  const calls: unknown[] = [];
  nativeWith(calls);
  fetchWith(async (url, init) => {
    expect(url).toBe("/api/desktop-computers/skill-snapshots");
    expect(JSON.parse(String(init?.body))).toEqual({ slugs: [snapshot.slug] });
    return Response.json({ skills: [snapshot] });
  });
  await createWorkspaceMutationOptions(queryClient).mutationFn!(
    {
      recipe: {
        ...recipe,
        skills: [{ ...snapshot, instructions: "Stale local copy" }],
      },
      slugs: [snapshot.slug],
    },
    {} as never,
  );
  expect(calls).toEqual([
    {
      command: "plugin:openbot-desktop|workspace_create",
      args: { recipe: { ...recipe, skills: [snapshot] } },
    },
  ]);
});

test("a disappeared skill refuses creation before any native VM call", async () => {
  const calls: unknown[] = [];
  nativeWith(calls);
  fetchWith(async () =>
    Response.json(
      { error: "That skill is no longer available. Choose skills again." },
      { status: 404 },
    ),
  );
  await expect(
    createWorkspaceMutationOptions(queryClient).mutationFn!(
      { recipe, slugs: [snapshot.slug] },
      {} as never,
    ),
  ).rejects.toThrow("no longer available");
  expect(calls).toEqual([]);
});

test("choosing no skills creates an explicit empty recipe without a server request", async () => {
  const calls: unknown[] = [];
  nativeWith(calls);
  fetchWith(async () => {
    throw new Error("Unexpected server request");
  });
  await createWorkspaceMutationOptions(queryClient).mutationFn!(
    { recipe, slugs: [] },
    {} as never,
  );
  expect(calls).toEqual([
    {
      command: "plugin:openbot-desktop|workspace_create",
      args: { recipe: { ...recipe, skills: [] } },
    },
  ]);
});

test("detail shows the frozen copy and source, not a live skill lookup", async () => {
  fetchWith(async () => {
    throw new Error("Unexpected live skill lookup");
  });
  const view = render(<WorkspaceSkillDetails skills={[snapshot]} />);
  expect(view.getByText(snapshot.name)).toBeTruthy();
  expect(view.getByText(/Copied from yours/)).toBeTruthy();
  expect(view.getByText(/accounts or tool access/)).toBeTruthy();
  await userEvent.click(view.getByText("Copied instructions"));
  expect(view.getByText(snapshot.instructions)).toBeTruthy();
  expect(view.getByText(`SHA-256: ${snapshot.sha256}`)).toBeTruthy();
});
