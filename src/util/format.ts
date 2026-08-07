import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Build a successful tool result with text and structured content. */
export function ok(
  text: string,
  structured?: Record<string, unknown>,
): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

/** Build a failed tool result. */
export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  source?: string;
  code?: string;
}

/** Render diagnostics as compact, agent-readable lines. */
export function renderDiagnostics(items: Diagnostic[]): string {
  if (items.length === 0) return "No diagnostics.";
  return items
    .map(
      (d) =>
        `${d.severity} ${shortPath(d.path)}:${d.line}:${d.column} ${d.message}` +
        (d.source ? ` [${d.source}]` : ""),
    )
    .join("\n");
}

/** Render numbered lines the way an editor shows them. */
export function renderLines(startLine: number, lines: string[]): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}  ${line}`)
    .join("\n");
}

export function shortPath(path: string): string {
  const cwd = process.cwd();
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

/** Neovim returns tables; a Lua error table carries an `error` key. */
export function luaError(value: unknown): string | undefined {
    if (value && typeof value === "object" && "error" in value) {
      return String((value as { error: unknown }).error);
  }
  return undefined;
}
