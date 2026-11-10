import { createHash } from "node:crypto";
import type { SkillRecord } from "../plugins/store";

export const workspaceSkillSlug = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
export const MAX_WORKSPACE_SKILL_BYTES = 64 * 1024;
export const MAX_WORKSPACE_SKILLS_BYTES = 256 * 1024;

export type WorkspaceSkillSnapshot = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  origin: string;
  sha256: string;
};
export type WorkspaceSkillChoice = Omit<
  WorkspaceSkillSnapshot,
  "instructions" | "sha256"
>;

/** Canonical provenance and content tuple shared with the native recipe validator. */
function canonical(snapshot: Omit<WorkspaceSkillSnapshot, "sha256">): string {
  return JSON.stringify([
    "openbot.workspace-skill.v1",
    snapshot.id,
    snapshot.slug,
    snapshot.name,
    snapshot.description,
    snapshot.instructions,
    snapshot.origin,
  ]);
}

function scalar(value: string, bytes: number, required = false): boolean {
  const hasControl = Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || (point >= 127 && point <= 159);
  });
  return (
    (!required || value.trim().length > 0) &&
    Buffer.byteLength(value, "utf8") <= bytes &&
    !hasControl &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

/** Instructions only. Tool declarations, grants and credential-bearing settings are never exported. */
export function snapshotOf(
  record: SkillRecord,
): { snapshot: WorkspaceSkillSnapshot; bytes: number } | null {
  if (
    !workspaceSkillSlug.test(record.slug) ||
    !scalar(record.id, 128, true) ||
    !scalar(record.title, 160, true) ||
    !scalar(record.summary, 2048) ||
    !scalar(record.origin, 128, true) ||
    !record.instructions.trim() ||
    record.instructions.includes("\0") ||
    Buffer.from(record.instructions, "utf8").toString("utf8") !==
      record.instructions
  )
    return null;
  const content = {
    id: record.id,
    slug: record.slug,
    name: record.title,
    description: record.summary,
    instructions: record.instructions,
    origin: record.origin,
  };
  const encoded = canonical(content);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_WORKSPACE_SKILL_BYTES) return null;
  return {
    snapshot: {
      ...content,
      sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
    },
    bytes,
  };
}

export function exportableSkills(
  records: SkillRecord[],
  actorId: string,
): SkillRecord[] {
  // Administrative visibility governs Bots. It does not authorize copying another person's private instructions.
  return records.filter(
    (record) => record.ownerUserId === null || record.ownerUserId === actorId,
  );
}

export function workspaceSkillChoices(
  records: SkillRecord[],
  actorId: string,
): WorkspaceSkillChoice[] {
  return exportableSkills(records, actorId).flatMap((record) => {
    const result = snapshotOf(record);
    if (!result) return [];
    const {
      instructions: _instructions,
      sha256: _sha256,
      ...choice
    } = result.snapshot;
    return [choice];
  });
}
