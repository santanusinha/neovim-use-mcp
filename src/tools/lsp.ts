import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as lua from "../nvim/lua.js";
import {
  fail,
  ok,
  renderDiagnostics,
  shortPath,
  luaError,
  type Diagnostic,
} from "../util/format.js";
import { describeError, ToolError } from "../util/errors.js";
import { ensureOpen, type ToolContext } from "./context.js";

interface Location {
  path: string;
  line: number;
  column: number;
  text?: string;
}

function renderLocations(items: Location[]): string {
  return items
    .map((l) => `${shortPath(l.path)}:${l.line}:${l.column}  ${l.text ?? ""}`.trimEnd())
    .join("\n");
}

function checkLsp(value: unknown, what: string): void {
  const error = luaError(value);
  if (error === "not_open") {
    throw new ToolError("The file is not open.", "Call nvim_open_file first.");
  }
  if (error === "no_lsp") {
    throw new ToolError(
      "No language server is attached to that file.",
      "Call nvim_open_file with a longer wait_ms. If the server still does not " +
        "attach, your Neovim config has no language server for this filetype.",
    );
  }
  if (error === "lsp_timeout") {
    throw new ToolError(
      `The LSP request for ${what} timed out.`,
      "Raise wait_ms, or check that a language server attaches with nvim_open_file.",
    );
  }
  if (error) throw new ToolError(`${what} failed: ${error}`);
}

