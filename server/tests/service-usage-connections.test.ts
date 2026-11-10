import { expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDesktopComputerBroker } from "../src/computer/desktop-broker";
import type { DesktopPairingStore } from "../src/computer/desktop-pairing-store";
import { createDesktopComputerRoutes } from "../src/computer/desktop-routes";

function fixture() {
  let now = 1000;
  const revoked = new Set<string>();
  const broker = createDesktopComputerBroker({ canDispatch: async () => true });
  const pairings: DesktopPairingStore = {
    audience: async () => "test-server-audience",
    ownerAllowed: async (id) => !revoked.has(id),
    issue: async () => {
      throw new Error("not used");
    },
    reconnect: async () => null,
    owned: async () => null,
    revoke: async () => false,
    revokeOwner: async () => {},
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    const id = c.req.header("x-test-user");
    if (!id) return c.json({ error: "Sign in" }, 401);
    c.set("actor", {
      id,
      email: `${id}@example.test`,
      role: id === "admin" ? "admin" : "user",
    });
    await next();
  };
  const app = new Hono().route(
    "/computers",
    createDesktopComputerRoutes({
      broker,
      requireUser,
      pairings,
      installationId: "test-native-installation",
      desktopToken: "host-secret",
      now: () => now,
    }),
  );
  const issue = (user: string) =>
    app.request("/computers/model-connections/ticket", {
      method: "POST",
      headers: { "x-test-user": user },
    });
  const redeem = (ticket: string, bearer = "host-secret") =>
    app.request("/computers/desktop/model-connections/redeem", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ticket }),
    });
  return {
    app,
    broker,
    issue,
    redeem,
    revoked,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("global connection proof works without VM bindings, takes authority only from signed-in actor, and redeems once via native bearer", async () => {
  const f = fixture();
  try {
    expect(f.broker.list("alice")).toEqual([]);
    expect(
      (
        await f.app.request("/computers/model-connections/ticket", {
          method: "POST",
        })
      ).status,
    ).toBe(401);
    for (const owner of ["alice", "bob", "admin"]) {
      const response = await f.issue(owner);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { ticket, expiresAt } = await response.json();
      expect(expiresAt).toBe(61_000);
      expect((await f.redeem(ticket, "wrong")).status).toBe(401);
      const redeemed = await f.redeem(ticket);
      expect(await redeemed.json()).toEqual({
        purpose: "usage",
        ownerUserId: owner,
        installationId: "test-native-installation",
        serverAudience: "test-server-audience",
        connectionId: f.broker.connectionId,
        installationVisible: owner === "admin",
      });
      expect(redeemed.headers.get("cache-control")).toBe("no-store");
      expect((await f.redeem(ticket)).status).toBe(403);
    }
  } finally {
    f.broker.dispose();
  }
});

test("global proofs expire, refuse offboarded owners, do not cross purposes, and are bounded", async () => {
  const f = fixture();
  try {
    const expired = await (await f.issue("alice")).json();
    f.advance(60_000);
    expect((await f.redeem(expired.ticket)).status).toBe(403);
    const retired = await (await f.issue("bob")).json();
    f.revoked.add("bob");
    expect((await f.redeem(retired.ticket)).status).toBe(403);
    expect((await f.issue("bob")).status).toBe(403);
    const wrongPurpose = await (await f.issue("alice")).json();
    const response = await f.app.request(
      "/computers/desktop/actor-ticket/redeem",
      {
        method: "POST",
        headers: {
          authorization: "Bearer host-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ticket: wrongPurpose.ticket,
          computerId: "obw-0123456789abcdef",
          purpose: "status",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect((await f.redeem(wrongPurpose.ticket)).status).toBe(200);
    for (let i = 0; i < 32; i++)
      expect((await f.issue("alice")).status).toBe(200);
    expect((await f.issue("alice")).status).toBe(429);
    const other = fixture();
    try {
      const ticket = (await (await f.issue("admin")).json()).ticket;
      expect((await other.redeem(ticket)).status).toBe(403);
    } finally {
      other.broker.dispose();
    }
  } finally {
    f.broker.dispose();
  }
});
