import { test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config";

// Execute production Lua without starting Factorio. Engine APIs are deterministic fakes;
// real engine/pathfinding coverage remains in the explicitly invoked test:game suite.
const { lua, lauxlib, lualib, to_luastring } = require("fengari");
const directory = join(PROJECT_ROOT, "factorio-mod/commands");
const modules = readdirSync(directory)
  .filter((name) => name.endsWith(".lua"))
  .map(
    (name) =>
      `package.preload["commands.${name.slice(0, -4)}"] = function(...)\n${readFileSync(join(directory, name), "utf8")}\nend`,
  )
  .join("\n");
const fixture = readFileSync(join(PROJECT_ROOT, "tests/fixtures/game.lua"), "utf8");
const guiFixture = readFileSync(join(PROJECT_ROOT, "tests/fixtures/gui.lua"), "utf8");
const control = `package.preload["control"] = function(...)\n${readFileSync(join(PROJECT_ROOT, "factorio-mod/control.lua"), "utf8")}\nend`;
function run(source: string) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    const status = lauxlib.luaL_dostring(
      state,
      to_luastring(modules + "\n" + control + "\n" + fixture + "\n" + source),
    );
    if (status !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(state, -1));
  } finally {
    lua.lua_close(state);
  }
}

test("Lua: wood resolves to harvestable trees and failed gather validates before queuing", () =>
  run(`
  local resources=require("commands.resource_query")
  local tree={valid=true,type="tree",name="tree-01",position={x=1,y=0},
    prototype={mineable_properties={products={{name="wood",type="item",amount=4}}}}}
  entity.surface.find_entities_filtered=function(args)
    assert(args.name~="wood", "wood is a product, not an entity")
    return args.type=="tree" and {tree} or {}
  end
  entity.surface.count_entities_filtered=function() return 0 end
  entity.surface.find_non_colliding_position=function(_,p) return p end
  entity.get_main_inventory().can_insert=function() return true end
  assert(queues.start_gather(1,"does-not-exist",4).error and not storage.gather_queues[1])
  assert(not queues.start_gather(1,"wood",4).error)
  queues.tick_gather_queues(); queues.tick_gather_queues(); queues.tick_gather_queues()
  assert(entity.selected==tree and entity.mining_state.mining)
  items.wood=4; game.tick=100; queues.tick_gather_queues()
  for _=1,2 do
    local s=queues.get_gather_status(1)
    assert(not s.active and s.state=="done" and s.gathered==4 and s.run_end_tick==100)
  end
  assert(#storage.errors==0)
`));

test("Lua: resource lookup sorts all candidates before limiting and filters by product", () =>
  run(`
  require("commands.resource")
  local ores={}
  for x=120,1,-1 do ores[#ores+1]={valid=true,type="resource",name="ore",amount=100,position={x=x,y=0},prototype=prototypes.entity.ore} end
  entity.surface.find_entities_filtered=function(args)
    assert(not args.limit and args.name=="ore")
    local found={}; for _,ore in ipairs(ores) do if ore.position.x<=args.radius then found[#found+1]=ore end end
    return found
  end
  local result; u.json_response=function(value) result=value end
  u.handlers.resource_nearest{companionId=1,resourceType="ore"}
  assert(result.position.x==1 and result.distance==1)
  u.handlers.resource_list{companionId=1,filter="ore",radius=200}
  assert(result.count==20 and result.resources[1].position.x==1 and result.resources[20].position.x==20)
`));

test("Lua: an exception terminates only the failed companion job and logs once", () =>
  run(`
  local core=require("commands.queues_core")
  storage.companions[2]={entity=entity,name="Grace"}
  storage.gather_queues[1]={state="find"};storage.gather_queues[2]={state="find"}
  local ran=false
  local function process(cid) if cid==1 then error("broken target") end; ran=true; return true end
  core.process_queue("gather_queues",process);core.process_queue("gather_queues",process)
  assert(ran and #storage.errors==1)
  assert(core.previous("gather_queues",1).state=="failed")
  assert(core.previous("gather_queues",2).state=="done")
`));

test("Lua: a chest reports one inventory despite the fuel enum alias and nearby ore", () =>
  run(`
  defines.inventory.chest=1;defines.inventory.fuel=1
  local chest={valid=true,name="wooden-chest",type="container",prototype={items_to_place_this={{name="wooden-chest",count=1}}},position={x=1,y=0},
    get_inventory=function(index) assert(index==1);return {valid=true,get_contents=function() return {{name="iron-plate",count=5,quality="normal"}} end} end,
    get_fuel_inventory=function() return nil end}
  entity.surface.find_entities_filtered=function() return {{valid=true,type="resource",prototype={},position={x=1,y=0}},chest} end
  require("commands.companion")
  local result;u.json_response=function(value) result=value end
  u.handlers.companion_inventory{companionId=1,x=1,y=0}
  assert(result.entity=="wooden-chest" and #result.items==1 and result.items[1].count==5)
`));

test("Lua: hand crafting distinguishes locked recipes, machine categories and missing items", () =>
  run(`
  entity.force.recipes.gear.enabled=false
  assert(queues.start_craft(1,"gear",1).error:find("locked"))
  entity.force.recipes.gear.enabled=true; prototypes.recipe.gear.categories={"smelting"}
  assert(queues.start_craft(1,"gear",1).error:find("not hand%-craftable"))
  prototypes.recipe.gear.categories={"crafting"};items.plate=0
  assert(queues.start_craft(1,"gear",1).error=="Missing ingredients")
  assert(not storage.craft_queues[1] and entity.crafting_queue_size==0)
`));

test("Lua: rotation targets the machine instead of a mod helper at the same position", () =>
  run(`
  local helper={valid=true,name="erm_attackable_entity_beacon",type="beacon",rotatable=true,position={x=1,y=0},prototype={}}
  local drill={valid=true,name="burner-mining-drill",type="mining-drill",rotatable=true,position={x=1,y=0},
    prototype={items_to_place_this={{name="burner-mining-drill",count=1}}},direction=0}
  entity.surface.find_entities_filtered=function() return {helper,drill} end
  local result;u.json_response=function(value) result=value end
  require("commands.building")
  u.handlers.building_rotate{companionId=1,x=1,y=0,direction=2}
  assert(result.rotated=="burner-mining-drill" and drill.direction==defines.direction.south)
  assert(helper.direction==nil)
`));

test("Lua: world_observe takes a radius the game clamps instead of rejecting the request", () =>
  run(`
  script={active_mods={["ai-companion"]="test"}}
  commands={add_command=function() end}
  entity.surface.get_pollution=function() return 0 end
  entity.surface.darkness=0
  entity.force.get_spawn_position=function() return {x=0,y=0} end
  entity.force.is_chunk_charted=function() return true end
  local searched={}
  entity.surface.find_entities_filtered=function(args) searched[#searched+1]=args.radius;return {} end
  entity.surface.find_tiles_filtered=function(args) searched[#searched+1]=args.radius;return {} end
  require("commands.observation")
  -- The in-game dispatcher validates against the regenerated contract, so a radius of 5 has to
  -- pass the SAME schema the MCP tool uses. Every other handler is stubbed.
  for name,def in pairs(require("commands.contract")) do
    if def.execution=="game" and not u.handlers[name] then u.handlers[name]=function() u.json_response{} end end
  end
  local result=require("commands.dispatch").call("world_observe",{companionId=1,radius=5})
  assert(result.error==nil, result.error)
  assert(result.radius==8, "the game must clamp the observation window to its 8-tile floor")
  assert(searched[1]==8 and searched[2]==8, "both observation queries must use the clamped radius")
  assert(result.entities_total==0)
`));

