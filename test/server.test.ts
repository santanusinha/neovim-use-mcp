import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Minimal MCP stdio client, enough to drive the server in a test. */
class Client {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
    constructor(cwd: string, extraArgs: string[] = []) {
      this.proc = spawn("node", ["dist/index.js", "--cwd", cwd, ...extraArgs], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      this.proc.stdout!.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        }
      });
    }

    send(method: string, params: unknown): Promise<any> {
      const id = this.nextId++;
      return new Promise((resolve) => {
        this.pending.set(id, resolve);
        this.proc.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    }

    notify(method: string, params: unknown): void {
      this.proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    }

    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const response = await this.send("tools/call", { name, arguments: args });
      return response.result?.content?.[0]?.text ?? JSON.stringify(response);
    }



  /** Call a tool and return the structured content the server attached. */
  async callStructured(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await this.send("tools/call", { name, arguments: args });
    return response.result?.structuredContent ?? null;
  }

  async listTools(): Promise<string[]> {
    const response = await this.send("tools/list", {});
    return response.result.tools.map((t: { name: string }) => t.name);
  }

  async close(): Promise<number | null> {
    this.proc.stdin!.end();
    return new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
  }
}

describe("neovim-use-mcp", () => {
  let client: Client;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nvim-mcp-test-"));
    file = join(dir, "demo.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    client = new Client(dir);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    client.notify("notifications/initialized", {});
  }, 60000);

  afterAll(async () => {
    await client.close();
  }, 30000);

  it("lists the 10 minimal-tier tools by default", async () => {
    const names = await client.listTools();
    expect(names.length).toBe(10);
    expect(names).toContain("nvim_open_file");
    expect(names).toContain("nvim_read_file");
    expect(names).toContain("nvim_edit_lines");
    expect(names).toContain("nvim_format");
    expect(names).toContain("nvim_rename_symbol");
    expect(names).toContain("nvim_goto_definition");
    expect(names).toContain("nvim_references");
    expect(names).toContain("nvim_hover");
    expect(names).toContain("nvim_code_actions");
    expect(names).toContain("nvim_exec_lua");
    expect(names).not.toContain("nvim_edit_text");
    expect(names).not.toContain("nvim_insert_lines");
    expect(names).not.toContain("nvim_save_buffer");
    expect(names).not.toContain("nvim_diagnostics");
    expect(names).not.toContain("nvim_list_buffers");
    expect(names).not.toContain("nvim_document_symbols");
    expect(names).not.toContain("nvim_workspace_symbols");
    expect(names).not.toContain("nvim_command");
  });

  it("opens a file and reports the buffer", async () => {
    const text = await client.call("nvim_open_file", { path: file, wait_ms: 0 });
    expect(text).toContain("3 lines");
  }, 30000);

  it("opens several files at once", async () => {
    const second = join(dir, "second.txt");
    writeFileSync(second, "one\ntwo\n");
    const third = join(dir, "third.txt");
    writeFileSync(third, "only\n");
    const text = await client.call("nvim_open_file", {
      path: [file, second, third],
      wait_ms: 0,
    });
    expect(text).toContain("demo.txt");
    expect(text).toContain("second.txt");
    expect(text).toContain("third.txt");
    expect(text).toContain("2 lines");
    expect(text).toContain("1 lines");
  }, 30000);

  it("never writes swap files", async () => {
    const target = join(dir, "noswap.txt");
    writeFileSync(target, "a\nb\n");
    await client.call("nvim_open_file", { path: target, wait_ms: 0 });
    await client.call("nvim_edit_lines", {
      path: target,
      start_line: 1,
      end_line: 1,
      text: "changed",
    });
    const swaps = readdirSync(dir).filter((name) => name.endsWith(".swp"));
    expect(swaps).toEqual([]);
  }, 30000);

  it("opens a file with a stale swap file and reports it", async () => {
    const target = join(dir, "stale.txt");
    writeFileSync(target, "x\ny\n");
    const swap = join(dir, ".stale.txt.swp");
    writeFileSync(swap, "B6");
    const text = await client.call("nvim_open_file", {
      path: target,
      wait_ms: 0,
    });
    expect(text).toContain("2 lines");
    expect(text).toContain("Stale swap file ignored");
    expect(text).toContain(".stale.txt.swp");
    const structured = await client.callStructured("nvim_open_file", {
      path: target,
      wait_ms: 0,
    });
    expect(structured.files[0].stale_swap).toContain(".stale.txt.swp");
  }, 30000);


  it("reads lines with numbers", async () => {
    const text = await client.call("nvim_read_file", { path: file });
    expect(text).toContain("1  alpha");
    expect(text).toContain("3  gamma");
  });

  it("reads a range", async () => {
    const text = await client.call("nvim_read_file", {
      path: file,
      start_line: 2,
      end_line: 2,
    });
    expect(text).toContain("2  beta");
    expect(text).not.toContain("alpha");
  });

  it("opens a file implicitly on read", async () => {
    const implicit = join(dir, "implicit.txt");
    writeFileSync(implicit, "uno\ndos\n");
    const text = await client.call("nvim_read_file", { path: implicit });
    expect(text).toContain("1  uno");
    expect(text).toContain("2  dos");
  });

  it("opens a file implicitly on edit", async () => {
    const implicit = join(dir, "implicit-edit.txt");
    writeFileSync(implicit, "keep\nchange\n");
    const text = await client.call("nvim_edit_lines", {
      path: implicit,
      start_line: 2,
      end_line: 2,
      text: "CHANGED",
    });
    expect(text).toContain("Saved.");
    expect(readFileSync(implicit, "utf8")).toContain("CHANGED");
  });

  it("replaces a line range and saves", async () => {
    await client.call("nvim_edit_lines", {
      path: file,
      start_line: 2,
      end_line: 2,
      text: "BETA",
    });
    expect(readFileSync(file, "utf8")).toContain("BETA");
  }, 20000);

  it("returns structured feedback after an edit", async () => {
    const structured = await client.callStructured("nvim_edit_lines", {
      path: file,
      start_line: 1,
      end_line: 1,
      text: "ALPHA",
    });
    expect(structured).not.toBeNull();
    expect(structured.saved).toBe(true);
    expect(typeof structured.line_count).toBe("number");
    expect(structured.errors).toBe(0);
    expect(structured.warnings).toBe(0);
    expect(Array.isArray(structured.diagnostics)).toBe(true);
  }, 20000);

  it("replaces a line range with multiple lines", async () => {
    const multi = join(dir, "multi.txt");
    writeFileSync(multi, "one\ntwo\nthree\n");
    await client.call("nvim_open_file", { path: multi, wait_ms: 0 });
    await client.call("nvim_edit_lines", {
      path: multi,
      start_line: 2,
      end_line: 2,
      text: "TWO-A\nTWO-B",
    });
    const saved = readFileSync(multi, "utf8");
    expect(saved).toContain("one");
    expect(saved).toContain("TWO-A");
    expect(saved).toContain("TWO-B");
    expect(saved).toContain("three");
  }, 20000);

  it("inserts before a line with start_line = end_line + 1", async () => {
    const insert = join(dir, "insert-mode.txt");
    writeFileSync(insert, "first\nsecond\n");
    await client.call("nvim_edit_lines", {
      path: insert,
      start_line: 1,
      end_line: 0,
      text: "# header",
    });
    const saved = readFileSync(insert, "utf8");
    expect(saved.startsWith("# header\n")).toBe(true);
    expect(saved).toContain("first");
  }, 20000);

  it("rejects a reversed range", async () => {
    const text = await client.call("nvim_edit_lines", {
      path: file,
      start_line: 3,
      end_line: 1,
      text: "x",
    });
    expect(text).toContain("must be start_line - 1");
  }, 20000);

  it("saves the buffer by default after an edit", async () => {
    const staged = join(dir, "staged.txt");
    writeFileSync(staged, "one\n");
    await client.call("nvim_edit_lines", {
      path: staged,
      start_line: 1,
      end_line: 1,
      text: "two",
    });
    expect(readFileSync(staged, "utf8")).toContain("two");
  }, 30000);


  it("edit does not trigger format-on-save autocmds (no whole-file reformat)", async () => {
    // Set up a file with multiple lines.
    const fmtFile = join(dir, "format-check.txt");
    const original = "line1\nline2\nline3\nline4\nline5\n";
    writeFileSync(fmtFile, original);
    await client.call("nvim_open_file", { path: fmtFile, wait_ms: 0 });
    // Install a BufWritePre autocmd that appends FORMATTED to every line.
    // A real formatter (jdtls, conform) does the same via this event.
    await client.call("nvim_exec_lua", {
      code: `vim.api.nvim_create_autocmd("BufWritePre", {
  pattern = "format-check.txt",
  callback = function(ev)
    local lines = vim.api.nvim_buf_get_lines(ev.buf, 0, -1, false)
    for i, l in ipairs(lines) do lines[i] = l .. "FORMATTED" end
    vim.api.nvim_buf_set_lines(ev.buf, 0, -1, false, lines)
  end,
})`,
    });
    // Edit only line 3.
    await client.call("nvim_edit_lines", {
      path: fmtFile,
      start_line: 3,
      end_line: 3,
      text: "LINE3-EDITED",
    });
    const saved = readFileSync(fmtFile, "utf8");
    // The autocmd must not have run: no line must contain FORMATTED.
    expect(saved).not.toContain("FORMATTED");
    // The edit must be present.
    expect(saved).toContain("LINE3-EDITED");
    // Lines outside the edit must be unchanged.
    expect(saved).toContain("line1");
    expect(saved).toContain("line5");
  }, 30000);

  it("runs Lua", async () => {
    const text = await client.call("nvim_exec_lua", { code: "return 1 + 1" });
    expect(text.trim()).toBe("2");
  });
});

