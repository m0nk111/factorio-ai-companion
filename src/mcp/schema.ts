import { z } from "zod";
import definitions from "../../config/commands.json";
export type InputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: boolean;
};
export interface CommandDefinition {
  description: string;
  execution: "game" | "session" | "wait";
  effect: "read" | "chat" | "act";
  inputSchema: InputSchema;
  before?: string[];
  continuation?: "none" | "timer";
}
export const COMMANDS = definitions as Record<string, CommandDefinition>;
const validators = new Map(
  Object.entries(COMMANDS).map(([name, definition]) => [
    name,
    z.fromJSONSchema(definition.inputSchema),
  ]),
);
const CARDINALS = 4;
/**
 * Models speak Factorio 2.x's 16-way `defines.direction` (north=0, east=4, south=8,
 * west=12, diagonals in between), while the mod's handlers index the 0-3 cardinal map in
 * `commands/init.lua`. Both conventions are accepted on the way in and the game layer only
 * ever receives 0-3, so accepting 16-way values needs no mod update.
 */
export function normalizeDirection(direction: number): number {
  return direction < CARDINALS ? direction : Math.floor(direction / CARDINALS) % CARDINALS;
}
/** Normalize every `direction` property in a parsed argument tree, nested ones included. */
function normalizeDirections(schema: Record<string, unknown>, value: unknown): void {
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items)
      for (const item of Array.isArray(value) ? value : []) normalizeDirections(items, item);
    return;
  }
  if (schema.type !== "object" || typeof value !== "object" || value === null) return;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, property] of Object.entries(properties)) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    if (key === "direction" && typeof field === "number")
      (value as Record<string, unknown>)[key] = normalizeDirection(field);
    else normalizeDirections(property, field);
  }
}
export function validateToolArgs(name: string, raw: unknown): Record<string, unknown> {
  const definition = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!definition) throw new Error("Unknown tool: " + name);
  const args = validators.get(name)!.parse(raw ?? {}) as Record<string, unknown>;
  for (const [key, schema] of Object.entries(definition.inputSchema.properties))
    if (args[key] === undefined && schema.default !== undefined) args[key] = schema.default;
  // Out-of-range directions never reach this point: the schema range (0-15) rejects them.
  normalizeDirections(definition.inputSchema as unknown as Record<string, unknown>, args);
  return args;
}
export function buildRCONCommand(name: string, raw: unknown): string {
  return "/fac_api " + JSON.stringify({ tool: name, args: validateToolArgs(name, raw) });
}
export function generateToolSchemas() {
  return Object.entries(COMMANDS).map(([name, definition]) => ({
    name,
    description:
      definition.description +
      (definition.before?.includes("companion_stop")
        ? " This command cancels all current work for this companion, including mining, crafting and tasks."
        : ""),
    inputSchema: definition.inputSchema,
  }));
}
