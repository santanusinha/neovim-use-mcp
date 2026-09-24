# AGENTS.md

Guidance for agents that work on this repository.

## What this is

An MCP server (TypeScript, stdio) that drives a headless Neovim process, so an
AI agent can edit files with the user's LSP, formatters and plugins.

## Layout

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Entry point: stdio transport, tool registration, tier wiring, shutdown |
| `src/nvim/session.ts` | Spawns or attaches nvim, serialises calls, warms plugins |
| `src/nvim/lua.ts` | Every Lua chunk that runs inside nvim |
| `src/tools/buffer.ts` | File and buffer tools, minimal and full tier |
| `src/tools/lsp.ts` | LSP tools, minimal and full tier |
| `src/tools/exec.ts` | Lua and Ex command escape hatches |
| `src/tools/context.ts` | Shared helpers: open, save, structured diagnostics feedback |
| `src/util/` | Config, errors, output format |
| `test/` | Vitest suite plus manual smoke scripts |

## Tool tiers

The `--tools` flag picks the tier. `minimal` is the default and loads 10
tools. `full` loads all 18. Registration functions take the tier and skip
tools outside it. A new tool must state its tier in its description and in
this table in `README.md`.

## Rules

1. Never write to stdout. It carries the MCP protocol. Log to stderr.
2. Put all Lua in `src/nvim/lua.ts`. Do not inline Lua in tool files.
3. A Lua chunk reports a problem with `return { error = "..." }`. The caller
   maps that to a `ToolError` with a hint.
4. Neovim sends absent arguments as `vim.NIL`, not `nil`. Convert them at the
   top of the chunk.
5. Every edit tool saves by default and returns fresh diagnostics, as text
   and as a structured payload from `editFeedback`.
6. Every tool gets `annotations` with the correct read-only and destructive
   hints.
7. Error messages must tell the agent what to do next.
8. `OPEN_FILE` must reuse an existing buffer. Never run `edit` on a modified
   buffer; that discards unsaved changes or raises E37.
9. The session sets `noswapfile` and `shortmess+=A` at start. A headless
   server must never block on the E325 swap prompt. `OPEN_FILE` reports a
   detected swap file as `stale_swap`, not as an error.

