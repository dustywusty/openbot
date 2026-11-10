/** Saved in the Bot's configuration. Credentials never belong in this object. */
export type WorkspaceBot = {
  workspaceId: string;
  runtime: "codex" | "claude";
  model: string | null;
  effort:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra"
    | null;
  speed: "standard" | "fast" | null;
  /** Full access is confined to the selected VM; it never permits a host command or mount. */
  permission: "read-only" | "workspace-write" | "vm-full-access";
};

export function parseWorkspaceBot(value: unknown): WorkspaceBot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a workspace bot configuration.");
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.workspaceId !== "string" ||
    !/^obw-[a-f0-9]{16}$/.test(entry.workspaceId)
  )
    throw new Error("Choose a project workspace.");
  if (entry.runtime !== "codex" && entry.runtime !== "claude")
    throw new Error("Choose Codex or Claude Code.");
  const model = entry.model ?? null;
  if (
    model !== null &&
    (typeof model !== "string" ||
      model.length < 1 ||
      model.length > 128 ||
      /\s/.test(model) ||
      Array.from(model).some((character) => character.charCodeAt(0) < 32))
  )
    throw new Error("Choose a valid model identifier.");
  const effort = entry.effort ?? null;
  if (
    effort !== null &&
    ![
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ].includes(String(effort))
  )
    throw new Error("Choose a supported thinking effort.");
  const speed = entry.speed ?? null;
  if (speed !== null && speed !== "standard" && speed !== "fast")
    throw new Error("Choose a supported speed.");
  if (
    entry.permission !== "read-only" &&
    entry.permission !== "workspace-write" &&
    entry.permission !== "vm-full-access"
  )
    throw new Error("Choose workspace permissions.");
  return {
    workspaceId: entry.workspaceId,
    runtime: entry.runtime,
    model: model as string | null,
    effort: effort as WorkspaceBot["effort"],
    speed,
    permission: entry.permission,
  };
}
