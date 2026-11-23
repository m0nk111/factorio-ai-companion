-- AI Companion - Factoriopedia
--
-- Everything the in-game factoriopedia shows is data on the prototypes:
-- `prototypes.recipe`, `prototypes.item`, `prototypes.entity`, `prototypes.fluid`
-- and `prototypes.technology`. Nothing in the mod exposed that, so a companion
-- could only learn what it could already craft and never why a thing is what it
-- is: no crafting time, no description, no "what turns this into that".
--
-- Factorio 2.x moved per-type statistics off the prototype onto accessors, and
-- reading a key that does not exist on a prototype raises instead of returning
-- nil. So every read below goes through pcall and every statistic goes through
-- the get_* form, otherwise a single missing field would take the whole answer
-- down.
local u = require("commands.init")

local MAX_RECIPES = 24
local KINDS = {"item", "recipe", "entity", "fluid", "technology"}

-- A LocalisedString is a nested array of strings and tables. Without the locale
-- tables the mod cannot resolve a key to words, so flatten what is there and let
-- the caller resolve names it already knows.
local function flatten(value, depth)
  depth = depth or 0
  if depth > 4 or value == nil then
    return nil
  end
  if type(value) == "string" then
    return value
  end
  if type(value) ~= "table" then
    return tostring(value)
  end
  local parts = {}
  for _, entry in ipairs(value) do
    local text = flatten(entry, depth + 1)
    if text then
      parts[#parts + 1] = text
    end
  end
  if #parts == 0 then
    return nil
  end
  return table.concat(parts, " ")
end

-- Reading a missing key on a prototype raises, so absence has to be asked for.
local function read(object, key)
  local ok, value = pcall(function()
    return object[key]
  end)
  if ok then
    return value
  end
  return nil
end

-- These are bound accessors, not plain functions: in 2.x get_max_health takes an
-- optional quality prototype, so passing the object as its own first argument
-- hands it over as a QualityID and raises.
local function call(object, method)
  local ok, value = pcall(function()
    return object[method]()
  end)
  if ok then
    return value
  end
  return nil
end

local function describe(prototype)
  return {
    name = prototype.name,
    localised_name = flatten(read(prototype, "localised_name")),
    description = flatten(read(prototype, "localised_description")),
  }
end

local function ingredient_list(list)
  local out = {}
  if type(list) ~= "table" then
    return out
  end
  for _, entry in ipairs(list) do
    local name = read(entry, "name")
    -- A fluid ingredient carries a type instead of a name.
    if not name and read(entry, "type") then
      name = read(entry, "type")
    end
    if name then
      out[#out + 1] = {name = name, amount = read(entry, "amount")}
    end
  end
  return out
end

local function amount_list(list)
  local out = {}
  if type(list) ~= "table" then
    return out
  end
  for _, entry in ipairs(list) do
    local name = read(entry, "name")
    if name then
      out[#out + 1] = {
        name = name,
        amount = read(entry, "amount"),
        probability = read(entry, "probability"),
        type = read(entry, "type"),
      }
    end
  end
  return out
end

-- Reverse lookup: which recipes consume, and which produce, a given thing. This
-- is the question the factoriopedia answers best and the one a companion asks
-- most ("where does this come from").
-- Space Age adds a recycling recipe for almost every item, so a bare reverse
-- lookup answers "which recipes make an iron gear wheel" with forty-seven hits
-- that are all "grind one down". They are kept, not discarded, but they come
-- last and are counted separately so the answer to the real question is first.
local function is_recycling(name)
  return name:find("%-recycling$") ~= nil
end

local function recipes_touching(name, want_products)
  local real, recycling = {}, {}
  local real_total, recycling_total = 0, 0
  for _, recipe in pairs(prototypes.recipe) do
    local hit = false
    local entries = want_products and read(recipe, "products") or read(recipe, "ingredients")
    if type(entries) == "table" then
      for _, entry in ipairs(entries) do
        if read(entry, "name") == name then
          hit = true
          break
        end
      end
    end
    if hit then
      if is_recycling(recipe.name) then
        recycling_total = recycling_total + 1
        if #recycling < MAX_RECIPES then
          recycling[#recycling + 1] = recipe.name
        end
      else
        real_total = real_total + 1
        if #real < MAX_RECIPES then
          real[#real + 1] = recipe.name
        end
      end
    end
  end
  table.sort(real)
  table.sort(recycling)
  -- Recycling stays reachable when nothing else produces the thing at all.
  if #real > 0 then
    return real, real_total, recycling_total
  end
  return recycling, recycling_total, recycling_total
end

local function item_detail(prototype)
  local detail = describe(prototype)
  detail.kind = "item"
  detail.item_type = read(prototype, "type")
  detail.stack_size = read(prototype, "stack_size")
  detail.weight = read(prototype, "weight")
  detail.fuel_value = read(prototype, "fuel_value")
  detail.spoil_ticks = read(prototype, "spoil_ticks")
  local subgroup = read(prototype, "subgroup")
  detail.subgroup = subgroup and read(subgroup, "name") or nil
  detail.place_result = read(prototype, "place_result")

  local produced, produced_total, produced_recycling = recipes_touching(prototype.name, true)
  detail.recipes_producing, detail.recipes_producing_total = produced, produced_total
  detail.recipes_producing_recycling_total = produced_recycling > 0 and produced_recycling or nil
  local used, used_total, used_recycling = recipes_touching(prototype.name, false)
  detail.recipes_using, detail.recipes_using_total = used, used_total
  detail.recipes_using_recycling_total = used_recycling > 0 and used_recycling or nil
  return detail
end

local function recipe_detail(prototype)
  local detail = describe(prototype)
  detail.kind = "recipe"
  detail.category = table.concat(read(prototype, "categories") or {}, ",")
  -- energy is the crafting time in seconds at crafting speed 1.
  detail.crafting_time = read(prototype, "energy")
  detail.ingredients = ingredient_list(read(prototype, "ingredients"))
  detail.products = amount_list(read(prototype, "products"))
  detail.hidden = read(prototype, "hidden")
  detail.allow_productivity = read(prototype, "allow_productivity")
  detail.main_product = read(prototype, "main_product")
  detail.enabled = read(prototype, "enabled")
  return detail
end

local function entity_detail(prototype)
  local detail = describe(prototype)
  detail.kind = "entity"
  detail.entity_type = read(prototype, "type")
  detail.max_health = call(prototype, "get_max_health")
  detail.crafting_speed = call(prototype, "get_crafting_speed")
  detail.mining_speed = read(prototype, "mining_speed")
  detail.energy_usage = read(prototype, "energy_usage")
  detail.module_slots = read(prototype, "module_inventory_size")
  detail.tile_width = read(prototype, "tile_width")
  detail.tile_height = read(prototype, "tile_height")
  detail.rotatable = read(prototype, "rotatable")

  local place = read(prototype, "items_to_place_this")
  local items = {}
  if type(place) == "table" then
    for _, entry in ipairs(place) do
      local name = read(entry, "name")
      if name then
        items[#items + 1] = name
      end
    end
  end
  detail.placed_by = items
  return detail
end

local function fluid_detail(prototype)
  local detail = describe(prototype)
  detail.kind = "fluid"
  detail.default_temperature = read(prototype, "default_temperature")
  detail.max_temperature = read(prototype, "max_temperature")
  detail.fuel_value = read(prototype, "fuel_value")

  local produced, produced_total, produced_recycling = recipes_touching(prototype.name, true)
  detail.recipes_producing, detail.recipes_producing_total = produced, produced_total
  detail.recipes_producing_recycling_total = produced_recycling > 0 and produced_recycling or nil
  local used, used_total, used_recycling = recipes_touching(prototype.name, false)
  detail.recipes_using, detail.recipes_using_total = used, used_total
  detail.recipes_using_recycling_total = used_recycling > 0 and used_recycling or nil
  return detail
end

local function technology_detail(prototype)
  local detail = describe(prototype)
  detail.kind = "technology"

  -- Factorio 2.x dropped the research unit from the prototype: the cost lives on
  -- the per-force technology, which is also where the researched state is.
  local technology = game.forces.player.technologies[prototype.name]
  if technology then
    local energy = read(technology, "research_unit_energy")
    detail.research_unit_count = read(technology, "research_unit_count")
    detail.research_unit_energy = energy
    -- Energy is in ticks; 60 ticks is a second at the default speed.
    detail.research_unit_seconds = energy and (energy / 60) or nil
    detail.research_unit_ingredients = amount_list(
      read(technology, "research_unit_ingredients")
    )
    detail.researched = read(technology, "researched")
    detail.enabled = read(technology, "enabled")
    detail.level = read(technology, "level")
  end

  -- pairs, not ipairs: these arrays come from the prototype store and a length
  -- that reads as 0 must not hide entries that are there.
  local prerequisites = {}
  local prerequisite_list = read(prototype, "prerequisites")
  if type(prerequisite_list) == "table" then
    for _, entry in pairs(prerequisite_list) do
      local name = read(entry, "name")
      if name then
        prerequisites[#prerequisites + 1] = name
      end
    end
  end
  table.sort(prerequisites)
  detail.prerequisites = prerequisites

  local effects = {}
  local effect_list = read(prototype, "effects")
  if type(effect_list) == "table" then
    for _, entry in pairs(effect_list) do
      effects[#effects + 1] = {type = read(entry, "type"), recipe = read(entry, "recipe")}
    end
  end
  detail.effects = effects
  return detail
end

local DETAIL = {
  item = item_detail,
  recipe = recipe_detail,
  entity = entity_detail,
  fluid = fluid_detail,
  technology = technology_detail,
}

local function resolve(name, kind)
  if kind then
    local prototype = prototypes[kind] and prototypes[kind][name]
    if prototype then
      return kind, prototype
    end
    return nil, nil
  end
  -- No kind given: answer with whatever exists under that name, in an order that
  -- prefers the thing a player usually means by a bare name.
  for _, candidate in ipairs(KINDS) do
    local prototype = prototypes[candidate] and prototypes[candidate][name]
    if prototype then
      return candidate, prototype
    end
  end
  return nil, nil
end

u.register("prototype_info", function(args)
  u.safe_command(function()
    local name = args and args.name
    if not name or name == "" then
      u.error_response("prototype_info needs a name")
      return
    end

    local kind = args.kind
    if kind == "" then
      kind = nil
    end
    if kind and not DETAIL[kind] then
      u.error_response("unknown kind '" .. tostring(kind) .. "'; use " .. table.concat(KINDS, ", "))
      return
    end

    local resolved_kind, prototype = resolve(name, kind)
    if not prototype then
      u.json_response({
        found = false,
        name = name,
        kind = kind,
        searched = kind and {kind} or KINDS,
      })
      return
    end

    local detail = DETAIL[resolved_kind](prototype)
    detail.found = true
    u.json_response(detail)
  end)
end)

return {}