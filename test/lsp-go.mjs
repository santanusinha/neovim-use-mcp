import { spawn } from "node:child_process";

const cwd = process.argv[2] ?? process.cwd();
const file = process.argv[3] ?? "main.go";

const proc = spawn("node", [`${process.cwd()}/dist/index.js`, "--cwd", cwd], {
  cwd,
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
const call = (name, args) => send("tools/call", { name, arguments: args });
function show(label, response) {
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response);
  console.log(`\n=== ${label} ===\n${text.slice(0, 1200)}`);
}

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lsp", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

show("open", await call("nvim_open_file", { path: file, wait_ms: 15000 }));
show("symbols", await call("nvim_document_symbols", { path: file, wait_ms: 10000 }));
show("diagnostics", await call("nvim_diagnostics", { path: file, wait_ms: 3000 }));
show("hover", await call("nvim_hover", { path: file, line: 5, column: 6, wait_ms: 10000 }));
show("definition", await call("nvim_goto_definition", { path: file, line: 11, column: 14, wait_ms: 10000 }));
show("references", await call("nvim_references", { path: file, line: 5, column: 6, wait_ms: 10000 }));
show("workspace symbols", await call("nvim_workspace_symbols", { query: "Greet", wait_ms: 10000 }));
show("code actions", await call("nvim_code_actions", { path: file, line: 10, column: 6, wait_ms: 10000 }));
show("format", await call("nvim_format", { path: file, wait_ms: 10000 }));
show("rename", await call("nvim_rename_symbol", { path: file, line: 5, column: 6, new_name: "Hello", wait_ms: 10000 }));
show("read", await call("nvim_read_file", { path: file }));

proc.stdin.end();
await new Promise((r) => proc.once("exit", r));
console.log("exited");
