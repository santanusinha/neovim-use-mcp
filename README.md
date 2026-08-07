# neovim-use-mcp

An MCP server that edits files **through a real Neovim instance**. Your agent
gets your language servers, your formatters and your plugins, not a plain text
writer.

- **Real LSP** — diagnostics after every edit, rename, code actions, hover,
  references, document and workspace symbols.
- **Format on save** — edits write the buffer, so `BufWritePre` runs and your
  formatter fires.
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

```bash
git clone <this repo> neovim-use-mcp
cd neovim-use-mcp
npm install
npm run build
```

The build writes `dist/index.js`. That file is the server.

---

## Connect an agent

Add the server to your MCP client config. Use an absolute path.

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

`NVIM_MCP_CWD` sets the project root. The language server uses that root to
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

1. **Open** the file with `nvim_open_file`. This starts the language server.
   Every LSP tool needs an open buffer.
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

### Buffer and file

| Tool | Arguments | Purpose |
|---|---|---|
| `nvim_open_file` | `path`, `wait_ms?` | Open a file and start its LSP client |
| `nvim_read_file` | `path`, `start_line?`, `end_line?` | Read numbered lines |
| `nvim_edit_lines` | `path`, `start_line`, `end_line`, `text`, `save?` | Replace a line range |
| `nvim_edit_text` | `path`, `old_text`, `new_text`, `replace_all?`, `save?` | Replace exact text |
| `nvim_insert_lines` | `path`, `line`, `text`, `save?` | Insert text before a line |
| `nvim_save_buffer` | `path` | Write a buffer and run format on save |
| `nvim_list_buffers` | — | List open buffers |

### LSP

| Tool | Arguments | Purpose |
|---|---|---|
| `nvim_diagnostics` | `path?`, `severity?`, `wait_ms?` | Errors and warnings |
| `nvim_goto_definition` | `path`, `line`, `column`, `wait_ms?` | Find a definition |
| `nvim_references` | `path`, `line`, `column`, `wait_ms?` | Find every reference |
| `nvim_hover` | `path`, `line`, `column`, `wait_ms?` | Type and documentation |
| `nvim_rename_symbol` | `path`, `line`, `column`, `new_name` | Rename across the workspace |
| `nvim_code_actions` | `path`, `line`, `column`, `apply_index?` | List or apply a quick fix |
| `nvim_format` | `path`, `start_line?`, `end_line?` | Format a file or a range |
| `nvim_document_symbols` | `path`, `wait_ms?` | Outline a file |
| `nvim_workspace_symbols` | `query`, `wait_ms?` | Search symbols in the project |

Lines and columns start at 1.

### Escape hatches

| Tool | Arguments | Purpose |
|---|---|---|
| `nvim_exec_lua` | `code`, `args?` | Run Lua inside Neovim |
| `nvim_command` | `command` | Run an Ex command, for example a plugin command |

These two tools run any code. Turn them off with `--no-exec` if the agent is
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
| `--cwd` | `NVIM_MCP_CWD` | process cwd | Project root for the LSP |
| `--lsp-wait-ms` | `NVIM_MCP_LSP_WAIT_MS` | `3000` | Default LSP wait |
| `--max-lines` | `NVIM_MCP_MAX_LINES` | `2000` | Line cap for a read |
| `--debug` | `NVIM_MCP_DEBUG` | off | Debug lines on stderr |

### Watch the agent work

Attach mode shows you every edit in your own window, live.

```bash
# terminal 1
nvim --listen /tmp/nvim.sock

# agent config
node dist/index.js --socket /tmp/nvim.sock
```

In attach mode the server does not stop your Neovim on exit.

The default is `embedded`, always. The server spawns its own headless Neovim
and owns it. A socket in the environment does not change the mode, so the
server does not take over your editor when the agent runs in a Neovim
terminal. Ask for attach mode with `--socket` or `--mode attach`.

---

## How lazy plugins load

Headless Neovim never fires `UIEnter` or `VeryLazy`, so a lazy.nvim setup keeps
`nvim-lspconfig` and `mason` asleep, and no language server attaches. On start
the server fires the `VeryLazy` event and forces those plugins to load. It then
waits for the client count to stay stable, so a slow real language server is not
missed behind a fast linter bridge.

---

## Troubleshooting

### When no LSP attaches

`nvim_open_file` reports `No LSP client attached`. Try these steps in order.

1. Confirm the file type is correct. The tool prints it. An empty file type
   means Neovim did not detect the language.
2. Raise the wait: `nvim_open_file path=... wait_ms=10000`. A cold TypeScript
   or Rust server needs more than 3 seconds.
3. Check that `NVIM_MCP_CWD` points at the project root. A server that cannot
   find `tsconfig.json` does not start.
4. Start the server with `--debug` and read stderr. It prints which plugins
   the warm-up loaded.
5. Confirm the server starts in your own Neovim for the same file.

### The server does not start

Run it by hand and read stderr:

```bash
NVIM_MCP_DEBUG=1 node dist/index.js
```

A healthy start prints:

```
[nvim-mcp] ready (mode=embedded, exec=true, cwd=/your/project)
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
npm run inspect          # MCP Inspector UI
```

List the tools without a UI:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

The Inspector CLI is good for `tools/list`. For a real tool call, use the
Inspector UI, because the CLI stops the server before a language server
attaches.

---

## Licence

MIT

!!! This is vibe coded slop. I guarantee nothing!!
