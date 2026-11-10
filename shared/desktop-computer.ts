import { z } from "zod";

/** Only guest operations: this protocol never names a host path or carries credentials. */
export const desktopComputerId = z.string().regex(/^obw-[a-f0-9]{16}$/);
function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}
const text = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacter(value));
// Relative guest paths only. The native executor must also reject symlink escapes at use time.
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
  );
export const desktopComputerRegistration = z.strictObject({
  computerId: desktopComputerId,
  name: z.string().trim().min(1).max(100),
});
export type DesktopComputer = z.infer<typeof desktopComputerRegistration>;
export const desktopComputerUnregistration = z.strictObject({
  computerId: desktopComputerId,
  ownerUserId: z.string().min(1).max(256),
  connectionId: z.string().uuid(),
  bindingId: z.string().uuid().optional(),
});
export const desktopActorPurpose = z.enum([
  "status",
  "start",
  "allow",
  "cancel",
  "logout",
  "disconnect",
]);
export type DesktopActorPurpose = z.infer<typeof desktopActorPurpose>;

export const desktopComputerAction = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("models"),
    runtime: z.enum(["codex", "claude"]),
  }),
  z.strictObject({ kind: z.literal("list_files"), path }),
  z.strictObject({ kind: z.literal("read_file"), path }),
  z.strictObject({
    kind: z.literal("write_file"),
    path,
    content: z.string().max(262_144),
    append: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("run_command"),
    command: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => !value.includes("\0")),
  }),
  z.strictObject({
    kind: z.literal("harness_turn"),
    runtime: z.enum(["codex", "claude"]),
    prompt: z.string().min(1).max(262_144),
    developerInstructions: z.string().max(32_768).optional(),
    sessionId: text.optional(),
    model: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/\s/.test(value) && !hasControlCharacter(value))
      .optional(),
    effort: z
      .enum([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      .optional(),
    speed: z.enum(["standard", "fast"]).optional(),
    permission: z.enum(["read-only", "workspace-write", "vm-full-access"]),
  }),
]);
export type DesktopComputerAction = z.infer<typeof desktopComputerAction>;

export type DesktopComputerOperation = {
  operationId: string;
  computerId: string;
  actorId: string;
  botId: string;
  threadId: string;
  runId: string;
  expiresAt: number;
  action: DesktopComputerAction;
};

export const desktopComputerEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started") }),
  z.strictObject({
    type: z.literal("output"),
    stream: z.enum(["stdout", "stderr", "assistant", "reasoning"]),
    text: z.string().max(65_536),
  }),
  z.strictObject({
    type: z.literal("completed"),
    exitCode: z.number().int().min(-255).max(255).optional(),
    result: z.unknown().optional(),
    sessionId: text.optional(),
  }),
  z.strictObject({
    type: z.literal("failed"),
    message: z.string().min(1).max(4096),
  }),
]);
export type DesktopComputerEvent = z.infer<typeof desktopComputerEvent>;
export const desktopComputerEventBatch = z.strictObject({
  operationId: z.string().uuid(),
  events: z
    .array(
      z.strictObject({
        sequence: z.number().int().positive(),
        event: desktopComputerEvent,
      }),
    )
    .min(1)
    .max(64),
});
export type DesktopComputerEventBatch = z.infer<
  typeof desktopComputerEventBatch
>;

/**
 * Redelivery retains operationId. The worker must never execute that id twice and must stop
 * active operations if it cannot renew this connection's lease. No queued job authorizes
 * continuing after the desktop disconnects from its owning server. A changed connectionId
 * means the server restarted: stop old operations and discard their session-local replay cache.
 */
export type DesktopComputerPoll = {
  connectionId: string;
  operations: DesktopComputerOperation[];
  cancellations: string[];
  leaseMs: number;
};
