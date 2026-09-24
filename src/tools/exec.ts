import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, ok } from "../util/format.js";
import { describeError, execDisabled } from "../util/errors.js";
import type { ToolContext } from "./context.js";
import type { ToolTier } from "../util/config.js";

const FULL_NOTE = "Full-tier tool. Enable with --tools full.";

/** Register the exec tools. The tier picks which tools load: nvim_exec_lua is
 * the minimal escape hatch; nvim_command is full-tier. */
export function registerExecTools(
  server: McpServer,
  ctx: ToolContext,
  tier: ToolTier = "minimal",
): void {
  server.registerTool(
    "nvim_exec_lua",
    {
      title: "Run Lua in Neovim",
      description:
        "Run a Lua chunk inside Neovim and return its value. The chunk receives its " +
        "arguments through `...` and must use `return` to send a value back. " +
        "Use this to reach plugins that have no dedicated tool.",
      inputSchema: {
        code: z.string().describe("Lua source; use return to send a value back"),
        args: z.array(z.any()).optional().describe("Values passed to the chunk as ..."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ code, args }) => {
      try {
        if (!ctx.config.allowExec) throw execDisabled("nvim_exec_lua");
        const value = await ctx.session.lua(code, args ?? []);
        const text = value === null || value === undefined ? "nil" : JSON.stringify(value, null, 2);
        return ok(text, { result: value ?? null });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  if (tier === "full") {
    server.registerTool(
      "nvim_command",
      {
        title: "Run an Ex command",
        description:
          `${FULL_NOTE} Run a Neovim Ex command, for example 'Telescope find_files' ` +
          "or 'Git blame', and return its output. Use this to drive installed plugins.",
        inputSchema: {
          command: z.string().describe("Ex command without the leading colon"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ command }) => {
        try {
          if (!ctx.config.allowExec) throw execDisabled("nvim_command");
          const output = await ctx.session.run(async (client) =>
            client.commandOutput(command),
          );
          return ok(output?.trim() || "The command produced no output.", { output });
        } catch (error) {
          return fail(describeError(error));
        }
      },
    );
  }
}
