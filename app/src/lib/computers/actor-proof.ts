import { client } from "@/lib/client";
import { queryClient } from "@/query-client";
import { computerOwnerRevision } from "./account-lifecycle";

export type ComputerActorPurpose =
  | "status"
  | "start"
  | "allow"
  | "cancel"
  | "logout"
  | "disconnect";
type ActorProof = {
  paired: boolean;
  canDisconnect?: boolean;
  ticket: string | null;
  expiresAt: number | null;
};

/** Each proof is used once by native IPC; it never enters query data or mutation variables. */
export async function computerActorProof(
  id: string,
  purpose: ComputerActorPurpose,
  signal?: AbortSignal,
): Promise<ActorProof> {
  const ownerRevision = computerOwnerRevision(queryClient);
  const response = await client(
    `/api/desktop-computers/${encodeURIComponent(id)}/actor-ticket`,
    {
      method: "POST",
      body: { purpose },
      signal,
      fallback: "Could not verify your workspace connection. Try again.",
    },
  );
  const proof = (await response.json()) as ActorProof;
  if (signal?.aborted || computerOwnerRevision(queryClient) !== ownerRevision)
    throw new Error(
      "Your OpenBot account changed. Try the workspace action again.",
    );
  if (purpose !== "status" && !proof.ticket)
    throw new Error("Pair this workspace with your OpenBot account first.");
  return proof;
}