test("Lua: machine-only resources remain discoverable but cannot start a hand-mining job", () =>
  run(`
  prototypes.entity.oil={type="resource",mineable_properties={products={{name="crude-oil",type="fluid"}}}}
  local query=require("commands.resource_query")
  local selector=query.resolve("oil")
  assert(selector and not selector.hand_mineable)
  local oil={valid=true,name="oil",type="resource",amount=100,position={x=0,y=0},prototype=prototypes.entity.oil}
  assert(query.available(oil,selector))
  assert(queues.start_gather(1,"oil",1).error:find("mining machine"))
  assert(not storage.gather_queues[1])
`));

test("Lua: extraction preserves quality and uses the shared inventory groups", () =>
  run(`
  require("commands.building")
  defines.inventory.chest=1
  local remaining=4
  local inv={valid=true,get_contents=function() return {{name="iron-plate",quality="uncommon",count=remaining}} end,
    remove=function(item) assert(item.quality=="uncommon");remaining=remaining-item.count;return item.count end,
    insert=function(item) assert(item.quality=="uncommon");remaining=remaining+item.count;return item.count end}
  local chest={valid=true,name="wooden-chest",type="container",position={x=1,y=0},
    prototype={items_to_place_this={{name="wooden-chest",count=1}}},get_inventory=function() return inv end,
    get_fuel_inventory=function() return nil end}
  entity.surface.find_entities_filtered=function() return {chest} end
  entity.insert=function(item) assert(item.quality=="uncommon");return 1 end
  local result;u.json_response=function(value) result=value end
  u.handlers.building_empty{companionId=1,x=1,y=0,itemName="iron-plate",count=3}
  assert(result.extracted==1 and remaining==3)
`));

// Target resolution: the caller's position names a TILE, and the building whose centre floors to
// that tile is the one they asked about -- even though the cross-border neighbour below is closer
// to the exact point. Today's nearest-only helper hands the items to that neighbour.
test("Lua: fill targets the building on the requested tile, not a closer neighbour", () =>
  run(`
  require("commands.building")
  local inserted={}
  local function machine(name,pos)
    return {valid=true,name=name,type="assembling-machine",position=pos,
      prototype={items_to_place_this={{name=name,count=1}}},
      insert=function(stack) inserted[#inserted+1]=name;return stack.count end}
  end
  local lab=machine("lab",{x=40.4,y=20.4})
  local neighbour=machine("stone-furnace",{x=39.9,y=20.1})
  entity.surface.find_entities_filtered=function() return {neighbour,lab} end
  entity.position={x=37,y=20}
  items["iron-plate"]=10
  entity.get_inventory(defines.inventory.character_main).remove=function(stack)
    items[stack.name]=items[stack.name]-stack.count;return stack.count end
  local result;u.json_response=function(value) result=value end
  u.handlers.building_fill{companionId=1,itemName="iron-plate",count=3,x=40,y=20}
  assert(inserted[1]=="lab", "a closer neighbour must not take the items")
  assert(result.inserted==3 and result.into=="lab" and items["iron-plate"]==7)
  assert(result.target.name=="lab" and result.target.position.x==40.4 and result.target.position.y==20.4)
`));

test("Lua: empty targets the building on the requested tile, not a closer neighbour", () =>
  run(`
  require("commands.building")
  defines.inventory.chest=1
  local function chest(name,pos,count)
    return {valid=true,name=name,type="container",position=pos,
      prototype={items_to_place_this={{name=name,count=1}}},
      get_inventory=function() return {valid=true,
        get_contents=function() return {{name="iron-plate",count=count,quality="normal"}} end,
        remove=function(stack) count=count-stack.count;return stack.count end,
        insert=function(stack) count=count+stack.count;return stack.count end} end,
      get_fuel_inventory=function() return nil end}
  end
  local lab=chest("wooden-chest",{x=40.4,y=20.4},4)
  local neighbour=chest("steel-chest",{x=39.9,y=20.1},9)
  entity.surface.find_entities_filtered=function() return {neighbour,lab} end
  entity.position={x=37,y=20}
  entity.insert=function(stack) return stack.count end
  local result;u.json_response=function(value) result=value end
  u.handlers.building_empty{companionId=1,itemName="iron-plate",count=3,x=40,y=20}
  assert(result.extracted==3 and result.into=="wooden-chest")
  assert(result.target.name=="wooden-chest" and result.target.position.x==40.4)
`));

test("Lua: info targets the building on the requested tile, not a closer neighbour", () =>
  run(`
  require("commands.building")
  local function machine(name,pos)
    return {valid=true,name=name,type="furnace",position=pos,force={name="player"},
      status=defines.entity_status.working,prototype={items_to_place_this={{name=name,count=1}}},
      get_fuel_inventory=function() return nil end,get_inventory=function() return nil end,
      get_output_inventory=function() return nil end,get_recipe=function() return nil end}
  end
  local lab=machine("lab",{x=40.4,y=20.4})
  local neighbour=machine("stone-furnace",{x=39.9,y=20.1})
  entity.surface.find_entities_filtered=function() return {neighbour,lab} end
  local result;u.json_response=function(value) result=value end
  u.handlers.building_info{companionId=1,x=40,y=20}
  assert(result.entity.name=="lab" and result.entity.position.x==40.4)
`));

test("Lua: a failed fill names the building it picked or reports its absence", () =>
  run(`
  require("commands.building")
  entity.position={x=37,y=20}
  items["iron-plate"]=10
  local result;u.json_response=function(value) result=value end
  -- The fallback branch: the furnace is on another tile (floor 42,20) 2.4 tiles from the request,
  -- so it is picked by distance rather than by tile.
  local refused={valid=true,name="stone-furnace",type="furnace",position={x=42.4,y=20.4},
    prototype={items_to_place_this={{name="stone-furnace",count=1}}},insert=function() return 0 end}
  entity.surface.find_entities_filtered=function() return {refused} end
  u.handlers.building_fill{companionId=1,itemName="iron-plate",count=5,x=40,y=20}
  assert(result.error:find("Could not insert"), "the failure keeps its original meaning")
  assert(result.error:find("stone%-furnace") and result.error:find("42.4"), result.error)
  assert(result.inserted==0 and result.into=="stone-furnace" and result.target.position.y==20.4)
  -- 3.6 tiles away is outside the 3-tile search radius, so the fallback must not reach it.
  local outside={valid=true,name="steel-furnace",type="furnace",position={x=43.6,y=20.4},
    prototype={items_to_place_this={{name="steel-furnace",count=1}}},insert=function() return 0 end}
  entity.surface.find_entities_filtered=function() return {outside} end
  u.handlers.building_fill{companionId=1,itemName="iron-plate",count=5,x=40,y=20}
  assert(result.error:find("No building") and result.error:find("3 tiles"), result.error)
  assert(result.inserted==0 and result.target==nil and result.into==nil)
  entity.surface.find_entities_filtered=function() return {} end
  u.handlers.building_fill{companionId=1,itemName="iron-plate",count=5,x=60,y=-40}
  assert(result.error:find("No building"), result.error)
  assert(result.inserted==0 and result.target==nil and result.into==nil)
`));

test("Lua: blueprint cancellation removes only its own remaining ghosts", () =>
  run(`
  local removed=0
  local ghost={valid=true,destroy=function() removed=removed+1 end}
  storage.blueprint_queues[1]={name="plan",state="building",targets={{ghost={valid=false},done=true},{ghost=ghost}},built=1}
  local unrelated={valid=true,destroy=function() error("Another companion's ghost must survive") end}
  storage.blueprint_queues[2]={targets={{ghost=unrelated}},state="building"}
  require("commands.lifecycle").stop(1)
  local status=queues.get_blueprint_status(1)
  assert(removed==1 and status.state=="cancelled" and status.built==1 and status.total==2)
  assert(storage.blueprint_queues[2] and items.plate==20)
`));

