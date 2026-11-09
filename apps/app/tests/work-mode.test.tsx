import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushWorkConnector } from "../src/app/lib/omnirush-server";
import { connectSettled, isWorkModeShortcut, visibleConnectors, WORK_TEMPLATES } from "../src/react-app/domains/work/work-mode";
import { ConnectorRow, WorkHome, WorkModeToggle } from "../src/react-app/domains/work/work-views";

const row = (over: Partial<OmniRushWorkConnector>): OmniRushWorkConnector => ({
  id: "google", label: "Google", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: false, ...over,
});
const noop = () => {};

describe("Work mode", () => {
  test("Cmd/Ctrl+Shift+K switches mode; Cmd/Ctrl+K stays the command palette", () => {
    const key = { key: "K", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
    expect(isWorkModeShortcut(key, true)).toBe(true);
    expect(isWorkModeShortcut(key, false)).toBe(false);
    expect(isWorkModeShortcut({ ...key, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isWorkModeShortcut({ ...key, shiftKey: false }, true)).toBe(false);
  });

  test("the toggle marks the current mode", () => {
    const markup = renderToStaticMarkup(<WorkModeToggle mode="work" onChange={noop} shortcut="⌘⇧K" />);
    expect(markup).toContain('data-app-mode="work"');
    expect(markup).toMatch(/aria-checked="true"[^>]*data-app-mode-option="work"/);
    expect(markup).toMatch(/aria-checked="false"[^>]*data-app-mode-option="code"/);
  });

  test("the home asks what to get done and shows the six template cards", () => {
    const markup = renderToStaticMarkup(<WorkHome onStart={async () => {}} onOpenConnectors={noop} />);
    expect(markup).toContain("What do you want to get done?");
    for (const id of ["inbox", "support", "meetings", "sales", "search", "backoffice"]) expect(markup).toContain(`data-work-template="${id}"`);
    expect(WORK_TEMPLATES.every((template) => template.prompt.length > 20)).toBe(true);
  });

  test("connectors: unavailable sources are hidden; a connect settles on connected, syncing or error", () => {
    const rows = [row({ id: "google" }), row({ id: "notion", status: "unavailable" }), row({ id: "slack", status: "syncing" })];
    expect(visibleConnectors(rows).map((item) => item.id)).toEqual(["google", "slack"]);
    expect(connectSettled(rows, "google")).toBe(false);
    expect(connectSettled(rows, "slack")).toBe(true);
    expect(connectSettled([row({ status: "error", error: "reconnect_required" })], "google")).toBe(true);
  });

  test("a connected source shows its account, records, last sync, sync switch and Disconnect", () => {
    const markup = renderToStaticMarkup(
      <ConnectorRow connector={row({ status: "connected", account: "ops@example.com", records: 1234, last_sync_at: "2026-11-09T10:00:00Z", sync_enabled: true })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />,
    );
    expect(markup).toContain("Connected");
    expect(markup).toContain("ops@example.com");
    expect(markup).toContain("records");
    expect(markup).toContain("Last sync");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("Disconnect");
  });

  test("a source needing a new sign-in offers Reconnect; a disconnected one offers Connect and no switch", () => {
    const error = renderToStaticMarkup(<ConnectorRow connector={row({ status: "error", error: "reconnect_required" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(error).toContain("Sign-in expired");
    expect(error).toContain("Reconnect");
    const off = renderToStaticMarkup(<ConnectorRow connector={row({})} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(off).toContain(">Connect<");
    expect(off).not.toContain('role="switch"');
  });
});
