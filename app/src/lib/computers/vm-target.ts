import { z } from "zod";

/** Native and ordinary Bots share the same assigned VM destination. */
export function assignedVm(
  profile:
    | {
        computerId?: string | null;
        workspaceBot?: { workspaceId: string } | null;
      }
    | undefined,
): string | undefined {
  return profile?.computerId ?? profile?.workspaceBot?.workspaceId ?? undefined;
}

export const computerDetailSearch = z.object({
  view: z.enum(["setup", "shell"]).optional().catch(undefined),
});