for (const nativeBuilt of [false, true])
  test(`Lua: blueprint revival error refunds only an unbuilt entity (${nativeBuilt})`, () =>
    run(`
  entity.build_distance=10
  local stock=1
  local inv=entity.get_main_inventory()
  inv.get_item_count=function() return stock end
  inv.remove=function(item) stock=stock-item.count;return item.count end
  inv.insert=function(item) stock=stock+item.count;return item.count end
  local ghost={valid=true,ghost_prototype={items_to_place_this={{name="wooden-chest",count=1}}}}
  ghost.revive=function() ghost.valid=${nativeBuilt ? "false" : "true"};error("Native event failed") end
  ghost.destroy=function() ghost.valid=false end
  storage.blueprint_queues[1]={name="plan",state="building",mode="manual",manages_timeout=true,progress_tick=0,built=0,
    targets={{ghost=ghost,name="wooden-chest",quality="normal",position={x=1,y=0}}}}
  queues.tick_blueprint_queues()
  assert(queues.get_blueprint_status(1).state=="failed")
  assert(stock==${nativeBuilt ? 0 : 1},"A native event must not duplicate or lose construction items")
`));

test("Lua: crafting finishes only when native outputs exist", () =>
  run(`
  assert(not queues.start_craft(1, "gear", 2).error)
  advance(40)
  assert(queues.get_craft_status(1).active)
  assert(queues.get_craft_status(1).crafted == 0)
  advance(200)
  assert(not queues.get_craft_status(1).active)
  assert(queues.get_craft_status(1).crafted == 2)
  assert(items.gear == 2)
`));
for (const stop of ["queues.stop_craft(1)", 'require("commands.lifecycle").stop(1)'])
  test(`Lua: ${stop} cancels native crafting and refunds ingredients`, () =>
    run(`
    queues.start_craft(1, "gear", 5)
    advance(35)
    assert(entity.crafting_queue_size > 0)
    ${stop}
    assert(entity.crafting_queue_size == 0, "native crafting survives stop")
    advance(200)
    assert((items.gear or 0) == 0, "items appeared after cancellation")
    assert(items.plate == 20, "cancel must refund unconsumed ingredients")
  `));
test("Lua: starting a second craft preserves the first job", () =>
  run(`
  queues.start_craft(1, "gear", 2)
  advance(35)
  assert(queues.start_craft(1, "gear", 4).error)
  advance(250)
  assert(items.gear == 2)
`));
test("Lua: a stalled mining job reports failure, never successful completion", () =>
  run(`
  storage.gather_queues[1] = {state="mine", resource="ore", product="ore", start_count=0, target=60,
    _stale_total=20, _stale_pos={x=0,y=0}, _stale_ticks=1000}
  queues.tick_gather_queues()
  queues.tick_gather_queues()
  local result = queues.get_gather_status(1)
  assert(not result.active)
  assert(result.error and result.state == "failed", "stalled mining is reported as done")
`));
test("Lua: stopped mining retains its partial result and reason on repeated reads", () =>
  run(`
  items.ore=33
  storage.gather_queues[1]={state="mine",product="ore",resource="ore",start_count=0,target=60}
  require("commands.lifecycle").stop(1)
  require("commands.lifecycle").stop(1)
  for _=1,2 do
    local result=queues.get_gather_status(1)
    assert(not result.active and result.state=="cancelled")
    assert(result.gathered==33 and result.error)
  end
`));
test("Lua: cancelling one companion preserves another companion's queues and reservations", () =>
  run(`
  local ledger=require("commands.task_pool_ledger")
  storage.companions[2]={entity=entity,name="Grace"}
  storage.next_task_id=1
  local a=ledger.submit_task(1,{{type="fuel",item="plate",count=5}})
  local b=ledger.submit_task(2,{{type="fuel",item="plate",count=5}})
  storage.gather_queues[2]={state="find",resource="ore",target=60}
  require("commands.lifecycle").stop(1)
  assert(ledger.get_task_status(a.task_id).status=="cancelled")
  assert(ledger.get_task_status(b.task_id).status=="active")
  assert(ledger.reservations(1).plate==0 and ledger.reservations(2).plate==5)
  assert(storage.gather_queues[2])
`));
test("Lua: machine inventories return names, quantities and quality without duplicate fuel", () =>
  run(`
  defines.inventory.chest=1; defines.inventory.fuel=1
  defines.inventory.crafter_input=2; defines.inventory.crafter_output=3
  local slots={
    [1]={valid=true,get_contents=function() return {{name="coal",count=5,quality="normal"}} end},
    [2]={valid=true,get_contents=function() return {{name="iron-ore",count=21,quality="normal"}} end},
    [3]={valid=true,get_contents=function() return {{name="iron-plate",count=4,quality="uncommon"}} end},
  }
  local machine={valid=true,type="furnace",name="stone-furnace",prototype={items_to_place_this={{name="stone-furnace",count=1}}},position={x=1,y=0},get_inventory=function(slot) return slots[slot] end, get_fuel_inventory=function() return slots[1] end, get_output_inventory=function() return slots[3] end}
  entity.surface.find_entities_filtered=function() return {machine} end
  local result; u.json_response=function(value) result=value end
  require("commands.companion")
  u.handlers.companion_inventory{companionId=1,x=1,y=0}
  assert(not result.error and #result.items==3)
  assert(result.items[1].name=="iron-ore" and result.items[1].count==21)
  assert(result.items[2].quality=="uncommon" and result.items[3].name=="coal")
`));
test("Lua: belt pathfinding avoids occupied tiles and reports blocked endpoints", () =>
  run(`
  local surf={
    count_entities_filtered=function() return 0 end,
    count_tiles_filtered=function() return 0 end,
    can_place_entity=function(args) return not (args.position[1]==2 and args.position[2]>=-1 and args.position[2]<=1) end,
  }
  local pathfind=require("commands.pathfind")
  local path,err=pathfind.find_path(surf,{x=0,y=0},{x=4,y=0},entity.force)
  assert(path and not err)
  for i,p in ipairs(path) do
    assert(not(p.x==2 and p.y>=-1 and p.y<=1))
    if i>1 then assert(math.abs(p.x-path[i-1].x)+math.abs(p.y-path[i-1].y)==1) end
  end
  local blocked,reason=pathfind.find_path(surf,{x=0,y=0},{x=2,y=0},entity.force)
  assert(not blocked and reason=="dest-blocked")
`));

test("Lua: drill inspection never treats fuel as output or calls crafting-only APIs", () =>
  run(`
  local fuel={valid=true,get_contents=function() return {{name="coal",count=4,quality="normal"}} end}
  local drill={valid=true,type="mining-drill",name="burner-mining-drill",prototype={items_to_place_this={{name="burner-mining-drill",count=1}}},position={x=1,y=0},
    direction=defines.direction.south,force={name="player"},status=defines.entity_status.working,
    get_fuel_inventory=function() return fuel end,
    get_output_inventory=function() error("Fuel inventory alias must not be read as output") end,
    get_inventory=function() error("Drill has no crafting input") end,
    get_recipe=function() error("Entity is not crafting-machine.") end,
    mining_target={valid=true,name="iron-ore",type="resource",position={x=1,y=0}},
    mining_progress=0.5,drop_position={x=0.5,y=1.5},
    drop_target={valid=true,name="stone-furnace",type="furnace",position={x=1,y=2}}}
  entity.surface.find_entities_filtered=function() return {drill} end
  local result; u.json_response=function(value) result=value end
  require("commands.building")
  u.handlers.building_info{companionId=1,x=1,y=0}
  assert(not result.error and result.entity.name=="burner-mining-drill")
  local info=result.entity
  assert(info.output==nil and info.input==nil and info.recipe==nil)
  assert(info.fuel[1].count==4 and info.facing=="south")
  assert(info.drop_target.name=="stone-furnace" and info.mining_target.name=="iron-ore")
  local observed=require("commands.entity_info").describe(drill,true)
  assert(observed.drop_position.y==info.drop_position.y and observed.output==nil)
`));

