import { describe, expect, test } from "bun:test";
import { keyWouldFollowEndpoint } from "../src/agents/auth-header";

/**
 * When an edit to a coworker's connection has to carry a new key.
 *
 * A key is write-only, so a blank key on an edit means "keep the stored one". That must not hold
 * when the endpoint moves: the stored key would go to the new address on the next run, and anybody
 * who may manage the coworker could read it by pointing the coworker at a server of their own.
 */

const stored = {
  endpoint: "https://agents.example.test/ag-ui",
  auth: { header: "Authorization", credentialId: "credential-1" },
};

describe("keyWouldFollowEndpoint", () => {
  test("a move with a stored key and no new key is refused", () => {
    expect(
      keyWouldFollowEndpoint(stored, {
        endpoint: "https://elsewhere.example.test/ag-ui",
      }),
    ).toBe(true);
  });

  test("a move that brings its own key is allowed", () => {
    expect(
      keyWouldFollowEndpoint(stored, {
        endpoint: "https://elsewhere.example.test/ag-ui",
        auth: { header: "Authorization", value: "new-secret" },
      }),
    ).toBe(false);
  });

  test("the same endpoint with no new key keeps the stored key", () => {
    expect(keyWouldFollowEndpoint(stored, { endpoint: stored.endpoint })).toBe(
      false,
    );
  });

  test("no endpoint sent leaves the stored one, so nothing moves", () => {
    expect(keyWouldFollowEndpoint(stored, {})).toBe(false);
    expect(keyWouldFollowEndpoint(stored, { endpoint: "" })).toBe(false);
  });

  test("a move with no stored key has nothing to carry", () => {
    expect(
      keyWouldFollowEndpoint(
        { endpoint: stored.endpoint },
        { endpoint: "https://elsewhere.example.test/ag-ui" },
      ),
    ).toBe(false);
    expect(
      keyWouldFollowEndpoint(null, {
        endpoint: "https://elsewhere.example.test/ag-ui",
      }),
    ).toBe(false);
  });

  test("a stored key with no stored endpoint is still guarded", () => {
    expect(
      keyWouldFollowEndpoint(
        { auth: stored.auth },
        { endpoint: "https://elsewhere.example.test/ag-ui" },
      ),
    ).toBe(true);
  });
});
