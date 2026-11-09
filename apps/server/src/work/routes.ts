/**
 * Work mode's local routes, for the app (client scope). The account's credential stays in this server: the
 * app and the engine reach /omnirush/work/* only through here.
 *
 *   GET   /work/state                      { enabled, sources, message, workspaceId }
 *   POST  /work/workspace                  makes the account's Work folder a workspace: { workspaceId, path }
 *   GET   /work/connectors                 GET /omnirush/work/connectors (also remembered for the upload)
 *   POST  /work/connectors/:id/start       { auth_url }
 *   POST  /work/connectors/:id/disconnect
 *   PATCH /work/connectors/:id             { sync_enabled }
 *
 * The engine's hosted MCP calls (POST /omnirush/work/mcp with the engine's token) are forwarded by server.ts.
 */
import { mkdir } from "node:fs/promises";

import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { rememberedWorkSwitch, rememberWorkConnectors, rememberWorkSwitch, WORK_PRESET, workHome } from "./work.js";

export type WorkBroker = {
  workRequest: (path: string, init: { method: "GET" | "POST" | "PATCH"; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  accountId: () => Promise<string | null>;
  capabilities: () => Promise<unknown>;
};

export type WorkRouteDeps = {
  routes: Route[];
  config: ServerConfig;
  workDir: () => string;
  broker: () => WorkBroker | null;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  addWorkspace: (folderPath: string) => Promise<WorkspaceInfo>;
  /** The engine picks up a changed switch (the Work folder's server comes or goes). */
  applyEngine: () => Promise<unknown>;
};

const WORK_ERRORS: Record<string, string> = {
  work_disabled: "Work is turned off for your account.",
  unknown_connector: "This connector is not available.",
  connector_unavailable: "This connector is not available on this server right now.",
  not_connected: "Connect this source first.",
  omnirush_account_required: "Sign in to omnirush.ai to use Work.",
};

const CONNECTOR = /^(google|microsoft|slack|hubspot|quickbooks|notion|mock)$/;

/** The Work workspace among the server's: preset "work" in the Work folder. */
export function findWorkWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | null {
  return workspaces.find((workspace) => workspace.preset === WORK_PRESET && workspace.workspaceType !== "remote") ?? null;
}

async function passThrough(response: Response, jsonResponse: WorkRouteDeps["jsonResponse"]): Promise<{ status: number; data: unknown; response: Response }> {
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: "unreadable_answer" }; }
  // The app's client reads `code` and `message`; the server's own `detail` is kept as it came.
  if (response.status >= 400 && data && typeof data === "object" && !Array.isArray(data) && typeof (data as { detail?: unknown }).detail === "string") {
    const detail = (data as { detail: string }).detail;
    data = { ...data, code: detail, message: WORK_ERRORS[detail] ?? detail };
  }
  return { status: response.status, data, response: jsonResponse(data, response.status) };
}

export function registerWorkRoutes(deps: WorkRouteDeps): void {
  const { routes, jsonResponse } = deps;
  const signedOut = () => jsonResponse({ detail: "omnirush_account_required", code: "omnirush_account_required", message: WORK_ERRORS.omnirush_account_required }, 401);

  // The switch, read again from the server (at most as old as the capabilities cache), so the toggle follows it.
  addRoute(routes, "GET", "/work/state", "client", async () => {
    const found = deps.broker();
    if (found) {
      const capabilities = await found.capabilities().catch(() => null);
      if (rememberWorkSwitch(deps.workDir(), capabilities)) void deps.applyEngine().catch(() => undefined);
    }
    const setting = rememberedWorkSwitch(deps.workDir());
    return jsonResponse({ ...setting, workspaceId: findWorkWorkspace(deps.config.workspaces)?.id ?? null });
  });

  addRoute(routes, "POST", "/work/workspace", "client", async () => {
    if (!rememberedWorkSwitch(deps.workDir()).enabled) return jsonResponse({ detail: "work_disabled", code: "work_disabled", message: WORK_ERRORS.work_disabled }, 404);
    const found = deps.broker();
    const accountId = found ? await found.accountId() : null;
    const home = accountId ? workHome(deps.workDir(), accountId) : null;
    if (!home) return signedOut();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const workspace = await deps.addWorkspace(home);
    return jsonResponse({ workspaceId: workspace.id, path: workspace.path });
  });

  addRoute(routes, "GET", "/work/connectors", "client", async () => {
    const found = deps.broker();
    if (!found) return signedOut();
    const answer = await passThrough(await found.workRequest("connectors", { method: "GET" }), jsonResponse);
    if (answer.status === 200) rememberWorkConnectors(deps.workDir(), answer.data);
    return answer.response;
  });

  for (const action of ["start", "disconnect"] as const) {
    addRoute(routes, "POST", `/work/connectors/:id/${action}`, "client", async (ctx) => {
      if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
      const found = deps.broker();
      if (!found) return signedOut();
      return (await passThrough(await found.workRequest(`connectors/${ctx.params.id}/${action}`, { method: "POST", body: "{}" }), jsonResponse)).response;
    });
  }

  addRoute(routes, "PATCH", "/work/connectors/:id", "client", async (ctx) => {
    if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
    const body = await deps.readJsonBody(ctx.request);
    if (typeof body.sync_enabled !== "boolean") return jsonResponse({ detail: "sync_enabled must be true or false" }, 400);
    const found = deps.broker();
    if (!found) return signedOut();
    return (await passThrough(await found.workRequest(`connectors/${ctx.params.id}`, { method: "PATCH", body: JSON.stringify({ sync_enabled: body.sync_enabled }) }), jsonResponse)).response;
  });
}

/**
 * The engine's hosted MCP call, forwarded as it is (streamable HTTP, JSON answers) with the account's
 * credential: POST only (the hosted server answers GET and DELETE with 405 anyway), the MCP headers kept.
 */
export async function forwardWorkMcp(request: Request, broker: WorkBroker): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const headers: Record<string, string> = { Accept: request.headers.get("accept") ?? "application/json, text/event-stream" };
  const version = request.headers.get("mcp-protocol-version");
  if (version) headers["mcp-protocol-version"] = version;
  const upstream = await broker.workRequest("mcp", { method: "POST", body: await request.text(), headers, signal: request.signal });
  const out = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
  const session = upstream.headers.get("mcp-session-id");
  if (session) out.set("mcp-session-id", session);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
