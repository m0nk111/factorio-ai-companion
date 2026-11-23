local u = require("commands.init")
local M = {}
local statuses, directions = {}, {}
for name, value in pairs(defines.entity_status) do statuses[value] = name end
for name, value in pairs(defines.direction) do directions[value] = name end
local function position(p) return p and {x=p.x, y=p.y} or nil end
local function brief(e)
  return e and e.valid and {name=e.name, type=e.type, position=position(e.position)} or nil
end
-- Any centre whose floor() equals the requested tile is less than sqrt(2) tiles away.
local TILE_DISTANCE = math.sqrt(2)

function M.is_building(e)
  return e.valid and e.type ~= "character" and e.type ~= "resource" and e.type ~= "tree"
    and e.prototype.items_to_place_this and e.prototype.items_to_place_this[1] ~= nil
end

-- Target resolution for commands that name a building by position. The position a caller holds is
-- the entity's own centre (a 3x3 machine reports 33.5,-18.5), so the comparison is tile-granular:
-- any centre whose floor() matches the requested tile IS the building that was asked about. Such a
-- building wins over a neighbour that merely happens to be closer, and only an empty tile falls
-- back to the closest building within `radius` -- the search radius around the requested position.
function M.resolve(surface, pos, radius, accept)
  local tx, ty = math.floor(pos.x), math.floor(pos.y)
  -- Query wide enough to see the whole requested tile even when `radius` is small (rotate: 1).
  local search = math.max(radius, TILE_DISTANCE)
  local at_tile, tile_distance, closest, distance = nil, math.huge, nil, math.huge
  for _,e in ipairs(surface.find_entities_filtered{position=pos,radius=search}) do
    -- Mod helper entities may share the exact position of a real machine.
    if M.is_building(e) and (not accept or accept(e)) then
      local d = u.distance(e.position,pos)
      if math.floor(e.position.x) == tx and math.floor(e.position.y) == ty then
        if d < tile_distance then at_tile,tile_distance = e,d end
      elseif d <= radius and d < distance then closest,distance = e,d end
    end
  end
  return at_tile or closest
end

-- Response payload naming the building a command resolved, so a caller never has to guess which
-- one a fill/empty touched (or failed to touch).
M.summary = brief

function M.point(p) return string.format("(%.1f,%.1f)", p.x, p.y) end

-- "<name> at (x,y)" for success and failure messages; nil when nothing was resolved.
function M.label(e) return e and (e.name .. " at " .. M.point(e.position)) or nil end

function M.inventories(e)
  local caps = u.settings.entity_capabilities[e.type] or {}
  local result = {}
  local function add(slot, inventory)
    if inventory and inventory.valid then result[#result+1] = {slot=slot, inventory=inventory} end
  end
  if caps.crafting then
    add("input", e.get_inventory(defines.inventory.crafter_input))
    add("output", e.get_output_inventory())
  end
  if caps.inventory then add("inventory", e.get_inventory(defines.inventory[caps.inventory])) end
  add("fuel", e.get_fuel_inventory())
  return result
end

-- Shared by world_observe and building_info. LuaEntity exposes methods even when the
-- entity's native class cannot use them; inventory indices also alias across classes.
function M.describe(e, detailed)
  local result = {name=e.name, type=e.type, position=position(e.position), direction=e.direction,
    facing=directions[e.direction], force=e.force.name, health=e.health, max_health=e.max_health,
    status=statuses[e.status]}
  if e.type == "resource" then result.amount = e.amount end
  if not detailed or e.force.name == "neutral" then return result end
  local capabilities = u.settings.entity_capabilities[e.type] or {}
  for _, group in ipairs(M.inventories(e)) do result[group.slot] = u.inventory_contents(group.inventory) end
  result.energy = e.energy
  if capabilities.crafting then
    local recipe = e.get_recipe()
    result.recipe = recipe and recipe.name
    result.crafting_progress = e.crafting_progress
    result.products_finished = e.products_finished
  end
  if capabilities.mining then
    result.mining_target = brief(e.mining_target)
    result.mining_progress = e.mining_progress
  end
  if capabilities.drop then
    result.drop_position = position(e.drop_position)
    result.drop_target = brief(e.drop_target)
  end
  if capabilities.inserter then
    result.pickup_position = position(e.pickup_position)
    local stack = e.held_stack
    if stack and stack.valid_for_read then
      result.held_stack = {name=stack.name, count=stack.count, quality=stack.quality.name}
    end
  end
  return result
end

return M
