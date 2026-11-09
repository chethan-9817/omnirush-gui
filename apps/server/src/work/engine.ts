// Work chats' engine config (Work mode), applied by the MCP plugin (opencode-plugins/omnirush-mcp-policy.ts).
import { FIRST_PARTY_REMOTE, firstPartyRemote, toolPrefix } from "../mcp-allow/mcp-allow.mjs";
import { WORK_PROMPT } from "./prompt.js";
import { isWorkRoot, rememberedWorkSwitch, WORK_DIR_ENV, WORK_DISABLED_TOOLS, WORK_READ_TOOLS } from "./work.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Work chat (the account's Work folder, Work on for the account): the hosted connector server through the
 * app's local API (it adds the account's credential; the engine never holds it), every tool but the read ones
 * asking first in every mode, no shell or code tools, and the Work prompt. Every other project: untouched.
 */
export function applyWork(target: Record<string, unknown>, root: string, env: Record<string, string | undefined> = process.env): void {
  const dir = env[WORK_DIR_ENV];
  if (!dir || !isWorkRoot(dir, root) || !rememberedWorkSwitch(dir).enabled) return;
  const origin = String(env.OMNIRUSH_SERVER_URL ?? "").trim();
  const token = String(env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
  const id = FIRST_PARTY_REMOTE.work.id;
  const entry = token ? firstPartyRemote("work", origin, `${origin.replace(/\/+$/, "")}${FIRST_PARTY_REMOTE.work.path}`, { Authorization: `Bearer ${token}` }) : null;
  if (entry) target.mcp = { ...(isRecord(target.mcp) ? target.mcp : {}), [id]: { ...entry, timeout: 60_000 } };
  const permission: Record<string, unknown> = typeof target.permission === "string" ? { "*": target.permission } : isRecord(target.permission) ? { ...target.permission } : {};
  const prefix = toolPrefix(id);
  delete permission[`${prefix}*`];
  permission[`${prefix}*`] = "ask";
  for (const tool of WORK_READ_TOOLS) permission[`${prefix}${tool}`] = "allow";
  permission.bash = "deny";
  permission.edit = "deny";
  target.permission = permission;
  target.tools = { ...(isRecord(target.tools) ? target.tools : {}), ...Object.fromEntries(WORK_DISABLED_TOOLS.map((tool) => [tool, false])) };
  const agents = isRecord(target.agent) ? { ...target.agent } : {};
  const main = isRecord(agents.omnirush) ? { ...agents.omnirush } : {};
  // The agent's own rules would otherwise win over the ones above (they are read after the global ones).
  if (isRecord(main.permission)) main.permission = { ...main.permission, ...permission };
  agents.omnirush = { ...main, prompt: WORK_PROMPT };
  target.agent = agents;
}

