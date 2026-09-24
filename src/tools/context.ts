import type { NvimSession } from "../nvim/session.js";
import type { ServerConfig } from "../util/config.js";
import * as lua from "../nvim/lua.js";
import { luaError, renderDiagnostics, type Diagnostic } from "../util/format.js";
import { ToolError } from "../util/errors.js";

/** Shared state handed to every tool module. */
export interface ToolContext {
  session: NvimSession;
  config: ServerConfig;
}

/** Open the file if no buffer holds it yet. Edits then always find a buffer. */
export async function ensureOpen(
  ctx: ToolContext,
  path: string,
  waitMs?: number,
): Promise<Record<string, unknown>> {
  const result = await ctx.session.lua<Record<string, unknown>>(lua.OPEN_FILE, [
    path,
    waitMs ?? ctx.config.lspWaitMs,
  ]);
  const error = luaError(result);
  if (error) {
    throw new ToolError(`Could not open "${path}": ${error}`);
  }
  return result;
}

  /** Structured post-edit state a client can machine-read. */
  export interface EditFeedback {
    saved: boolean;
    line_count: number;
    errors: number;
    warnings: number;
    infos: number;
    diagnostics: Diagnostic[];
  }

  /** Fetch diagnostics for one file, for the feedback loop after an edit. */
  export async function diagnosticsFor(
    ctx: ToolContext,
    path: string,
    waitMs = ctx.config.diagWaitMs,
  ): Promise<Diagnostic[]> {
    const result = await ctx.session.lua<Diagnostic[] | Record<string, unknown>>(
      lua.DIAGNOSTICS,
      [path, "hint", Math.max(250, waitMs)],
    );
    if (luaError(result)) return [];
    return result as Diagnostic[];
  }

  /** Write the buffer to disk. Does not fire BufWritePre autocmds (no formatter side-effect). */
  export async function saveBuffer(
    ctx: ToolContext,
    path: string,
  ): Promise<Record<string, unknown>> {
    const result = await ctx.session.lua<Record<string, unknown>>(
      lua.SAVE_BUFFER,
      [path],
    );
    const error = luaError(result);
    if (error) throw new ToolError(`Could not save "${path}": ${error}`);
    return result;
  }

  /** Build the post-edit feedback: structured payload plus a compact text tail.
   * The text tail caps rendered diagnostics at 10; the full list stays in the
   * structured payload. */
  export async function editFeedback(
    ctx: ToolContext,
    path: string,
    saved: boolean,
  ): Promise<{ text: string; structured: EditFeedback }> {
    const diagnostics = await diagnosticsFor(ctx, path);
    const errors = diagnostics.filter((d) => d.severity === "ERROR").length;
    const warnings = diagnostics.filter((d) => d.severity === "WARN").length;
    const infos = diagnostics.filter(
      (d) => d.severity !== "ERROR" && d.severity !== "WARN",
    ).length;
    const open = await ctx.session.lua<Record<string, unknown>>(lua.OPEN_FILE, [
      path,
      0,
    ]);
    const line_count =
      typeof open.line_count === "number" ? open.line_count : 0;
    const structured: EditFeedback = {
      saved,
      line_count,
      errors,
      warnings,
      infos,
      diagnostics,
    };
    const head = saved ? "Saved." : "Buffer changed, not saved.";
    const text =
      diagnostics.length === 0
        ? `${head} No diagnostics.`
        : `${head} ${errors} error(s), ${warnings} warning(s).\n${renderDiagnostics(
            diagnostics.slice(0, 10),
          )}`;
    return { text, structured };
  }
