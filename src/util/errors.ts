/** Errors that carry an actionable hint for the agent. */
export class ToolError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }

  toString(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

export function fileNotOpen(path: string): ToolError {
  return new ToolError(
    `No buffer is open for "${path}".`,
    "Call nvim_open_file first, then retry.",
  );
}

export function execDisabled(tool: string): ToolError {
  return new ToolError(
    `${tool} is disabled.`,
    "Start the server with --allow-exec or NVIM_MCP_ALLOW_EXEC=1.",
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.toString();
  if (error instanceof Error) return error.message;
  return String(error);
}
