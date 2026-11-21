import { test, expect } from "bun:test";
import {
  buildRCONCommand,
  COMMANDS,
  generateToolSchemas,
  validateToolArgs,
} from "../src/mcp/schema";
import { readSettings } from "../config/settings";
import { generate } from "../scripts/generate";

test("the generated Lua/mod/env files match the canonical configuration", () => generate(true));
test("MCP and Codex share the complete tool contract", () => {
  expect(generateToolSchemas().map((tool) => tool.name)).toEqual(Object.keys(COMMANDS));
  expect(Object.keys(COMMANDS)).not.toContain("chat_get");
});
test("required properties are declared in every tool schema, including nested schemas", () => {
  function check(schema: unknown, path: string): void {
    if (schema === null || typeof schema !== "object") return;
    const node = schema as Record<string, unknown>;
    for (const required of (node.required as string[] | undefined) ?? []) {
      expect(
        Object.hasOwn((node.properties ?? {}) as object, required),
        `${path}: required property ${required} must be declared`,
      ).toBe(true);
    }
    for (const keyword of ["properties", "$defs", "definitions", "patternProperties"]) {
      for (const [name, child] of Object.entries((node[keyword] ?? {}) as object))
        check(child, `${path}/${keyword}/${name}`);
    }
    for (const keyword of [
      "items",
      "additionalProperties",
      "not",
      "contains",
      "if",
      "then",
      "else",
    ])
      check(node[keyword], `${path}/${keyword}`);
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"])
      for (const [index, child] of ((node[keyword] ?? []) as unknown[]).entries())
        check(child, `${path}/${keyword}/${index}`);
  }
  for (const tool of generateToolSchemas()) check(tool.inputSchema, tool.name);
});
test("help advertises and accepts empty named arguments", () => {
  expect(generateToolSchemas().find((tool) => tool.name === "help")?.inputSchema).toEqual({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
  expect(validateToolArgs("help", {})).toEqual({});
  expect(buildRCONCommand("help", {})).toBe('/fac_api {"tool":"help","args":{}}');
  expect(() => validateToolArgs("help", { category: "all" })).toThrow();
});
test("named RCON arguments preserve Unicode, negative coordinates and literal newlines", () => {
  const message = 'ñ "hola"\n/fac kill\\';
  const command = buildRCONCommand("chat_say", { companionId: 0, message });
  expect(command).not.toContain("\n");
  expect(JSON.parse(command.slice(9)).args.message).toBe(message);
  expect(validateToolArgs("move_to", { companionId: 1, x: -1.25, y: 0 }).x).toBe(-1.25);
});
test("contract rejects unknown tools, extra arguments and invalid limits", () => {
  expect(() => validateToolArgs("__proto__", {})).toThrow();
  expect(() => validateToolArgs("companion_stop", { companionId: 1, surprise: true })).toThrow();
  expect(() => validateToolArgs("world_observe", { radius: 999 })).toThrow();
  expect(() => validateToolArgs("task_submit", { companionId: 1, steps: "[]" })).toThrow();
  expect(validateToolArgs("world_observe", {})).toMatchObject({ companionId: 0, radius: 48 });
});
test("environment configuration rejects invalid values and uses one set of defaults", () => {
  expect(readSettings({}).FACTORIO_RCON_PORT).toBe(34198);
  expect(() => readSettings({ COMPANION_PORT: "NaN" })).toThrow();
  expect(() => readSettings({ MAX_TOOL_CALLS: "0" })).toThrow();
});
