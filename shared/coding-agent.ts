import { type ModelSettings, parseModelSettings } from "./model-settings";

export type CodingAgentConfig = {
  framework: "codex" | "claude";
  cwd: string;
  permission: "read-only" | "workspace-write";
  defaults: ModelSettings;
};

export function parseCodingAgent(value: unknown): CodingAgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid coding agent configuration.");
  const data = value as Record<string, unknown>;
  if (data.framework !== "codex" && data.framework !== "claude")
    throw new Error("Choose Codex or Claude.");
  if (
    typeof data.cwd !== "string" ||
    !data.cwd.startsWith("/") ||
    data.cwd.length > 4096 ||
    [...data.cwd].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Choose an absolute working folder path.");
  if (data.permission !== "read-only" && data.permission !== "workspace-write")
    throw new Error("Choose a permission mode.");
  return {
    framework: data.framework,
    cwd: data.cwd,
    permission: data.permission,
    defaults: parseModelSettings(data.defaults ?? {}),
  };
}
