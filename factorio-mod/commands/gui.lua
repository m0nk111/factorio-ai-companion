local u = require("commands.init")
local input = require("commands.player_input")
local contract = require("commands.contract")
local cfg = u.settings.overlay
local M = {}
local MOD = "ai-companion"
local BAR, PANEL = "fac_chat_bar", "fac_companion_panel"
local ERROR_COOLDOWN_TICKS = 300 -- Five seconds at normal game speed, per GUI operation.

local function preferences(player)
  storage.overlay = storage.overlay or {}
  storage.overlay[player.index] = storage.overlay[player.index] or {}
  return storage.overlay[player.index]
end

local function root(player, name)
  local element = player.gui.screen[name]
  if element and element.valid and element.get_mod() == MOD then return element end
end

local function remove(player, name)
  local element = root(player, name)
  if element then element.destroy() end
end

local function protect(operation, work, recover)
  local ok, err = pcall(work)
  if ok then return end
  if recover then
    local cleaned, cleanup_err = pcall(recover)
    if not cleaned then err = tostring(err) .. "; cleanup: " .. tostring(cleanup_err) end
  end
  storage.overlay_error_ticks = storage.overlay_error_ticks or {}
  local last = storage.overlay_error_ticks[operation]
  if not last or game.tick - last >= ERROR_COOLDOWN_TICKS then
    storage.overlay_error_ticks[operation] = game.tick
    u.log_error(err, "gui:" .. operation)
  end
end

local function recover_root(player, name)
  -- Do not retry a broken build every tick. Leave the other window alone and
  -- let the player reopen the affected window explicitly after the failure.
  if name == BAR then preferences(player).chat_visible = false end
  remove(player, name)
end

local function for_root(player, name, operation, work)
  protect(operation, work, function() recover_root(player, name) end)
end

