-- MCP usage: which assistant called, and how a tool refused.
--
-- WHY: a tool that refuses (`{ ok: false, error }`) still answers HTTP 200, and a
-- row recorded only the status, so a refused call was counted as served. And no
-- row said which assistant made the call, so "who uses the MCP server" had no
-- answer. saferate-ai's own MCP server has recorded both since launch.
--
-- clientName is the name the client says it is (MCP v2 `_meta` clientInfo, e.g.
-- "claude-code"), not a user-agent or anything about the person. errorCode is the
-- tool's own code ("bad_request", "not_found"), "input_required" when the tool
-- asked for a missing argument, or the exception's name when it threw. Both are
-- null for REST requests and for MCP requests that are not tool calls.
alter table apiUsageEvents add column clientName text;
alter table apiUsageEvents add column errorCode text;
