import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { serviceUsageKeys } from "./queries";

export function refreshServiceUsageMutationOptions(
  queryClient: QueryClient,
  userId?: string,
) {
  return mutationOptions({
    mutationFn: async () => {
      if (!userId) throw new Error("Sign in to view your OpenBot connections.");
      // The active observer performs one fresh, actor-authorized read.
      await queryClient.invalidateQueries({
        queryKey: serviceUsageKeys.snapshot(userId),
      });
    },
  });
}
