import { describe, expect, test } from "bun:test";
import {
  SETTINGS_SIDEBAR_ITEMS,
  settingsSidebarItems,
} from "../src/components/settings/settings-sidebar";

describe("settings sidebar", () => {
  test("Browsers links to /settings/browsers, right after Approvals", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const browsers = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Browsers")];

    expect(browsers?.linkOptions).toEqual({ to: "/settings/browsers" });
    expect(titles.indexOf("Browsers")).toBe(titles.indexOf("Approvals") + 1);
  });

  test("Learning links to /settings/learning, right after Browsers", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const learning = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("Learning")];

    expect(learning?.linkOptions).toEqual({ to: "/settings/learning" });
    expect(titles.indexOf("Learning")).toBe(titles.indexOf("Browsers") + 1);
  });
});

test("computer controls have one destination under Computers", () => {
  expect(
    SETTINGS_SIDEBAR_ITEMS.some(
      (item) =>
        item.title === "This computer" ||
        item.linkOptions.to === "/settings/this-computer",
    ),
  ).toBe(false);
  expect(
    settingsSidebarItems("personal").find((item) => item.title === "Computers")
      ?.linkOptions,
  ).toEqual({ to: "/computers" });
});
