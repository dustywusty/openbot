import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";
import { synchronizeComputerOwner } from "./account-lifecycle";
import { computerKeys } from "./queries";

/** Reconnection refreshes model settings; it never grants a model account to a VM. */
export function ComputerAccountSync() {
  useEffect(() => {
    const current = queryClient.getQueryData<AuthenticatedUser | null>(
      authKeys.currentUser(),
    );
    if (current !== undefined)
      void synchronizeComputerOwner(queryClient, current?.id ?? null);
    const stopAccount = queryClient
      .getQueryCache()
      .subscribe(({ query, type }) => {
        if (type !== "updated") return;
        if (
          JSON.stringify(query.queryKey) !==
          JSON.stringify(authKeys.currentUser())
        )
          return;
        const user = query.state.data as AuthenticatedUser | null | undefined;
        if (user !== undefined)
          void synchronizeComputerOwner(queryClient, user?.id ?? null);
      });
    let disposed = false;
    let stopEvent: (() => void) | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    if (desktopShell())
      void listen<{ computerId: string }>(
        "computer-pairing-changed",
        ({ payload }) => {
          if (
            disposed ||
            !payload ||
            !/^obw-[a-f0-9]{16}$/.test(payload.computerId) ||
            refresh
          )
            return;
          refresh = setTimeout(() => {
            refresh = undefined;
            void queryClient.invalidateQueries({ queryKey: computerKeys.all });
          }, 100);
        },
      )
        .then((stop) => {
          if (disposed) stop();
          else stopEvent = stop;
        })
        .catch(() => {});
    return () => {
      disposed = true;
      stopAccount();
      stopEvent?.();
      if (refresh) clearTimeout(refresh);
    };
  }, []);
  return null;
}
