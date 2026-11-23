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
test("a small observation radius reaches the game and the schema advertises its clamp", () => {
  expect(validateToolArgs("world_observe", { radius: 5 })).toMatchObject({ radius: 5 });
  const radius = COMMANDS.world_observe!.inputSchema.properties.radius!;
  expect({ minimum: radius.minimum, maximum: radius.maximum, default: radius.default }).toEqual({
    minimum: 1,
    maximum: 96,
    default: 48,
  });
  expect(String(radius.description)).toContain("8..96");
  expect(() => validateToolArgs("world_observe", { radius: 0 })).toThrow();
  expect(() => validateToolArgs("world_observe", { radius: 97 })).toThrow();
});
test("targeting commands describe their radius as a search radius", () => {
  for (const name of ["building_fill", "building_empty", "building_info", "building_fuel"])
    expect(COMMANDS[name]!.description).toContain("SEARCH radius");
  expect(COMMANDS.building_fill!.description).toContain("3 tiles");
  expect(COMMANDS.building_empty!.description).toContain("5 tiles");
  expect(COMMANDS.building_info!.description).toContain("2 tiles");
  expect(COMMANDS.building_fill!.description).toContain("reach distance");
  expect(COMMANDS.building_empty!.description).toContain("reach distance");
});
test("environment configuration rejects invalid values and uses one set of defaults", () => {
  expect(readSettings({}).FACTORIO_RCON_PORT).toBe(34198);
  expect(() => readSettings({ COMPANION_PORT: "NaN" })).toThrow();
  expect(() => readSettings({ MAX_TOOL_CALLS: "0" })).toThrow();
});
