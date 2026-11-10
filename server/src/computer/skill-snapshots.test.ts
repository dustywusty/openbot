import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { SkillRecord } from "../plugins/store";
import { createDesktopComputerBroker } from "./desktop-broker";
import { createDesktopComputerRoutes } from "./desktop-routes";
import { MAX_WORKSPACE_SKILL_BYTES, snapshotOf } from "./skill-snapshots";

function skill(
  slug = "review-code",
  ownerUserId: string | null = "alice",
  extra: Partial<SkillRecord> = {},
): SkillRecord {
  return {
    id: slug,
    slug,
    ownerUserId,
    title: "Review code",
    summary: "Check the changes.",
    instructions: "Read the changes.\nRun the relevant checks.\n",
    origin: "yours",
    installedBy: "alice@example.com",
    grantedTo: ["private-bot"],
    tools: ["private-server/write"],
    ...extra,
  };
}

function fixture(records: SkillRecord[]) {
  const actors: { id: string; isAdmin: boolean }[] = [];
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const id = context.req.header("x-test-user");
    if (!id) return context.json({ error: "Sign in" }, 401);
    context.set("actor", {
      id,
      email: `${id}@example.com`,
      role: context.req.header("x-test-admin") ? "admin" : "user",
    });
    await next();
  };
  const broker = createDesktopComputerBroker({ canDispatch: async () => true });
  const app = new Hono().route(
    "/computers",
    createDesktopComputerRoutes({
      broker,
      requireUser,
      skillStore: {
        listSkills: async (actor) => {
          if (actor) actors.push(actor);
          return records;
        },
      },
    }),
  );
  const post = (
    body: unknown,
    headers: Record<string, string> = { "x-test-user": "alice" },
  ) =>
    app.request("/computers/skill-snapshots", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, post, actors, close: () => broker.dispose() };
}

describe("workspace instruction snapshot authorization", () => {
  test("authentication runs before reads and admin visibility cannot export another person's private skill", async () => {
    const f = fixture([
      skill(),
      skill("shared-guide", null),
      skill("bob-private", "bob"),
    ]);
    try {
      expect((await f.post({ slugs: ["review-code"] }, {})).status).toBe(401);
      expect((await f.app.request("/computers/skills")).status).toBe(401);
      expect(f.actors).toEqual([]);
      const list = await f.app.request("/computers/skills", {
        headers: { "x-test-user": "alice", "x-test-admin": "yes" },
      });
      const json = (await list.json()) as { skills: { slug: string }[] };
      expect(json.skills.map((entry) => entry.slug)).toEqual([
        "review-code",
        "shared-guide",
      ]);
      expect(JSON.stringify(json)).not.toContain("instructions");
      for (const slug of ["bob-private", "missing-skill"]) {
        const response = await f.post(
          { slugs: [slug] },
          { "x-test-user": "alice", "x-test-admin": "yes" },
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: "A selected skill is unavailable. Choose your skills again.",
        });
      }
      expect(
        f.actors.every(
          (actor) => actor.id === "alice" && actor.isAdmin === false,
        ),
      ).toBe(true);
      expect(
        (await f.post({ slugs: ["review-code", "shared-guide"] })).status,
      ).toBe(200);
    } finally {
      f.close();
    }
  });

  test("freezes exact instruction bytes and provenance without exporting tool grants or author identity", async () => {
    const record = skill();
    const f = fixture([record]);
    try {
      const response = await f.post({ slugs: [record.slug] });
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        skills: Record<string, unknown>[];
      };
      const frozen = body.skills[0];
      const encoded = JSON.stringify([
        "openbot.workspace-skill.v1",
        record.id,
        record.slug,
        record.title,
        record.summary,
        record.instructions,
        record.origin,
      ]);
      expect(frozen).toEqual({
        id: record.id,
        slug: record.slug,
        name: record.title,
        description: record.summary,
        instructions: record.instructions,
        origin: record.origin,
        sha256: createHash("sha256").update(encoded).digest("hex"),
      });
      expect(JSON.stringify(body)).not.toContain("private-server");
      expect(JSON.stringify(body)).not.toContain("alice@example.com");
      for (const metadata of [
        { id: "changed-id" },
        { title: "Changed name" },
        { summary: "Changed description" },
        { origin: "catalogue" },
      ]) {
        expect(
          snapshotOf({ ...record, ...metadata })?.snapshot.sha256,
        ).not.toBe(frozen?.sha256);
      }
      record.instructions = "Changed source later.";
      record.title = "Changed title later";
      expect(frozen?.instructions).toBe(
        "Read the changes.\nRun the relevant checks.\n",
      );
      const next = await f.post({ slugs: [record.slug] });
      expect((await next.json()).skills[0].sha256).not.toBe(frozen?.sha256);
    } finally {
      f.close();
    }
  });
});

describe("workspace snapshot bounds", () => {
  test("rejects duplicate, unsafe, overcount and caller-supplied content selections", async () => {
    const f = fixture([skill()]);
    try {
      for (const body of [
        { slugs: ["review-code", "review-code"] },
        { slugs: ["../escape"] },
        { slugs: ["review-code"], instructions: "Override" },
        { slugs: Array.from({ length: 17 }, (_, i) => `skill-${i}`) },
      ]) {
        expect((await f.post(body)).status).toBe(400);
      }
      expect(f.actors).toHaveLength(0);
      const response = await f.app.request("/computers/skill-snapshots", {
        method: "POST",
        headers: { "x-test-user": "alice" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(4097)));
            controller.close();
          },
        }),
      });
      expect(response.status).toBe(413);
      expect((await f.post({ slugs: [] })).status).toBe(200);
    } finally {
      f.close();
    }
  });

  test("measures canonical UTF-8 bytes exactly and independently bounds aggregate exports", async () => {
    const record = skill();
    const overhead = snapshotOf({ ...record, instructions: "x" })!.bytes - 1;
    expect(
      snapshotOf({
        ...record,
        instructions: "x".repeat(MAX_WORKSPACE_SKILL_BYTES - overhead),
      })?.bytes,
    ).toBe(MAX_WORKSPACE_SKILL_BYTES);
    expect(
      snapshotOf({
        ...record,
        instructions: "x".repeat(MAX_WORKSPACE_SKILL_BYTES - overhead + 1),
      }),
    ).toBeNull();
    expect(
      snapshotOf({ ...record, instructions: "é".repeat(33000) }),
    ).toBeNull();
    for (const extra of [
      { instructions: "bad\0body" },
      { title: "bad\nname" },
      { instructions: "bad\ud800" },
      { origin: "x".repeat(129) },
    ]) {
      expect(snapshotOf({ ...record, ...extra })).toBeNull();
    }
    const f = fixture(
      Array.from({ length: 5 }, (_, i) =>
        skill(`skill-${i}`, "alice", { instructions: "x".repeat(60000) }),
      ),
    );
    try {
      expect(
        (await f.post({ slugs: ["skill-0", "skill-1", "skill-2", "skill-3"] }))
          .status,
      ).toBe(200);
      expect(
        (
          await f.post({
            slugs: ["skill-0", "skill-1", "skill-2", "skill-3", "skill-4"],
          })
        ).status,
      ).toBe(413);
    } finally {
      f.close();
    }
  });
});
