local handlers, console = {}, {}
local init, configure, nth_tick
local events = {on_gui_click=2,on_gui_confirmed=3,on_gui_closed=4,on_gui_text_changed=5,
  on_gui_location_changed=6,on_player_created=7,on_player_joined_game=8,
  on_player_display_resolution_changed=9,on_player_display_scale_changed=10,on_gui_selection_state_changed=11,
  on_console_chat=12,on_script_path_request_finished=13,on_player_removed=14}
defines.events = events
script = {active_mods={["ai-companion"]="test"},on_init=function(fn) init=fn end,
  on_configuration_changed=function(fn) configure=fn end,on_nth_tick=function(_,fn) nth_tick=fn end,
  on_event=function(id,fn)
    if type(id)=="table" then for _,key in ipairs(id) do handlers[key]=fn end else handlers[id]=fn end
  end}
commands = {add_command=function(name,_,fn) console[name]=fn end}
helpers = {table_to_json=function() error("GUI must not serialize RCON output") end}
rcon = {print=function() error("GUI must not write to RCON") end}
local fail_add
local function element(args,parent,owner,index)
  local e={valid=true,name=args.name or "",type=args.type,parent=parent,children={},style={},tags=args.tags or {},
    caption=args.caption,text=args.text or "",items=args.items,selected_index=args.selected_index}
  e.get_mod=function() return owner end
  e.add=function(a)
    if fail_add then fail_add(a,index) end
    -- Like Factorio, every element reserves native member names regardless of type.
    assert(a.name~="state", "GUI name conflicts with LuaGuiElement.state")
    if a.name then assert(not e[a.name],"Duplicate GUI child") end
    local c=element(a,e,owner,index);e.children[#e.children+1]=c
    if a.name then e[a.name]=c end
    return c
  end
  e.clear=function() while #e.children>0 do e.children[#e.children].destroy() end end
  e.destroy=function()
    e.clear();e.valid=false
    if parent then
      if e.name~="" then parent[e.name]=nil end
      for i,child in ipairs(parent.children) do if child==e then table.remove(parent.children,i);break end end
    end
    if game.players[index] and game.players[index].opened==e then game.players[index].opened=nil end
  end
  e.focus=function() end;e.bring_to_front=function() end
  return e
end
local function add_player(index)
  local p={valid=true,index=index,name="Player" .. index,force=entity.force,
    display_resolution={width=1920,height=1080},display_scale=1,
    gui={screen=element({type="screen"},nil,"ai-companion",index)}}
  game.players[index]=p;game.connected_players[index]=p
  return p
end
local player=add_player(1)
game.get_player=function(index) return game.players[index] end
storage.companion_messages={}
require("control")
local function fac(parameter,index) console.fac{parameter=parameter,player_index=index or 1} end
local function emit(name,e,index) handlers[events[name]]{element=e,player_index=index or 1} end
local function click(e,index) emit("on_gui_click",e,index) end
local function bar(p) return (p or player).gui.screen.fac_chat_bar end
local function panel(p) return (p or player).gui.screen.fac_companion_panel end
local function refresh_tick()
  game.tick=game.tick+u.settings.overlay.refresh_ticks
  nth_tick{tick=game.tick}
end
