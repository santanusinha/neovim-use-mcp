import { spawn, type ChildProcess } from "node:child_process";
import { attach, type NeovimClient } from "neovim";
import type { ServerConfig } from "../util/config.js";
import { ToolError } from "../util/errors.js";
import { WARMUP } from "./lua.js";

/**
 * Owns one Neovim process (or one attached socket) and serialises all calls.
 */
export class NvimSession {
  private readonly config: ServerConfig;
  private proc?: ChildProcess;
  private client?: NeovimClient;
  private starting?: Promise<NeovimClient>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(config: ServerConfig) {
    this.config = config;
  }


  private log(message: string): void {
    if (this.config.debug) process.stderr.write(`[nvim-mcp] ${message}\n`);
  }

  /** Start nvim if needed and return the client. Safe to call many times. */
  async ready(): Promise<NeovimClient> {
    if (this.client) return this.client;
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }


    private async start(): Promise<NeovimClient> {
      if (this.closed) throw new ToolError("The Neovim session is shut down.");

      let client: NeovimClient;
      if (this.config.mode === "attach") {
        const socket = this.config.socket as string;
        this.log(`attaching to ${socket}`);
        client = attach({ socket });
      } else {
        const args = ["--embed", "--headless"];
        if (this.config.configMode === "minimal") args.push("--clean");
        this.log(`spawning ${this.config.nvimPath} ${args.join(" ")}`);
        const proc = spawn(this.config.nvimPath, args, {
          cwd: this.config.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NVIM_MCP_CHILD: "1" },
        });
        proc.on("error", (error) => {
          process.stderr.write(
            `[nvim-mcp] failed to start nvim: ${error.message}\n`,
          );
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          if (this.config.debug) process.stderr.write(`[nvim] ${chunk}`);
        });

        proc.on("exit", (code) => {
          this.log(`nvim exited with code ${code}`);
          this.client = undefined;
          this.starting = undefined;
          this.proc = undefined;
        });
        this.proc = proc;
        client = attach({ proc });
      }


      try {
        await client.command(`cd ${escapeVimPath(this.config.cwd)}`);
      } catch (error) {
        throw new ToolError(
          `Could not talk to Neovim: ${(error as Error).message}`,
          "Check that nvim starts cleanly with: nvim --headless --embed. " +
            "If a plugin breaks headless startup, use --config-mode minimal.",
        );
      }

      // A swap-file prompt (E325) blocks forever headless: no UI can answer
      // it. This session edits with the user's knowledge and saves after
      // every edit, so swap files add no value here. Never write them and
      // never stop on a stale one.
      try {
        await client.command("set noswapfile shortmess+=A");
        this.log("swap files disabled");
      } catch (error) {
        this.log(`swap setup failed: ${(error as Error).message}`);
      }


    if (this.config.configMode === "user") {
      try {
        const warm = (await client.lua(WARMUP, [] as never)) as {
          loaded?: string[];
        };
        this.log(`warmed plugins: ${(warm?.loaded ?? []).join(", ") || "none"}`);
      } catch (error) {
        this.log(`warm-up failed: ${(error as Error).message}`);
      }
    }

    this.client = client;
    return client;
  }

  /** Run work with exclusive access to nvim, in call order. */
  async run<T>(work: (client: NeovimClient) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const client = await this.ready();
      return work(client);
    });
    this.queue = task.catch(() => undefined);
    return task as Promise<T>;
  }

  /** Run Lua inside nvim and return its value. */
  async lua<T = unknown>(code: string, args: unknown[] = []): Promise<T> {
    return this.run(async (client) => {
      return (await client.lua(code, args as never)) as T;
    });
  }

  /** Stop nvim and release the socket. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    this.proc = undefined;

    try {
      if (client && this.config.mode === "embedded") {
        await Promise.race([
          client.command("qall!").catch(() => undefined),
          delay(1500),
        ]);
      }
      client?.quit?.();
    } catch {
      // Ignore: we kill the process next.
    }

    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      await Promise.race([once(proc, "exit"), delay(2000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(proc: ChildProcess, event: string): Promise<void> {
  return new Promise((resolve) => proc.once(event, () => resolve()));
}

function escapeVimPath(path: string): string {
  return path.replace(/ /g, "\\ ");
}
