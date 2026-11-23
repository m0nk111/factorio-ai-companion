local u = require("commands.init")
local M = {}
local dispatch

-- Bind after control.lua registers every handler; require is forbidden during events.
function M.bind_dispatcher(value)
  dispatch = value
end

function M.send(player, text, cid)
  text = text:match("^%s*(.-)%s*$")
  if #text == 0 then return nil, "Write a message first" end
  if #text > u.settings.chat.max_message_bytes then return nil, "Message is too long" end
  if cid ~= 0 and not u.get_companion(cid) then return nil, "Companion is no longer available" end
  local name = player and player.name or "server"
  local message = {player=name,message=text,tick=game.tick,target_companion=cid}
  storage.companion_messages[#storage.companion_messages+1] = message
  local target = cid == 0 and "Codex" or u.get_companion_display(cid)
  game.print("[" .. name .. " -> " .. target .. "] " .. text, u.print_color(u.COLORS.player))
  return message
end

-- A click is an event, so the dispatcher is bound by control.lua at parse time
-- rather than required here; the loaded module is only a fallback so a missed
-- binding degrades into an error reply instead of a crashed handler.
local function dispatcher()
  return dispatch or package.loaded["commands.dispatch"]
end

function M.control(player, tool, args)
  local resolved = dispatcher()
  if not resolved then return {error = "dispatch not loaded yet"} end
  local result = resolved.call(tool, args, player)
  if not result.error then
    storage.companion_messages[#storage.companion_messages+1] = {
      player=player.name,tick=game.tick,target_companion=args.companionId,control={tool=tool,args=args}}
  end
  return result
end

return M