export function registerLspTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "nvim_diagnostics",
    {
      title: "Get LSP diagnostics",
      description:
        "Get LSP errors and warnings for one file, or for every open buffer when path " +
        "is omitted. Use this to check work after an edit.",
      inputSchema: {
        path: z.string().optional().describe("File path; omit for all open buffers"),
        severity: z
          .enum(["error", "warn", "info", "hint"])
          .optional()
          .describe("Lowest severity to report, default hint"),
        wait_ms: z.number().int().min(0).max(30000).optional().describe("Settle time"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, severity, wait_ms }) => {
      try {
        if (path) await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Diagnostic[]>(lua.DIAGNOSTICS, [
          path ?? "",
          severity ?? "hint",
          wait_ms ?? 500,
        ]);
        checkLsp(result, "diagnostics");
        const items = result ?? [];
        return ok(renderDiagnostics(items), { diagnostics: items, count: items.length });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  const positionSchema = {
    path: z.string().describe("File path"),
    line: z.number().int().min(1).describe("Line number, 1-based"),
    column: z.number().int().min(1).describe("Column number, 1-based"),
    wait_ms: z.number().int().min(0).max(30000).optional().describe("LSP timeout"),
  };

  server.registerTool(
    "nvim_goto_definition",
    {
      title: "Find a definition",
      description: "Find where the symbol at a position is defined, through the LSP.",
      inputSchema: positionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, line, column, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Location[]>(lua.LSP_LOCATIONS, [
          path,
          line,
          column,
          "textDocument/definition",
          wait_ms ?? ctx.config.lspWaitMs,
        ]);
        checkLsp(result, "definition");
        if (!result || result.length === 0) return ok("No definition found.");
        return ok(renderLocations(result), { locations: result });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_references",
    {
      title: "Find references",
      description:
        "Find every reference to the symbol at a position, through the LSP. " +
        "Use this before a rename or a signature change.",
      inputSchema: positionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, line, column, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Location[]>(lua.LSP_LOCATIONS, [
          path,
          line,
          column,
          "textDocument/references",
          wait_ms ?? ctx.config.lspWaitMs,
        ]);
        checkLsp(result, "references");
        if (!result || result.length === 0) return ok("No references found.");
        return ok(`${result.length} reference(s):\n${renderLocations(result)}`, {
          locations: result,
          count: result.length,
        });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_hover",
    {
      title: "Get hover information",
      description:
        "Get type and documentation information for the symbol at a position, " +
        "the same text the editor shows on hover.",
      inputSchema: positionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, line, column, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<{ text: string }>(lua.LSP_HOVER, [
          path,
          line,
          column,
          wait_ms ?? ctx.config.lspWaitMs,
        ]);
        checkLsp(result, "hover");
        const text = result?.text?.trim();
        if (!text) return ok("No hover information at that position.");
        return ok(text, { text });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_rename_symbol",
    {
      title: "Rename a symbol",
      description:
        "Rename a symbol across the whole workspace with the LSP, then save every " +
        "changed file. Safer than a text search and replace.",
      inputSchema: {
        ...positionSchema,
        new_name: z.string().describe("New symbol name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ path, line, column, new_name, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<{ new_name: string; files: string[] }>(
          lua.LSP_RENAME,
          [path, line, column, new_name, wait_ms ?? 5000],
        );
        checkLsp(result, "rename");
        const files = result.files ?? [];
        if (files.length === 0) {
          return ok(
            `The rename returned no edits. Check that the position points at a symbol, ` +
              `and that its language server supports rename.`,
          );
        }
        return ok(
          `Renamed to "${new_name}" in ${files.length} file(s):\n` +
            files.map((f) => shortPath(f)).join("\n"),
          result,
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_code_actions",
    {
      title: "List or apply a code action",
      description:
        "List LSP code actions at a position. Pass apply_index to apply one and save " +
        "the file. Use this to apply quick fixes for diagnostics.",
      inputSchema: {
        ...positionSchema,
        apply_index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Index from a previous list call; omit to only list"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ path, line, column, apply_index, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Record<string, unknown>>(
          lua.LSP_CODE_ACTIONS,
          [path, line, column, apply_index ?? 0, wait_ms ?? ctx.config.lspWaitMs],
        );
        if (luaError(result) === "index_out_of_range") {
          throw new ToolError(
            `apply_index is out of range; there are ${result.count} action(s).`,
            "Call the tool without apply_index to list the actions first.",
          );
        }
        checkLsp(result, "code actions");
          const applied = result.applied as string | undefined;
          if (applied) return ok(`Applied and saved: ${applied}`, result);
          const actions = (result.actions as { index: number; title: string; kind?: string }[]) ?? [];
          if (actions.length === 0) return ok("No code actions at that position.");
          const text = actions
            .map((a) => {
              const kind = a.kind ? `  (${a.kind})` : "";
              return `${a.index}. ${a.title}${kind}`;
            })
            .join("\n");
        return ok(`${text}\n\nCall again with apply_index to apply one.`, result);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_format",
    {
      title: "Format a file",
      description:
        "Format a whole file or a line range with the formatter Neovim is configured " +
        "to use, then save it.",
      inputSchema: {
        path: z.string().describe("File path"),
        start_line: z.number().int().min(1).optional().describe("Range start, 1-based"),
        end_line: z.number().int().min(1).optional().describe("Range end, inclusive"),
        wait_ms: z.number().int().min(0).max(30000).optional().describe("Format timeout"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, start_line, end_line, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<Record<string, unknown>>(lua.LSP_FORMAT, [
          path,
          start_line ?? null,
          end_line ?? null,
          wait_ms ?? 5000,
        ]);
        checkLsp(result, "format");
        return ok(
          `Formatted and saved ${shortPath(String(result.path))} ` +
            `(${result.line_count} lines).`,
          result,
        );
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_document_symbols",
    {
      title: "Outline a file",
      description:
        "List the symbol outline of a file: classes, functions and fields with their " +
        "line numbers. Cheaper than reading the whole file.",
      inputSchema: {
        path: z.string().describe("File path"),
        wait_ms: z.number().int().min(0).max(30000).optional().describe("LSP timeout"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, wait_ms }) => {
      try {
        await ensureOpen(ctx, path);
        const result = await ctx.session.lua<
          { name: string; kind: string; line: number; depth: number; detail?: string }[]
        >(lua.LSP_DOCUMENT_SYMBOLS, [path, wait_ms ?? ctx.config.lspWaitMs]);
        checkLsp(result, "document symbols");
        if (!result || result.length === 0) return ok("No symbols found.");
        const text = result
          .map(
            (s) =>
              `${"  ".repeat(s.depth)}${s.line}: ${s.kind} ${s.name}` +
              (s.detail ? `  ${s.detail}` : ""),
          )
          .join("\n");
        return ok(text, { symbols: result });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "nvim_workspace_symbols",
    {
      title: "Search workspace symbols",
      description:
        "Search symbols across the whole project through the LSP. Use this to find a " +
        "definition by name without knowing the file.",
      inputSchema: {
        query: z.string().describe("Symbol name or prefix"),
        wait_ms: z.number().int().min(0).max(30000).optional().describe("LSP timeout"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, wait_ms }) => {
      try {
        const result = await ctx.session.lua<
          { name: string; kind: string; path?: string; line?: number; container?: string }[]
        >(lua.LSP_WORKSPACE_SYMBOLS, [query, wait_ms ?? 5000]);
        checkLsp(result, "workspace symbols");
        if (!result || result.length === 0) {
          return ok(
            "No symbols found. Open a project file with nvim_open_file first, so a " +
              "language server attaches to the workspace.",
          );
        }
        const text = result
          .map(
            (s) =>
              `${s.kind} ${s.name}` +
              (s.container ? ` in ${s.container}` : "") +
              (s.path ? `  ${shortPath(s.path)}:${s.line}` : ""),
          )
          .join("\n");
        return ok(text, { symbols: result });
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