test("Lua: shared machine inspection exposes real crafting output and production counters", () =>
  run(`
  defines.inventory.crafter_input=2
  local output={valid=true,get_contents=function() return {{name="iron-plate",count=8,quality="uncommon"}} end}
  local machine={name="stone-furnace",type="furnace",position={x=1,y=0},direction=0,
    force={name="player"},status=1,get_fuel_inventory=function() return nil end,
    get_inventory=function(slot) assert(slot==2); return nil end,
    get_output_inventory=function() return output end,get_recipe=function() return {name="iron-plate"} end,
    products_finished=31,crafting_progress=0.25}
  local info=require("commands.entity_info").describe(machine,true)
  assert(info.recipe=="iron-plate" and info.products_finished==31)
  assert(info.output[1].quality=="uncommon" and info.crafting_progress==0.25)
`));

test("Lua: mining with a stuck selection changes tile without reporting completion", () =>
  run(`
  entity.surface.find_non_colliding_position=function() return nil end
  local ore = {name="ore",type="resource",valid=true,amount=100,position={x=1,y=0},prototype=prototypes.entity.ore}
  entity.surface.find_entities_filtered = function(args) return args.name and {ore} or {} end
  entity.get_main_inventory().can_insert = function() return true end
  entity.selected=ore
  entity.mining_state={mining=true}
  storage.gather_queues[1]={state="mine",resource="ore",selector={name="ore",product="ore"},product="ore",start_count=0,target=60,
    entity_pos={x=1,y=0},mine_gathered_at_entry=0,mine_stuck_ticks=u.settings.queue_tuning.mine_stuck_ticks}
  queues.tick_gather_queues()
  local q=storage.gather_queues[1]
  assert(q.state=="find" and q.blacklist["1,0"] and not entity.mining_state.mining)
  assert(queues.get_gather_status(1).active)
`));

test("Lua: gathering skips ore covered by a machine", () =>
  run(`
  local blocked={name="ore",type="resource",valid=true,amount=100,position={x=1,y=0},prototype=prototypes.entity.ore}
  local free={name="ore",type="resource",valid=true,amount=100,position={x=4,y=0},prototype=prototypes.entity.ore}
  entity.surface.find_entities_filtered=function(args)
    if args.name then return {blocked,free} end
    return args.position.x==1 and {{valid=true,type="furnace",prototype={items_to_place_this={{name="stone-furnace",count=1}}}}} or {}
  end
  entity.surface.count_entities_filtered=function() return 0 end
  entity.surface.find_non_colliding_position=function(_,p) return p end
  queues.start_gather(1,"ore",20)
  queues.tick_gather_queues()
  assert(storage.gather_queues[1].entity_pos.x==4)
`));

test("Lua: blocked tasks expire but procurement of future materials keeps running", () =>
  run(`
  local pool=require("commands.task_pool")
  pool.init()
  local blocked=pool.submit_task(1,{{type="place",entity="stone-furnace",x=0,y=0}}).task_id
  pool.tick()
  assert(pool.get_task_status(blocked).active)
  game.tick=u.settings.task_tuning.needs_unmet_giveup_ticks
  pool.tick()
  assert(pool.get_task_status(blocked).status=="failed")
  local preparing=pool.submit_task(1,{{type="ensure_item",item="wood",count=1},{type="place",entity="stone-furnace"}}).task_id
  storage.gather_queues[1]={state="mine"}
  game.tick=game.tick+u.settings.task_tuning.needs_unmet_giveup_ticks*2
  pool.tick()
  assert(pool.get_task_status(preparing).active, "future materials must not expire an active procurement step")
`));

test("Lua: task fuel selects the nearest burner and fails clearly without a target", () =>
  run(`
  local pool=require("commands.task_pool")
  pool.init()
  items.coal=5
  local amounts={0,0}
  local function burner(x,index)
    return {valid=true,position={x=x,y=0},get_fuel_inventory=function()
      return {insert=function(stack) amounts[index]=amounts[index]+stack.count;return stack.count end}
    end}
  end
  entity.remove_item=function(stack) items[stack.name]=items[stack.name]-stack.count;return stack.count end
  entity.surface.find_entities_filtered=function(args)
    assert(args.type[3]=="inserter", "burner-inserter is a name, not an entity type")
    return {burner(2,1),burner(0,2)}
  end
  local task=pool.submit_task(1,{{type="fuel",item="coal",count=3,x=0,y=0}}).task_id
  pool.tick(); pool.tick()
  assert(amounts[1]==0 and amounts[2]==3)
  assert(pool.get_task_status(task).status=="done")
  local invalid=pool.submit_task(1,{{type="fuel",item="coal",count=1}}).task_id
  pool.tick(); pool.tick()
  assert(pool.get_task_status(invalid).error:find("no target position"))
`));

test("Lua: procurement collects matching furnace output beyond an empty nearer machine", () =>
  run(`
  local procurement=require("commands.task_pool_ensure_item")
  prototypes.recipe["iron-plate"]={categories={"smelting"},ingredients={{name="iron-ore",amount=1}},products={{name="iron-plate",amount=1}}}
  local counts={0,2}
  local function furnace(x,index)
    return {valid=true,position={x=x,y=0},get_recipe=function() return prototypes.recipe["iron-plate"] end,
      get_output_inventory=function() return {valid=true,get_contents=function() return {{name="iron-plate",count=counts[index],quality="normal"}} end,
        remove=function(stack) counts[index]=counts[index]-stack.count;return stack.count end,
        insert=function(stack) counts[index]=counts[index]+stack.count;return stack.count end} end}
  end
  entity.insert=function(stack) items[stack.name]=(items[stack.name] or 0)+stack.count;return stack.count end
  entity.surface.find_entities_filtered=function() return {furnace(1,1),furnace(2,2)} end
  local task={ctx={ensure_stack={{item="iron-plate",count=2}}}}
  assert(procurement.start_ensure_item_action(storage.companions[1],1,task)=="satisfied")
  assert(items["iron-plate"]==2 and counts[2]==0)
  items["iron-plate"]=nil
  entity.surface.find_entities_filtered=function() return {} end
  local result,err=procurement.start_ensure_item_action(storage.companions[1],1,task)
  assert(not result and err:find("No nearby machine"))
`));

test("Lua: drill footprints reject mixed or missing resources without creating entities", () =>
  run(`
  local steps=require("commands.task_pool_steps")
  prototypes.entity.drill={type="mining-drill",collision_box={left_top={x=-1,y=-1},right_bottom={x=1,y=1}}}
  entity.surface.can_place_entity=function() return true end
  entity.surface.create_entity=function() error("Read checks must not create entities") end
  entity.surface.get_tile=function() return {name="grass"} end
  local mode="mixed"
  entity.surface.find_entities_filtered=function(args)
    if args.area then
      if mode=="empty" then return {} end
      if mode=="mixed" then return {{valid=true,name="coal"},{valid=true,name="iron-ore"}} end
      return {{valid=true,name="coal"}}
    end
    return {}
  end
  local task={ctx={px=0,py=0},cursor=2,steps={{type="find_patch",resource="coal"}}}
  local step={primary="drill",secondary="drill",offsets={{2,0}}}
  assert(not steps.run_pick_orientation(storage.companions[1],task,step))
  mode="empty"
  assert(not steps.run_pick_orientation(storage.companions[1],task,step))
  mode="coal"
  assert(steps.run_pick_orientation(storage.companions[1],task,step))
`));

test("Lua: a failed recovery clone leaves the companion and its inventory intact", () =>
  run(`
  entity.surface.find_non_colliding_position=function(_,pos) return pos end
  entity.clone=function() return nil end
  entity.destroy=function() error("Original must survive a failed clone") end
  local result=queues.debug_respawn_entity(1)
  assert(not result.respawned and storage.companions[1].entity==entity and items.plate==20)
`));