local function roster(player)
  local result, signature = {}, {}
  for id, c in pairs(storage.companions or {}) do
    if c.entity and c.entity.valid and c.entity.force == player.force then
      result[#result+1] = {id=id,name=c.name or ("#" .. id)}
    end
  end
  table.sort(result, function(a,b) return a.id < b.id end)
  for i, c in ipairs(result) do signature[i] = c.id .. ":" .. c.name end
  return result, table.concat(signature,"|")
end

local function target(select)
  return select.tags.ids[select.selected_index] or 0
end

local function remember_bar(player, bar)
  if not bar then return end
  local prefs = preferences(player)
  -- An existing save may contain a partially constructed window from an older build.
  local text = bar.body and bar.body.fac_message
  if text then prefs.draft = text.text end
  local select = bar.header and bar.header.target
  if select and select.tags.ids then prefs.target = target(select) end
end

local function place(player, frame)
  local scale, resolution = player.display_scale, player.display_resolution
  local compact = resolution.width/scale < cfg.compact_below_width
  local saved = preferences(player).location
  local x = saved and saved.x or (compact and cfg.compact_left or cfg.left)*scale
  local y = saved and saved.y or resolution.height-(cfg.height+(compact and cfg.compact_bottom or cfg.bottom))*scale
  frame.location = {x=math.floor(math.max(0,math.min(x,resolution.width-cfg.width*scale))),
    y=math.floor(math.max(0,math.min(y,resolution.height-cfg.height*scale)))}
end

local function button(parent, name, caption, tags, tooltip)
  return parent.add{type="button",name=name,caption=caption,tags=tags or {},tooltip=tooltip}
end

local function build_bar(player)
  local bar = player.gui.screen.add{type="frame",name=BAR,direction="vertical"}
  bar.style.width = cfg.width
  local header = bar.add{type="flow",name="header",direction="horizontal"}
  local handle = header.add{type="label",caption="To",tooltip="Drag to move chat"}
  handle.drag_target = bar
  local select = header.add{type="drop-down",name="target",items={"Codex"},selected_index=1,tags={ids={0}}}
  select.style.width = 160
  button(header,"fac_manage","Companions")
  button(header,"fac_hide_chat","Close",nil,"Hide chat; /fac chat to reopen")
  local body = bar.add{type="flow",name="body",direction="horizontal"}
  body.style.horizontally_stretchable = true
  local text = body.add{type="text-box",name="fac_message",text=preferences(player).draft or ""}
  text.word_wrap = true
  -- Let the text box fill the space left by the Send button's natural width.
  text.style.minimal_width = 80
  text.style.horizontally_stretchable = true
  text.style.height = 52
  button(body,"fac_send","Send")
  local status = bar.add{type="label",name="status",caption="Waiting for connection"}
  status.style.font = "default-small"
  place(player,bar)
  return bar
end

local function refresh_bar(player, bar)
  local list, signature = roster(player)
  local select = bar.header.target
  if select.tags.signature ~= signature then
    local prefs = preferences(player)
    local selected = prefs.target or target(select)
    local ids, names = {0}, {"Codex"}
    local index = 1
    for _, c in ipairs(list) do
      ids[#ids+1], names[#names+1] = c.id, c.name .. " #" .. c.id
      if c.id == selected then index = #ids end
    end
    select.items = names
    select.selected_index = index
    select.tags = {ids=ids,signature=signature}
    prefs.target = ids[index]
  end
  local connected = storage.bridge_last_poll_tick and game.tick-storage.bridge_last_poll_tick <= cfg.connection_timeout_ticks
  bar.status.caption = connected and "Connected" or "Waiting for connection"
end

local function hide_chat(player)
  local bar = root(player, BAR)
  remember_bar(player, bar)
  preferences(player).chat_visible = false
  if bar then bar.destroy() end
end

function M.toggle_chat(player)
  for_root(player, BAR, "toggle_chat", function()
    local prefs = preferences(player)
    if prefs.chat_visible then
      hide_chat(player)
    else
      local bar = root(player, BAR) or build_bar(player)
      refresh_bar(player, bar)
      prefs.chat_visible = true
    end
  end)
end

local function activity(id)
  for _, name in ipairs(u.settings.queues) do
    if storage[name .. "_queues"] and storage[name .. "_queues"][id] then
      local q = storage[name .. "_queues"][id]
      local detail = q.resource or q.recipe
      return name .. (detail and (" · " .. detail) or "")
    end
  end
  if storage.active_step and storage.active_step[id] then return storage.active_step[id].state end
  return "Idle"
end

local function refresh_panel(player, panel)
  local list, signature = roster(player)
  if panel.roster.tags.signature ~= signature then
    panel.roster.clear()
    if #list == 0 then panel.roster.add{type="label",caption="No companions"} end
    for _, c in ipairs(list) do
      local row = panel.roster.add{type="flow",name="companion_" .. c.id,direction="horizontal"}
      local label = row.add{type="label",caption=c.name .. " #" .. c.id}
      label.style.width = 150
      -- `state` is reserved by LuaGuiElement, even on non-checkbox elements.
      local status = row.add{type="label",name="fac_activity"}
      status.style.width = 150
      for i, action in ipairs(cfg.actions) do
        button(row,"action_" .. i,action.caption,{fac_action=i,cid=c.id},action.tooltip)
      end
    end
    panel.roster.tags = {signature=signature}
  end
  for _, c in ipairs(list) do panel.roster["companion_" .. c.id].fac_activity.caption = activity(c.id) end
end

local function build_panel(player)
  local panel = player.gui.screen.add{type="frame",name=PANEL,direction="vertical",caption="Companions"}
  local create = panel.add{type="flow",name="create",direction="horizontal"}
  create.add{type="textfield",name="fac_name",text="",tooltip="Companion name (optional)"}
  button(create,"fac_spawn","Spawn")
  local pane = panel.add{type="scroll-pane",name="roster",horizontal_scroll_policy="never"}
  pane.style.maximal_height = 340
  panel.add{type="label",name="error",caption=""}
  local footer = panel.add{type="flow",name="footer",direction="horizontal"}
  button(footer,"fac_reset_position","Reset chat position")
  button(footer,"fac_close","Close")
  panel.auto_center = true
  return panel
end

function M.open(player)
  for_root(player, PANEL, "open_manager", function()
    local panel = root(player, PANEL) or build_panel(player)
    refresh_panel(player, panel)
    panel.bring_to_front()
    if player.opened ~= panel then player.opened = panel end
  end)
end

local function send(player, bar)
  local message, err = input.send(player,bar.body.fac_message.text,target(bar.header.target))
  if not message then bar.status.caption=err;return end
  preferences(player).draft = ""
  bar.body.fac_message.text = ""
  bar.body.fac_send.focus()
  bar.status.caption = "Sent"
end

local function spawn(player, panel)
  local id, maximum = 1, contract.companion_spawn.inputSchema.properties.companionId.maximum
  while storage.companions[id] and id <= maximum do id=id+1 end
  local name = panel.create.fac_name.text:match("^%s*(.-)%s*$")
  local result = input.control(player,"companion_spawn",{companionId=id,name=name~="" and name or nil})
  panel.error.caption = result.error or ""
  if not result.error then panel.create.fac_name.text="" end
  refresh_panel(player, panel)
end

local function reset_position(player)
  for_root(player, BAR, "reset_position", function()
    preferences(player).location = nil
    local bar = root(player, BAR)
    if bar then place(player, bar) end
  end)
end

local function click(player, e, owner, name)
  if name == BAR then
    if e.name == "fac_send" then send(player, owner)
    elseif e.name == "fac_manage" then M.open(player)
    elseif e.name == "fac_hide_chat" then hide_chat(player) end
    return
  end
  if e.name == "fac_close" then owner.destroy()
  elseif e.name == "fac_spawn" then spawn(player, owner)
  elseif e.name == "fac_reset_position" then reset_position(player)
  elseif e.tags.fac_action then
    local action, cid = cfg.actions[e.tags.fac_action], e.tags.cid
    local c = u.get_companion(cid)
    if not action or not c or c.entity.force ~= player.force then return end
    local args = {companionId=cid}
    if action.player_argument then args[action.player_argument]=player.name end
    local result = input.control(player,action.tool,args)
    owner.error.caption = result.error or ""
    refresh_panel(player, owner)
  end
end

function M.rebuild()
  for _, player in pairs(game.players) do
    for_root(player, PANEL, "rebuild_manager", function() remove(player, PANEL) end)
    for_root(player, BAR, "rebuild_chat", function()
      local bar = root(player, BAR)
      remember_bar(player, bar)
      if bar then bar.destroy() end
      -- Legacy saves have no explicit visibility preference: retire their old bar.
      if preferences(player).chat_visible then refresh_bar(player, build_bar(player)) end
    end)
  end
end

local function refresh(player)
  for_root(player, BAR, "refresh_chat", function()
    local prefs = storage.overlay and storage.overlay[player.index]
    if prefs and prefs.chat_visible then
      refresh_bar(player, root(player, BAR) or build_bar(player))
    end
  end)
  for_root(player, PANEL, "refresh_manager", function()
    local panel = root(player, PANEL)
    if panel then refresh_panel(player, panel) end
  end)
end

function M.tick()
  for _, player in pairs(game.connected_players) do refresh(player) end
end

local function gui_event(event_type, operation, handle)
  script.on_event(event_type,function(event)
    local player, name
    protect(operation, function()
      local e = event.element
      if not e or not e.valid or e.get_mod() ~= MOD then return end
      player = game.get_player(event.player_index)
      if not player or not player.valid then return end
      local bar, panel = root(player, BAR), root(player, PANEL)
      local owner = e
      while owner and owner ~= bar and owner ~= panel do owner = owner.parent end
      if not owner then return end
      name = owner == bar and BAR or PANEL
      handle(player, e, owner, name)
    end, function()
      if name then recover_root(player, name) end
    end)
  end)
end

gui_event(defines.events.on_gui_click,"click",click)
gui_event(defines.events.on_gui_confirmed,"confirm",function(player, e, owner, name)
  if name == PANEL and e == owner.create.fac_name then spawn(player, owner) end
end)
gui_event(defines.events.on_gui_closed,"close",function(_, e, owner, name)
  if name == PANEL and e == owner then owner.destroy() end
end)
gui_event(defines.events.on_gui_text_changed,"draft",function(player, e, owner, name)
  if name == BAR and e == owner.body.fac_message then preferences(player).draft = e.text end
end)
gui_event(defines.events.on_gui_selection_state_changed,"selection",function(player, e, owner, name)
  if name == BAR and e == owner.header.target then preferences(player).target = target(e) end
end)
gui_event(defines.events.on_gui_location_changed,"location",function(player, e, owner, name)
  if name == BAR and e == owner then preferences(player).location = e.location end
end)

local function player_event(event_types, operation, handle)
  script.on_event(event_types,function(event)
    protect(operation, function()
      local player = game.get_player(event.player_index)
      if player and player.valid then handle(player) end
    end)
  end)
end

player_event({defines.events.on_player_created,defines.events.on_player_joined_game},"join",refresh)
script.on_event(defines.events.on_player_removed,function(event)
  if storage.overlay then storage.overlay[event.player_index] = nil end
end)
player_event({defines.events.on_player_display_resolution_changed,defines.events.on_player_display_scale_changed},"resize",function(player)
  for_root(player, BAR, "place_chat", function()
    local bar = root(player, BAR)
    if bar then place(player,bar) end
  end)
end)

return M
