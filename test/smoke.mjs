import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "nvim-mcp-"));
const file = join(dir, "demo.txt");
writeFileSync(file, "alpha\nbeta\ngamma\n");

const proc = spawn("node", ["dist/index.js", "--cwd", dir], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function show(label, response) {
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response);
  console.log(`\n=== ${label} ===\n${text}`);
}

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("server:", init.result.serverInfo.name, init.result.serverInfo.version);
notify("notifications/initialized", {});

const tools = await send("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

show("open", await send("tools/call", { name: "nvim_open_file", arguments: { path: file, wait_ms: 0 } }));
show("read", await send("tools/call", { name: "nvim_read_file", arguments: { path: file } }));
show("edit_lines", await send("tools/call", { name: "nvim_edit_lines", arguments: { path: file, start_line: 2, end_line: 2, text: "BETA" } }));
show("edit_text", await send("tools/call", { name: "nvim_edit_text", arguments: { path: file, old_text: "gamma", new_text: "GAMMA" } }));
show("insert", await send("tools/call", { name: "nvim_insert_lines", arguments: { path: file, line: 1, text: "# header" } }));
show("read again", await send("tools/call", { name: "nvim_read_file", arguments: { path: file } }));
show("buffers", await send("tools/call", { name: "nvim_list_buffers", arguments: {} }));
show("diagnostics", await send("tools/call", { name: "nvim_diagnostics", arguments: {} }));
show("exec_lua", await send("tools/call", { name: "nvim_exec_lua", arguments: { code: "return vim.version().major .. '.' .. vim.version().minor" } }));
show("command", await send("tools/call", { name: "nvim_command", arguments: { command: "echo 'hello from nvim'" } }));
show("missing text", await send("tools/call", { name: "nvim_edit_text", arguments: { path: file, old_text: "nope", new_text: "x" } }));

console.log("\ndisk content:\n" + (await import("node:fs")).readFileSync(file, "utf8"));

proc.stdin.end();
await new Promise((r) => proc.once("exit", r));
console.log("server exited cleanly");
