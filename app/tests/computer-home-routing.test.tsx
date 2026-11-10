import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { renderHomeComputerPage } from "./home-computer.fixture";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
test("home computer controls return to Computers instead of opening a Settings sidebar", async () => {
  const view = renderHomeComputerPage();
  const back = await view.findByRole("button", { name: "Computers" });
  expect(back.getAttribute("href")).toBe("/computers");
  fireEvent.click(back);
  await view.findByText("Computers overview");
  expect(view.router.state.location.pathname).toBe("/computers");
});
test("the old Settings address redirects to the same Computer home page", async () => {
  const view = renderHomeComputerPage("/settings/this-computer");
  await view.findByRole("heading", { name: "This Mac" });
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe("/computers/home"),
  );
  expect(
    view.getByRole("button", { name: "Computers" }).getAttribute("href"),
  ).toBe("/computers");
});
