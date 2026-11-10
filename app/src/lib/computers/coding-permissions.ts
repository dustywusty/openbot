import type { WorkspaceBot } from "@openbot/shared/workspace-bot";

export const CODING_PERMISSIONS = [
  { value: "workspace-write", label: "Read and edit project files" },
  { value: "read-only", label: "Read only" },
  { value: "vm-full-access", label: "Full access inside VM" },
] as const;
export function isCodingPermission(
  value: unknown,
): value is WorkspaceBot["permission"] {
  return CODING_PERMISSIONS.some((permission) => permission.value === value);
}
export function codingPermissionLabel(
  permission: WorkspaceBot["permission"],
): string {
  return (
    CODING_PERMISSIONS.find((option) => option.value === permission)?.label ??
    "Read and edit project files"
  );
}
export function codingPermissionDescription(
  permission: WorkspaceBot["permission"],
): string {
  return permission === "vm-full-access"
    ? "Allows system package installation, Git operations, and commands throughout this VM. Your Mac's folders are not mounted."
    : permission === "read-only"
      ? "Reads project files without changing them. Your Mac's folders are not mounted."
      : "May edit project files. Full VM access is needed to install system packages and manage Git. Your Mac's folders are not mounted.";
}
