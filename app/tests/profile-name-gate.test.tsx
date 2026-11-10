import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileNameGate } from "@/components/settings/profile-name-gate";
import { authKeys, type AuthenticatedUser } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const legacy: AuthenticatedUser = {
  id: "existing-user",
  email: "dev@openbot.local",
  name: "dev@openbot.local",
  needsName: true,
  role: "admin",
  onboarding: { step: 0, completedAt: "2026-09-26T11:46:43.011Z" },
};

function draw(user: AuthenticatedUser) {
  queryClient.setQueryData(authKeys.currentUser(), user);
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfileNameGate>
        <p>The original destination</p>
      </ProfileNameGate>
    </QueryClientProvider>,
  );
}

test("an existing completed installation gets only the missing name step, then resumes its destination", async () => {
  let current = legacy;
  const requests: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (path.endsWith("/api/me/profile")) {
        current = { ...legacy, name: "Taylor", needsName: false };
        return Response.json({
          profile: { name: current.name, needsName: false },
        });
      }
      if (path.endsWith("/api/me")) return Response.json({ user: current });
      throw new Error(`Unexpected request: ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw(legacy);
  expect(
    view.getByRole("heading", { name: "What should we call you?" }),
  ).toBeTruthy();
  expect(view.queryByText("The original destination")).toBeNull();
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  await userEvent
    .setup({ document })
    .type(view.getByLabelText("Name"), "Taylor");
  fireEvent.click(view.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(view.getByText("The original destination")).toBeTruthy(),
  );
  expect(requests.find((request) => request.method === "PATCH")).toEqual({
    path: "/api/me/profile",
    method: "PATCH",
    body: { name: "Taylor" },
  });
  expect(requests.some((request) => request.path.includes("onboarding"))).toBe(
    false,
  );
  expect(
    queryClient.getQueryData<AuthenticatedUser>(authKeys.currentUser()),
  ).toMatchObject({
    id: legacy.id,
    email: legacy.email,
    name: "Taylor",
    needsName: false,
    onboarding: legacy.onboarding,
  });
});

test("a saved name enters the requested screen without another prompt", () => {
  const view = draw({ ...legacy, name: "Taylor", needsName: false });
  expect(view.getByText("The original destination")).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Name" })).toBeNull();
});

test("unfinished onboarding retains its existing name step", () => {
  const view = draw({ ...legacy, onboarding: { step: 1, completedAt: null } });
  expect(view.getByText("The original destination")).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Name" })).toBeNull();
});
