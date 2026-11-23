import { test, expect } from "bun:test";
import {
  buildRCONCommand,
  COMMANDS,
  normalizeDirection,
  validateToolArgs,
} from "../src/mcp/schema";

// Models reason in Factorio 2.x's 16-way defines.direction (north=0, east=4, south=8,
// west=12, diagonals in between); the mod indexes a 0-3 cardinal map. The server accepts both
// conventions and only ever sends 0-3 to the game, so no in-game update is required.
type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;
const DIRECTIONS: Record<string, (direction: number) => Args> = {
  building_can_place: (direction) => ({
    companionId: 1,
    entityName: "wooden-chest",
    x: 0.5,
    y: 0.5,
    direction,
  }),
  building_place: (direction) => ({
    companionId: 1,
    entityName: "wooden-chest",
    x: 0.5,
    y: 0.5,
    direction,
  }),
  building_place_start: (direction) => ({
    companionId: 1,
    entityName: "wooden-chest",
    x: 0.5,
    y: 0.5,
    direction,
  }),
  building_rotate: (direction) => ({ companionId: 1, x: 0.5, y: 0.5, direction }),
  blueprint_build: (direction) => ({ companionId: 1, name: "base", x: 0, y: 0, direction }),
};

function directionProperties(): { tool: string; schema: Schema }[] {
  const found: { tool: string; schema: Schema }[] = [];
  const walk = (schema: Schema, tool: string) => {
    if (schema.type === "array") {
      if (schema.items) walk(schema.items as Schema, tool);
      return;
    }
    for (const [key, property] of Object.entries(
      (schema.properties ?? {}) as Record<string, Schema>,
    ))
      if (key === "direction") found.push({ tool, schema: property });
      else walk(property, tool);
  };
  for (const tool of Object.keys(DIRECTIONS))
    walk(COMMANDS[tool]!.inputSchema as unknown as Schema, tool);
  walk(COMMANDS.blueprint_save!.inputSchema as unknown as Schema, "blueprint_save");
  return found;
}

test("normalizeDirection keeps the 0-3 cardinals and folds 16-way values onto them", () =>
  expect([...Array(16).keys()].map(normalizeDirection)).toEqual([
    0, 1, 2, 3, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  ]));

test("every direction property in the contract accepts the 16 Factorio 2.x values", () => {
  const properties = directionProperties();
  expect(properties.map((entry) => entry.tool).sort()).toEqual([
    "blueprint_build",
    "blueprint_save",
    "building_can_place",
    "building_place",
    "building_place_start",
    "building_rotate",
  ]);
  for (const { tool, schema } of properties) {
    expect({
      tool,
      range: [schema.minimum, schema.maximum],
      documented: schema.description,
    }).toEqual({
      tool,
      range: [0, 15],
      documented: expect.stringContaining("16-way"),
    });
  }
});

test("cardinal directions 0-3 pass through exactly as before the fix", () => {
  for (const [tool, build] of Object.entries(DIRECTIONS))
    for (const direction of [0, 1, 2, 3])
      expect({
        tool,
        direction,
        normalized: validateToolArgs(tool, build(direction)).direction,
      }).toEqual({ tool, direction, normalized: direction });
});

test("16-way directions reach the game as the 0-3 cardinal the mod handles", () => {
  // floor(direction / 4) buckets the 16 steps onto the 8 known cardinals: each cardinal
  // covers the four steps from itself up to the step before the next cardinal.
  const expected: Record<number, number> = { 4: 1, 5: 1, 7: 1, 8: 2, 11: 2, 12: 3, 15: 3 };
  for (const [tool, build] of Object.entries(DIRECTIONS))
    for (const [direction, cardinal] of Object.entries(expected))
      expect({
        tool,
        direction: Number(direction),
        normalized: validateToolArgs(tool, build(Number(direction))).direction,
      }).toEqual({ tool, direction: Number(direction), normalized: cardinal });
});

test("the RCON payload carries only the normalized cardinal direction", () => {
  const command = buildRCONCommand("building_can_place", {
    companionId: 1,
    entityName: "wooden-chest",
    x: 0.5,
    y: 0.5,
    direction: 12,
  });
  expect(JSON.parse(command.slice("/fac_api ".length)).args.direction).toBe(3);
});

test("blueprint entity directions are normalized the same way", () => {
  const args = validateToolArgs("blueprint_save", {
    name: "base",
    entities: [
      { name: "wooden-chest", x: 0, y: 0, direction: 8 },
      { name: "wooden-chest", x: 1, y: 0, direction: 2 },
    ],
  });
  expect((args.entities as { direction: number }[]).map((entity) => entity.direction)).toEqual([
    2, 2,
  ]);
});

test("directions outside 0-15 are rejected, not silently clamped", () => {
  const build = DIRECTIONS.building_can_place!;
  expect(() => validateToolArgs("building_can_place", build(16))).toThrow(/<=15/);
  expect(() => validateToolArgs("building_can_place", build(-1))).toThrow(/>=0/);
  expect(() => validateToolArgs("building_can_place", build(4.5))).toThrow(/expected int/);
});