test("Lua: clearing wrong furnace output preserves quality and rolls back overflow", () =>
  run(`
  require("commands.building")
  local stored=3
  local inv={valid=true,get_contents=function() return {{name="copper-plate",count=stored,quality="uncommon"}} end,
    remove=function(stack) assert(stack.quality=="uncommon");stored=stored-stack.count;return stack.count end,
    insert=function(stack) assert(stack.quality=="uncommon");stored=stored+stack.count;return stack.count end}
  entity.surface.find_entities_filtered=function() return {{valid=true,type="furnace",position={x=1,y=0},get_output_inventory=function() return inv end}} end
  entity.insert=function(stack) assert(stack.quality=="uncommon");return 1 end
  local result
  u.json_response=function(value) result=value end
  u.handlers.building_clear_wrong_output{companionId=1,itemName="iron-plate",x=1,y=0}
  assert(result.cleared and result.count==1 and stored==2)
`));

test("Lua: walking retargets blocked destinations, replans stalled paths and retains arrival", () =>
  run(`
  local init,tick,path_event
  script={active_mods={["ai-companion"]="test"},on_init=function(fn) init=fn end,
    on_configuration_changed=function() end,on_event=function(_,fn) path_event=fn end,
    on_nth_tick=function(_,fn) tick=fn end}
  commands={add_command=function() end}
  defines.events={on_script_path_request_finished=1}
  defines.entity_status={}
  require("control")
  init()
  prototypes.entity.character={collision_box={},collision_mask={}}
  local requests={}
  entity.surface.find_entities_filtered=function() return {} end
  entity.surface.find_non_colliding_position=function(_,pos) return {x=8,y=pos.y} end
  entity.surface.request_path=function(args) requests[#requests+1]=args;return #requests end
  storage.walking_queues[1]={target={x=10,y=0}}
  game.tick=5;tick{tick=5}
  assert(#requests==1 and requests[1].goal.x==8)
  path_event{id=1,path={{position={x=8,y=0}}}}
  local q=storage.walking_queues[1]
  for t=10,170,5 do game.tick=t;tick{tick=t} end
  for _,error in ipairs(storage.errors) do assert(error.context~="walking",error.error) end
  assert(#requests==2 and q.path_pending, "a stale waypoint must request a new path")
  entity.position={x=8,y=0}
  game.tick=175;tick{tick=175}
  assert(not storage.walking_queues[1] and storage.walk_last_arrived[1].x==8)
  for _,error in ipairs(storage.errors) do assert(error.context~="walking",error.error) end
`));

const walkingFixture = `
  local init,tick,path_event
  script={active_mods={["ai-companion"]="test"},on_init=function(fn) init=fn end,
    on_configuration_changed=function() end,on_event=function(_,fn) path_event=fn end,
    on_nth_tick=function(_,fn) tick=fn end}
  commands={add_command=function() end}
  defines.events={on_script_path_request_finished=1}
  require("control");init()
  prototypes.entity.character={collision_box={},collision_mask={}}
  local requests=0
  entity.surface.find_entities_filtered=function() return {} end
  entity.surface.find_non_colliding_position=function(_,pos) return pos end
  entity.surface.request_path=function() requests=requests+1;return requests end
  local function step(t) game.tick=t;tick{tick=t} end
  local function healthy()
    for _,error in ipairs(storage.errors) do assert(error.context~="walking",error.error) end
  end
`;

test("Lua: a long waypoint keeps moving without harvesting neighboring trees or replanning", () =>
  run(
    walkingFixture +
      `
  local tree={valid=true,type="tree",name="tree-01",position={x=0,y=1},
    prototype={mineable_properties={products={{type="item",name="wood"}}}}}
  entity.surface.find_entities_filtered=function() return {tree} end
  storage.walking_queues[1]={target={x=50,y=0}}
  step(5);path_event{id=1,path={{position={x=50,y=0}}}}
  for t=10,500,5 do
    entity.position.x=entity.position.x+0.35
    step(t)
    assert(entity.walking_state.walking and not entity.mining_state.mining)
  end
  assert(requests==1, "forward progress on a long waypoint must not trigger a replan")
  healthy()
`,
  ));

test("Lua: mining a modded path obstacle counts as progress and stops on arrival", () =>
  run(
    walkingFixture +
      `
  local rock={valid=true,type="simple-entity",name="big-rock-cream",position={x=2,y=0},
    prototype={mineable_properties={products={{type="item",name="stone"}}}}}
  entity.surface.find_entities_filtered=function() return rock.valid and {rock} or {} end
  storage.walking_queues[1]={target={x=10,y=0},giveup_enabled=true}
  step(5);path_event{id=1,path={{position={x=2,y=0},needs_destroy_to_reach=true},{position={x=10,y=0}}}}
  for t=10,800,5 do
    entity.mining_progress=t/1000
    step(t)
    assert(entity.selected==rock and entity.mining_state.mining)
  end
  assert(requests==1 and storage.walking_queues[1], "active mining must not repath or give up")
  entity.position={x=10,y=0};step(805)
  assert(not entity.mining_state.mining and not storage.walking_queues[1])
  healthy()
`,
  ));

test("Lua: obsolete path results cannot redirect a replacement walking job", () =>
  run(
    walkingFixture +
      `
  storage.walking_queues[1]={target={x=50,y=0}};step(5)
  storage.walking_queues[1]={target={x=0,y=50}};step(10)
  path_event{id=1,path={{position={x=50,y=0}}}}
  assert(not storage.walking_queues[1].path and storage.walking_queues[1].path_pending)
  path_event{id=2,path={{position={x=0,y=50}}}}
  assert(storage.walking_queues[1].path[1].position.y==50)
  healthy()
`,
  ));

test("Lua: task walking deadlines extend on progress but still expire when stuck", () =>
  run(`
  local pool=require("commands.task_pool");pool.init()
  storage.tasks[1]={cid=1,status="active",steps={{type="place",entity="wooden-chest"}},cursor=1,ctx={},needs={},reserved={}}
  storage.active_step[1]={task_id=1,state="walking",approach_deadline=5}
  storage.walking_queues[1]={target={x=10,y=0},last_progress_tick=5}
  game.tick=5;pool.tick()
  assert(storage.tasks[1].status=="active" and storage.active_step[1].approach_deadline>5)
  game.tick=storage.active_step[1].approach_deadline;pool.tick()
  assert(storage.tasks[1].status=="failed" and not storage.walking_queues[1])
`));

test("Lua: replanning from the same position does not extend a task's movement deadline", () =>
  run(
    walkingFixture +
      `
  storage.walking_queues[1]={target={x=50,y=0}}
  step(5)
  for attempt=1,4 do
    local q=storage.walking_queues[1]
    path_event{id=requests,path={{position={x=50,y=0}}}}
    for t=1,33 do step(game.tick+5) end
    assert(not q.last_progress_tick,"A fresh path is not physical progress")
  end
  healthy()
`,
  ));

