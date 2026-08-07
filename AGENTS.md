# AGENTS.md

Guidance for agents that work on this repository.

## What this is

An MCP server (TypeScript, stdio) that drives a headless Neovim process, so an
AI agent can edit files with the user's LSP, formatters and plugins.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Entry point: stdio transport, tool registration, shutdown |
| `src/nvim/session.ts` | Spawns or attaches nvim, serialises calls, warms plugins |
| `src/nvim/lua.ts` | Every Lua chunk that runs inside nvim |
| `src/tools/buffer.ts` | File and buffer tools |
| `src/tools/lsp.ts` | LSP tools |
| `src/tools/exec.ts` | Lua and Ex command escape hatches |
| `src/tools/context.ts` | Shared helpers: open, save, diagnostics feedback |
| `src/util/` | Config, errors, output format |
| `test/` | Vitest suite plus manual smoke scripts |

## Rules

1. Never write to stdout. It carries the MCP protocol. Log to stderr.
2. Put all Lua in `src/nvim/lua.ts`. Do not inline Lua in tool files.
3. A Lua chunk reports a problem with `return { error = "..." }`. The caller
   maps that to a `ToolError` with a hint.
4. Neovim sends absent arguments as `vim.NIL`, not `nil`. Convert them at the
   top of the chunk.
5. Every edit tool saves by default and returns fresh diagnostics.
6. Every tool gets `annotations` with the correct read-only and destructive
   hints.
7. Error messages must tell the agent what to do next.

## Commands

```bash
npm run build     # tsc
npm test          # vitest, needs a real nvim
node test/smoke.mjs           # buffer tools against a temp file
node test/lsp-go.mjs <dir> <file>   # LSP tools against a project
```

## Known constraints

- Headless nvim does not fire `UIEnter` or `VeryLazy`. `WARMUP` in
  `src/nvim/lua.ts` forces lazy.nvim to load the LSP plugins.
- Language servers attach at different speeds. `OPEN_FILE` waits for a stable
  client count instead of the first client.
- One nvim process serves every request, so `NvimSession.run` keeps a queue.

## Style

Write comments and documents in ASD-STE100 Simplified Technical English: short
active sentences, simple words, no jargon.
