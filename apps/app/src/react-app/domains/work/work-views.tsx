/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Briefcase, CalendarDays, Code2, Inbox, LifeBuoy, Plug, Receipt, Search, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { OmniRushWorkConnector } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { useNavigate } from "react-router";

import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { connectSettled, countLabel, useWorkState, visibleConnectors, WORK_CONNECTORS_ROUTE, WORK_TEMPLATES, workConnectorsKey, type AppMode, type WorkClient } from "./work-mode";

const TEMPLATE_ICONS: Record<(typeof WORK_TEMPLATES)[number]["id"], ReactNode> = {
  inbox: <Inbox />,
  support: <LifeBuoy />,
  meetings: <CalendarDays />,
  sales: <TrendingUp />,
  search: <Search />,
  backoffice: <Receipt />,
};

/** The Code | Work switch at the top of the sidebar (Cmd/Ctrl+Shift+K). Shown only while Work is on for the account. */
export function WorkModeToggle(props: { mode: AppMode; onChange: (mode: AppMode) => void; shortcut: string }) {
  const option = (mode: AppMode, label: string, icon: ReactNode) => {
    const active = props.mode === mode;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        data-app-mode-option={mode}
        onClick={() => props.onChange(mode)}
        className={cn(
          "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] transition-colors [&_svg]:size-3.5",
          active
            ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      title={`Switch between Code and Work (${props.shortcut})`}
      data-app-mode={props.mode}
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 mac:titlebar-no-drag"
    >
      {option("code", "Code", <Code2 />)}
      {option("work", "Work", <Briefcase />)}
    </div>
  );
}

/** Work home: "What do you want to get done?" and the template cards; every start opens a Work chat. */
export function WorkHome(props: { onStart: (prompt: string) => Promise<void>; onOpenConnectors: () => void; busy?: boolean; message?: string | null }) {
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const busy = Boolean(props.busy) || starting;
  const start = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    setStarting(true);
    try {
      await props.onStart(prompt.trim());
      setText("");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The chat could not be started.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto" data-testid="work-home">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-10 pt-16">
        <h1 className="text-center text-2xl font-semibold tracking-tight">What do you want to get done?</h1>
        <form
          className="rounded-2xl border border-border bg-background p-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
          onSubmit={(event) => { event.preventDefault(); void start(text); }}
        >
          <Textarea
            aria-label="What do you want to get done?"
            data-testid="work-home-input"
            placeholder="Ask about your email, documents, customers or invoices…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void start(text);
              }
            }}
            className="min-h-20 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={props.onOpenConnectors} data-testid="work-home-connectors">
              <Plug className="size-4" />
              Connectors
            </Button>
            <Button type="submit" size="icon-sm" aria-label="Start" disabled={busy || !text.trim()}>
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </form>
        {props.message ? <p className="text-center text-sm text-muted-foreground">{props.message}</p> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="work-templates">
          {WORK_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-work-template={template.id}
              disabled={busy}
              onClick={() => void start(template.prompt)}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-background p-4 text-start transition-colors hover:border-foreground/20 hover:bg-muted disabled:opacity-60 [&_svg]:size-4"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span className="text-muted-foreground">{TEMPLATE_ICONS[template.id]}</span>
                {template.title}
              </span>
              <span className="text-[13px] text-muted-foreground">{template.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<OmniRushWorkConnector["status"], string> = {
  connected: "Connected",
  syncing: "Importing history",
  error: "Needs attention",
  disconnected: "Not connected",
  unavailable: "Unavailable",
};

function lastSync(value: string | null): string {
  if (!value) return "Not synced yet";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "Not synced yet" : `Last sync ${at.toLocaleString()}`;
}

function errorText(error: string | undefined): string {
  return error === "reconnect_required" ? "Sign-in expired: connect again." : error ? `Error: ${error}` : "Something went wrong: connect again.";
}

export const CONNECT_POLL_MS = 2_000;
export const CONNECT_TIMEOUT_MS = 60_000;

/** One source on the Connectors page. */
export function ConnectorRow(props: {
  connector: OmniRushWorkConnector;
  connecting: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: (enabled: boolean) => void;
}) {
  const row = props.connector;
  const connected = row.status === "connected" || row.status === "syncing" || row.status === "error";
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0" data-work-connector={row.id} data-status={row.status}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{row.label}</span>
          <Badge variant={row.status === "error" ? "destructive" : row.status === "disconnected" ? "outline" : "secondary"} data-testid="work-connector-status">
            {props.connecting ? "Waiting for sign-in…" : STATUS_LABEL[row.status]}
          </Badge>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {row.status === "error"
            ? errorText(row.error)
            : connected
              ? [row.account, countLabel(row.records, "record"), lastSync(row.last_sync_at)].filter(Boolean).join(" · ")
              : "Connect to let the agent search and use it."}
        </div>
      </div>
      {connected ? (
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          Data sync
          <Switch
            aria-label={`Data sync for ${row.label}`}
            checked={row.sync_enabled}
            disabled={props.busy}
            onCheckedChange={(checked: boolean) => props.onSync(checked)}
          />
        </label>
      ) : null}
      {connected && row.status !== "error" ? (
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onDisconnect}>Disconnect</Button>
      ) : (
        <Button size="sm" disabled={props.busy || props.connecting} onClick={props.onConnect}>{row.status === "error" ? "Reconnect" : "Connect"}</Button>
      )}
    </div>
  );
}

/** Work > Connectors (also reachable from Settings): each source's status, record count, last sync and sync switch. */
export function WorkConnectorsPage(props: { client: WorkClient | null; openLink: (url: string) => void; onBack?: () => void }) {
  const queryClient = useQueryClient();
  const key = workConnectorsKey(props.client);
  const [connecting, setConnecting] = useState<string | null>(null);
  const connectStarted = useRef(0);
  const query = useQuery({
    queryKey: key,
    queryFn: () => props.client!.listWorkConnectors(),
    enabled: Boolean(props.client),
    refetchInterval: connecting ? CONNECT_POLL_MS : false,
  });
  useEffect(() => {
    if (!connecting) return;
    if (connectSettled(query.data, connecting)) {
      setConnecting(null);
      return;
    }
    if (Date.now() - connectStarted.current > CONNECT_TIMEOUT_MS) {
      setConnecting(null);
      toast.error("Sign-in did not finish. Try connecting again.");
    }
  }, [connecting, query.data]);
  const onError = (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "That did not work. Try again.");
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const connect = useMutation({
    mutationFn: (id: string) => props.client!.startWorkConnector(id),
    onSuccess: (answer, id) => {
      connectStarted.current = Date.now();
      setConnecting(id);
      props.openLink(answer.auth_url);
    },
    onError,
  });
  const disconnect = useMutation({ mutationFn: (id: string) => props.client!.disconnectWorkConnector(id), onSuccess: refresh, onError });
  const sync = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => props.client!.setWorkConnectorSync(id, enabled),
    onSuccess: refresh,
    onError,
  });
  const rows = visibleConnectors(query.data);
  const busy = connect.isPending || disconnect.isPending || sync.isPending;
  return (
    <div className="h-full overflow-y-auto" data-testid="work-connectors">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pb-10 pt-10">
        <div>
          {props.onBack ? <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}>Back to Work</Button> : null}
          <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect the tools your business uses. The agent can search and read them in Work chats, and asks you before it sends or changes anything. Data sync keeps a copy up to date; switch it off to stop collecting new data.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-background">
          {query.isLoading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
          ) : query.error ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : "The connectors could not be loaded."}</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No connectors are available yet.</div>
          ) : rows.map((row) => (
            <ConnectorRow
              key={row.id}
              connector={row}
              connecting={connecting === row.id}
              busy={busy}
              onConnect={() => connect.mutate(row.id)}
              onDisconnect={() => disconnect.mutate(row.id)}
              onSync={(enabled) => sync.mutate({ id: row.id, enabled })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Settings > Preferences: the way to Work > Connectors, while Work is on for the account. */
export function WorkConnectorsSetting(props: { client: WorkClient | null }) {
  const navigate = useNavigate();
  const state = useWorkState(props.client);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>Work connectors</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>Connect Google, Microsoft 365, Slack, HubSpot, QuickBooks or Notion for Work chats.</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-connectors" onClick={() => navigate(WORK_CONNECTORS_ROUTE)}>Open</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
