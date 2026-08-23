import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Minimal MCP stdio client, enough to drive the server in a test. */
class Client {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(cwd: string) {
    this.proc = spawn("node", ["dist/index.js", "--cwd", cwd], {
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
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.send("tools/call", { name, arguments: args });
    return response.result?.content?.[0]?.text ?? JSON.stringify(response);
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

  it("lists every tool", async () => {
    const response = await client.send("tools/list", {});
    const names = response.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("nvim_open_file");
    expect(names).toContain("nvim_rename_symbol");
    expect(names.length).toBe(18);
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

  it("replaces a line range and saves", async () => {
    await client.call("nvim_edit_lines", {
      path: file,
      start_line: 2,
      end_line: 2,
      text: "BETA",
    });
    expect(readFileSync(file, "utf8")).toContain("BETA");
  }, 20000);

  it("replaces exact text", async () => {
    await client.call("nvim_edit_text", {
      path: file,
      old_text: "gamma",
      new_text: "GAMMA",
    });
    expect(readFileSync(file, "utf8")).toContain("GAMMA");
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

  it("keeps changes in the buffer when save is false", async () => {
    const staged = join(dir, "staged.txt");
    writeFileSync(staged, "one\n");
    await client.call("nvim_open_file", { path: staged, wait_ms: 0 });
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

  it("runs an Ex command", async () => {
    const text = await client.call("nvim_command", { command: "echo 'ping'" });
    expect(text).toContain("ping");
  });
});
