-- AI Companion - Help
local u = require("commands.init")
local contract = require("commands.contract")

-- Version command
u.register("version", function(args)
  local version = script.active_mods["ai-companion"] or "unknown"
  u.json_response({version = version, factorio = script.active_mods["base"] or "unknown"})
end)

u.register("get_errors", function(args)
  u.json_response({errors = storage.errors or {}})
end)

u.register("help", function(args)
  local version = script.active_mods["ai-companion"] or "unknown"
  local category = args and args.category
  local tools = {}
  for name, definition in pairs(contract) do
    -- The filter is a plain name prefix: "building" selects building_* and nothing else.
    local wanted = not category or name:sub(1, #category) == category
    if definition.execution == "game" and wanted then
      tools[#tools + 1] = {name = name, description = definition.description, inputSchema = definition.inputSchema}
    end
  end
  table.sort(tools, function(a, b) return a.name < b.name end)
  u.json_response({version = version, category = category, count = #tools, tools = tools})
end)
