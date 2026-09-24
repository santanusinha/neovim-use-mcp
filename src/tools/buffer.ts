import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as lua from "../nvim/lua.js";
import { fail, ok, renderLines, shortPath, luaError } from "../util/format.js";
import { describeError, ToolError } from "../util/errors.js";
import {
  editFeedback,
  ensureOpen,
  saveBuffer,
  type ToolContext,
} from "./context.js";
import type { ToolTier } from "../util/config.js";

const FULL_NOTE = "Full-tier tool. Enable with --tools full.";

/** Register the buffer tools. The tier picks which tools load: minimal is the
 * default daily loop; full adds the rare or overlapping tools. */
export function registerBufferTools(
  server: McpServer,
  ctx: ToolContext,
  tier: ToolTier = "minimal",
): void {
  const full = tier === "full";

  server.registerTool(
    "nvim_open_file",
    {
      title: "Open files in Neovim",
      description:
        "Open one or more files in Neovim buffers and start their LSP clients. " +
        "Pass a single path or an array of paths. Returns the buffer id, filetype, " +
        "line count and attached LSP clients for each file. Optional: use it to " +
        "pre-warm files or tune wait_ms. Other tools open files on demand.",
      inputSchema: {
        path: z
          .union([z.string(), z.array(z.string())])
          .describe("File path, or an array of file paths, absolute or relative to the server cwd"),
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
        const paths = Array.isArray(path) ? path : [path];
        const results = await ctx.session.lua<Record<string, unknown>[]>(
          lua.OPEN_FILES,
          [paths, wait_ms ?? ctx.config.lspWaitMs],
        );
        const lines = (results ?? []).map((info) => {
          if (info.error) return `Could not open: ${String(info.error)}`;
          const clients = (info.lsp_clients as string[]) ?? [];
          const base = `Opened ${shortPath(String(info.path))} (buffer ${info.buffer}, ` +
            `${info.line_count} lines, filetype ${String(info.filetype) || "none"}).`;
          return clients.length > 0
            ? `${base}\n  LSP clients: ${clients.join(", ")}`
            : `${base}\n  No LSP client attached. Diagnostics may be empty.`;
        });
        return ok(lines.join("\n"), { files: results });
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
          2000,
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
        "This is the default way to edit files. Use the provided line numbers to " +
        "directly replace lines start_line..end_line (1-based, inclusive) with new text. " +
        "To insert before a line, pass start_line = end_line + 1 (for example start 5, " +
        "end 4 inserts before line 5). Saves the buffer by default without running " +
        "format-on-save autocmds, so the diff is minimal. Returns fresh LSP diagnostics " +
        "for the file. Use nvim_format to format after editing once editing and fixes " +
        "on that are done.",
      inputSchema: {
        path: z.string().describe("File path"),
        start_line: z.number().int().min(1).describe("First line to replace, 1-based"),
        end_line: z
          .number()
          .int()
          .min(0)
          .describe("Last line to replace, inclusive. start_line - 1 means insert"),
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
        const action = result.mode === "insert" ? "Inserted before line" : "Replaced lines";
        return ok(
          `${action} ${start_line}${result.mode === "insert" ? "" : `-${end_line}`} in ${shortPath(path)}. ` +
            `File now has ${result.new_line_count} lines.\n${feedback.text}`,
          { ...result, ...feedback.structured },
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  if (full) {
    server.registerTool(
      "nvim_edit_text",
      {
        title: "Replace exact text",
        description:
          `${FULL_NOTE} Replace an exact string in a file. Fails if the string is ` +
          "missing, or if it appears more than once and replace_all is false. Matching " +
          "tolerates trailing-whitespace and indentation drift, and preserves the " +
          "file's indentation on a fuzzy match. Prefer nvim_edit_lines for line-based " +
          "edits. Saves without running format-on-save autocmds by default.",
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
            const hint = result.closest_line
              ? ` The closest match is at line ${result.closest_line}:\n${result.closest_text}`
              : "";
            throw new ToolError(
              `The text was not found in ${shortPath(path)}.${hint}`,
              "Read the file first and copy the exact text, including whitespace.",
            );
          }
          if (error === "many_matches") {
            throw new ToolError(
              `The text appears ${result.count} times in ${shortPath(path)} ` +
                `(lines ${(result.lines as number[])?.join(", ") ?? "?"}).`,
              "Add more context to make the text unique, or set replace_all to true.",
            );
          }
          if (error) throw new ToolError(`Edit failed: ${error}`);
          const shouldSave = save !== false;
          if (shouldSave) await saveBuffer(ctx, path);
          const feedback = await editFeedback(ctx, path, shouldSave);
          return ok(
            `Made ${result.replacements} replacement(s) in ${shortPath(path)} ` +
              `(match tier ${result.match_tier}).\n${feedback.text}`,
            { ...result, ...feedback.structured },
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
          `${FULL_NOTE} Insert text before the given line, 1-based. Use a line beyond ` +
          "the end to append. Prefer nvim_edit_lines with start_line = end_line + 1. " +
          "Saves without running format-on-save autocmds by default.",
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
              `File now has ${result.new_line_count} lines.\n${feedback.text}`,
            { ...result, ...feedback.structured },
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
          `${FULL_NOTE} Write a buffer to disk without running format-on-save ` +
          "autocmds. Use this after edits made with save set to false.",
        inputSchema: { path: z.string().describe("File path") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ path }) => {
        try {
          const result = await saveBuffer(ctx, path);
          const feedback = await editFeedback(ctx, path, true);
          return ok(`${shortPath(String(result.path))}\n${feedback.text}`, {
            ...result,
            ...feedback.structured,
          });
        } catch (error) {
          return fail(describeError(error));
        }
      },
    );

    server.registerTool(
      "nvim_list_buffers",
      {
        title: "List open buffers",
        description: `${FULL_NOTE} List every loaded buffer with its path, filetype and modified state.`,
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
}
