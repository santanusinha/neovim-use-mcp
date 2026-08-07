/**
 * Lua chunks that run inside Neovim. Each chunk takes its arguments through
 * `...` and returns plain tables, so msgpack can carry them back.
 */

/**
 * Force lazy-loaded plugin managers to load their LSP setup. Headless Neovim
 * never fires UIEnter or VeryLazy, so plugins that lazy-load on those events
 * stay asleep and no language server attaches.
 */
export const WARMUP = `
local loaded = {}
pcall(function()
  vim.api.nvim_exec_autocmds("User", { pattern = "VeryLazy", modeline = false })
end)
local ok, lazy = pcall(require, "lazy")
if ok then
  local want = {}
  for _, plugin in ipairs(lazy.plugins()) do
    local name = plugin.name or ""
    if name:match("lsp") or name:match("mason") or name:match("lint")
      or name:match("conform") or name:match("null%-ls") or name:match("treesitter") then
      if not plugin._.loaded then want[#want + 1] = name end
    end
  end
  if #want > 0 then
    pcall(lazy.load, { plugins = want, wait = true })
    loaded = want
  end
end
vim.wait(200)
return { loaded = loaded }
`;
/** Open a file, attach LSP, and report buffer facts. */
export const OPEN_FILE = `
local path, wait_ms = ...
local abs = vim.fn.fnamemodify(path, ":p")
if vim.fn.filereadable(abs) == 0 and vim.fn.isdirectory(abs) == 1 then
  return { error = "path is a directory: " .. abs }
end
vim.cmd("edit " .. vim.fn.fnameescape(abs))
local buf = vim.api.nvim_get_current_buf()
vim.bo[buf].buflisted = true

-- Servers attach at different speeds. Wait for the count to stay stable, so a
-- slow real language server is not missed behind a fast linter bridge.
local deadline = vim.loop.now() + (wait_ms or 3000)
local clients = {}
local stable = 0
while vim.loop.now() < deadline do
  local now = vim.lsp.get_clients({ bufnr = buf })
  if #now > 0 and #now == #clients then
    stable = stable + 1
    if stable >= 6 then break end
  else
    stable = 0
  end
  clients = now
  vim.wait(100)
end
clients = vim.lsp.get_clients({ bufnr = buf })

local names = {}
for _, c in ipairs(clients) do names[#names + 1] = c.name end
return {
  buffer = buf,
  path = abs,
  exists = vim.fn.filereadable(abs) == 1,
  line_count = vim.api.nvim_buf_line_count(buf),
  filetype = vim.bo[buf].filetype,
  modified = vim.bo[buf].modified,
  lsp_clients = names,
}
`;

/** Read a line range from a buffer. */
export const READ_LINES = `
local path, start_line, end_line, max_lines = ...
if start_line == vim.NIL then start_line = nil end
if end_line == vim.NIL then end_line = nil end
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
local total = vim.api.nvim_buf_line_count(buf)
local s = math.max(1, start_line or 1)
local e = end_line and math.min(end_line, total) or total
if e - s + 1 > max_lines then e = s + max_lines - 1 end
local lines = vim.api.nvim_buf_get_lines(buf, s - 1, e, false)
return {
  path = vim.api.nvim_buf_get_name(buf),
  start_line = s,
  end_line = e,
  total_lines = total,
  truncated = e < total,
  lines = lines,
}
`;

/** Replace a line range with new text. */
export const SET_LINES = String.raw`
local path, start_line, end_line, text = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
local total = vim.api.nvim_buf_line_count(buf)
if start_line < 1 or start_line > total + 1 then
  return { error = "start_line " .. start_line .. " is out of range 1.." .. (total + 1) }
end
local new_lines = vim.split(text, "\\n", { plain = true })
if text == "" then new_lines = {} end
vim.api.nvim_buf_set_lines(buf, start_line - 1, end_line, false, new_lines)
return {
  buffer = buf,
  replaced_from = start_line,
  replaced_to = end_line,
  new_line_count = vim.api.nvim_buf_line_count(buf),
}
`;

/** Insert lines before a given line number. */
export const INSERT_LINES = String.raw`
local path, line, text = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
local total = vim.api.nvim_buf_line_count(buf)
local at = math.max(0, math.min(line - 1, total))
local new_lines = vim.split(text, "\\n", { plain = true })
vim.api.nvim_buf_set_lines(buf, at, at, false, new_lines)
return { buffer = buf, inserted_at = at + 1, new_line_count = vim.api.nvim_buf_line_count(buf) }
`;

/** Replace exact text once, or report the match count. */
export const REPLACE_TEXT = String.raw`
local path, old_text, new_text, replace_all = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
local content = table.concat(lines, "\\n")
local count = 0
local search_start = 1
while true do
  local s = string.find(content, old_text, search_start, true)
  if not s then break end
  count = count + 1
  search_start = s + #old_text
end
if count == 0 then return { error = "no_match", count = 0 } end
if count > 1 and not replace_all then return { error = "many_matches", count = count } end

local out = {}
local pos = 1
while true do
  local s, e = string.find(content, old_text, pos, true)
  if not s then break end
  out[#out + 1] = string.sub(content, pos, s - 1)
  out[#out + 1] = new_text
  pos = e + 1
  if not replace_all then break end
end
out[#out + 1] = string.sub(content, pos)
local updated = table.concat(out)
vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(updated, "\\n", { plain = true }))
return { buffer = buf, replacements = replace_all and count or 1,
  new_line_count = vim.api.nvim_buf_line_count(buf) }
`;

