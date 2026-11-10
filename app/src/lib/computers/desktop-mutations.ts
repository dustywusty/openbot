import {
  parseWorkspaceBot,
  type WorkspaceBot,
} from "@openbot/shared/workspace-bot";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type AgentProfile,
  agentApiPath,
  agentKeys,
} from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { computerOwnerRevision } from "./account-lifecycle";
import { computerActorProof } from "./actor-proof";
import {
  type CodingConversationChoice,
  computerDesktopInvoke,
  type LocalVm,
  type VmRecipe,
  type WorkspaceSkillSnapshot,
} from "./desktop-queries";
import { computerKeys } from "./queries";

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}
export function setCodingBotDefaultsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      agent,
      defaults,
    }: {
      agent: AgentProfile;
      defaults: Pick<WorkspaceBot, "model" | "effort" | "speed" | "permission">;
    }): Promise<AgentProfile> => {
      if (!agent.workspaceBot)
        throw new Error("This Bot does not use a coding harness.");
      const workspaceBot = parseWorkspaceBot({
        workspaceId: agent.workspaceBot.workspaceId,
        runtime: agent.workspaceBot.runtime,
        model: defaults.model,
        effort: defaults.effort,
        speed: defaults.speed,
        permission: defaults.permission,
      });
      return client(agentApiPath(agent.id), "agent", {
        method: "PATCH",
        body: {
          name: agent.name,
          title: agent.title,
          roleDescription: agent.roleDescription,
          visibility: agent.visibility,
          workspaceBot,
        },
        fallback: "Could not save this coding Bot's defaults.",
      });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        invalidateComputers(queryClient),
      ]),
  });
}
export function deleteWorkspaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    // Native code rechecks the selected VM, terminals and worker usage before removal.
    mutationFn: (id: string): Promise<void> =>
      computerDesktopInvoke("workspace_delete", { id }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
export function setBotComputerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      agent,
      computerId,
    }: {
      agent: Pick<
        AgentProfile,
        "id" | "name" | "title" | "roleDescription" | "visibility"
      >;
      computerId: string | null;
    }): Promise<AgentProfile> =>
      client(agentApiPath(agent.id), "agent", {
        method: "PATCH",
        // Managed Bots carry an internal endpoint in their DTO; it is not a caller-supplied URL.
        // Sending it back would reject this valid assignment as an external-agent configuration.
        body: {
          name: agent.name,
          title: agent.title,
          roleDescription: agent.roleDescription,
          visibility: agent.visibility,
          computerId,
        },
        fallback: "Could not change this Bot's project VM.",
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        invalidateComputers(queryClient),
      ]),
  });
}
export function setCodingConversationModelMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async ({
      channelId,
      choice,
    }: {
      channelId: string;
      choice: CodingConversationChoice;
    }): Promise<void> => {
      await client(
        `/api/channels/${encodeURIComponent(channelId)}/desktop-model`,
        {
          method: "PUT",
          body: choice,
          fallback:
            "Could not save the coding model. Your message has not been sent.",
        },
      );
    },
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.conversationModel(variables.channelId),
      }),
  });
}
export function pairDesktopComputerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{ computerId: string; name: string }> => {
      const ownerRevision = computerOwnerRevision(queryClient);
      const response = await client("/api/desktop-computers/pair", {
        method: "POST",
        fallback: "Could not pair this VM with your account.",
      });
      const { ticket } = (await response.json()) as { ticket: string };
      if (computerOwnerRevision(queryClient) !== ownerRevision)
        throw new Error(
          "Your OpenBot account changed. Pair the workspace again.",
        );
      // One-use proof of the signed-in OpenBot account; no model credential crosses the page.
      return computerDesktopInvoke("computer_register", { id, ticket });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}
export function connectComputerChatGptMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    // The native command opens the system browser only for this explicit button action.
    mutationFn: async (
      id: string,
    ): Promise<{ attemptId: string; expiresAt: number }> => {
      const { ticket } = await computerActorProof(id, "start");
      return computerDesktopInvoke("computer_auth_start", { id, ticket });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}
export function allowComputerChatGptMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      const { ticket } = await computerActorProof(id, "allow");
      return computerDesktopInvoke("computer_auth_allow", { id, ticket });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}
export function cancelComputerChatGptMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      id,
      attemptId,
    }: {
      id: string;
      attemptId: string;
    }): Promise<void> => {
      const { ticket } = await computerActorProof(id, "cancel");
      return computerDesktopInvoke("computer_auth_cancel", {
        id,
        ticket,
        attemptId,
      });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}
export function disconnectComputerChatGptMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{
      remoteRevocationConfirmed: boolean;
      warning: string | null;
    }> => {
      const { ticket } = await computerActorProof(id, "logout");
      return computerDesktopInvoke("computer_auth_logout", { id, ticket });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

/** Freeze selected instructions on the server immediately before native creation. */
export function createWorkspaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      recipe,
      slugs,
    }: {
      recipe: VmRecipe;
      slugs: string[];
    }): Promise<LocalVm> => {
      if (slugs.length > 16 || new Set(slugs).size !== slugs.length)
        throw new Error("Choose up to 16 different skills.");
      const skills = slugs.length
        ? await client<WorkspaceSkillSnapshot[]>(
            "/api/desktop-computers/skill-snapshots",
            "skills",
            {
              method: "POST",
              body: { slugs },
              fallback:
                "Could not copy the selected skills. Choose them again and retry.",
            },
          )
        : [];
      return computerDesktopInvoke("workspace_create", {
        recipe: { ...recipe, skills },
      });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

export function disconnectWorkspaceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      const { ticket } = await computerActorProof(id, "disconnect");
      return computerDesktopInvoke("computer_disconnect", { id, ticket });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}
