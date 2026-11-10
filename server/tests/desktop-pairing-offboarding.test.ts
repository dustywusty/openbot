import { expect, test } from "bun:test";
import { retireOwnedAccounts } from "../src/identity/retire";

test("desktop revoke failure still retires plugins, identities, recorders and native memory authority", async () => {
  const called: string[] = [];
  await expect(
    retireOwnedAccounts({
      plugins: async () => {
        called.push("plugins");
        throw new Error("plugin failure");
      },
      identities: async () => {
        called.push("identities");
        return 1;
      },
      recorders: async () => {
        called.push("recorders");
      },
      computers: async () => {
        try {
          called.push("durable revoke");
          throw new Error("database failure");
        } finally {
          called.push("native revoke");
        }
      },
    }),
  ).rejects.toThrow(AggregateError);
  expect(called).toEqual([
    "plugins",
    "identities",
    "recorders",
    "durable revoke",
    "native revoke",
  ]);
});