describe("neovim-use-mcp full tier", () => {
  let client: Client;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nvim-mcp-full-"));
    file = join(dir, "demo.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    client = new Client(dir, ["--tools", "full"]);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    client.notify("notifications/initialized", {});
  }, 60000);

  afterAll(async () => {
    await client.close();
  }, 30000);

  it("lists all 18 tools with --tools full", async () => {
    const names = await client.listTools();
    expect(names.length).toBe(18);
    expect(names).toContain("nvim_edit_text");
    expect(names).toContain("nvim_insert_lines");
    expect(names).toContain("nvim_save_buffer");
    expect(names).toContain("nvim_diagnostics");
    expect(names).toContain("nvim_list_buffers");
    expect(names).toContain("nvim_document_symbols");
    expect(names).toContain("nvim_workspace_symbols");
    expect(names).toContain("nvim_command");
  });

  it("replaces exact text", async () => {
    await client.call("nvim_edit_text", {
      path: file,
      old_text: "gamma",
      new_text: "GAMMA",
    });
    expect(readFileSync(file, "utf8")).toContain("GAMMA");
  }, 20000);

  it("replaces multi-line text", async () => {
    const multi = join(dir, "ml.txt");
    writeFileSync(multi, "head\none\ntwo\ntail\n");
    await client.call("nvim_edit_text", {
      path: multi,
      old_text: "one\ntwo",
      new_text: "ONE\nTWO",
    });
    const saved = readFileSync(multi, "utf8");
    expect(saved).toContain("ONE\nTWO");
    expect(saved).toContain("head");
    expect(saved).toContain("tail");
  }, 20000);

  it("matches with indentation drift and preserves the file indent", async () => {
    const drift = join(dir, "drift.txt");
    writeFileSync(drift, "function f() {\n    return 1;\n}\n");
    await client.call("nvim_edit_text", {
      path: drift,
      old_text: "return 1;",
      new_text: "return 2;",
    });
    const saved = readFileSync(drift, "utf8");
    expect(saved).toContain("    return 2;");
  }, 20000);

  it("reports missing text with a hint", async () => {
    const text = await client.call("nvim_edit_text", {
      path: file,
      old_text: "absent",
      new_text: "x",
    });
    expect(text).toContain("was not found");
    expect(text).toContain("Hint:");
  });

  it("refuses an ambiguous replace", async () => {
    const many = join(dir, "many.txt");
    writeFileSync(many, "dup\ndup\n");
    await client.call("nvim_open_file", { path: many, wait_ms: 0 });
    const text = await client.call("nvim_edit_text", {
      path: many,
      old_text: "dup",
      new_text: "x",
    });
    expect(text).toContain("appears 2 times");
  }, 20000);

  it("inserts lines", async () => {
    await client.call("nvim_insert_lines", { path: file, line: 1, text: "# header" });
    expect(readFileSync(file, "utf8").startsWith("# header")).toBe(true);
  }, 20000);

  it("keeps changes in the buffer when save is false, then saves", async () => {
    const staged = join(dir, "staged.txt");
    writeFileSync(staged, "one\n");
    await client.call("nvim_edit_lines", {
      path: staged,
      start_line: 1,
      end_line: 1,
      text: "two",
      save: false,
    });
    expect(readFileSync(staged, "utf8")).toContain("one");
    await client.call("nvim_save_buffer", { path: staged });
    expect(readFileSync(staged, "utf8")).toContain("two");
  }, 30000);

  it("lists buffers", async () => {
    const text = await client.call("nvim_list_buffers", {});
    expect(text).toContain("demo.txt");
  });

  it("runs an Ex command", async () => {
    const text = await client.call("nvim_command", { command: "echo 'ping'" });
    expect(text).toContain("ping");
  });
});
