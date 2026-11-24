defines = {direction={north=0,northeast=2,east=4,southeast=6,south=8,southwest=10,west=12,northwest=14}, inventory={character_main=1,turret_ammo=1,artillery_turret_ammo=1,artillery_wagon_ammo=1,car_ammo=3,spider_ammo=3}, shooting={not_shooting=0}, entity_status={working=1}}
-- Fengari's Lua 5.3 atan(y, x) supplies Factorio's Lua 5.2 atan2.
math.atan2 = math.atan
storage = {companions={}, walking_queues={}, tasks={}, reserved={}, active_step={}, path_requests={}, errors={}}
game = {tick=0, print=function() end, forces={}, surfaces={},players={},connected_players={}}
prototypes = {recipe={gear={energy=0.5,categories={"crafting"},ingredients={}}}, entity={
  ore={type="resource",mineable_properties={products={{type="item",name="ore"}}}}
}}
-- Factoriopedia shape: Factorio 2.x exposes per-type statistics through get_*
-- accessors and raises on a key the prototype does not have, so a fixture that
-- only carries plain fields would hide exactly the bugs a lookup can hit.
-- A recipe that consumes the gear, so the reverse lookup is exercised in the
-- direction a companion asks most: "what do I need this for".
prototypes.recipe["automation-science-pack"] = {
  name="automation-science-pack", energy=5, categories={"crafting"},
  ingredients={{name="copper-plate", amount=1}, {name="iron-gear-wheel", amount=1}},
  products={{name="automation-science-pack", amount=1}}
}
prototypes.recipe["iron-gear-wheel"] = {
  name="iron-gear-wheel", energy=0.5, categories={"crafting"},
  ingredients={{name="iron-plate", amount=2}}, products={{name="iron-gear-wheel", amount=1}},
  localised_name={"recipe-name.iron-gear-wheel"}, hidden=false, allow_productivity=true
}
prototypes.item = {
  ["iron-gear-wheel"] = {
    name="iron-gear-wheel", type="item", stack_size=100, weight=1000,
    localised_name={"item-name.iron-gear-wheel"},
    localised_description={"item-description.iron-gear-wheel"},
    subgroup={name="intermediate-product"}
  },
  ["assembling-machine-1"] = {
    name="assembling-machine-1", type="item", stack_size=50,
    place_result="assembling-machine-1"
  }
}
prototypes.entity["assembling-machine-1"] = {
  name="assembling-machine-1", type="assembling-machine",
  tile_width=3, tile_height=3, module_inventory_size=0, energy_usage=1250,
  -- Bound accessors: real Factorio treats a supplied argument as an optional
  -- quality prototype and raises "Invalid QualityID" for anything else, so the
  -- fixture raises too. Without this a regression from `obj[method]()` to
  -- `obj[method](obj)` would pass the suite silently.
  get_max_health=function(...)
    assert(select("#", ...) == 0, "get_max_health takes no arguments")
    return 300
  end,
  get_crafting_speed=function(...)
    assert(select("#", ...) == 0, "get_crafting_speed takes no arguments")
    return 0.5
  end
}
-- A product may be a range with a probability instead of a fixed amount.
prototypes.recipe["sulfuric-acid"] = {
  name="sulfuric-acid", category="chemistry", energy_required=1,
  ingredients={{type="fluid", name="water", amount=100}},
  products={{type="fluid", name="sulfuric-acid", amount_min=50, amount_max=100, probability=0.5}},
}
-- The same name as an item and as a fluid. A reverse lookup must not mix them.
prototypes.item["test-shared"] = {name="test-shared", type="item", stack_size=10}
prototypes.recipe["shared-item"] = {
  name="shared-item", category="crafting", energy_required=1,
  ingredients={{type="item", name="iron-plate", amount=1}},
  products={{type="item", name="test-shared", amount=1}},
}
prototypes.recipe["shared-fluid"] = {
  name="shared-fluid", category="chemistry", energy_required=1,
  ingredients={{type="fluid", name="water", amount=10}},
  products={{type="fluid", name="test-shared", amount=1}},
}
prototypes.fluid = {water={name="water", default_temperature=15, max_temperature=100},
  ["test-shared"]={name="test-shared", default_temperature=25, max_temperature=25}}
prototypes.technology = {logistics={
  name="logistics",
  prerequisites={{name="automation"}},
  effects={{type="unlock-recipe", recipe="fast-inserter"}}
},
  ["weapon-damage"]={
    name="weapon-damage",
    prerequisites={},
    -- A bonus, not a recipe: the category, the modifier and its ceiling are the
    -- answer to "what does this research give me".
    effects={{type="ammo-damage", ammo_category={name="bullet"}, modifier=0.1, maximum=1.2}}
  }
}
-- The research unit is per-force in Factorio 2.x, not on the prototype.
game.forces.player = game.forces.player or {technologies={}}
game.forces.player.technologies = {logistics={
  research_unit_count=20, research_unit_energy=600,
  research_unit_ingredients={{name="automation-science-pack", amount=1}},
  researched=false, enabled=true, level=1
}}
items = {plate=20}
local inventory = {valid=true}
inventory.get_item_count = function(name)
  if name then return items[name] or 0 end
  local total=0; for _, count in pairs(items) do total=total+count end; return total
end
inventory.get_contents = function()
  local result={}; for name,count in pairs(items) do result[#result+1]={name=name,count=count,quality="normal"} end; return result
end
entity = {valid=true, position={x=0,y=0}, crafting_queue={}, crafting_queue_size=0,
  crafting_queue_progress=0, mining_state={mining=false}, walking_state={walking=false},
  prototype={crafting_categories={crafting=true}},
  force={recipes={gear={enabled=true}}, technologies={}}, surface={}}
entity.surface.find_logistic_networks_by_construction_area=function() return {} end
entity.force.add_chart_tag=function() return {valid=true,destroy=function() end} end
entity.get_main_inventory = function() return inventory end
entity.get_inventory = function() return inventory end
entity.get_craftable_count = function() return math.floor(items.plate/2) end
entity.begin_crafting = function(args)
  local count=math.min(args.count, entity.get_craftable_count())
  items.plate=items.plate-count*2
  if count>0 then
    entity.crafting_queue[#entity.crafting_queue+1]={recipe=args.recipe,count=count,index=#entity.crafting_queue+1}
    entity.crafting_queue_size=#entity.crafting_queue
  end
  return count
end
entity.cancel_crafting = function(args)
  local job=entity.crafting_queue[args.index]
  local count=math.min(args.count,job.count)
  items.plate=items.plate+count*2; job.count=job.count-count
  if job.count==0 then table.remove(entity.crafting_queue,args.index) end
  entity.crafting_queue_size=#entity.crafting_queue
  entity.crafting_queue_progress=0
end
storage.companions[1]={entity=entity,name="Atlas"}
u = require("commands.init")
u.fire_craft_triggers = function() end
queues = require("commands.queues")
queues.init()
function advance(ticks)
  for _=1,ticks do
    game.tick=game.tick+1
    local native=entity.crafting_queue[1]
    if native then
      entity.crafting_queue_progress=entity.crafting_queue_progress+1/60
      if entity.crafting_queue_progress>=0.9999 then
        items.gear=(items.gear or 0)+1
        native.count=native.count-1
        if native.count==0 then table.remove(entity.crafting_queue,1) end
        entity.crafting_queue_size=#entity.crafting_queue
        entity.crafting_queue_progress=0
      end
    end
    if game.tick%5==0 then queues.tick_craft_queues() end
  end
end
