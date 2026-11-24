local u = require("commands.init")

u.register("research_get", function(args)
  u.safe_command(function()
    local id, c = u.find_companion(args.companionId)
    if not id then u.not_found(); return end
    local force = c.entity.force
    local current = force.current_research and {name = force.current_research.name, progress = force.research_progress} or nil
    local available = {}
    for name, tech in pairs(force.technologies) do
      if not tech.researched and tech.enabled then
        local can = true
        for _, p in pairs(tech.prerequisites) do if not p.researched then can = false; break end end
        if can then
          local ings = {}
          for _, ing in pairs(tech.research_unit_ingredients) do ings[#ings + 1] = ing.name end
          available[#available + 1] = {name = name, units = tech.research_unit_count, ingredients = ings}
        end
      end
    end
    table.sort(available, function(a, b) return a.units < b.units end)
    if #available > 30 then local t = {}; for i = 1, 30 do t[i] = available[i] end; available = t end
    -- The queue is where a technology goes without becoming the active one, and a
    -- companion that cannot see it cannot tell "queued" from "not accepted".
    local queue = {}
    for position, tech in ipairs(force.research_queue or {}) do
      queue[#queue + 1] = {position = position, name = tech.name}
    end
    u.json_response({id = id, current = current, queue = queue, available = available, count = #available})
  end)
end)

u.register("research_progress", function(args)
  u.safe_command(function()
    local id, c = u.find_companion(args.companionId)
    if not id then u.not_found(); return end
    local force = c.entity.force
    local tech_name = args.technology ~= "" and args.technology or (force.current_research and force.current_research.name)
    if not tech_name then u.json_response({id = id, researching = nil}); return end
    local tech = force.technologies[tech_name]
    if not tech then u.json_response({id = id, error = "Not found"}); return end
    if tech.researched then u.json_response({id = id, tech = tech_name, done = true}); return end
    local is_cur = force.current_research and force.current_research.name == tech_name
    local prog = is_cur and force.research_progress or 0
    u.json_response({id = id, tech = tech_name, progress = prog, remaining = math.ceil(tech.research_unit_count * (1 - prog))})
  end)
end)

u.register("research_set", function(args)
  u.safe_command(function()
    local id, c = u.find_companion(args.companionId)
    if not id then u.not_found(); return end
    local force = c.entity.force
    local tech = force.technologies[args.technology]
    if not tech then u.json_response({id = id, error = "Not found"}); return end
    if tech.researched then u.json_response({id = id, error = "Already done"}); return end
    for _, p in pairs(tech.prerequisites) do if not p.researched then u.json_response({id = id, error = "Missing: " .. p.name}); return end end
    -- Both of these make add_research return false without anything being wrong.
    -- Reporting them as "Failed" told a caller its research request had been
    -- rejected when the technology was already on its way.
    for position, queued in ipairs(force.research_queue or {}) do
      if queued.name == args.technology then
        u.json_response({id = id, research = args.technology, queued = true,
          position = position, already_queued = true}); return
      end
    end
    if force.current_research and force.current_research.name == args.technology then
      u.json_response({id = id, research = args.technology, researching = true, already_current = true}); return
    end
    if force.add_research(args.technology) then
      u.json_response({id = id, research = args.technology, queued = true})
    else
      u.json_response({id = id, error = "Could not queue " .. args.technology ..
        ": the research queue is disabled or full"})
    end
  end)
end)

-- Switching the active research is what a player does by clicking a technology in
-- the research screen. Without it a companion could only ever append to the queue
-- and wait behind whatever was in front.
u.register("research_switch", function(args)
  u.safe_command(function()
    local id, c = u.find_companion(args.companionId)
    if not id then u.not_found(); return end
    local force = c.entity.force
    local tech = force.technologies[args.technology]
    if not tech then u.json_response({id = id, error = "Not found"}); return end
    if tech.researched then u.json_response({id = id, error = "Already done"}); return end
    if not tech.enabled then u.json_response({id = id, error = "Not available yet"}); return end
    for _, p in pairs(tech.prerequisites) do
      if not p.researched then u.json_response({id = id, error = "Missing: " .. p.name}); return end
    end
    local previous = force.current_research and force.current_research.name or nil
    -- current_research is read only in Factorio 2.x ("LuaForce::current_research is
    -- read only"). The head of research_queue IS the active technology, so
    -- promoting a technology means moving it to the head and keeping the rest
    -- behind it. Assigning the queue also starts research when nothing runs.
    local queue = {tech}
    for _, other in ipairs(force.research_queue or {}) do
      if other.name ~= tech.name then
        queue[#queue + 1] = other
      end
    end
    force.research_queue = queue
    local order = {}
    for _, entry in ipairs(force.research_queue or {}) do
      order[#order + 1] = entry.name
    end
    u.json_response({id = id,
      researching = force.current_research and force.current_research.name or nil,
      previous = previous, queue = order})
  end)
end)

-- Cancel without picking a replacement: the queue decides what runs next.
u.register("research_cancel", function(args)
  u.safe_command(function()
    local id, c = u.find_companion(args.companionId)
    if not id then u.not_found(); return end
    local force = c.entity.force
    local current = force.current_research
    if not current then u.json_response({id = id, cancelled = nil, note = "nothing in progress"}); return end
    local name = current.name
    force.cancel_current_research()
    u.json_response({id = id, cancelled = name,
      researching = force.current_research and force.current_research.name or nil})
  end)
end)