/** Save a buffer so BufWritePre autocommands run. */
export const SAVE_BUFFER = `
local path = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
local ok, err = pcall(function()
  vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end)
end)
if not ok then return { error = tostring(err) } end
return { buffer = buf, path = vim.api.nvim_buf_get_name(buf),
  line_count = vim.api.nvim_buf_line_count(buf), modified = vim.bo[buf].modified }
`;

/** List listed buffers. */
export const LIST_BUFFERS = `
local out = {}
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buflisted then
    out[#out + 1] = {
      buffer = buf,
      path = vim.api.nvim_buf_get_name(buf),
      filetype = vim.bo[buf].filetype,
      modified = vim.bo[buf].modified,
      line_count = vim.api.nvim_buf_line_count(buf),
    }
  end
end
return out
`;

/** Collect diagnostics for one buffer or for all buffers. */
export const DIAGNOSTICS = `
local path, severity, wait_ms = ...
local bufs = {}
if path and path ~= "" then
  local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
  if buf == -1 then return { error = "not_open" } end
  bufs = { buf }
else
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buflisted then bufs[#bufs + 1] = b end
  end
end
vim.wait(wait_ms or 300)

local names = { "ERROR", "WARN", "INFO", "HINT" }
local min = 4
if severity == "error" then min = 1
elseif severity == "warn" then min = 2
elseif severity == "info" then min = 3 end

local out = {}
for _, buf in ipairs(bufs) do
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    if d.severity <= min then
      out[#out + 1] = {
        path = vim.api.nvim_buf_get_name(buf),
        line = d.lnum + 1,
        column = d.col + 1,
        severity = names[d.severity] or "UNKNOWN",
        message = d.message,
        source = d.source,
        code = d.code and tostring(d.code) or nil,
      }
    end
  end
end
return out
`;

/** Run a position-based LSP request and normalise the locations. */
export const LSP_LOCATIONS = `
local path, line, col, method, wait_ms = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local params = vim.lsp.util.make_position_params(0, "utf-8")
params.textDocument = { uri = vim.uri_from_bufnr(buf) }
params.position = { line = line - 1, character = col - 1 }
if method == "textDocument/references" then
  params.context = { includeDeclaration = true }
end

local results = vim.lsp.buf_request_sync(buf, method, params, wait_ms or 3000)
if not results then return { error = "lsp_timeout" } end

local out = {}
for _, res in pairs(results) do
  local items = res.result
  if items then
    if items.uri or items.targetUri then items = { items } end
    for _, item in ipairs(items) do
      local uri = item.uri or item.targetUri
      local range = item.range or item.targetSelectionRange or item.targetRange
      if uri and range then
        local file = vim.uri_to_fname(uri)
        local text = ""
        local ok, lines = pcall(vim.fn.readfile, file)
        if ok and lines[range.start.line + 1] then
          text = vim.trim(lines[range.start.line + 1])
        end
        out[#out + 1] = {
          path = file,
          line = range.start.line + 1,
          column = range.start.character + 1,
          text = text,
        }
      end
    end
  end
end
return out
`;

/** Hover text at a position. */
export const LSP_HOVER = String.raw`
local path, line, col, wait_ms = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local params = {
  textDocument = { uri = vim.uri_from_bufnr(buf) },
  position = { line = line - 1, character = col - 1 },
}
local results = vim.lsp.buf_request_sync(buf, "textDocument/hover", params, wait_ms or 3000)
if not results then return { error = "lsp_timeout" } end
local parts = {}
for _, res in pairs(results) do
  local c = res.result and res.result.contents
  if c then
    if type(c) == "string" then parts[#parts + 1] = c
    elseif c.value then parts[#parts + 1] = c.value
    else
      for _, entry in ipairs(c) do
        parts[#parts + 1] = type(entry) == "string" and entry or entry.value
      end
    end
  end
end
return { text = table.concat(parts, "\\n") }
`;

/** Rename a symbol across the workspace and save every touched buffer. */
export const LSP_RENAME = `
local path, line, col, new_name, wait_ms = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local params = {
  textDocument = { uri = vim.uri_from_bufnr(buf) },
  position = { line = line - 1, character = col - 1 },
  newName = new_name,
}
local results = vim.lsp.buf_request_sync(buf, "textDocument/rename", params, wait_ms or 5000)
if not results then return { error = "lsp_timeout" } end

local touched = {}
for client_id, res in pairs(results) do
  if res.result then
    local client = vim.lsp.get_client_by_id(client_id)
    local encoding = client and client.offset_encoding or "utf-8"
    vim.lsp.util.apply_workspace_edit(res.result, encoding)
    local changes = res.result.changes or {}
    for uri, _ in pairs(changes) do touched[vim.uri_to_fname(uri)] = true end
    for _, change in ipairs(res.result.documentChanges or {}) do
      if change.textDocument then
        touched[vim.uri_to_fname(change.textDocument.uri)] = true
      end
    end
  end
end

local saved = {}
for file, _ in pairs(touched) do
  local b = vim.fn.bufnr(file)
  if b ~= -1 then
    vim.api.nvim_buf_call(b, function() vim.cmd("silent write") end)
    saved[#saved + 1] = file
  end
end
return { new_name = new_name, files = saved }
`;

