import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BusinessLink } from "@/components/edition/business-link";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let saved: Map<string, UserPreferences>;
let actor: string;
let failSave: boolean;
let writes: unknown[];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  sessionStorage.clear();
  saved = new Map();
  actor = "alice";
  failSave = false;
  writes = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        writes.push(patch);
        if (failSave)
          return Response.json({ error: "Save failed" }, { status: 500 });
        saved.set(actor, {
          ...DEFAULT_USER_PREFERENCES,
          ...saved.get(actor),
          ...patch,
        });
      }
      return Response.json({
        preferences: saved.get(actor) ?? DEFAULT_USER_PREFERENCES,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
function draw(edition: "personal" | "team", seed = true) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: actor,
    email: `${actor}@example.test`,
    role: "user",
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition,
    transcription: false,
    voice: false,
  });
  if (seed)
    client.setQueryData(
      userPreferencesQueryOptions(actor).queryKey,
      saved.get(actor) ?? DEFAULT_USER_PREFERENCES,
    );
  return render(
    <QueryClientProvider client={client}>
      <BusinessLink />
    </QueryClientProvider>,
  );
}

test("the personal edition links to OpenBot for Business in a new tab", () => {
  const view = draw("personal");
  const link = view.getByRole("link", { name: "Meet OpenBot for Business" });
  expect(link.getAttribute("href")).toBe("https://open.bot/business");
  expect(link.getAttribute("target")).toBe("_blank");
});
test("the team edition shows nothing", () => {
  expect(draw("team").queryByText("Meet OpenBot for Business")).toBeNull();
});
test("Close stays saved across a fresh query cache and new app session, without dismissing another person's offer", async () => {
  const first = draw("personal");
  fireEvent.click(first.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(first.queryByText("Meet OpenBot for Business")).toBeNull(),
  );
  await waitFor(() =>
    expect(saved.get("alice")?.selfHostBannerDismissed).toBe(true),
  );
  expect(writes).toEqual([{ selfHostBannerDismissed: true }]);
  first.unmount();
  sessionStorage.clear();
  const restarted = draw("personal", false);
  // The reloaded account preference, not browser/session state, keeps it closed.
  await waitFor(() =>
    expect(
      clients
        .at(-1)
        ?.getQueryData<UserPreferences>(
          userPreferencesQueryOptions("alice").queryKey,
        )?.selfHostBannerDismissed,
    ).toBe(true),
  );
  expect(restarted.queryByText("Meet OpenBot for Business")).toBeNull();
  restarted.unmount();
  actor = "bob";
  expect(
    await draw("personal", false).findByText("Meet OpenBot for Business"),
  ).toBeTruthy();
});
test("a refused save restores the offer and explains how to retry", async () => {
  failSave = true;
  const view = draw("personal");
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not save your choice. Close it again to retry.",
  );
  expect(view.getByText("Meet OpenBot for Business")).toBeTruthy();
  expect(saved.has("alice")).toBe(false);
  failSave = false;
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(saved.get("alice")?.selfHostBannerDismissed).toBe(true),
  );
});
