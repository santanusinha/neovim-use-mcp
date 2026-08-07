import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as lua from "../nvim/lua.js";
import { fail, ok, renderLines, shortPath, luaError } from "../util/format.js";
import { describeError, ToolError } from "../util/errors.js";
import { editFeedback, ensureOpen, saveBuffer, type ToolContext } from "./context.js";

export function registerBufferTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "nvim_open_file",
    {
      title: "Open a file in Neovim",
      description:
        "Open a file in a Neovim buffer and start its LSP client. Returns the buffer id, " +
        "filetype, line count and attached LSP clients. Call this before LSP tools.",
      inputSchema: {
        path: z.string().describe("File path, absolute or relative to the server cwd"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .optional()
          .describe("Milliseconds to wait for the LSP client to attach"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, wait_ms }) => {
      try {
        const info = await ensureOpen(ctx, path, wait_ms);
        const clients = (info.lsp_clients as string[]) ?? [];
        const text =
          `Opened ${shortPath(String(info.path))} (buffer ${info.buffer}, ` +
          `${info.line_count} lines, filetype ${String(info.filetype) || "none"}).\n` +
          (clients.length > 0
            ? `LSP clients: ${clients.join(", ")}`
            : "No LSP client attached. Diagnostics may be empty.");
        return ok(text, info);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_read_file",
    {
      title: "Read lines from a Neovim buffer",
      description:
        "Read a file through Neovim with line numbers. Opens the file if needed. " +
        "Use start_line and end_line to read a slice of a large file.",
      inputSchema: {
        path: z.string().describe("File path"),
        start_line: z.number().int().min(1).optional().describe("First line, 1-based"),
        end_line: z.number().int().min(1).optional().describe("Last line, inclusive"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, start_line, end_line }) => {
      try {
        await ensureOpen(ctx, path, 0);
        const result = await ctx.session.lua<Record<string, unknown>>(lua.READ_LINES, [
          path,
          start_line ?? 1,
          end_line ?? null,
          ctx.config.maxLines,
        ]);
        const error = luaError(result);
        if (error) throw new ToolError(`Could not read "${path}": ${error}`);
        const lines = (result.lines as string[]) ?? [];
        const body = renderLines(Number(result.start_line), lines);
        const note = result.truncated
          ? `\n... truncated at line ${result.end_line} of ${result.total_lines}. ` +
            "Call again with start_line to continue."
          : "";
        return ok(`${shortPath(String(result.path))}\n${body}${note}`, result);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_edit_lines",
    {
      title: "Replace a line range",
      description:
        "Replace lines start_line..end_line (1-based, inclusive) with new text. " +
        "Saves the buffer by default, so format-on-save plugins run. " +
        "Returns fresh LSP diagnostics for the file.",
      inputSchema: {
        path: z.string().describe("File path"),
        start_line: z.number().int().min(1).describe("First line to replace, 1-based"),
        end_line: z.number().int().min(0).describe("Last line to replace, inclusive"),
        text: z.string().describe(String.raw`Replacement text; use \n for several lines`),
        save: z.boolean().optional().describe("Write the buffer, default true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ path, start_line, end_line, text, save }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Record<string, unknown>>(lua.SET_LINES, [
          path,
          start_line,
          end_line,
          text,
        ]);
        const error = luaError(result);
        if (error) throw new ToolError(`Edit failed: ${error}`);
        const shouldSave = save !== false;
        if (shouldSave) await saveBuffer(ctx, path);
        const feedback = await editFeedback(ctx, path, shouldSave);
        return ok(
          `Replaced lines ${start_line}-${end_line} in ${shortPath(path)}. ` +
            `File now has ${result.new_line_count} lines.\n${feedback}`,
          result,
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_edit_text",
    {
      title: "Replace exact text",
      description:
        "Replace an exact string in a file. Fails if the string is missing, or if it " +
        "appears more than once and replace_all is false. Saves by default.",
      inputSchema: {
        path: z.string().describe("File path"),
        old_text: z.string().describe("Exact text to find, including indentation"),
        new_text: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace every match, default false"),
        save: z.boolean().optional().describe("Write the buffer, default true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ path, old_text, new_text, replace_all, save }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Record<string, unknown>>(lua.REPLACE_TEXT, [
          path,
          old_text,
          new_text,
          replace_all ?? false,
        ]);
        const error = luaError(result);
        if (error === "no_match") {
          throw new ToolError(
            `The text was not found in ${shortPath(path)}.`,
            "Read the file first and copy the exact text, including whitespace.",
          );
        }
        if (error === "many_matches") {
          throw new ToolError(
            `The text appears ${result.count} times in ${shortPath(path)}.`,
            "Add more context to make the text unique, or set replace_all to true.",
          );
        }
        if (error) throw new ToolError(`Edit failed: ${error}`);
        const shouldSave = save !== false;
        if (shouldSave) await saveBuffer(ctx, path);
        const feedback = await editFeedback(ctx, path, shouldSave);
        return ok(
          `Made ${result.replacements} replacement(s) in ${shortPath(path)}.\n${feedback}`,
          result,
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_insert_lines",
    {
      title: "Insert lines",
      description:
        "Insert text before the given line, 1-based. Use a line beyond the end to append. " +
        "Saves by default.",
      inputSchema: {
        path: z.string().describe("File path"),
        line: z.number().int().min(1).describe("Insert before this line, 1-based"),
        text: z.string().describe(String.raw`Text to insert; use \n for several lines`),
        save: z.boolean().optional().describe("Write the buffer, default true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, line, text, save }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Record<string, unknown>>(lua.INSERT_LINES, [
          path,
          line,
          text,
        ]);
        const error = luaError(result);
        if (error) throw new ToolError(`Insert failed: ${error}`);
        const shouldSave = save !== false;
        if (shouldSave) await saveBuffer(ctx, path);
        const feedback = await editFeedback(ctx, path, shouldSave);
        return ok(
          `Inserted at line ${result.inserted_at} in ${shortPath(path)}. ` +
            `File now has ${result.new_line_count} lines.\n${feedback}`,
          result,
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_save_buffer",
    {
      title: "Save a buffer",
      description:
        "Write a buffer to disk. BufWritePre autocommands run, so formatters and " +
        "linters fire. Use this after edits made with save set to false.",
      inputSchema: { path: z.string().describe("File path") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path }) => {
      try {
        const result = await saveBuffer(ctx, path);
        const feedback = await editFeedback(ctx, path, true);
        return ok(`${shortPath(String(result.path))}\n${feedback}`, result);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_list_buffers",
    {
      title: "List open buffers",
      description: "List every loaded buffer with its path, filetype and modified state.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const buffers = await ctx.session.lua<Record<string, unknown>[]>(lua.LIST_BUFFERS);
        if (!buffers || buffers.length === 0) return ok("No buffers are open.");
        const text = buffers
          .map(
            (b) =>
              `${b.buffer}  ${shortPath(String(b.path)) || "[no name]"}  ` +
              `${String(b.filetype) || "-"}  ${b.line_count} lines` +
              (b.modified ? "  [modified]" : ""),
          )
          .join("\n");
        return ok(text, { buffers });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
