import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { UsageServiceRow } from "@/components/service-usage/usage-monitor";
import { synchronizeComputerOwner } from "@/lib/computers/account-lifecycle";
import {
  observedLabel,
  reportedUsedPercent,
  resetLabel,
} from "@/lib/service-usage/format";
import {
  readServiceUsage,
  type ServiceUsage,
  serviceUsageKeys,
  serviceUsageQueryOptions,
} from "@/lib/service-usage/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const service: ServiceUsage = {
  id: "coding-chatgpt",
  accountUrl: "https://chatgpt.com/settings/usage",
  provider: "codex",
  displayName: "Codex",
  source: "ChatGPT for VM coding",
  status: "available",
  accountName: "test@example.invalid",
  message: null,
  windows: [
    {
      id: "primary",
      label: "5-hour allowance",
      usedPercent: 0,
      resetAt: 7200,
      windowDurationMins: 300,
    },
  ],
};

test("zero used is measured, while missing or invalid quota stays unknown", () => {
  expect(reportedUsedPercent(100)).toBe(100);
  expect(reportedUsedPercent(0)).toBe(0);
  for (const value of [null, undefined, NaN, Infinity, -1, 101])
    expect(reportedUsedPercent(value)).toBeNull();
});
test("reset labels use the actual duration until reset, not the quota window", () => {
  expect(resetLabel(7200, 3600)).toBe("Resets in 1h");
  expect(resetLabel(7200, 7190)).toBe("Resets in less than a minute");
  expect(resetLabel(7200, 7200)).toContain("refresh");
  expect(resetLabel(null, 0)).toBe("Reset time not reported");
  expect(observedLabel(100, 400)).toBe("Updated 5m ago · May be out of date");
});
test("an unused allowance renders zero and its reset without hiding the account source", () => {
  const view = render(<UsageServiceRow service={service} now={3600} />);
  expect(view.getByText("0% used")).toBeTruthy();
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  expect(view.getByText("Resets in 1h")).toBeTruthy();
  expect(view.getByText("ChatGPT for VM coding")).toBeTruthy();
  expect(view.getByText("test@example.invalid")).toBeTruthy();
  expect(view.getByRole("link").getAttribute("href")).toContain(
    "chatgpt.com/settings/usage",
  );
});
test("reported percentages keep accessible bounds and exact values through a full allowance", () => {
  const view = render(
    <UsageServiceRow
      service={{
        ...service,
        windows: [{ ...service.windows[0]!, usedPercent: 71 }],
      }}
      now={3600}
    />,
  );
  const bar = view.getByRole("progressbar", { name: "5-hour allowance used" });
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("100");
  expect(bar.getAttribute("aria-valuenow")).toBe("71");
  expect(bar.getAttribute("aria-valuetext")).toBe("71% used");
  view.rerender(
    <UsageServiceRow
      service={{
        ...service,
        windows: [{ ...service.windows[0]!, usedPercent: 100 }],
      }}
      now={3600}
    />,
  );
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "100",
  );
  expect(view.getByText("100% used")).toBeTruthy();
});

test("unsupported services show their status without invented quota bars", () => {
  const view = render(
    <UsageServiceRow
      service={{
        ...service,
        provider: "claude",
        displayName: "Claude Code",
        accountUrl: "https://claude.ai/settings/usage",
        status: "unsupported",
        windows: [],
        accountName: null,
      }}
      now={3600}
    />,
  );
  expect(view.getByText("Usage not supported")).toBeTruthy();
  expect(view.queryByRole("progressbar")).toBeNull();
  expect(view.queryByText("0% used")).toBeNull();
  expect(view.getByRole("link").getAttribute("href")).toBe(
    "https://claude.ai/settings/usage",
  );
});
test("unknown quota renders no meter even when a window exists", () => {
  const view = render(
    <UsageServiceRow
      service={{
        ...service,
        windows: [{ ...service.windows[0]!, usedPercent: null, resetAt: null }],
      }}
      now={3600}
    />,
  );
  expect(view.getByText("Not reported")).toBeTruthy();
  expect(view.getByText("Reset time not reported")).toBeTruthy();
  expect(view.queryByRole("progressbar")).toBeNull();
});
test("usage reads are disabled outside desktop and never poll in the background", () => {
  const options = serviceUsageQueryOptions(false);
  expect(options.enabled).toBe(false);
  expect(options.refetchInterval).toBe(false);
  expect(options.refetchIntervalInBackground).toBe(false);
});

