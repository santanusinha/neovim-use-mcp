/**
 * Runtime configuration. Values come from CLI flags first, then environment.
 */
import { resolve } from "node:path";

export type NvimMode = "embedded" | "attach";
export type ConfigMode = "user" | "minimal";

const MODES = ["embedded", "attach"] as const;
const CONFIG_MODES = ["user", "minimal"] as const;

/** Embedded is the default: the server owns its own Neovim process. */
export const DEFAULT_MODE: NvimMode = "embedded";

export interface ServerConfig {
  /** embedded spawns its own nvim; attach connects to a running one. */
  mode: NvimMode;
  /** Socket or TCP address for attach mode. */
  socket?: string;
  /** Path to the nvim binary. */
  nvimPath: string;
  /** user loads ~/.config/nvim; minimal starts nvim --clean. */
  configMode: ConfigMode;
  /** Allow nvim_exec_lua and nvim_command. */
  allowExec: boolean;
  /** Working directory used as the LSP root. */
  cwd: string;
  /** Default milliseconds to wait for LSP to settle. */
  lspWaitMs: number;
  /** Maximum lines a read tool returns in one call. */
  maxLines: number;
  /** Write debug lines to stderr. */
  debug: boolean;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off", ""].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Read a path variable. A missing or blank value counts as unset. */
function envPath(name: string): string | undefined {
  const raw = process.env[name]?.trim();
    return raw || undefined;
}

/** Read an enum variable. An unknown or blank value falls back. */
function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name]?.trim().toLowerCase();
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/** Read an enum flag. An unknown value is a mistake, so fail loudly. */
function pickFlag<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  const raw = value?.trim().toLowerCase();
  if (allowed.includes(raw as T)) return raw as T;
  throw new Error(
    `${flag} accepts ${allowed.join(" or ")}, but got "${value ?? ""}".`,
  );
}

/** Fall back to the current directory, then make the path absolute. */
function resolveCwd(value: string | undefined): string {
  return resolve(value?.trim() || process.cwd());
}

export function loadConfig(argv: string[] = process.argv.slice(2)): ServerConfig {
  const mode = envEnum("NVIM_MCP_MODE", MODES, DEFAULT_MODE);
  const config: ServerConfig = {
    mode,
    // A socket alone does not switch mode. Attach mode needs an explicit ask,
    // so running inside a Neovim terminal does not hijack the session.
    socket: envPath("NVIM_MCP_SOCKET") ?? envPath("NVIM_LISTEN_ADDRESS"),
    nvimPath: envPath("NVIM_MCP_BIN") ?? "nvim",
    configMode: envEnum("NVIM_MCP_CONFIG_MODE", CONFIG_MODES, "user"),
    allowExec: envFlag("NVIM_MCP_ALLOW_EXEC", true),
    cwd: envPath("NVIM_MCP_CWD") ?? process.cwd(),
    lspWaitMs: envInt("NVIM_MCP_LSP_WAIT_MS", 3000),
    maxLines: envInt("NVIM_MCP_MAX_LINES", 2000),
    debug: envFlag("NVIM_MCP_DEBUG", false),
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i++];
    switch (arg) {
      case "--mode":
        config.mode = pickFlag("--mode", argv[i++], MODES);
        break;
      case "--socket":
        config.socket = argv[i++];
        config.mode = "attach";
        break;
      case "--nvim":
        config.nvimPath = argv[i++];
        break;
      case "--config-mode":
        config.configMode = pickFlag("--config-mode", argv[i++], CONFIG_MODES);
        break;
      case "--allow-exec":
        config.allowExec = true;
        break;
      case "--no-exec":
        config.allowExec = false;
        break;
      case "--cwd":
        config.cwd = argv[i++];
        break;
      case "--lsp-wait-ms":
        config.lspWaitMs = Number.parseInt(argv[i++], 10);
        break;
      case "--max-lines":
        config.maxLines = Number.parseInt(argv[i++], 10);
        break;
      case "--debug":
        config.debug = true;
        break;
      default:
        break;
    }
  }

  config.cwd = resolveCwd(config.cwd);

  if (config.mode === "attach" && !config.socket) {
    throw new Error(
      "attach mode needs a socket. Pass --socket <path> or set NVIM_MCP_SOCKET. " +
        "Start nvim with: nvim --listen /tmp/nvim.sock",
    );
  }

  return config;
}
