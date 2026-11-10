import type { QueryClient } from "@tanstack/react-query";
import { computerKeys } from "./queries";

const owners = new WeakMap<QueryClient, string | null>();
const revisions = new WeakMap<QueryClient, number>();
export function computerOwnerRevision(queryClient: QueryClient): number {
  return revisions.get(queryClient) ?? 0;
}
/** Drop another account's status before its successor can render cached native identity. */
export function synchronizeComputerOwner(
  queryClient: QueryClient,
  owner: string | null,
): Promise<void> {
  if (owners.has(queryClient) && owners.get(queryClient) === owner)
    return Promise.resolve();
  owners.set(queryClient, owner);
  revisions.set(queryClient, computerOwnerRevision(queryClient) + 1);
  const cancelled = queryClient.cancelQueries({ queryKey: computerKeys.all });
  queryClient.removeQueries({ queryKey: computerKeys.all });
  return cancelled;
}
