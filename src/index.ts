#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./util/config.js";
import { NvimSession } from "./nvim/session.js";
import { registerBufferTools } from "./tools/buffer.js";
import { registerLspTools } from "./tools/lsp.js";
import { registerExecTools } from "./tools/exec.js";
import type { ToolContext } from "./tools/context.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const session = new NvimSession(config);
  const ctx: ToolContext = { session, config };

  const server = new McpServer(
    { name: "neovim-use-mcp", version: "0.2.0" },
    {
      instructions:
        `These tools edit files through a real Neovim instance, so every edit gets the ` +
        `user's LSP servers, Treesitter and plugins. Files open on demand: read, edit ` +
        `and LSP tools call nvim_open_file for you. nvim_open_file stays useful to ` +
        `pre-warm files or tune wait_ms. Edit tools save the file by default, so ` +
        `format-on-save runs, and they return fresh diagnostics. nvim_edit_lines is the ` +
        `default edit tool; insert before a line with start_line = end_line + 1. Prefer ` +
        `nvim_rename_symbol over a text replace for renames, and nvim_code_actions to ` +
        `fix a diagnostic. Tool tier: ${config.tools}. The minimal tier loads 10 tools; ` +
        `pass --tools full for all 18.`,
    },
  );

  registerBufferTools(server, ctx, config.tools);
  registerLspTools(server, ctx, config.tools);
  registerExecTools(server, ctx, config.tools);

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await session.shutdown().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  process.stdin.on("end", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[nvim-mcp] uncaught: ${error.stack ?? error}\n`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[nvim-mcp] unhandled rejection: ${String(reason)}\n`);
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[nvim-mcp] ready (mode=${config.mode}, tools=${config.tools}, exec=${config.allowExec}, cwd=${config.cwd})\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[nvim-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
