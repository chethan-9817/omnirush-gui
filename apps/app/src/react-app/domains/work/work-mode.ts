import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { OmniRushServerClient, OmniRushWorkConnector, OmniRushWorkState } from "@/app/lib/omnirush-server";

/** The window's top-level mode: Code (today's app) or Work (business chats). Remembered across restarts. */
export type AppMode = "code" | "work";

export const WORK_PRESET = "work";
export const WORK_HOME_ROUTE = "/work";
export const WORK_CONNECTORS_ROUTE = "/work/connectors";

type WorkModeStore = { mode: AppMode; setMode: (mode: AppMode) => void };

export const useWorkModeStore = create<WorkModeStore>()(
  persist((set) => ({ mode: "code", setMode: (mode) => set({ mode }) }), {
    name: "omnirush.appMode",
    storage: createJSONStorage(() => localStorage),
  }),
);

export type WorkClient = Pick<OmniRushServerClient, "getWorkState" | "ensureWorkWorkspace" | "listWorkConnectors" | "startWorkConnector" | "disconnectWorkConnector" | "setWorkConnectorSync"> & { baseUrl?: string };

export const workStateKey = (client: WorkClient | null) => ["omnirush-work-state", client?.baseUrl?.trim() || "default"];
export const workConnectorsKey = (client: WorkClient | null) => ["omnirush-work-connectors", client?.baseUrl?.trim() || "default"];

/** The server's Work switch (re-read every 60 s); Work is hidden entirely while it is off or unknown. */
export function useWorkState(client: WorkClient | null) {
  return useQuery<OmniRushWorkState>({
    queryKey: workStateKey(client),
    queryFn: () => client!.getWorkState(),
    enabled: Boolean(client),
    refetchInterval: 60_000,
    retry: false,
  });
}

/** Cmd/Ctrl+Shift+K: switch between Code and Work. */
export function isWorkModeShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key?.toLowerCase() === "k";
}

/** The sources shown on the Connectors page: everything the server offers (an `unavailable` one is hidden). */
export function visibleConnectors(rows: OmniRushWorkConnector[] | null | undefined): OmniRushWorkConnector[] {
  return (rows ?? []).filter((row) => row.status !== "unavailable");
}

/** A connect in progress is over once the source is connected (or syncing) or reports an error. */
export function connectSettled(rows: OmniRushWorkConnector[] | null | undefined, id: string): boolean {
  const row = rows?.find((item) => item.id === id);
  return Boolean(row && (row.status === "connected" || row.status === "syncing" || row.status === "error"));
}

/** Template cards on the Work home: each starts a chat with its brief. */
export const WORK_TEMPLATES = [
  {
    id: "inbox",
    title: "Inbox",
    description: "Triage, draft replies, follow-ups.",
    prompt: "Go through my inbox from the last few days. Group what needs a reply, what needs a follow-up and what can wait, and draft replies for the urgent ones. Don't send anything.",
  },
  {
    id: "support",
    title: "Support desk",
    description: "Answer and route tickets and emails.",
    prompt: "Look at the open support tickets and customer emails. For each, suggest who should handle it and draft an answer based on how we answered similar questions before.",
  },
  {
    id: "meetings",
    title: "Meetings",
    description: "Notes to tasks and CRM updates.",
    prompt: "Take the notes from my latest meeting, list the action items with owners and dates, and suggest the CRM updates they imply.",
  },
  {
    id: "sales",
    title: "Sales/CRM",
    description: "Log leads, follow up, write quotes.",
    prompt: "Find new leads from my email and chat that are not in the CRM yet, and list who I should follow up with this week and why.",
  },
  {
    id: "search",
    title: "Company search",
    description: "\"What did we quote X?\" across mail, Drive and chat.",
    prompt: "Search my mail, Drive and chat: what did we quote each customer most recently, and when? Link the source for each.",
  },
  {
    id: "backoffice",
    title: "Back office",
    description: "Invoices, purchase orders, reconciliation.",
    prompt: "List unpaid and overdue invoices, and match recent payments and bills against them. Flag anything that doesn't reconcile.",
  },
] as const;
