import { expect, test } from "bun:test";
import { desktopComputerAction } from "./desktop-computer";
import { parseWorkspaceBot } from "./workspace-bot";

const bot = { workspaceId: "obw-0123456789abcdef", runtime: "codex" } as const;
const action = {
  kind: "harness_turn",
  runtime: "codex",
  prompt: "Work on the project.",
} as const;

test("VM full access is an explicit saved Bot permission, alongside unchanged read and write modes", () => {
  for (const permission of [
    "read-only",
    "workspace-write",
    "vm-full-access",
  ] as const) {
    expect(parseWorkspaceBot({ ...bot, permission })).toEqual({
      ...bot,
      permission,
      model: null,
      effort: null,
      speed: null,
    });
    expect(desktopComputerAction.parse({ ...action, permission })).toEqual({
      ...action,
      permission,
    });
  }
});

test("missing permission and internal or host-wide sandbox names cannot opt a Bot into VM full access", () => {
  for (const permission of [
    undefined,
    null,
    "danger-full-access",
    "host-full-access",
    "full-access",
    true,
  ]) {
    expect(() => parseWorkspaceBot({ ...bot, permission })).toThrow(
      "permissions",
    );
    expect(
      desktopComputerAction.safeParse({ ...action, permission }).success,
    ).toBe(false);
  }
});

test("full VM permission does not allow credentials or arbitrary host fields onto the job protocol", () => {
  for (const extra of [
    { accessToken: "fixture-not-a-real-token" },
    { hostPath: "/Users/owner/project" },
    { sandbox: "danger-full-access" },
  ]) {
    expect(
      desktopComputerAction.safeParse({
        ...action,
        permission: "vm-full-access",
        ...extra,
      }).success,
    ).toBe(false);
  }
});
