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
    { name: "neovim-use-mcp", version: "0.1.0" },
    {
      instructions:
        "These tools edit files through a real Neovim instance, so every edit gets the " +
        "user's LSP servers, Treesitter and plugins. Open a file with nvim_open_file " +
        "first; that starts the language server. Edit tools save the file by default, " +
        "so format-on-save runs, and they return fresh diagnostics. Prefer " +
        "nvim_rename_symbol over a text replace for renames, and nvim_code_actions to " +
        "fix a diagnostic.",
    },
  );

  registerBufferTools(server, ctx);
  registerLspTools(server, ctx);
  registerExecTools(server, ctx);

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
    `[nvim-mcp] ready (mode=${config.mode}, exec=${config.allowExec}, cwd=${config.cwd})\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[nvim-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
