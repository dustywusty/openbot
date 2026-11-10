import { queryOptions } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { client } from "@/lib/client";
import { desktopShell } from "@/lib/desktop/shell";
import type { ModelCatalogue } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { computerOwnerRevision } from "./account-lifecycle";
import { computerActorProof } from "./actor-proof";
import { computerKeys } from "./queries";

export type WorkspaceSkillOption = {
  id: string;
  slug: string;
  name: string;
  description: string;
  origin: string;
};
export type WorkspaceSkillSnapshot = WorkspaceSkillOption & {
  instructions: string;
  sha256: string;
};
/** The server returns only skills this person can copy to a workspace. */
export function workspaceSkillsQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: computerKeys.workspaceSkills(),
    queryFn: (): Promise<WorkspaceSkillOption[]> =>
      client("/api/desktop-computers/skills", "skills", {
        fallback: "Could not list skills for this workspace.",
      }),
    enabled,
  });
}

export type VmRecipe = {
  baseImage: "debian13" | "ubuntu2404";
  name: string;
  repository: string;
  gitRef: string;
  resources: { cpus: number; memoryGib: number; diskGib: number };
  packages: string[];
  skills?: WorkspaceSkillSnapshot[];
  tools: { codex: string | null; claude: string | null };
  setup: string[];
  verify: string[];
  ports: { guest: number; host: number }[];
};
export type LocalVm = {
  id: string;
  recipe: VmRecipe;
  phase: string;
  problem: string | null;
  completed: string[];
};
/** All ownership/grant verdicts come from the native worker, never inferred in React. */
export type ComputerAuthStatus = {
  /** Current OpenBot user may revoke the saved workspace connection, even while offline. */
  canDisconnect?: boolean;
  connected: boolean;
  pending: boolean;
  paired: boolean;
  allowed: boolean;
  canAllow: boolean;
  attemptId: string | null;
  accountName: string | null;
  email: string | null;
  expiresAt: number | null;
  error: string | null;
};
export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  serviceTiers: { id: string; name: string; description: string }[];
  defaultServiceTier: string | null;
};

export type CodingConversationChoice = {
  model: string | null;
  effort: string | null;
  speed: "standard" | "fast" | null;
};
export type PairedDesktopVm = { computerId: string; name: string };
/** The authenticated server returns only VMs paired with the signed-in person's account. */
export function pairedDesktopVmsQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.pairedDesktopVms(),
    queryFn: (): Promise<PairedDesktopVm[]> =>
      client("/api/desktop-computers", "computers", {
        fallback: "Could not list your paired project VMs.",
      }),
    staleTime: 10_000,
  });
}
export type CodingConversationModel = {
  catalogue: ModelCatalogue;
  /** The server resolves conversation overrides against the Bot's saved defaults. */
  choice: CodingConversationChoice;
};
export function codingConversationModelQueryOptions(
  channelId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: computerKeys.conversationModel(channelId),
    queryFn: async (): Promise<CodingConversationModel> =>
      (
        await client(
          `/api/channels/${encodeURIComponent(channelId)}/desktop-model`,
          {
            fallback:
              "Could not read this coding conversation's model. Check that its VM is running.",
          },
        )
      ).json(),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Native IPC failures are strings; queries expose normal Error objects like the API client. */
export async function computerDesktopInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktopShell())
    throw new Error("Open this Computer in OpenBot Desktop.");
  try {
    return await invoke<T>(`plugin:openbot-desktop|${command}`, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}
export function localVmsQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.localVms(),
    queryFn: (): Promise<LocalVm[]> => computerDesktopInvoke("workspace_list"),
    enabled: !!desktopShell(),
    refetchInterval: 3000,
  });
}
export function computerAuthQueryOptions(id: string) {
  return queryOptions({
    queryKey: computerKeys.desktopAuth(id),
    queryFn: async ({ signal }): Promise<ComputerAuthStatus> => {
      const ownerRevision = computerOwnerRevision(queryClient);
      const proof = await computerActorProof(id, "status", signal);
      if (!proof.paired || !proof.ticket)
        return {
          canDisconnect: proof.canDisconnect === true,
          connected: false,
          pending: false,
          paired: false,
          allowed: false,
          canAllow: false,
          attemptId: null,
          accountName: null,
          email: null,
          expiresAt: null,
          error: null,
        };
      const status = await computerDesktopInvoke<ComputerAuthStatus>(
        "computer_auth_status",
        {
          id,
          ticket: proof.ticket,
        },
      );
      if (
        signal?.aborted ||
        computerOwnerRevision(queryClient) !== ownerRevision
      )
        throw new Error(
          "Your OpenBot account changed. Try the workspace action again.",
        );
      return { ...status, canDisconnect: proof.canDisconnect === true };
    },
    enabled: !!desktopShell(),
    // Polling completes the native consent intent while the user signs in in their browser.
    refetchInterval: 2000,
    retry: false,
  });
}
export function computerModelsQueryOptions(id: string, ready: boolean) {
  return queryOptions({
    queryKey: computerKeys.desktopModels(id),
    queryFn: (): Promise<CodexModel[]> =>
      computerDesktopInvoke("workspace_models", { id }),
    enabled: !!desktopShell() && ready,
    staleTime: 60_000,
    retry: false,
  });
}