/** List or apply code actions at a position. */
export const LSP_CODE_ACTIONS = `
local path, line, col, apply_index, wait_ms = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local params = {
  textDocument = { uri = vim.uri_from_bufnr(buf) },
  range = {
    start = { line = line - 1, character = col - 1 },
    ["end"] = { line = line - 1, character = col - 1 },
  },
  context = { diagnostics = vim.lsp.diagnostic.get_line_diagnostics and
    vim.lsp.diagnostic.get_line_diagnostics(buf, line - 1) or {} },
}
local results = vim.lsp.buf_request_sync(buf, "textDocument/codeAction", params, wait_ms or 3000)
if not results then return { error = "lsp_timeout" } end

local actions = {}
for client_id, res in pairs(results) do
  for _, action in ipairs(res.result or {}) do
    actions[#actions + 1] = { client_id = client_id, action = action }
  end
end
if #actions == 0 then return { actions = {} } end

if apply_index and apply_index > 0 then
  local chosen = actions[apply_index]
  if not chosen then return { error = "index_out_of_range", count = #actions } end
  local client = vim.lsp.get_client_by_id(chosen.client_id)
  local action = chosen.action
  if action.edit then
    vim.lsp.util.apply_workspace_edit(action.edit, client and client.offset_encoding or "utf-8")
  end
  if action.command then
    local cmd = type(action.command) == "table" and action.command or action
    if client then client:exec_cmd(cmd, { bufnr = buf }) end
  end
  vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end)
  return { applied = action.title }
end

local titles = {}
for i, entry in ipairs(actions) do
  titles[#titles + 1] = { index = i, title = entry.action.title, kind = entry.action.kind }
end
return { actions = titles }
`;

/** Format a buffer or a line range. */
export const LSP_FORMAT = `
local path, start_line, end_line, wait_ms = ...
if start_line == vim.NIL then start_line = nil end
if end_line == vim.NIL then end_line = nil end
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local opts = { bufnr = buf, timeout_ms = wait_ms or 5000, async = false }
if start_line and end_line then
  opts.range = {
    start = { start_line, 0 },
    ["end"] = { end_line, 0 },
  }
end
local ok, err = pcall(vim.lsp.buf.format, opts)
if not ok then return { error = tostring(err) } end
vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end)
return { path = vim.api.nvim_buf_get_name(buf), line_count = vim.api.nvim_buf_line_count(buf) }
`;

/** Document symbol outline. */
export const LSP_DOCUMENT_SYMBOLS = `
local path, wait_ms = ...
local buf = vim.fn.bufnr(vim.fn.fnamemodify(path, ":p"))
if buf == -1 then return { error = "not_open" } end
if #vim.lsp.get_clients({ bufnr = buf }) == 0 then return { error = "no_lsp" } end
local params = { textDocument = { uri = vim.uri_from_bufnr(buf) } }
local results = vim.lsp.buf_request_sync(buf, "textDocument/documentSymbol", params, wait_ms or 3000)
if not results then return { error = "lsp_timeout" } end

local kinds = vim.lsp.protocol.SymbolKind
local out = {}
local function walk(items, depth)
  for _, s in ipairs(items or {}) do
    local range = s.range or (s.location and s.location.range)
    out[#out + 1] = {
      name = s.name,
      kind = type(kinds[s.kind]) == "string" and kinds[s.kind] or tostring(s.kind),
      line = range and (range.start.line + 1) or 0,
      depth = depth,
      detail = s.detail,
    }
    walk(s.children, depth + 1)
  end
end
for _, res in pairs(results) do walk(res.result, 0) end
return out
`;

/** Workspace symbol search. */
export const LSP_WORKSPACE_SYMBOLS = `
local query, wait_ms = ...
local buf = vim.api.nvim_get_current_buf()
if #vim.lsp.get_clients() == 0 then return { error = "no_lsp" } end
local results = vim.lsp.buf_request_sync(buf, "workspace/symbol", { query = query }, wait_ms or 5000)
if not results then return { error = "lsp_timeout" } end
local kinds = vim.lsp.protocol.SymbolKind
local out = {}
for _, res in pairs(results) do
  for _, s in ipairs(res.result or {}) do
    local loc = s.location
    out[#out + 1] = {
      name = s.name,
      kind = type(kinds[s.kind]) == "string" and kinds[s.kind] or tostring(s.kind),
      path = loc and vim.uri_to_fname(loc.uri) or nil,
      line = loc and (loc.range.start.line + 1) or nil,
      container = s.containerName,
    }
  end
end
return out
`;
