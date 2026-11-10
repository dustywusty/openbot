import { randomBytes } from "node:crypto";
import {
  desktopActorPurpose,
  desktopComputerEventBatch,
  desktopComputerRegistration,
  desktopComputerUnregistration,
} from "@openbot/shared/desktop-computer";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sameToken } from "../agents/callback-token";
import type { AppVariables } from "../auth/guards";
import type { PluginStore } from "../plugins/store";
import {
  type DesktopComputerBroker,
  DesktopComputerRefusedError,
} from "./desktop-broker";
import {
  DesktopPairingRefusedError,
  type DesktopPairingStore,
  type DurablePairing,
} from "./desktop-pairing-store";
import {
  exportableSkills,
  MAX_WORKSPACE_SKILLS_BYTES,
  snapshotOf,
  type WorkspaceSkillSnapshot,
  workspaceSkillChoices,
  workspaceSkillSlug,
} from "./skill-snapshots";

/** Mount on the existing API server. Native requests use its existing per-run host token. */
export function createDesktopComputerRoutes(options: {
  broker: DesktopComputerBroker;
  desktopToken?: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  skillStore?: Pick<PluginStore, "listSkills">;
  pairings?: DesktopPairingStore;
  installationId?: string;
  now?: () => number;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { broker, requireUser } = options;
  const activateDurably = async <T>(
    computer: z.infer<typeof desktopComputerRegistration>,
    reset: boolean,
    work: (activate: (pairing: DurablePairing) => void) => Promise<T>,
  ): Promise<T> => {
    let activated: { pairing: DurablePairing; revision: string | null } | null =
      null;
    try {
      return await work((pairing) => {
        broker.restoreRegistration(
          pairing.ownerUserId,
          computer,
          pairing.bindingId,
          reset,
        );
        activated = {
          pairing,
          revision: broker.registrationRevisionOf(computer.computerId),
        };
      });
    } catch (error) {
      // A failed commit must remove only its own activation, never a newer reconnect/rotation.
      const current = activated as {
        pairing: DurablePairing;
        revision: string | null;
      } | null;
      if (
        current &&
        broker.registrationRevisionOf(computer.computerId) ===
          current.revision &&
        broker.bindingOf(computer.computerId) === current.pairing.bindingId &&
        broker.ownerOf(computer.computerId) === current.pairing.ownerUserId
      )
        broker.unregister({
          computerId: computer.computerId,
          ownerUserId: current.pairing.ownerUserId,
          connectionId: broker.connectionId,
        });
      throw error;
    }
  };
  const now = options.now ?? Date.now;
  const pairingStore = () => {
    if (!options.pairings) throw new DesktopPairingRefusedError();
    return options.pairings;
  };
  const nativeInstallation = () => {
    if (
      !options.installationId ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(options.installationId)
    )
      throw new DesktopPairingRefusedError();
    return options.installationId;
  };
  let audiencePromise: Promise<string> | null = null;
  const audience = () => {
    if (
      !options.pairings ||
      !options.installationId ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(options.installationId)
    )
      throw new DesktopPairingRefusedError();
    audiencePromise ??= options.pairings.audience().catch((error) => {
      audiencePromise = null;
      throw error;
    });
    return audiencePromise;
  };
  type ActorProof = {
    ownerUserId: string;
    computerId: string;
    installationId: string;
    serverAudience: string;
    connectionId: string;
    purpose: z.infer<typeof desktopActorPurpose>;
    bindingId: string;
    expiresAt: number;
  };
  type UsageProof = {
    purpose: "usage";
    ownerUserId: string;
    installationId: string;
    serverAudience: string;
    connectionId: string;
    installationVisible: boolean;
    expiresAt: number;
  };
  const usageProofs = new Map<string, UsageProof>();
  const proofs = new Map<string, ActorProof>();
  const sweepProofs = () => {
    for (const [ticket, proof] of usageProofs)
      if (proof.expiresAt <= now()) usageProofs.delete(ticket);
    for (const [ticket, proof] of proofs)
      if (proof.expiresAt <= now()) proofs.delete(ticket);
  };
  const requireDesktop: MiddlewareHandler = async (context, next) => {
    if (!options.desktopToken)
      return context.json(
        { error: "Desktop computers are not configured." },
        503,
      );
    const authorization = context.req.header("authorization") ?? "";
    const [scheme, token] = authorization.split(/\s+/);
    if (
      scheme?.toLowerCase() !== "bearer" ||
      !token ||
      token.length !== options.desktopToken.length ||
      !sameToken(token, options.desktopToken)
    ) {
      return context.json(
        { error: "Desktop computer authentication failed." },
        401,
      );
    }
    await next();
  };
  routes.onError((error, context) => {
    if (error instanceof DesktopPairingRefusedError)
      return context.json({ error: error.message }, 403);
    if (error instanceof DesktopComputerRefusedError)
      return context.json({ error: error.message }, 409);
    return context.json({ error: "The desktop computer request failed." }, 500);
  });
  routes.post("/:id/actor-ticket", requireUser, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = z
      .strictObject({ purpose: desktopActorPurpose })
      .safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json({ error: "Choose a valid workspace action." }, 400);
    const id = context.req.param("id");
    const actor = context.var.actor.id;
    const registered = broker.ownerOf(id) === actor;
    const serverAudience = await audience();
    const binding = await pairingStore().owned(actor, nativeInstallation(), id);
    if (
      body.data.purpose === "status" &&
      (!registered || !binding || broker.bindingOf(id) !== binding.bindingId)
    )
      return context.json({
        paired: false,
        canDisconnect: !!binding,
        ticket: null,
        expiresAt: null,
      });
    if (
      !binding ||
      (body.data.purpose !== "disconnect" &&
        (!registered || broker.bindingOf(id) !== binding.bindingId))
    )
      throw new DesktopPairingRefusedError();
    sweepProofs();
    if (
      proofs.size + usageProofs.size >= 256 ||
      [...proofs.values()].filter((proof) => proof.ownerUserId === actor)
        .length +
        [...usageProofs.values()].filter((proof) => proof.ownerUserId === actor)
          .length >=
        32
    )
      return context.json(
        { error: "Too many workspace actions are waiting. Try again shortly." },
        429,
      );
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = now() + 60_000;
    proofs.set(ticket, {
      ownerUserId: actor,
      computerId: id,
      installationId: nativeInstallation(),
      serverAudience,
      connectionId: broker.connectionId,
      purpose: body.data.purpose,
      bindingId: binding.bindingId,
      expiresAt,
    });
    return context.json({
      paired: registered,
      canDisconnect: true,
      ticket,
      expiresAt,
    });
  });
  routes.post("/model-connections/ticket", requireUser, async (context) => {
    context.header("Cache-Control", "no-store");
    const ownerUserId = context.var.actor.id;
    if (!(await pairingStore().ownerAllowed(ownerUserId)))
      throw new DesktopPairingRefusedError();
    const serverAudience = await audience();
    const installationId = nativeInstallation();
    sweepProofs();
    const ownedProofs = [...usageProofs.values(), ...proofs.values()].filter(
      (proof) => proof.ownerUserId === ownerUserId,
    );
    if (usageProofs.size + proofs.size >= 256 || ownedProofs.length >= 32)
      return context.json(
        { error: "Too many connection checks are waiting. Try again shortly." },
        429,
      );
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = now() + 60_000;
    usageProofs.set(ticket, {
      purpose: "usage",
      ownerUserId,
      installationId,
      serverAudience,
      connectionId: broker.connectionId,
      installationVisible: context.var.actor.role === "admin",
      expiresAt,
    });
    return context.json({ ticket, expiresAt });
  });
  routes.post(
    "/desktop/model-connections/redeem",
    requireDesktop,
    async (context) => {
      context.header("Cache-Control", "no-store");
      const input = z
        .strictObject({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
        .safeParse(await context.req.json().catch(() => null));
      if (!input.success) throw new DesktopPairingRefusedError();
      sweepProofs();
      const proof = usageProofs.get(input.data.ticket);
      usageProofs.delete(input.data.ticket);
      if (
        !proof ||
        proof.installationId !== nativeInstallation() ||
        proof.serverAudience !== (await audience()) ||
        proof.connectionId !== broker.connectionId ||
        !(await pairingStore().ownerAllowed(proof.ownerUserId))
      )
        throw new DesktopPairingRefusedError();
      const { expiresAt: _expiresAt, ...verified } = proof;
      return context.json(verified);
    },
  );
  routes.get("/", requireUser, (context) =>
    context.json({ computers: broker.list(context.var.actor.id) }),
  );
  routes.get("/skills", requireUser, async (context) => {
    context.header("Cache-Control", "no-store");
    if (!options.skillStore)
      return context.json(
        { error: "Workspace skills are unavailable. Try again later." },
        503,
      );
    const records = await options.skillStore.listSkills({
      id: context.var.actor.id,
      isAdmin: false,
    });
    return context.json({
      skills: workspaceSkillChoices(records, context.var.actor.id),
    });
  });
  routes.post("/skill-snapshots", requireUser, async (context) => {
    if (!options.skillStore)
      return context.json(
        { error: "Workspace skills are unavailable. Try again later." },
        503,
      );
    const reader = context.req.raw.body?.getReader();
    if (!reader)
      return context.json({ error: "Choose skills for this workspace." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return context.json(
            { error: "Choose at most 16 workspace skills." },
            413,
          );
        }
        chunks.push(value);
      }
    } catch {
      return context.json(
        { error: "Couldn't read the skill selection. Try again." },
        400,
      );
    } finally {
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return context.json({ error: "Send a valid skill selection." }, 400);
    }
    const parsed = z
      .strictObject({
        slugs: z.array(z.string().regex(workspaceSkillSlug)).max(16),
      })
      .safeParse(body);
    if (
      !parsed.success ||
      new Set(parsed.data.slugs).size !== parsed.data.slugs.length
    )
      return context.json(
        { error: "Choose up to 16 different workspace skills." },
        400,
      );
    const records = exportableSkills(
      await options.skillStore.listSkills({
        id: context.var.actor.id,
        isAdmin: false,
      }),
      context.var.actor.id,
    );
    const bySlug = new Map(records.map((record) => [record.slug, record]));
    const snapshots: WorkspaceSkillSnapshot[] = [];
    let bytes = 0;
    for (const slug of parsed.data.slugs) {
      const record = bySlug.get(slug);
      if (!record)
        return context.json(
          {
            error: "A selected skill is unavailable. Choose your skills again.",
          },
          404,
        );
      const result = snapshotOf(record);
      if (!result)
        return context.json(
          {
            error:
              "A selected skill cannot fit in a workspace snapshot. Edit it or choose another skill.",
          },
          413,
        );
      bytes += result.bytes;
      if (bytes > MAX_WORKSPACE_SKILLS_BYTES)
        return context.json(
          {
            error: "These skills are too large together. Choose fewer skills.",
          },
          413,
        );
      snapshots.push(result.snapshot);
    }
    context.header("Cache-Control", "no-store");
    return context.json({ skills: snapshots });
  });
  routes.post("/pair", requireUser, (context) => {
    if (!options.desktopToken)
      return context.json(
        { error: "Only OpenBot Desktop can add a local computer." },
        409,
      );
    return context.json(broker.createPairingTicket(context.var.actor.id));
  });
  routes.post("/operations/:operationId/cancel", requireUser, (context) => {
    broker.cancel(context.var.actor.id, context.req.param("operationId"));
    return context.json({ ok: true });
  });
  routes.post("/desktop/register", requireDesktop, async (context) => {
    const parsed = z
      .strictObject({
        ticket: z.string().regex(/^[a-f0-9]{64}$/),
        computer: desktopComputerRegistration,
      })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        { error: "Send a valid computer pairing request." },
        400,
      );
    if (!options.pairings) {
      const computer = broker.register(
        parsed.data.ticket,
        parsed.data.computer,
      );
      return context.json({
        computer,
        ownerUserId: broker.ownerOf(computer.computerId),
        connectionId: broker.connectionId,
      });
    }
    const serverAudience = await audience();
    const ownerUserId = broker.redeemPairingTicket(parsed.data.ticket);
    const issued = await activateDurably(
      parsed.data.computer,
      false,
      (activate) =>
        pairingStore().issue(
          ownerUserId,
          nativeInstallation(),
          parsed.data.computer,
          activate,
        ),
    );
    const computer = parsed.data.computer;
    context.header("Cache-Control", "no-store");
    return context.json({
      computer,
      ownerUserId,
      connectionId: broker.connectionId,
      reconnect: {
        bindingId: issued.pairing.bindingId,
        installationId: nativeInstallation(),
        serverAudience,
        voucher: issued.voucher,
      },
    });
  });
  routes.post("/desktop/reconnect", requireDesktop, async (context) => {
    const input = z
      .strictObject({
        bindingId: z.string().uuid(),
        voucher: z.string().regex(/^[a-f0-9]{64}$/),
        computer: desktopComputerRegistration,
      })
      .safeParse(await context.req.json().catch(() => null));
    if (!input.success) throw new DesktopPairingRefusedError();
    const serverAudience = await audience();
    const binding = await activateDurably(
      input.data.computer,
      true,
      (activate) =>
        pairingStore().reconnect(
          nativeInstallation(),
          input.data.bindingId,
          input.data.computer.computerId,
          input.data.voucher,
          activate,
        ),
    );
    if (!binding) throw new DesktopPairingRefusedError();
    const computer = input.data.computer;
    context.header("Cache-Control", "no-store");
    return context.json({
      computer,
      ownerUserId: binding.ownerUserId,
      connectionId: broker.connectionId,
      reconnect: {
        bindingId: binding.bindingId,
        installationId: binding.installationId,
        serverAudience,
      },
    });
  });
  routes.post(
    "/desktop/actor-ticket/redeem",
    requireDesktop,
    async (context) => {
      const input = z
        .strictObject({
          ticket: z.string().regex(/^[a-f0-9]{64}$/),
          computerId: desktopComputerRegistration.shape.computerId,
          purpose: desktopActorPurpose,
        })
        .safeParse(await context.req.json().catch(() => null));
      if (!input.success) throw new DesktopPairingRefusedError();
      sweepProofs();
      const proof = proofs.get(input.data.ticket);
      proofs.delete(input.data.ticket);
      if (
        !proof ||
        proof.purpose !== input.data.purpose ||
        proof.computerId !== input.data.computerId ||
        proof.connectionId !== broker.connectionId ||
        proof.installationId !== options.installationId ||
        proof.serverAudience !== (await audience())
      )
        throw new DesktopPairingRefusedError();
      const binding = await pairingStore().owned(
        proof.ownerUserId,
        proof.installationId,
        proof.computerId,
      );
      if (
        !binding ||
        binding.bindingId !== proof.bindingId ||
        (proof.purpose !== "disconnect" &&
          (broker.ownerOf(proof.computerId) !== proof.ownerUserId ||
            broker.bindingOf(proof.computerId) !== proof.bindingId))
      )
        throw new DesktopPairingRefusedError();
      const { expiresAt: _expiresAt, ...verified } = proof;
      context.header("Cache-Control", "no-store");
      return context.json(verified);
    },
  );
  routes.get("/desktop/next", requireDesktop, async (context) =>
    context.json({
      ...broker.poll(),
      ...(options.pairings
        ? {
            serverAudience: await audience(),
            installationId: nativeInstallation(),
          }
        : {}),
    }),
  );
  routes.post("/desktop/unregister", requireDesktop, async (context) => {
    const parsed = desktopComputerUnregistration.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        { error: "Send a valid workspace disconnection request." },
        400,
      );
    if (options.pairings) {
      await audience();
      if (
        !parsed.data.bindingId ||
        !(await options.pairings.revoke(
          nativeInstallation(),
          parsed.data.bindingId,
          parsed.data.computerId,
          parsed.data.ownerUserId,
        ))
      )
        throw new DesktopPairingRefusedError();
      // A stale epoch can revoke its exact durable binding but cannot stop a replacement's jobs.
      if (broker.bindingOf(parsed.data.computerId) === parsed.data.bindingId)
        broker.unregister({
          ...parsed.data,
          connectionId: broker.connectionId,
        });
    } else broker.unregister(parsed.data);
    return context.json({ ok: true });
  });
  routes.post("/desktop/events", requireDesktop, async (context) => {
    // Bound the body before JSON parsing, including when Content-Length is absent or untrusted.
    const reader = context.req.raw.body?.getReader();
    if (!reader)
      return context.json({ error: "Send computer operation events." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512 * 1024) {
          await reader.cancel();
          return context.json(
            { error: "Send a smaller computer event batch." },
            413,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return context.json(
        { error: "Send valid computer operation events." },
        400,
      );
    }
    const parsed = desktopComputerEventBatch.safeParse(body);
    if (!parsed.success)
      return context.json(
        { error: "Send valid computer operation events." },
        400,
      );
    return context.json(broker.acceptEvents(parsed.data));
  });
  return routes;
}
