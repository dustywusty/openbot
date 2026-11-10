import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDesktopComputerBroker } from "../src/computer/desktop-broker";
import { createDesktopPairingStore } from "../src/computer/desktop-pairing-store";
import { createDesktopComputerRoutes } from "../src/computer/desktop-routes";
import { createDatabase } from "../src/db/client";
import {
  desktopComputerPairings,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const created: string[] = [];
const prefix = `desktop-pair-${randomUUID()}`;
const installation = "native-installation-test-0123456789";
const host = "synthetic-native-host-token";
const computer = () => ({
  computerId: `obw-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  name: "Private test project",
});
async function person() {
  const id = `${prefix}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  await database.insert(userRoles).values({ userId: id, role: "user" });
  created.push(id);
  return id;
}
afterAll(async () => {
  for (const id of created) {
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, `${id}@example.test`));
    await database.delete(users).where(eq(users.id, id));
  }
  await database.$client.close();
});

function service(nativeId = installation) {
  let clock = Date.now();
  const store = createDesktopPairingStore(database);
  const broker = createDesktopComputerBroker({
    canDispatch: async ({ actorId, computerId }) =>
      !!(await store.owned(actorId, nativeId, computerId)),
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const id = context.req.header("x-test-user");
    if (!id) return context.json({ error: "Sign in" }, 401);
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };
  const app = new Hono().route(
    "/computers",
    createDesktopComputerRoutes({
      broker,
      pairings: store,
      installationId: nativeId,
      desktopToken: host,
      requireUser,
      now: () => clock,
    }),
  );
  const post = (path: string, body: unknown, owner?: string, native = false) =>
    app.request(`/computers${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(owner ? { "x-test-user": owner } : {}),
        ...(native ? { authorization: `Bearer ${host}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const pair = async (owner: string, vm: ReturnType<typeof computer>) => {
    const ticket = await (await post("/pair", {}, owner)).json();
    const response = await post(
      "/desktop/register",
      { ticket: ticket.ticket, computer: vm },
      undefined,
      true,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const proof = async (owner: string, id: string, purpose = "status") =>
    (await post(`/${id}/actor-ticket`, { purpose }, owner)).json();
  const redeem = (ticket: string, id: string, purpose = "status") =>
    post(
      "/desktop/actor-ticket/redeem",
      { ticket, computerId: id, purpose },
      undefined,
      true,
    );
  return {
    app,
    broker,
    store,
    post,
    pair,
    proof,
    redeem,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("durable desktop pairing with a dedicated PostgreSQL database", () => {
  test("only explicit single-user configuration authorizes its local actor without stored roles", async () => {
    const localOwner = await person();
    await database.delete(userRoles).where(eq(userRoles.userId, localOwner));
    const ordinary = createDesktopPairingStore(database);
    const standalone = createDesktopPairingStore(database, {
      singleUserOwnerId: localOwner,
    });
    expect(await ordinary.ownerAllowed(localOwner)).toBe(false);
    expect(await standalone.ownerAllowed(localOwner)).toBe(true);
    const issued = await standalone.issue(localOwner, installation, computer());
    expect(
      await standalone.reconnect(
        installation,
        issued.pairing.bindingId,
        issued.pairing.computerId,
        issued.voucher,
      ),
    ).not.toBeNull();
    expect(
      await ordinary.reconnect(
        installation,
        issued.pairing.bindingId,
        issued.pairing.computerId,
        issued.voucher,
      ),
    ).toBeNull();
    await database
      .insert(revokedAccess)
      .values({ email: `${localOwner}@example.test`, revokedBy: "test" });
    expect(await standalone.ownerAllowed(localOwner)).toBe(false);
  });
  test("revocation waits for validated reconnect activation, then removes it before acknowledging", async () => {
    const owner = await person();
    const vm = computer();
    const f = service();
    const registered = await f.pair(owner, vm);
    const monitor = createDatabase(testDatabaseUrl(), { max: 1 });
    let signalEntered: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconnect = f.store.reconnect;
    f.store.reconnect = (
      installationId,
      bindingId,
      computerId,
      voucher,
      activate,
    ) =>
      reconnect(
        installationId,
        bindingId,
        computerId,
        voucher,
        async (pairing) => {
          signalEntered();
          await released;
          await activate?.(pairing);
        },
      );
    const pending = f.post(
      "/desktop/reconnect",
      {
        bindingId: registered.reconnect.bindingId,
        voucher: registered.reconnect.voucher,
        computer: vm,
      },
      undefined,
      true,
    );
    let disconnected: Promise<Response> | undefined;
    try {
      await Promise.race([
        entered,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("Reconnect did not reach the validation barrier"),
              ),
            3000,
          ),
        ),
      ]);
      let settled = false;
      disconnected = f
        .post(
          "/desktop/unregister",
          {
            computerId: vm.computerId,
            ownerUserId: owner,
            bindingId: registered.reconnect.bindingId,
            connectionId: registered.connectionId,
          },
          undefined,
          true,
        )
        .then((response) => {
          settled = true;
          return response;
        });
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!settled && Date.now() < deadline) {
        const blocked = await monitor.execute(
          sql`select pid from pg_stat_activity where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
        );
        if (blocked.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);
      release();
      expect((await pending).status).toBe(200);
      expect((await disconnected).status).toBe(200);
      expect(f.broker.list(owner)).toEqual([]);
      expect(
        await f.store.owned(owner, installation, vm.computerId),
      ).toBeNull();
    } finally {
      release();
      await pending;
      await disconnected;
      f.broker.dispose();
      await monitor.$client.close();
    }
  });

  test("a failed durable transaction rolls back its exact native activation", async () => {
    const owner = await person();
    const vm = computer();
    const f = service();
    const issue = f.store.issue;
    f.store.issue = (actor, installationId, selected, activate) =>
      issue(actor, installationId, selected, async (pairing) => {
        await activate?.(pairing);
        throw new Error("Synthetic transaction failure after activation");
      });
    try {
      const ticket = await (await f.post("/pair", {}, owner)).json();
      expect(
        (
          await f.post(
            "/desktop/register",
            { ticket: ticket.ticket, computer: vm },
            undefined,
            true,
          )
        ).status,
      ).toBe(500);
      expect(f.broker.list(owner)).toEqual([]);
      expect(
        await f.store.owned(owner, installation, vm.computerId),
      ).toBeNull();
      f.store.issue = issue;
      expect((await f.pair(owner, vm)).ownerUserId).toBe(owner);
    } finally {
      f.broker.dispose();
    }
  });

  test("concurrent rotation commits before stale revoke checks its exact binding generation", async () => {
    const owner = await person();
    const vm = computer();
    const f = service();
    const original = await f.pair(owner, vm);
    const monitor = createDatabase(testDatabaseUrl(), { max: 1 });
    let signalEntered: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.store.issue;
    f.store.issue = (actor, nativeId, selected, activate) =>
      issue(actor, nativeId, selected, async (pairing) => {
        signalEntered();
        await released;
        await activate?.(pairing);
      });
    const ticket = await (await f.post("/pair", {}, owner)).json();
    const pending = f.post(
      "/desktop/register",
      { ticket: ticket.ticket, computer: vm },
      undefined,
      true,
    );
    let stale: Promise<Response> | undefined;
    try {
      await Promise.race([
        entered,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Rotation did not reach activation barrier")),
            3000,
          ),
        ),
      ]);
      let settled = false;
      stale = f
        .post(
          "/desktop/unregister",
          {
            computerId: vm.computerId,
            ownerUserId: owner,
            bindingId: original.reconnect.bindingId,
            connectionId: original.connectionId,
          },
          undefined,
          true,
        )
        .then((response) => {
          settled = true;
          return response;
        });
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!settled && Date.now() < deadline) {
        const blocked = await monitor.execute(
          sql`select pid from pg_stat_activity where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
        );
        if (blocked.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      release();
      const rotated = await (await pending).json();
      expect((await stale).status).toBe(403);
      expect(f.broker.bindingOf(vm.computerId)).toBe(
        rotated.reconnect.bindingId,
      );
      expect(
        (await f.store.owned(owner, installation, vm.computerId))?.bindingId,
      ).toBe(rotated.reconnect.bindingId);
    } finally {
      release();
      await pending;
      await stale;
      f.broker.dispose();
      await monitor.$client.close();
    }
  });

  test("only hashes persist; a restarted broker restores verified owner presence without replaying jobs", async () => {
    const owner = await person();
    const vm = computer();
    const first = service();
    const registration = await first.pair(owner, vm);
    const voucher = registration.reconnect.voucher;
    try {
      const [stored] = await database
        .select()
        .from(desktopComputerPairings)
        .where(
          eq(desktopComputerPairings.id, registration.reconnect.bindingId),
        );
      expect(stored?.secretHash).toBe(
        createHash("sha256").update(voucher).digest("hex"),
      );
      expect(JSON.stringify(stored)).not.toContain(voucher);
      const oldJob = await first.broker.dispatch({
        actorId: owner,
        botId: "test-bot",
        computerId: vm.computerId,
        threadId: "thread",
        runId: "run",
        action: { kind: "models", runtime: "codex" },
      });
      const stopped = oldJob.completion.catch(() => "stopped");
      first.broker.dispose();
      expect(await stopped).toBe("stopped");
      const restarted = service();
      try {
        expect(await restarted.store.audience()).toBe(
          registration.reconnect.serverAudience,
        );
        expect(restarted.broker.connectionId).not.toBe(
          registration.connectionId,
        );
        const offline = await restarted.proof(owner, vm.computerId);
        expect(offline).toEqual({
          paired: false,
          canDisconnect: true,
          ticket: null,
          expiresAt: null,
        });
        const reconnect = await restarted.post(
          "/desktop/reconnect",
          {
            bindingId: registration.reconnect.bindingId,
            voucher,
            computer: vm,
          },
          undefined,
          true,
        );
        expect(reconnect.status).toBe(200);
        const restored = await reconnect.json();
        expect(restored.ownerUserId).toBe(owner);
        expect(restored.reconnect).not.toHaveProperty("voucher");
        expect(restarted.broker.poll().operations).toEqual([]);
        expect(restarted.broker.list(owner)).toEqual([vm]);
        const list = await restarted.app.request("/computers", {
          headers: { "x-test-user": owner },
        });
        expect(JSON.stringify(await list.json())).not.toContain(voucher);
        expect(() =>
          restarted.broker.acceptEvents({
            operationId: oldJob.operationId,
            events: [
              { sequence: 1, event: { type: "completed", exitCode: 0 } },
            ],
          }),
        ).toThrow("no longer available");
      } finally {
        restarted.broker.dispose();
      }
    } finally {
      first.broker.dispose();
    }
  });

  test("actor proofs are owner-, VM-, action-, epoch- and generation-bound, one-use and short-lived", async () => {
    const owner = await person(),
      stranger = await person();
    const vm = computer(),
      other = computer();
    const f = service();
    try {
      await f.pair(owner, vm);
      expect(await f.proof(stranger, vm.computerId)).toEqual({
        paired: false,
        canDisconnect: false,
        ticket: null,
        expiresAt: null,
      });
      expect(
        (
          await f.post(
            `/${vm.computerId}/actor-ticket`,
            { purpose: "allow" },
            stranger,
          )
        ).status,
      ).toBe(403);
      for (const purpose of [
        "status",
        "start",
        "allow",
        "cancel",
        "logout",
        "disconnect",
      ]) {
        const proof = await f.proof(owner, vm.computerId, purpose);
        const response = await f.redeem(proof.ticket, vm.computerId, purpose);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ownerUserId: owner,
          computerId: vm.computerId,
          purpose,
          installationId: installation,
          connectionId: f.broker.connectionId,
          bindingId: f.broker.bindingOf(vm.computerId),
        });
        expect(
          (await f.redeem(proof.ticket, vm.computerId, purpose)).status,
        ).toBe(403);
      }
      const wrongPurpose = await f.proof(owner, vm.computerId, "start");
      expect(
        (await f.redeem(wrongPurpose.ticket, vm.computerId, "allow")).status,
      ).toBe(403);
      const wrongVm = await f.proof(owner, vm.computerId);
      expect((await f.redeem(wrongVm.ticket, other.computerId)).status).toBe(
        403,
      );
      const expired = await f.proof(owner, vm.computerId);
      f.advance(60_001);
      expect((await f.redeem(expired.ticket, vm.computerId)).status).toBe(403);
      const priorGeneration = await f.proof(owner, vm.computerId);
      await f.pair(owner, vm);
      expect(
        (await f.redeem(priorGeneration.ticket, vm.computerId)).status,
      ).toBe(403);
      const anotherProcess = service();
      try {
        expect(
          (
            await anotherProcess.redeem(
              (
                await f.proof(owner, vm.computerId)
              ).ticket,
              vm.computerId,
            )
          ).status,
        ).toBe(403);
      } finally {
        anotherProcess.broker.dispose();
      }
    } finally {
      f.broker.dispose();
    }
  });

  test("wrong vouchers, clone installation, revoked binding and offboarded owners cannot reconnect", async () => {
    const owner = await person();
    const vm = computer();
    const f = service();
    const registered = await f.pair(owner, vm);
    const input = {
      bindingId: registered.reconnect.bindingId,
      voucher: registered.reconnect.voucher,
      computer: vm,
    };
    try {
      const clone = service("different-native-installation-0123456789");
      try {
        expect(
          (await clone.post("/desktop/reconnect", input, undefined, true))
            .status,
        ).toBe(403);
      } finally {
        clone.broker.dispose();
      }
      expect(
        (
          await f.post(
            "/desktop/reconnect",
            { ...input, voucher: "0".repeat(64) },
            undefined,
            true,
          )
        ).status,
      ).toBe(403);
      expect((await f.post("/desktop/reconnect", input)).status).toBe(401);
      await database
        .insert(revokedAccess)
        .values({ email: `${owner}@example.test`, revokedBy: "test" });
      expect(
        (await f.post("/desktop/reconnect", input, undefined, true)).status,
      ).toBe(403);
      await f.store.revokeOwner(owner);
      await database
        .delete(revokedAccess)
        .where(eq(revokedAccess.email, `${owner}@example.test`));
      expect(
        (await f.post("/desktop/reconnect", input, undefined, true)).status,
      ).toBe(403);
    } finally {
      f.broker.dispose();
    }
  });

  test("rotation cancels old work and stale deletion cannot revoke the replacement; offline deletion persists", async () => {
    const owner = await person();
    const vm = computer();
    const f = service();
    try {
      const original = await f.pair(owner, vm);
      const job = await f.broker.dispatch({
        actorId: owner,
        botId: "test-bot",
        computerId: vm.computerId,
        threadId: "thread",
        runId: "run",
        action: { kind: "models", runtime: "codex" },
      });
      const cancelled = job.completion.catch(() => "cancelled");
      const rotated = await f.pair(owner, vm);
      expect(await cancelled).toBe("cancelled");
      expect(f.broker.poll().operations).toEqual([]);
      expect(
        f.broker.acceptEvents({
          operationId: job.operationId,
          events: [{ sequence: 1, event: { type: "completed", exitCode: 0 } }],
        }).finished,
      ).toBe(true);
      expect(
        (
          await f.post(
            "/desktop/unregister",
            {
              computerId: vm.computerId,
              ownerUserId: owner,
              bindingId: original.reconnect.bindingId,
              connectionId: original.connectionId,
            },
            undefined,
            true,
          )
        ).status,
      ).toBe(403);
      expect(
        await f.store.owned(owner, installation, vm.computerId),
      ).not.toBeNull();
      const offline = service();
      try {
        const proof = await offline.proof(owner, vm.computerId, "disconnect");
        expect(proof.paired).toBe(false);
        expect(
          (await offline.redeem(proof.ticket, vm.computerId, "disconnect"))
            .status,
        ).toBe(200);
        expect(
          (
            await offline.post(
              "/desktop/unregister",
              {
                computerId: vm.computerId,
                ownerUserId: owner,
                bindingId: rotated.reconnect.bindingId,
                connectionId: f.broker.connectionId,
              },
              undefined,
              true,
            )
          ).status,
        ).toBe(200);
        const retry = await offline.post(
          "/desktop/reconnect",
          {
            bindingId: rotated.reconnect.bindingId,
            voucher: rotated.reconnect.voucher,
            computer: vm,
          },
          undefined,
          true,
        );
        expect(retry.status).toBe(403);
      } finally {
        offline.broker.dispose();
      }
    } finally {
      f.broker.dispose();
    }
  });
});
