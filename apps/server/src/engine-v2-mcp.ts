/**
 * MCP on the 2.x engine. Its plugins have no config hook, so the server applies the allowlist itself:
 * - the engine's gate (engine-gates.mjs) names the servers it may start at all: the server list's ids,
 *   plus the built-in computer use server while it is on, and the Work server's name (only the account's Work
 *   folder gets it, while Work is on: work/engine.ts);
 * - each project's servers (the ones added in the app) go through the same filter as on the 1.x engine
 *   (mcp-allow.mjs, which also writes the report Settings > MCP shows) and reach the engine through its
 *   runtime MCP API, as direct tools (`codemode: false`: calls stay `<server>_<tool>`, never Code Mode).
 * The engine starts a local server with its own environment under the entry's: the app's secrets are set
 * empty there, and the server's own values come from the person's environment (env-only filtering).
 */
import { computerUseBuiltins, computerUseDir } from "./computer-use/desktop.js";
import { SERVER_ID } from "./computer-use/shared/contract.mjs";
import { createMcpPolicyHooks, FIRST_PARTY_REMOTE, mcpServerEnvironment } from "./mcp-allow/mcp-allow.mjs";
import { isV2WorkRoot, v2WorkMcp } from "./work/engine.js";
import { workDir } from "./work/work.js";
import { currentMcpPolicy, mcpPolicyFile, mcpReportDir, mcpWorkspaceDir, readWorkspaceMcp } from "./mcp-allow/state.js";

const GATE_NAME = /^[A-Za-z0-9_.-]+$/;
const APP_SECRET_NAME = /^(?:OMNIRUSH_|OPENCODE_)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The org's cloud connector (cloud-mcp-health.ts): a remote server the app configures, never a project. */
export const CLOUD_MCP_NAME = "omnirush-cloud";

/**
 * The org's cloud connector as the app persisted it (validated and scope-checked when it was set up), or null
 * when it is absent, turned off, or not a plain https (or loopback) remote server.
 */
export function cloudMcpEntry(runtimeMcp: Record<string, unknown>): Record<string, unknown> | null {
  const entry = runtimeMcp[CLOUD_MCP_NAME];
  if (!isRecord(entry) || entry.type !== "remote" || entry.enabled === false || typeof entry.url !== "string") return null;
  try {
    const url = new URL(entry.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return null;
  } catch {
    return null;
  }
  return entry;
}

/** The names the engine's gate allows (fixed for the engine's lifetime). */
export function v2McpGate(stateDir: string, env: Record<string, string | undefined> = process.env, cloud = false): string[] {
  const policy = currentMcpPolicy(stateDir);
  const ids = policy?.enabled ? policy.allow.map((entry) => entry.id) : [];
  const computerUse = computerUseBuiltins(computerUseDir(stateDir), env)[SERVER_ID] ? [SERVER_ID] : [];
  // The Work name always: Work can be turned on while the engine runs, and project files never add servers here
  // (the gate drops project MCP config), so only desiredV2Mcp below can start it.
  return [...new Set([...ids, ...computerUse, FIRST_PARTY_REMOTE.work.id, ...(cloud ? [CLOUD_MCP_NAME] : [])])].filter((name) => GATE_NAME.test(name)).sort();
}

/** One server's 2.x runtime config (the same fields the 1.x engine had), always a direct-tool server. */
export function v2McpConfig(value: Record<string, unknown>, engineEnv: Record<string, string>): Record<string, unknown> | null {
  const timeout = typeof value.timeout === "number" && value.timeout > 0 ? { timeout: { startup: value.timeout, catalog: value.timeout, execution: value.timeout } } : {};
  if (value.type === "remote" && typeof value.url === "string") {
    return { type: "remote", url: value.url, ...(value.oauth === false ? { oauth: false } : {}), ...(value.enabled === false ? { disabled: true } : {}), codemode: false, ...timeout };
  }
  if (!Array.isArray(value.command) || value.command.length === 0 || !value.command.every((part) => typeof part === "string" && part)) return null;
  const own = isRecord(value.environment)
    ? Object.fromEntries(Object.entries(value.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  // The engine's own secrets (its password, the app's tokens) are empty for the server.
  for (const key of Object.keys(engineEnv)) if (APP_SECRET_NAME.test(key) && !(key in own)) own[key] = "";
  return {
    type: "local", command: value.command, environment: own,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(value.enabled === false ? { disabled: true } : {}),
    codemode: false, ...timeout,
  };
}

/** The servers a project gets on the 2.x engine, by name; fails closed (no servers) on any error. */
export async function desiredV2Mcp(stateDir: string, root: string, engineEnv: Record<string, string>, gate: readonly string[], cloud: Record<string, unknown> | null = null): Promise<Record<string, Record<string, unknown>>> {
  try {
    const target: Record<string, unknown> = { mcp: readWorkspaceMcp(mcpWorkspaceDir(stateDir), root) };
    // The built-ins' names belong to the app.
    target.mcp = Object.fromEntries(Object.entries(target.mcp as Record<string, unknown>).filter(([name]) => !name.toLowerCase().startsWith(SERVER_ID) && !name.toLowerCase().startsWith(FIRST_PARTY_REMOTE.work.id)));
    const hooks = createMcpPolicyHooks({
      directory: root, policyFile: mcpPolicyFile(stateDir), reportDir: mcpReportDir(stateDir),
      // The engine adds its whole environment under the entry's: values the server needs come from the person's.
      envOnly: true, filterRequired: false,
    });
    await hooks.config(target, undefined);
    const allowed: Record<string, Record<string, unknown>> = isRecord(target.mcp) ? (target.mcp as Record<string, Record<string, unknown>>) : {};
    const builtin = computerUseBuiltins(computerUseDir(stateDir))[SERVER_ID];
    if (builtin) {
      const own = isRecord(builtin.environment) ? Object.fromEntries(Object.entries(builtin.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
      allowed[SERVER_ID] = { ...builtin, environment: { ...mcpServerEnvironment(process.env, {}, [], process.platform, { envOnly: true }), ...own } };
    }
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(allowed)) {
      const config = isRecord(value) && gate.includes(name) ? v2McpConfig(value, engineEnv) : null;
      if (config) out[name] = config;
    }
    // The org's cloud connector: its sign-in rides in its own request headers (the engine's environment never
    // holds it); a direct-tool server like the others.
    if (cloud && gate.includes(CLOUD_MCP_NAME)) {
      const headers = isRecord(cloud.headers)
        ? Object.fromEntries(Object.entries(cloud.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
      const timeout = typeof cloud.timeout === "number" && cloud.timeout > 0 ? { timeout: { startup: cloud.timeout, catalog: cloud.timeout, execution: cloud.timeout } } : {};
      out[CLOUD_MCP_NAME] = { type: "remote", url: cloud.url, headers, ...(cloud.oauth === false ? { oauth: false } : {}), codemode: false, ...timeout };
    }
    // Work mode: the account's Work folder gets the hosted connector server (through the app's local API).
    const work = gate.includes(FIRST_PARTY_REMOTE.work.id) && isV2WorkRoot(workDir(stateDir), root) ? v2WorkMcp(engineEnv) : null;
    if (work) out[FIRST_PARTY_REMOTE.work.id] = work;
    return out;
  } catch {
    return {};
  }
}
