import { describe, expect, test } from "bun:test";
import { parseCodingAgent } from "./coding-agent";
import {
  type ModelCapabilities,
  parseModelSettings,
  validateModelChoice,
} from "./model-settings";

const capabilities: ModelCapabilities = {
  framework: "test",
  defaultModel: "reasoning",
  customModels: false,
  models: [
    { id: "reasoning", name: "Reasoning", efforts: ["low", "high"] },
    { id: "fast", name: "Fast", efforts: [] },
  ],
};
describe("conversation model choices", () => {
  test("rejects provider endpoints and credentials in per-turn settings", () => {
    for (const input of [
      null,
      [],
      { apiKey: "secret" },
      { endpoint: "http://localhost" },
      { model: "x\nheader" },
      { effort: "automatic" },
    ])
      expect(() => parseModelSettings(input)).toThrow();
  });
  test("uses the selected model's capabilities, including an explicit reset", () => {
    expect(parseModelSettings({ model: "", effort: "" })).toEqual({});
    expect(parseModelSettings({ model: "claude-fable-5[1m]" })).toEqual({
      model: "claude-fable-5[1m]",
    });
    expect(() =>
      validateModelChoice({ effort: "high" }, capabilities),
    ).not.toThrow();
    expect(() =>
      validateModelChoice({ model: "fast", effort: "high" }, capabilities),
    ).toThrow();
    expect(() =>
      validateModelChoice({ model: "missing" }, capabilities),
    ).toThrow();
    expect(() =>
      validateModelChoice(
        { model: "missing" },
        { ...capabilities, customModels: true },
      ),
    ).not.toThrow();
  });
  test("coding profiles accept no shell command or unrestricted permission mode", () => {
    const valid = {
      framework: "codex",
      cwd: "/tmp/project",
      permission: "read-only",
    };
    expect(parseCodingAgent(valid).defaults).toEqual({});
    expect(() =>
      parseCodingAgent({ ...valid, framework: "bash -c bad" }),
    ).toThrow();
    expect(() => parseCodingAgent({ ...valid, cwd: "../project" })).toThrow();
    expect(() =>
      parseCodingAgent({ ...valid, permission: "danger-full-access" }),
    ).toThrow();
  });
});
