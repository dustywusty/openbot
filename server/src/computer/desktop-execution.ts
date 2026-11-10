import { randomUUID } from "node:crypto";
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { currentApprovalContext } from "../approvals/types";
import type { DesktopComputerBroker } from "./desktop-broker";
import type { NativeComputerExecution } from "./gateway";

type Profile = Pick<
  AgentProfile,
  "ownerUserId" | "visibility" | "systemOwned" | "workspaceBot" | "computerId"
>;

/** The gateway calls execute only after its policy, approval and audit steps permit an action. */
export function createDesktopComputerExecution(options: {
  profiles: {
    get: (actor: AgentActor, botId: string) => Promise<Profile | null>;
  };
  broker: Pick<DesktopComputerBroker, "ownerOf" | "dispatch">;
  /** Only isolated seats need the Bot's private owner instead of the person's seat identity. */
  botOwnership: (
    botId: string,
  ) => Promise<{ ownerUserId: string | null } | null>;
  context?: () => { threadId?: string; runId?: string } | undefined;
  now?: () => number;
  newId?: () => string;
}): NativeComputerExecution {
  const context = options.context ?? currentApprovalContext;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  return {
    async resolve(seat, actor) {
      // The personal browser has no Bot profile and never uses a project VM.
      if (isPersonBrowserId(seat.botId)) return null;
      const personId =
        actor?.id ??
        (seat.key.kind === "person"
          ? seat.key.personId
          : (await options.botOwnership(seat.botId))?.ownerUserId);
      if (!personId)
        throw new Error("That Bot's computer owner could not be resolved.");
      if (actor && seat.key.kind === "person" && actor.id !== seat.key.personId)
        throw new Error("That Computer is not available to this person.");
      const profile = await options.profiles.get(
        { id: personId, role: "user" },
        seat.botId,
      );
      if (!profile) throw new Error("That Bot is not available to you.");
      const computerId =
        profile.workspaceBot?.workspaceId ?? profile.computerId;
      if (!computerId) return null;
      if (
        !/^obw-[a-f0-9]{16}$/.test(computerId) ||
        profile.ownerUserId !== personId ||
        profile.visibility !== "private" ||
        profile.systemOwned ||
        options.broker.ownerOf(computerId) !== personId
      ) {
        throw new Error(
          "This Bot's VM is not connected to your desktop. Pair it in Computers and try again.",
        );
      }
      return { computerId };
    },
    async execute(input) {
      const started = now();
      const run = context();
      let stdout = "";
      let stderr = "";
      const operation = await options.broker.dispatch({
        actorId: input.actor.id,
        botId: input.botId,
        computerId: input.computerId,
        threadId: run?.threadId ?? `computer-${newId()}`,
        runId: run?.runId ?? newId(),
        action: input.action,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        onEvent(event) {
          if (event.type !== "output") return;
          if (event.stream === "stdout") stdout += event.text;
          if (event.stream === "stderr") stderr += event.text;
        },
      });
      const completed = await operation.completion;
      return {
        result: completed.result,
        exitCode: completed.exitCode,
        stdout,
        stderr,
        elapsedMs: now() - started,
      };
    },
  };
}
