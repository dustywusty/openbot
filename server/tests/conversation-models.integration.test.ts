import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAgentProfileStore(database, undefined);
const ids: string[] = [];
const people: string[] = [];
afterAll(async () => {
  if (ids.length) await database.delete(agents).where(inArray(agents.id, ids));
  if (people.length)
    await database.delete(users).where(inArray(users.id, people));
});

test("conversation overrides persist and stay isolated by person, thread, and profile", async () => {
  const actor = { id: crypto.randomUUID(), role: "admin" as const };
  const other = { id: crypto.randomUUID(), role: "admin" as const };
  for (const person of [actor, other]) {
    await database.insert(users).values({
      id: person.id,
      email: `${person.id}@example.test`,
      name: "Model test",
    });
    people.push(person.id);
  }
  const input = {
    name: "Coder",
    title: "Coding",
    roleDescription: "Edit code",
    visibility: "private" as const,
    codingAgent: {
      framework: "codex" as const,
      cwd: "/tmp",
      permission: "read-only" as const,
      defaults: { model: "profile-model", effort: "high" },
    },
  };
  const agent = await store.create(actor, input);
  ids.push(agent.id);
  const copied = await store.duplicate(actor, agent.id);
  ids.push(copied.id);
  expect(copied.codingAgent).toEqual(input.codingAgent);
  const thread = crypto.randomUUID();
  await store.threadModel!(actor, agent.id, thread, {
    model: "thread-model",
    effort: "low",
  });
  const reloaded = createAgentProfileStore(database, undefined);
  expect(await reloaded.threadModel!(actor, agent.id, thread)).toEqual({
    model: "thread-model",
    effort: "low",
  });
  expect(
    await store.threadModel!(actor, agent.id, crypto.randomUUID()),
  ).toEqual({});
  expect(await store.threadModel!(other, agent.id, thread)).toEqual({});
  expect(await store.threadModel!(actor, copied.id, thread)).toEqual({});
  expect((await store.get(actor, agent.id))?.codingAgent?.defaults).toEqual(
    input.codingAgent.defaults,
  );
  await store.threadModel!(actor, agent.id, thread, {});
  expect(await store.threadModel!(actor, agent.id, thread)).toEqual({});
  await database.delete(agents).where(eq(agents.id, copied.id));
});