test("Lua: fresh and upgraded saves keep chat opt-in per player and retain legacy drafts", () =>
  run(
    guiFixture +
      `
  local second=add_player(2)
  init()
  assert(not bar() and not bar(second))
  -- Build the shape the old release would have saved and discard the new opt-in flag.
  fac("chat")
  bar().body.fac_message.text="Legacy draft"
  bar().header.target.selected_index=2
  bar().location={x=42,y=80};emit("on_gui_location_changed",bar())
  storage.overlay[1].chat_visible=nil
  configure()
  assert(storage.companions[1].entity==entity and not bar())
  for _,name in ipairs({"on_player_created","on_player_joined_game","on_player_display_resolution_changed","on_player_display_scale_changed"}) do
    emit(name);emit(name,nil,2)
  end
  refresh_tick()
  assert(not bar() and not bar(second))
  fac("gui")
  assert(panel().roster.companion_1.fac_activity.caption=="Idle" and not bar())
  click(panel().footer.fac_close);assert(not panel() and not player.opened)
  fac();assert(panel() and not bar())
  emit("on_gui_closed",panel());assert(not panel())
  fac("1 build a furnace")
  assert(#storage.companion_messages==1 and storage.companion_messages[1].target_companion==1)
  assert(storage.companion_messages[1].message=="build a furnace")
  assert(handlers[events.on_console_chat]==nil, "native chat must not be forwarded")
  fac("chat with Codex")
  assert(not bar() and storage.companion_messages[2].message=="chat with Codex")
  fac("chat")
  assert(bar().body.fac_message.text=="Legacy draft" and bar().header.target.selected_index==2)
  assert(bar().location.x==42 and bar().location.y==80 and not bar(second))
  click(bar().header.fac_hide_chat)
  refresh_tick();emit("on_player_joined_game");emit("on_player_display_scale_changed")
  assert(not bar() and not bar(second))
  fac("chat",2);assert(not bar() and bar(second))
  configure();assert(not bar() and bar(second), "later upgrades retain explicit opt-in")
  bar(second).body.fac_message.text="Private draft"
  click(bar(second).header.fac_hide_chat,2)
  assert(not bar(second) and storage.overlay[2].draft=="Private draft", "close stores the draft before player removal")
  emit("on_player_removed",nil,2)
  second=add_player(2);emit("on_player_created",nil,2)
  assert(not bar(second) and not storage.overlay[2])
  fac("chat",2);assert(bar(second).body.fac_message.text=="")
  fac("chat");assert(bar().body.fac_message.text=="Legacy draft")
`,
  ));

test("Lua: overlay routes multiline chat, preserves drafts and survives a vanished recipient", () =>
  run(
    guiFixture +
      `
  fac("chat")
  assert(bar().header.target.items[2]=="Atlas #1")
  bar().header.target.selected_index=2
  bar().body.fac_message.text="  Build a lab\\nthen check power  "
  click(bar().body.fac_send)
  assert(storage.companion_messages[1].target_companion==1)
  assert(storage.companion_messages[1].message=="Build a lab\\nthen check power")
  assert(bar().body.fac_message.text=="")
  click(bar().body.fac_send)
  assert(#storage.companion_messages==1,"Blank submission must not enqueue a request")
  bar().body.fac_message.text="Unsent draft";configure()
  assert(bar().body.fac_message.text=="Unsent draft" and bar().header.target.selected_index==2)
  storage.companions[1]=nil;refresh_tick()
  assert(bar().header.target.selected_index==1 and bar().body.fac_message.text=="Unsent draft")
  player.display_resolution={width=800,height=600};player.display_scale=1.5
  emit("on_player_display_resolution_changed")
  assert(bar().location.x>=0 and bar().location.x+u.settings.overlay.width*1.5<=800)
`,
  ));

test("Lua: overlay controls use validated commands and send a cancellation event to the host", () =>
  run(
    guiFixture +
      `
  fac("chat");click(bar().header.fac_manage)
  local calls={}
  u.handlers.companion_stop=function(args)
    calls[#calls+1]=args.companionId
    require("commands.lifecycle").stop(args.companionId)
    u.json_response{stopped=true}
  end
  storage.walking_queues[1]={target={x=10,y=0}}
  click(panel().roster.companion_1.action_2)
  assert(#calls==1 and not storage.walking_queues[1])
  assert(storage.companion_messages[1].control.tool=="companion_stop")
  local bad=require("commands.dispatch").call("companion_stop",{companionId=-1})
  assert(bad.error and #calls==1,"GUI calls must validate the same schema as MCP")
  u.handlers.companion_spawn=function(args,origin)
    assert(origin==player and args.companionId==2 and args.name=="Almendra")
    u.json_response{spawned=true}
  end
  panel().create.fac_name.text="Almendra";click(panel().create.fac_spawn)
  assert(storage.companion_messages[2].control.tool=="companion_spawn")
  assert(panel().create.fac_name.text=="")
`,
  ));

test("Lua: registered GUI callbacks ignore same-named foreign, stale and other-player elements", () =>
  run(
    guiFixture +
      `
  local second=add_player(2)
  fac("chat");fac("gui");fac("chat",2);fac("gui",2)
  local function foreign_events(owner)
    local other=element({type="screen"},nil,owner,1)
    local b=other.add{type="frame",name="fac_chat_bar"}
    local p=other.add{type="frame",name="fac_companion_panel"}
    click(b.add{type="button",name="fac_send"})
    click(p.add{type="button",name="fac_close"})
    click(p.add{type="button",tags={fac_action=2,cid=1}})
    emit("on_gui_confirmed",p.add{type="textfield",name="fac_name",text="Wrong"})
    emit("on_gui_closed",p)
    emit("on_gui_text_changed",b.add{type="text-box",name="fac_message",text="Wrong"})
    local header=b.add{type="flow",name="header"}
    emit("on_gui_selection_state_changed",header.add{type="drop-down",name="target",tags={ids={1}},selected_index=1})
    b.location={x=13,y=37};emit("on_gui_location_changed",b)
    assert(p.valid and b.valid)
  end
  foreign_events("another-mod")
  foreign_events("ai-companion") -- even our names outside the actual roots aren't ours to handle
  click(bar(second).header.fac_hide_chat)
  emit("on_gui_closed",panel(second))
  local invalid=element({type="textfield",name="fac_name"},nil,"ai-companion",1)
  invalid.destroy();emit("on_gui_confirmed",invalid);emit("on_gui_closed")
  assert(bar() and panel() and bar(second) and panel(second))
  assert(#storage.errors==0 and #storage.companion_messages==0)
  assert(storage.overlay[1].draft==nil and storage.overlay[1].target==0 and storage.overlay[1].location==nil)
  local draft=bar().body.fac_message;draft.text="Mine"
  emit("on_gui_text_changed",draft)
  bar().header.target.selected_index=2;emit("on_gui_selection_state_changed",bar().header.target)
  assert(storage.overlay[1].draft=="Mine" and storage.overlay[1].target==1)
`,
  ));

test("Lua: GUI failures are contained, partial windows are removed, and diagnostic logging is throttled", () =>
  run(
    guiFixture +
      `
  local second=add_player(2)
  fac("chat");fac("gui",2)
  local function broken_row(args,index)
    if index==1 and args.name=="fac_activity" then error("Injected row build failure") end
  end
  fail_add=broken_row
  for _=1,4 do click(bar().header.fac_manage);assert(not panel() and not player.opened and bar()) end
  assert(#storage.errors==1 and storage.errors[1].context=="gui:open_manager")
  fail_add=nil;fac("gui");assert(panel().roster.companion_1.fac_activity.caption=="Idle")
  storage.companions[2]={entity=entity,name="Second"}
  fail_add=broken_row;refresh_tick()
  assert(not panel() and bar() and panel(second).roster.companion_2)
  assert(#storage.errors==2 and storage.errors[2].context=="gui:refresh_manager")
  refresh_tick();assert(not panel() and #storage.errors==2)
  fail_add=nil;fac("gui")
  local input=require("commands.player_input")
  input.control=function() error("Injected confirm failure") end
  emit("on_gui_confirmed",panel().create.fac_name)
  assert(not panel() and bar() and storage.errors[3].context=="gui:confirm")
  local draft=bar().body.fac_message;draft.text="Recover me";emit("on_gui_text_changed",draft)
  player.display_resolution=nil
  emit("on_player_display_resolution_changed")
  assert(not bar() and storage.errors[4].context=="gui:place_chat")
  player.display_resolution={width=1920,height=1080}
  fail_add=function(args) if args.name=="fac_message" then error("Injected chat build failure") end end
  fac("chat");assert(not bar() and storage.errors[5].context=="gui:toggle_chat")
  fail_add=nil;refresh_tick();emit("on_player_joined_game");assert(not bar())
  fac("chat");assert(bar().body.fac_message.text=="Recover me")
  fac("gui");assert(panel().roster.companion_2 and #storage.companion_messages==0)
`,
  ));

