import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { computerOwnerRevision } from "@/lib/computers/account-lifecycle";
import { invokeDesktop } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetAt: number | null;
  windowDurationMins: number | null;
};
export type ServiceUsage = {
  id: string;
  provider:
    | "chatgpt"
    | "custom"
    | "codex"
    | "claude"
    | "openai"
    | "anthropic"
    | "google"
    | "xai"
    | "compatible";
  displayName: string;
  status:
    | "available"
    | "not-reported"
    | "sign-in-required"
    | "unavailable"
    | "not-installed"
    | "unsupported";
  source: string;
  accountName: string | null;
  windows: UsageWindow[];
  message: string | null;
  accountUrl: string | null;
};
export type ServiceUsageSnapshot = {
  observedAt: number;
  services: ServiceUsage[];
};
export const serviceUsageKeys = {
  // Account lifecycle cancels/removes computer data when the signed-in actor changes.
  all: ["computers", "service-usage"] as const,
  snapshot: (userId?: string) => [...serviceUsageKeys.all, userId] as const,
};

/** Fresh actor proof on every read. It never enters cached data or mutation arguments. */
export async function readServiceUsage(
  userId: string,
  signal?: AbortSignal,
): Promise<ServiceUsageSnapshot> {
  if (!userId) throw new Error("Sign in to view your OpenBot connections.");
  if (!desktopShell())
    throw new Error("Open Usage in the OpenBot desktop app.");
  const ownerRevision = computerOwnerRevision(queryClient);
  const response = await client(
    "/api/desktop-computers/model-connections/ticket",
    {
      method: "POST",
      body: {},
      signal,
      fallback: "Could not verify your OpenBot connections. Try again.",
    },
  );
  const proof = (await response.json()) as {
    ticket: string;
    expiresAt: number;
  };
  const changed = () =>
    signal?.aborted || computerOwnerRevision(queryClient) !== ownerRevision;
  if (changed())
    throw new Error("Your OpenBot account changed. Open Usage again.");
  const snapshot = await invokeDesktop<ServiceUsageSnapshot>("service_usage", {
    ticket: proof.ticket,
  });
  if (changed())
    throw new Error("Your OpenBot account changed. Open Usage again.");
  return snapshot;
}
export function serviceUsageQueryOptions(open: boolean, userId?: string) {
  return queryOptions({
    queryKey: serviceUsageKeys.snapshot(userId),
    queryFn: ({ signal }): Promise<ServiceUsageSnapshot> =>
      readServiceUsage(userId ?? "", signal),
    enabled: !!desktopShell() && open && !!userId,
    retry: false,
    staleTime: 0,
    refetchInterval: open ? 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
