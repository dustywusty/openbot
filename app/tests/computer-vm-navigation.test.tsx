import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  showComputerView,
  takeRequestedView,
  useOpenComputerOnRequest,
} from "@/lib/computers/panel-view";
import { assignedVm, computerDetailSearch } from "@/lib/computers/vm-target";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("ordinary and coding Bots resolve the same native workspace destination", () => {
  expect(assignedVm({ computerId: "ordinary-vm" })).toBe("ordinary-vm");
  expect(assignedVm({ workspaceBot: { workspaceId: "coding-vm" } })).toBe(
    "coding-vm",
  );
  expect(
    assignedVm({
      computerId: "assigned-vm",
      workspaceBot: { workspaceId: "older-vm" },
    }),
  ).toBe("assigned-vm");
  expect(assignedVm({ computerId: null })).toBeUndefined();
  expect(assignedVm(undefined)).toBeUndefined();
});

test("detail search accepts shell navigation and discards unknown views", () => {
  expect(computerDetailSearch.parse({ view: "shell" })).toEqual({
    view: "shell",
  });
  expect(computerDetailSearch.parse({ view: "terminal" }).view).toBeUndefined();
  expect(computerDetailSearch.parse({ view: ["shell"] }).view).toBeUndefined();
  expect(computerDetailSearch.parse({}).view).toBeUndefined();
});

test("terminal requests retain the requested view and Bot identity across rerenders", () => {
  const opened: string[] = [];
  const hook = renderHook(
    ({ bot }: { bot: string }) =>
      useOpenComputerOnRequest(bot, (view) => {
        opened.push(`${bot}:${view}`);
      }),
    { initialProps: { bot: "native-bot" } },
  );
  act(() => {
    showComputerView("other-bot", "terminal");
    showComputerView("native-bot", "terminal");
  });
  expect(opened).toEqual(["native-bot:terminal"]);
  hook.rerender({ bot: "next-bot" });
  act(() => {
    showComputerView("native-bot", "screen");
    showComputerView("next-bot", "screen");
  });
  expect(opened).toEqual(["native-bot:terminal", "next-bot:screen"]);
  for (const id of ["other-bot", "native-bot", "next-bot"])
    takeRequestedView(id);
});