test("Lua: a turret's ammunition is readable through the shared inventory walk", () =>
  run(`
  local info = require("commands.entity_info")
  local mags = 2
  local ammo = {valid=true}
  ammo.get_item_count = function(a) return mags end
  ammo.get_contents = function() return {{name="firearm-magazine",count=mags,quality="normal"}} end
  local turret = {valid=true, name="gun-turret", type="ammo-turret",
    position={x=3,y=53}, direction=0, health=400, max_health=400, status=1,
    energy=0, force={name="player"},
    get_inventory=function(index) return index==defines.inventory.turret_ammo and ammo or nil end,
    get_main_inventory=function() return nil end,
    get_fuel_inventory=function() return nil end,
    get_output_inventory=function() return nil end}

  -- building_empty walks exactly this list, so the ammo inventory has to be in it.
  local groups = info.inventories(turret)
  local found
  for _, group in ipairs(groups) do if group.slot=="ammo" then found=group end end
  assert(found and found.inventory==ammo, "the turret ammo inventory must be part of the walk")

  -- building_info and world_observe share describe(), so the count shows up there too.
  local described = info.describe(turret, true)
  assert(described.ammo and described.ammo[1].name=="firearm-magazine" and described.ammo[1].count==2)
  assert(described.status=="working")
`));

test("Lua: help is callable with no arguments and filters on a name prefix", () =>
  run(`
  script = {active_mods = {["ai-companion"] = "0.18.3", base = "2.1.23"}}
  local u = require("commands.init")
  require("commands.help")   -- control.lua requires the modules; the harness does not

  -- The schema used to require a field it also declared as additional, so no call
  -- could ever succeed and a caller could not discover the real tool names.
  local all = u.capture_response(function() u.handlers.help({}) end)
  assert(all.count and all.count > 10, "every game tool must be listed")
  assert(not all.error)

  local building = u.capture_response(function() u.handlers.help({category="building"}) end)
  assert(building.category == "building")
  assert(building.count > 0 and building.count < all.count)
  for _, tool in ipairs(building.tools) do
    assert(tool.name:sub(1, 9) == "building_", "unexpected tool for the filter: " .. tool.name)
  end

  local none = u.capture_response(function() u.handlers.help({category="no-such-prefix"}) end)
  assert(none.count == 0)
`));

