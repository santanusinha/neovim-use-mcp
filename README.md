# neovim-use-mcp

[![npm version](https://img.shields.io/npm/v/neovim-use-mcp.svg)](https://www.npmjs.com/package/neovim-use-mcp)
[![CI](https://github.com/santanusinha/neovim-use-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/santanusinha/neovim-use-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that edits files **through a real Neovim instance**. Your agent
gets your language servers, your formatters and your plugins, not a plain text
writer.

- **Real LSP** — diagnostics after every edit, rename, code actions, hover,
  references, document and workspace symbols.
- **Minimal diffs** — edit tools save the buffer with `noautocmd write` by
  default, so `BufWritePre` (format-on-save) does not run. Only the edited
  lines change. Use `nvim_format` to format explicitly.
- **Plugin access** — `nvim_command` and `nvim_exec_lua` reach anything else.
- **stdio transport** — the server starts with the agent and stops with it.
  It also stops the Neovim child process.

---

## Requirements

| Item | Version | Note |
|---|---|---|
| Node.js | 18 or later | The server runs on Node. |
| Neovim | 0.10 or later | The server calls `vim.lsp.get_clients`. |
| A Neovim config | optional | Without one, you get edits but no LSP. |

Check your Neovim first:

```bash
nvim --version
nvim --headless --embed   # must start and stay quiet; press Ctrl-C to stop
```

If that command prints errors, a plugin breaks headless start. Use
`--config-mode minimal` until you fix the plugin.

---

## Install

### From npm (recommended)

```bash
npm install -g neovim-use-mcp
```

Or use `npx` without a global install:

```bash
npx neovim-use-mcp
```

### From source

```bash
git clone https://github.com/santanusinha/neovim-use-mcp.git
cd neovim-use-mcp
npm install
npm run build
```

The build writes `dist/index.js`. That file is the server.

---

## Connect an agent

Add the server to your MCP client config.

**With npx (no install needed):**

```json
{
  "mcpServers": {
    "neovim": {
      "command": "npx",
      "args": ["neovim-use-mcp"],
      "env": {
        "NVIM_MCP_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```

**With a global install:**

```json
{
  "mcpServers": {
    "neovim": {
      "command": "neovim-use-mcp",
      "env": {
        "NVIM_MCP_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```

**From a local build:**

```json
{
  "mcpServers": {
    "neovim": {
      "command": "node",
      "args": ["/absolute/path/to/neovim-use-mcp/dist/index.js"],
      "env": {
        "NVIM_MCP_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```
> [!TIP]
> `NVIM_MCP_CWD` sets the project root. The language server uses that root to
find `tsconfig.json`, `go.mod`, `Cargo.toml` and so on. If you leave it out,
the server uses the directory that the agent starts it in.

The server needs no start or stop command. The agent starts it over stdio and
stops it on exit. The server then stops its Neovim child process.

---

## First run

Ask your agent to open a file:

> Open `src/util/format.ts` with the Neovim tools.

A correct answer looks like this:

```
Opened src/util/format.ts (buffer 1, 59 lines, filetype typescript).
LSP clients: null-ls, quick_lint_js, ts_ls
```

If you see `No LSP client attached`, read
[When no LSP attaches](#when-no-lsp-attaches).

---

## How an agent should work

The tools follow one simple order.

1. **Open** the file(s) with `nvim_open_file`. Pass an array of paths to open
   several files at once. This starts the language server. Every LSP tool needs
   an open buffer.
2. **Read** with `nvim_read_file` to get numbered lines.
3. **Edit** with `nvim_edit_text`, `nvim_edit_lines` or `nvim_insert_lines`.
   Each edit saves the file and returns fresh diagnostics.
4. **Fix** any new diagnostic with `nvim_code_actions`.

Three rules make the results much better:

- Use `nvim_rename_symbol` for a rename. Do not use a text replace. The LSP
  changes every file, and a text replace does not.
- Use `nvim_edit_text` when you know the exact text. It fails if the text is
  not unique, which stops a wrong edit.
- Stage a multi-file change with `save: false`, then call `nvim_save_buffer`
  once per file.

---

## Tools

The server loads one of two tiers. The `--tools` flag picks the tier.
`minimal` is the default and loads the 10 tools an agent runs all day.
`full` loads all 18 tools. No tool is deleted; the tier only decides what
loads into the agent's context.

### Minimal tier (default, 10 tools)

| Tool | Arguments | Purpose |
|---|---|---|
| `nvim_open_file` | `path` (string or array), `wait_ms?` | Pre-warm files or tune the LSP wait. Other tools open files on demand |
| `nvim_read_file` | `path`, `start_line?`, `end_line?` | Read numbered lines |
| `nvim_edit_lines` | `path`, `start_line`, `end_line`, `text`, `save?` | Replace a range, or insert before a line with `start_line = end_line + 1`. The default edit tool |
| `nvim_format` | `path`, `start_line?`, `end_line?` | Format a file or a range |
| `nvim_rename_symbol` | `path`, `line`, `column`, `new_name` | Rename across the workspace |
| `nvim_goto_definition` | `path`, `line`, `column`, `wait_ms?` | Find a definition |
| `nvim_references` | `path`, `line`, `column`, `wait_ms?` | Find every reference |
| `nvim_hover` | `path`, `line`, `column`, `wait_ms?` | Type and documentation |
| `nvim_code_actions` | `path`, `line`, `column`, `apply_index?` | List or apply a quick fix |
| `nvim_exec_lua` | `code`, `args?` | Run Lua inside Neovim |

### Full tier adds (8 tools)

| Tool | Arguments | Purpose |
|---|---|---|
| `nvim_edit_text` | `path`, `old_text`, `new_text`, `replace_all?`, `save?` | Replace exact text. Tolerates whitespace drift and preserves indentation |
| `nvim_insert_lines` | `path`, `line`, `text`, `save?` | Insert text before a line. Prefer `nvim_edit_lines` insert mode |
| `nvim_save_buffer` | `path` | Write a buffer (no format-on-save autocmds) |
| `nvim_diagnostics` | `path?`, `severity?`, `wait_ms?` | Errors and warnings for one file or all buffers |
| `nvim_list_buffers` | — | List open buffers |
| `nvim_document_symbols` | `path`, `wait_ms?` | Outline a file |
| `nvim_workspace_symbols` | `query`, `path?`, `wait_ms?` | Search symbols in the project |
| `nvim_command` | `command` | Run an Ex command, for example a plugin command |

Lines and columns start at 1.

Edit tools save the buffer by default and return fresh diagnostics, both as
text and as a structured payload: `{ saved, line_count, errors, warnings,
infos, diagnostics[] }`.

`nvim_exec_lua` runs any code. Turn it off with `--no-exec` if the agent is
not trusted.
not trusted.

---

## Recipes

### Fix every error in a file

```
nvim_open_file    path=src/app.ts
nvim_diagnostics  path=src/app.ts severity=error
nvim_code_actions path=src/app.ts line=42 column=9        # list
nvim_code_actions path=src/app.ts line=42 column=9 apply_index=1
```

### Rename a symbol everywhere

```
nvim_open_file      path=src/util/format.ts
nvim_document_symbols path=src/util/format.ts             # find the line
nvim_rename_symbol  path=src/util/format.ts line=28 column=17 new_name=renderIssues
```

The tool returns the list of files that it changed and saved.

### Change several places, then save once

```
nvim_edit_text path=src/a.ts old_text="foo(" new_text="bar(" save=false
nvim_edit_text path=src/a.ts old_text="= foo" new_text="= bar" save=false
nvim_save_buffer path=src/a.ts
```

### Run a plugin command

```
nvim_command command="Telescope find_files"
nvim_exec_lua code="return vim.fn.getcwd()"
```

---

## Options

Command line flags win over environment variables.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--mode` | `NVIM_MCP_MODE` | `embedded` | `embedded` spawns its own nvim; `attach` connects to a socket |
| `--socket` | `NVIM_MCP_SOCKET` | — | Socket for attach mode |
| `--nvim` | `NVIM_MCP_BIN` | `nvim` | Path to the nvim binary |
| `--config-mode` | `NVIM_MCP_CONFIG_MODE` | `user` | `user` loads your config; `minimal` runs `nvim --clean` |
| `--no-exec` | `NVIM_MCP_ALLOW_EXEC=0` | exec on | Turn off `nvim_exec_lua` and `nvim_command` |
| `--tools` | `NVIM_MCP_TOOLS` | `minimal` | `minimal` loads 10 tools; `full` loads all 18 |
| `--cwd` | `NVIM_MCP_CWD` | process cwd | Project root for the LSP |
| `--lsp-wait-ms` | `NVIM_MCP_LSP_WAIT_MS` | `3000` | Default LSP wait |
| `--diag-wait-ms` | `NVIM_MCP_DIAG_WAIT_MS` | `500` | Diagnostics settle wait after an edit; floor 250 |
| `--debug` | `NVIM_MCP_DEBUG` | off | Debug lines on stderr |

### Watch the agent work

Attach mode shows you every edit in your own window, live.

## Recipes

### Fix every error in a file

```
nvim_read_file    path=src/app.ts                          # implicit open
nvim_edit_lines   path=src/app.ts start_line=42 end_line=42 text="..."
                                                            # feedback carries diagnostics
nvim_code_actions path=src/app.ts line=42 column=9 apply_index=1
```

### Rename a symbol everywhere

```
nvim_rename_symbol  path=src/util/format.ts line=28 column=17 new_name=renderIssues
```

The tool returns the list of files that it changed and saved.

### Insert before a line

```
nvim_edit_lines path=src/app.ts start_line=5 end_line=4 text="import { join } from \"node:path\";"
```

`start_line = end_line + 1` means insert before `start_line`.

### Stage several edits, then save once (full tier)

```
nvim_edit_lines  path=src/a.ts start_line=10 end_line=10 text="..." save=false
nvim_edit_lines  path=src/a.ts start_line=20 end_line=20 text="..." save=false
nvim_save_buffer path=src/a.ts
```

### Run a plugin command (full tier)

```
nvim_command command="Telescope find_files"
nvim_exec_lua code="return vim.fn.getcwd()"
```

### A tool is missing

The minimal tier loads 10 tools. Start the server with `--tools full` to load
all 18. Full-tier tool descriptions start with "Full-tier tool".
### A language server does not attach

1. Check that the file type has a language server in your Neovim config.
2. Call `nvim_open_file` with a longer `wait_ms`, for example `10000`.
3. Confirm the server starts in your own Neovim for the same file.

### A stale swap file blocks or warns

The server never writes swap files and never stops on the E325 prompt. A
swap file that sits next to a target file is stale, or another editor owns
it. `nvim_open_file` still opens the file and prints a note:

```
Stale swap file ignored: /path/.file.txt.swp. Delete it to remove this note.
```

Delete the `.swp` file to remove the note. The structured result carries
the path in `stale_swap`.

### The server does not start


Run it by hand and read stderr:

```bash
NVIM_MCP_DEBUG=1 node dist/index.js
```

A healthy start prints:

```
[nvim-mcp] ready (mode=embedded, tools=minimal, exec=true, cwd=/your/project)
```

### A plugin breaks headless Neovim

Use `--config-mode minimal`. The server then runs `nvim --clean`. You keep the
edit tools, but you lose your plugins and your LSP setup.

### Diagnostics look wrong or stale

A linter bridge, for example `null-ls` with `eslint_d`, reports an error when
the project has no lint config. Add the config, or make the null-ls source
conditional on a config file. This is an editor setup problem, not a server
problem.

### A tool says the text is not unique

`nvim_edit_text` refuses an ambiguous match on purpose. Add more context lines
to `old_text`, or set `replace_all: true` if you truly want every match.

---

## Development

```bash
npm run dev              # tsc --watch
npm test                 # vitest, uses a real headless nvim
npm run typecheck        # tsc --noEmit
npm run inspect          # MCP Inspector UI
```

### Docker

A Dockerfile is included for isolated or CI usage. The image bundles Node and
Neovim, but has no user Neovim config. Mount your config if you need LSP:

```bash
docker build -t neovim-use-mcp .
docker run --rm neovim-use-mcp
```

### Releasing

Releases publish to npm through GitHub Actions with OIDC trusted publishing.
No npm token is stored.

1. Bump the version in `package.json`.
2. Tag and push: `git tag v0.x.0 && git push origin v0.x.0`.
3. Create a GitHub Release from the tag.
4. The `Publish to npm` workflow builds, tests, and publishes automatically.

---

## Licence

MIT

> [!CAUTION]
> This is completely vibe coded. I guarantee absolutely nothing!!