test("Usage sends only a fresh OpenBot actor proof to native, without host CLI discovery", async () => {
  const originalFetch = globalThis.fetch;
  const previous = Object.getOwnPropertyDescriptor(
    window,
    "__TAURI_INTERNALS__",
  );
  const calls: { command: string; args: unknown }[] = [];
  const requests: { path: string; body: unknown }[] = [];
  let next = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), body: init?.body });
      return Response.json({ ticket: `proof-${++next}`, expiresAt: 100 });
    },
    { preconnect: originalFetch.preconnect },
  );
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      transformCallback: () => 1,
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        return {
          observedAt: 100,
          services: [
            {
              ...service,
              source: "Coding Bots",
              windows: [],
              status: "not-reported",
            },
          ],
        };
      },
    },
  });
  try {
    const snapshot = await readServiceUsage("alice");
    expect(snapshot.services[0]?.source).toBe("Coding Bots");
    expect(snapshot.services[0]?.windows).toEqual([]);
    await readServiceUsage("alice");
    expect(requests).toEqual(
      [1, 2].map(() => ({
        path: "/api/desktop-computers/model-connections/ticket",
        body: "{}",
      })),
    );
    expect(calls).toEqual(
      [1, 2].map((n) => ({
        command: "plugin:openbot-desktop|service_usage",
        args: { ticket: `proof-${n}` },
      })),
    );
    expect(serviceUsageKeys.snapshot("alice")).not.toEqual(
      serviceUsageKeys.snapshot("bob"),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      readServiceUsage("alice", controller.signal),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous)
      Object.defineProperty(window, "__TAURI_INTERNALS__", previous);
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});

test("an account switch discards an already running native account read", async () => {
  const originalFetch = globalThis.fetch;
  const previous = Object.getOwnPropertyDescriptor(
    window,
    "__TAURI_INTERNALS__",
  );
  const pending = Promise.withResolvers<unknown>();
  const called = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(
    async () => Response.json({ ticket: "fresh", expiresAt: 100 }),
    { preconnect: originalFetch.preconnect },
  );
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      transformCallback: () => 1,
      invoke: () => {
        called.resolve();
        return pending.promise;
      },
    },
  });
  try {
    await synchronizeComputerOwner(queryClient, "alice");
    const read = readServiceUsage("alice");
    await called.promise;
    await synchronizeComputerOwner(queryClient, "bob");
    pending.resolve({ observedAt: 100, services: [service] });
    await expect(read).rejects.toThrow("account changed");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous)
      Object.defineProperty(window, "__TAURI_INTERNALS__", previous);
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});

test("native inventory renders distinct OpenBot and coding connections and provider usage links", () => {
  // Exact serialized renderer contract, also asserted by native provider_usage.rs tests.
  const rows: ServiceUsage[] = JSON.parse(
    `[{"id":"installation-ai","accountUrl":"https://chatgpt.com/settings/usage","provider":"chatgpt","displayName":"ChatGPT plan","status":"not-reported","source":"OpenBot AI","accountName":null,"windows":[],"message":"Configured for OpenBot. This connection does not provide a supported quota report."},{"id":"coding-chatgpt","accountUrl":"https://chatgpt.com/settings/usage","provider":"chatgpt","displayName":"ChatGPT","status":"not-reported","source":"Coding Bots","accountName":"owner@example.test","windows":[],"message":"Saved ChatGPT sign-in for your OpenBot account. Quota is not provided by this connection; manage usage in ChatGPT settings."}]`,
  );
  const view = render(
    rows.map((row) => <UsageServiceRow key={row.id} service={row} now={100} />),
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(view.getByText("OpenBot AI")).toBeTruthy();
  expect(view.getByText("Coding Bots")).toBeTruthy();
  expect(
    view.getAllByRole("link").map((link) => link.getAttribute("href")),
  ).toEqual([
    "https://chatgpt.com/settings/usage",
    "https://chatgpt.com/settings/usage",
  ]);
  expect(view.queryByRole("progressbar")).toBeNull();
  const first = rows[0];
  if (!first) throw new Error("Missing fixture");
  view.rerender(
    <UsageServiceRow
      service={{
        ...first,
        provider: "openai",
        displayName: "OpenAI API",
        accountUrl: null,
      }}
      now={100}
    />,
  );
  expect(view.queryByRole("link")).toBeNull();
});