test("Lua: prototype_info answers what the factoriopedia answers", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- An item: what it is, and which recipes make it and use it. The reverse
  -- lookup is the question a companion actually asks ("where does this come from").
  local item = u.capture_response(function()
    u.handlers.prototype_info({name="iron-gear-wheel"})
  end)
  assert(item.found, "an existing prototype must be found")
  assert(item.kind == "item", "item is searched before recipe: " .. tostring(item.kind))
  assert(item.stack_size == 100, "stack size must come from the item prototype")
  assert(item.subgroup == "intermediate-product")
  assert(item.localised_name == "item-name.iron-gear-wheel", item.localised_name)
  assert(#item.recipes_producing >= 1, "the recipe that makes it must be listed")
  assert(item.recipes_producing[1] == "iron-gear-wheel", item.recipes_producing[1])
  assert(item.recipes_producing_total == #item.recipes_producing)

  -- The same name in another table: crafting time and ingredients.
  local recipe = u.capture_response(function()
    u.handlers.prototype_info({name="iron-gear-wheel", kind="recipe"})
  end)
  assert(recipe.found and recipe.kind == "recipe")
  assert(recipe.crafting_time == 0.5, "crafting time is the recipe energy")
  assert(recipe.category == "crafting")
  assert(recipe.ingredients[1].name == "iron-plate" and recipe.ingredients[1].amount == 2)
  assert(recipe.products[1].name == "iron-gear-wheel")

  -- The other direction: what consumes it.
  assert(#item.recipes_using >= 1, "recipes that consume it must be listed")
  assert(item.recipes_using[1] == "automation-science-pack", item.recipes_using[1])

  local missing = u.capture_response(function()
    u.handlers.prototype_info({name="no-such-thing"})
  end)
  assert(missing.found == false)
  assert(#missing.searched == 5, "a miss must say which tables were searched")
`));

test("Lua: prototype_info reads building statistics through the 2.x accessors", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- In Factorio 2.x max_health and crafting_speed are get_* methods on the
  -- prototype, and reading them as fields raises. A plain field read here would
  -- take the whole answer down.
  local entity = u.capture_response(function()
    u.handlers.prototype_info({name="assembling-machine-1", kind="entity"})
  end)
  assert(entity.found and entity.kind == "entity")
  assert(entity.max_health == 300, tostring(entity.max_health))
  assert(entity.crafting_speed == 0.5, tostring(entity.crafting_speed))
  assert(entity.tile_width == 3 and entity.tile_height == 3)
  assert(entity.module_slots == 0)
  assert(entity.energy_usage == 1250)

  -- The technology table, including what it unlocks.
  local tech = u.capture_response(function()
    u.handlers.prototype_info({name="logistics", kind="technology"})
  end)
  assert(tech.found and tech.kind == "technology")
  assert(tech.research_unit_count == 20, tostring(tech.research_unit_count))
  assert(tech.research_unit_energy == 600)
  assert(tech.research_unit_seconds == 10, "energy is ticks; a second is 60")
  assert(tech.research_unit_ingredients[1].name == "automation-science-pack")
  assert(tech.prerequisites[1] == "automation")
  assert(tech.effects[1].recipe == "fast-inserter")

  -- A fluid carries temperatures and the same reverse lookups.
  local fluid = u.capture_response(function()
    u.handlers.prototype_info({name="water"})
  end)
  assert(fluid.found and fluid.kind == "fluid")
  assert(fluid.default_temperature == 15)

  -- An unknown kind is refused instead of silently searching everything.
  local bad = u.capture_response(function()
    u.handlers.prototype_info({name="water", kind="nonsense"})
  end)
  assert(bad.error and bad.error:find("unknown kind"), tostring(bad.error))
`));

test("Lua: prototype_info puts the real recipe first and keeps recycling counted", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- Space Age has a recycling recipe for nearly everything; without separation
  -- "what makes an iron gear wheel" is answered with forty-seven grinders.
  prototypes.recipe["iron-gear-wheel-recycling"] = {
    name="iron-gear-wheel-recycling", energy=0.5, categories={"recycling"},
    ingredients={{name="iron-gear-wheel", amount=1}},
    products={{name="iron-plate", amount=1}}
  }

  local item = u.capture_response(function()
    u.handlers.prototype_info({name="iron-gear-wheel"})
  end)
  assert(item.recipes_using[1] == "automation-science-pack",
    "the real consumer comes first: " .. tostring(item.recipes_using[1]))
  -- The totals count their own bucket: the real consumer, and the grinder apart.
  assert(item.recipes_using_total == 1, tostring(item.recipes_using_total))
  assert(item.recipes_using_recycling_total == 1, tostring(item.recipes_using_recycling_total))

  -- The recipe that produces it is never a recycling recipe.
  assert(item.recipes_producing[1] == "iron-gear-wheel", item.recipes_producing[1])
  prototypes.recipe["iron-gear-wheel-recycling"] = nil
`));

test("Lua: building_info says when the answer is a neighbour, not the tile asked about", () =>
  run(`
  local entity_info = require("commands.entity_info")

  -- A caller that asks about one tile and silently receives the adjacent machine
  -- reads that machine's recipe and status as if they were the tile's. The
  -- returned position was already honest; the payload now says it too.
  local function surface_with(offset)
    return {find_entities_filtered = function(filter)
      local e = {valid=true, type="assembling-machine", name="assembling-machine-1",
        position={x=filter.position.x + offset, y=filter.position.y}, direction=0,
        force={name="player"}, health=300, max_health=300, status=1, unit_number=1,
        prototype={items_to_place_this={{name="assembling-machine-1"}}},
        get_recipe=function() return {name="iron-gear-wheel"} end,
        get_inventory=function() return nil end}
      return {e}
    end}
  end

  local neighbour, on_tile = entity_info.resolve_on_tile(surface_with(1), {x=10.5, y=-10.5}, 2)
  assert(neighbour, "a neighbour within the radius must still resolve")
  assert(on_tile == false, "a building on the next tile is not on the requested tile")

  local centred, centred_on_tile = entity_info.resolve_on_tile(surface_with(0), {x=10.5, y=-10.5}, 2)
  assert(centred and centred_on_tile == true, "a building centred on the tile is on it")

  local none = entity_info.resolve_on_tile({find_entities_filtered = function(filter) return {} end},
    {x=10.5, y=-10.5}, 2)
  assert(none == nil, "an empty area resolves to nothing rather than to a neighbour")
`));

test("Lua: research_set tells a queued technology apart from a rejected one", () =>
  run(`
  local u = require("commands.init")
  require("commands.research")

  -- add_research returns false both for "already queued" and for a real refusal.
  -- Reporting both as "Failed" told a caller its request had been rejected while
  -- the technology was already on its way.
  local queued_tech = {name="gun-turret", researched=false, enabled=true, prerequisites={}}
  local force = {
    technologies = {["gun-turret"] = queued_tech, concrete = {name="concrete", researched=false, enabled=true, prerequisites={}}},
    research_queue = {queued_tech},
    current_research = {name="concrete"},
    research_progress = 0.43,
    add_research = function(name) return false end,
  }
  _G.game = {players = {}, forces = {player = force}}
  local companion = {entity = {force = force, valid = true}}
  local function with_companion(fn)
    local original = u.find_companion
    u.find_companion = function() return 1, companion end
    local result = u.capture_response(fn)
    u.find_companion = original
    return result
  end

  local queued = with_companion(function() u.handlers.research_set({companionId=1, technology="gun-turret"}) end)
  assert(queued.queued == true and queued.already_queued == true, "already queued is not a failure")
  assert(queued.position == 1, tostring(queued.position))
  assert(queued.error == nil, "no error when the technology is already queued")

  local current = with_companion(function() u.handlers.research_set({companionId=1, technology="concrete"}) end)
  assert(current.already_current == true, "the technology already being researched is not a failure")

  -- A genuine refusal still says so, and says why instead of the word "Failed".
  force.research_queue = {}
  local refused = with_companion(function() u.handlers.research_set({companionId=1, technology="gun-turret"}) end)
  assert(refused.error and refused.error:find("queue is disabled or full"), tostring(refused.error))
`));

test("Lua: research_switch promotes a technology the way the research screen does", () =>
  run(`
  local u = require("commands.init")
  require("commands.research")

  local logistics = {name="logistics-2", researched=false, enabled=true, prerequisites={}}
  local concrete = {name="concrete", researched=false, enabled=true, prerequisites={}}
  local locked = {name="laser-turret", researched=false, enabled=true, prerequisites={{name="laser", researched=false}}}
  local force = {
    technologies = {["logistics-2"]=logistics, concrete=concrete, ["laser-turret"]=locked,
      laser={name="laser", researched=false}},
    research_queue = {concrete},
    current_research = concrete,
    research_progress = 0.1,
  }
  -- Factorio's accessor is bound: called as a method, implemented as a closure. It
  -- has to be attached after the table exists, or the name resolves to a global.
  force.cancel_current_research = function() force.current_research = nil end
  _G.game = {players = {}, forces = {player = force}}
  local companion = {entity = {force = force, valid = true}}
  local function with_companion(fn)
    local original = u.find_companion
    u.find_companion = function() return 1, companion end
    local result = u.capture_response(fn)
    u.find_companion = original
    return result
  end

  local switched = with_companion(function() u.handlers.research_switch({companionId=1, technology="logistics-2"}) end)
  assert(switched.error == nil, "onverwachte fout: " .. tostring(switched.error))
  -- current_research is read only in 2.x, so promotion means reordering the queue:
  -- the head is the active technology and everything else stays behind it.
  assert(switched.queue[1] == "logistics-2", "kop van de queue: " .. tostring(switched.queue[1]))
  assert(switched.queue[2] == "concrete", "de rest blijft staan: " .. tostring(switched.queue[2]))
  assert(switched.previous == "concrete", "vorige: " .. tostring(switched.previous))

  force.current_research = concrete
  local blocked = with_companion(function() u.handlers.research_switch({companionId=1, technology="laser-turret"}) end)
  assert(blocked.error and blocked.error:find("Missing"), tostring(blocked.error))

  local cancelled = with_companion(function() u.handlers.research_cancel({companionId=1}) end)
  assert(cancelled.cancelled == "concrete", tostring(cancelled.cancelled))
`));

test("Lua: a ranged product keeps its bounds instead of answering nothing", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- A chemistry recipe whose product is 50..100 with a probability. Reporting
  -- only "amount" told the caller nothing about how much it makes.
  local recipe = u.capture_response(function()
    u.handlers.prototype_info({name="sulfuric-acid", kind="recipe"})
  end)
  assert(recipe.found, "the recipe must be found")
  local product = recipe.products[1]
  assert(product.name == "sulfuric-acid")
  assert(product.amount == nil, "a ranged product has no fixed amount")
  assert(product.amount_min == 50, "ondergrens: " .. tostring(product.amount_min))
  assert(product.amount_max == 100, "bovengrens: " .. tostring(product.amount_max))
  assert(product.probability == 0.5, "kans: " .. tostring(product.probability))
`));

test("Lua: a bonus research keeps the modifier it grants, not just its type", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- "ammo-damage" is not a recipe unlock: the answer to "what does this give me"
  -- is the category, the modifier and the ceiling.
  local tech = u.capture_response(function()
    u.handlers.prototype_info({name="weapon-damage", kind="technology"})
  end)
  assert(tech.found, "the technology must be found")
  local effect = tech.effects[1]
  assert(effect.type == "ammo-damage", tostring(effect.type))
  assert(effect.modifier == 0.1, "modifier: " .. tostring(effect.modifier))
  assert(effect.maximum == 1.2, "maximum: " .. tostring(effect.maximum))
  assert(effect.ammo_category == "bullet", "de categorie als naam: " .. tostring(effect.ammo_category))

  -- The recipe unlock still reads as before.
  local unlock = u.capture_response(function()
    u.handlers.prototype_info({name="logistics", kind="technology"})
  end)
  assert(unlock.effects[1].type == "unlock-recipe")
  assert(unlock.effects[1].recipe == "fast-inserter")
`));

test("Lua: an item and a fluid sharing a name do not mix their recipes", () =>
  run(`
  local u = require("commands.init")
  require("commands.prototype_info")

  -- A mod may define an item and a fluid under one name. When the caller says
  -- which one it meant, only that one may answer.
  local item = u.capture_response(function()
    u.handlers.prototype_info({name="test-shared", kind="item"})
  end)
  assert(item.kind == "item")
  assert(item.recipes_producing_total == 1, "alleen het item-recept: " .. tostring(item.recipes_producing_total))
  assert(item.recipes_producing[1] == "shared-item", tostring(item.recipes_producing[1]))

  local fluid = u.capture_response(function()
    u.handlers.prototype_info({name="test-shared", kind="fluid"})
  end)
  assert(fluid.kind == "fluid")
  assert(fluid.recipes_producing_total == 1, "alleen het vloeistof-recept: " .. tostring(fluid.recipes_producing_total))
  assert(fluid.recipes_producing[1] == "shared-fluid", tostring(fluid.recipes_producing[1]))
`));
