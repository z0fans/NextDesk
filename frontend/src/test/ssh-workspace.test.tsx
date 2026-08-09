import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SSH_CONNECTIONS_STORAGE_KEY,
  SSH_DEFAULT_GROUP_ID,
  SSH_GROUP_NAME_MAX_LENGTH,
  SSH_GROUPS_STORAGE_KEY,
} from "@/ssh/connection-store";
import { SSH_WORKSPACE_LAYOUT_STORAGE_KEY } from "@/ssh/ssh-workspace-layout-store";
import type { SshEvent } from "@/ssh/types";

const terminalProps = vi.hoisted(
  () =>
    new Map<
      string,
      {
        sessionId: string;
        retryToken: number;
        connection: {
          id: string;
          credentialReference?: string;
        };
        onEvent: (event: SshEvent) => void;
      }
    >(),
);

const credentialApi = vi.hoisted(() => ({
  input: vi.fn<(...args: [string, Uint8Array]) => Promise<void>>(),
  storeCredential: vi.fn<(...args: [string, string]) => Promise<void>>(),
  storePrivateKeyCredential:
    vi.fn<
      (...args: [string, string, string, string?, string?]) => Promise<void>
    >(),
  deleteCredential: vi.fn<(...args: [string]) => Promise<void>>(),
  close: vi.fn<(...args: [string]) => Promise<void>>(),
  monitorSnapshot: vi.fn<
    (...args: [string]) => Promise<{
      supported: boolean;
      platform: "linux" | "windows" | "unknown";
      uptimeSeconds: number;
      loadAverage: [number, number, number];
      cpuPercent: number;
      memoryUsedBytes: number;
      memoryTotalBytes: number;
      swapUsedBytes: number;
      swapTotalBytes: number;
      processes: [];
      networkReceiveBytesPerSecond: number;
      networkTransmitBytesPerSecond: number;
      latencyMs: number;
      disks: [];
    }>
  >(),
}));

const workspaceApi = vi.hoisted(() => ({
  sshSftpOpen: vi.fn<(...args: [string]) => Promise<{ path: string }>>(),
  sshSftpList: vi.fn<
    (...args: [string, string]) => Promise<{
      path: string;
      entries: Array<{ name: string; kind: string }>;
    }>
  >(),
}));

vi.mock("@/i18n/useTranslation", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/ssh/TerminalSurface", () => ({
  TerminalSurface: (props: {
    sessionId: string;
    connection: { id: string };
    visible: boolean;
    retryToken: number;
    onEvent: (event: SshEvent) => void;
  }) => {
    terminalProps.set(props.connection.id, props);
    return (
      <div
        data-testid={`terminal-${props.connection.id}`}
        data-visible={String(props.visible)}
      />
    );
  },
}));

vi.mock("@/ssh/ssh-api", () => ({
  sshApi: credentialApi,
}));

vi.mock("@/api", () => ({ api: workspaceApi }));

vi.mock("@/ssh/SftpPanel", () => ({
  SftpPanel: ({
    sessionId,
    visible,
  }: {
    sessionId: string;
    visible: boolean;
  }) => (
    <div data-testid={`sftp-${sessionId}`} data-visible={String(visible)} />
  ),
}));

import { SshWorkspace } from "@/ssh/SshWorkspace";

describe("SSH workspace", () => {
  beforeEach(() => {
    terminalProps.clear();
    credentialApi.input.mockReset().mockResolvedValue(undefined);
    credentialApi.storeCredential.mockReset().mockResolvedValue(undefined);
    credentialApi.storePrivateKeyCredential
      .mockReset()
      .mockResolvedValue(undefined);
    credentialApi.deleteCredential.mockReset().mockResolvedValue(undefined);
    credentialApi.close.mockReset().mockResolvedValue(undefined);
    credentialApi.monitorSnapshot.mockReset().mockResolvedValue({
      supported: false,
      platform: "unknown",
      uptimeSeconds: 0,
      loadAverage: [0, 0, 0],
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      processes: [],
      networkReceiveBytesPerSecond: 0,
      networkTransmitBytesPerSecond: 0,
      latencyMs: 0,
      disks: [],
    });
    workspaceApi.sshSftpOpen
      .mockReset()
      .mockResolvedValue({ path: "/home/root" });
    workspaceApi.sshSftpList.mockReset().mockResolvedValue({
      path: "/home/root",
      entries: [{ name: "logs", kind: "directory" }],
    });
    localStorage.clear();
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "alpha",
          name: "Alpha",
          host: "alpha.example.com",
          port: 22,
          username: "root",
          authMethod: "password",
          credentialReference: "ssh-alpha",
          routePolicy: "auto",
        },
        {
          id: "beta",
          name: "Beta",
          host: "beta.example.com",
          port: 22,
          username: "root",
          authMethod: "password",
          credentialReference: "ssh-beta",
          routePolicy: "direct",
        },
      ]),
    );
  });

  it("uses application theme tokens for workspace chrome and the empty state", () => {
    const { container } = render(<SshWorkspace isVisible />);
    const workspace = container.firstElementChild;
    const connectionSidebar = workspace?.querySelector("aside");

    expect(workspace).toHaveClass("bg-background", "text-foreground");
    expect(workspace).not.toHaveClass("bg-[#080d16]", "text-slate-100");
    expect(connectionSidebar).toHaveClass(
      "bg-sidebar",
      "border-sidebar-border",
    );
    expect(screen.getByText("sshWorkspaceEmptyTitle")).toHaveClass(
      "text-foreground",
    );
    expect(screen.getByText("sshWorkspaceEmptyDesc")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("keeps the SSH sidebar header compact and moves secondary tools into a menu", async () => {
    const user = userEvent.setup();
    const { container } = render(<SshWorkspace isVisible />);

    expect(
      container.querySelector('[data-region="ssh-sidebar-header"]'),
    ).toHaveClass("h-[73px]", "shrink-0", "items-center");

    expect(screen.getByText("sshConnections")).toHaveClass(
      "truncate",
      "whitespace-nowrap",
    );
    expect(
      screen.getAllByRole("button", { name: "sshNewConnection" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("menuitem", { name: "sshTerminalSettings" }),
    ).not.toBeInTheDocument();

    const moreActions = screen.getByRole("button", {
      name: "sshMoreActions",
    });
    await user.click(moreActions);

    const terminalSettings = screen.getByRole("menuitem", {
      name: "sshTerminalSettings",
    });
    const knownHosts = screen.getByRole("menuitem", {
      name: "sshKnownHostsTitle",
    });
    expect(terminalSettings).toBeInTheDocument();
    expect(knownHosts).toBeInTheDocument();
    await waitFor(() => expect(terminalSettings).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(knownHosts).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(moreActions).toHaveFocus();
  });

  it("shows legacy connections in a collapsible default SSH group", async () => {
    const user = userEvent.setup();
    render(<SshWorkspace isVisible />);

    const toggle = screen.getByRole("button", {
      name: "sshToggleGroup sshDefaultGroup",
    });
    expect(toggle).toHaveTextContent("sshDefaultGroup");
    expect(toggle).toHaveTextContent("2");
    expect(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    ).toBeInTheDocument();

    await user.click(toggle);

    expect(
      screen.queryByRole("button", { name: "sshConnect Alpha" }),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(SSH_GROUPS_STORAGE_KEY) ?? "[]"),
    ).toEqual([{ id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: false }]);
  });

  it("aligns the SSH sidebar actions with the collapsed app status footer", () => {
    const { container } = render(<SshWorkspace isVisible />);

    expect(
      container.querySelector('[data-region="ssh-sidebar-actions"]'),
    ).toHaveClass("h-11", "shrink-0", "items-center");
  });

  it("creates and persists a custom SSH group from the sidebar", async () => {
    const user = userEvent.setup();
    render(<SshWorkspace isVisible />);

    await user.click(screen.getByRole("button", { name: "sshNewGroup" }));
    const groupNameInput = screen.getByRole("textbox", {
      name: "sshGroupName",
    });
    expect(groupNameInput).toHaveAttribute(
      "maxlength",
      String(SSH_GROUP_NAME_MAX_LENGTH),
    );
    await user.type(groupNameInput, "Production");
    await user.click(screen.getByRole("button", { name: "sshCreateGroup" }));

    expect(
      screen.getByRole("button", { name: "sshToggleGroup Production" }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(SSH_GROUPS_STORAGE_KEY) ?? "[]"),
    ).toEqual([
      { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
      expect.objectContaining({ name: "Production", isExpanded: true }),
    ]);
  });

  it("moves a saved SSH connection to another group from its context menu", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      SSH_GROUPS_STORAGE_KEY,
      JSON.stringify([
        { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
        { id: "production", name: "Production", isExpanded: true },
      ]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    await user.click(screen.getByRole("button", { name: "sshMoveToGroup" }));
    await user.click(
      screen.getByRole("button", { name: "sshMoveConnectionTo Production" }),
    );

    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    expect(
      saved.find((connection: { id: string }) => connection.id === "alpha"),
    ).toEqual(expect.objectContaining({ groupId: "production" }));
    expect(
      screen.getByRole("button", { name: "sshToggleGroup Production" }),
    ).toHaveTextContent("1");
  });

  it("moves a saved SSH connection by dragging it onto a group", () => {
    localStorage.setItem(
      SSH_GROUPS_STORAGE_KEY,
      JSON.stringify([
        { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
        { id: "production", name: "Production", isExpanded: true },
      ]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.dragStart(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const production = screen.getByRole("button", {
      name: "sshToggleGroup Production",
    });
    fireEvent.dragOver(production);
    fireEvent.drop(production);

    expect(production).toHaveTextContent("1");
    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    expect(
      saved.find((connection: { id: string }) => connection.id === "alpha"),
    ).toEqual(expect.objectContaining({ groupId: "production" }));
  });

  it("renames a custom SSH group from the group context menu", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      SSH_GROUPS_STORAGE_KEY,
      JSON.stringify([
        { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
        { id: "production", name: "Production", isExpanded: true },
      ]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshToggleGroup Production" }),
    );
    await user.click(screen.getByRole("button", { name: "sshRenameGroup" }));
    const input = screen.getByRole("textbox", { name: "sshRenameGroup" });
    expect(input).toHaveAttribute(
      "maxlength",
      String(SSH_GROUP_NAME_MAX_LENGTH),
    );
    await user.clear(input);
    await user.type(input, "Servers{Enter}");

    expect(
      screen.getByRole("button", { name: "sshToggleGroup Servers" }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(SSH_GROUPS_STORAGE_KEY) ?? "[]")[1],
    ).toEqual(expect.objectContaining({ id: "production", name: "Servers" }));
  });

  it("deletes a custom SSH group and returns its connections to the default group", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      SSH_GROUPS_STORAGE_KEY,
      JSON.stringify([
        { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
        { id: "production", name: "Production", isExpanded: true },
      ]),
    );
    const connections = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    connections[0].groupId = "production";
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify(connections),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshToggleGroup Production" }),
    );
    await user.click(screen.getByRole("button", { name: "sshDeleteGroup" }));

    expect(
      screen.queryByRole("button", { name: "sshToggleGroup Production" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sshToggleGroup sshDefaultGroup" }),
    ).toHaveTextContent("2");
    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    expect(
      saved.find((connection: { id: string }) => connection.id === "alpha"),
    ).toEqual(expect.objectContaining({ groupId: SSH_DEFAULT_GROUP_ID }));
  });

  it("selects a saved connection on single click and opens it on double click", async () => {
    const user = userEvent.setup();
    render(<SshWorkspace isVisible />);
    const alpha = screen.getByRole("button", { name: "sshConnect Alpha" });

    await user.click(alpha);
    expect(alpha).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Alpha")).toHaveClass("text-cyan-300");
    expect(screen.queryByTestId("terminal-alpha")).not.toBeInTheDocument();

    await user.click(alpha);
    expect(alpha).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Alpha")).toHaveClass("text-sidebar-foreground");

    await user.dblClick(alpha);
    expect(screen.getByTestId("terminal-alpha")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("hides the connection sidebar after opening a session and lets the user restore it", () => {
    render(<SshWorkspace isVisible />);
    expect(
      screen.getByText("sshConnections").closest("aside"),
    ).toBeInTheDocument();

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );

    expect(screen.queryByText("sshConnections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sshShowConnections" }));
    expect(
      screen.getByText("sshConnections").closest("aside"),
    ).toBeInTheDocument();
  });

  it("restores the connection sidebar after closing the last session tab", () => {
    render(<SshWorkspace isVisible />);

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    expect(screen.queryByText("sshConnections")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "sshClose Alpha" }),
    );

    expect(screen.queryByTestId("terminal-alpha")).not.toBeInTheDocument();
    expect(
      screen.getByText("sshConnections").closest("aside"),
    ).toBeInTheDocument();
  });

  it("keeps the connection sidebar hidden while another session tab remains", () => {
    render(<SshWorkspace isVisible />);

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshShowConnections" }));
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Beta" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "sshClose Beta" }));

    expect(screen.getByTestId("terminal-alpha")).toBeInTheDocument();
    expect(screen.queryByText("sshConnections")).not.toBeInTheDocument();
  });

  it("keeps inactive terminals mounted while switching session tabs", () => {
    render(<SshWorkspace isVisible />);

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshShowConnections" }));
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Beta" }),
    );

    const alpha = screen.getByTestId("terminal-alpha");
    const beta = screen.getByTestId("terminal-beta");
    expect(alpha).toHaveAttribute("data-visible", "false");
    expect(beta).toHaveAttribute("data-visible", "true");

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(alpha).toHaveAttribute("data-visible", "true");
    expect(beta).toHaveAttribute("data-visible", "false");
  });

  it("reconnects or closes an SSH session from the tab context menu", () => {
    const { container } = render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const first = terminalProps.get("alpha");
    const tab = screen.getByRole("button", { name: "Alpha" });

    fireEvent.contextMenu(tab, { clientX: 140, clientY: 72 });
    const reconnectMenu = container.querySelector(
      '[data-region="ssh-session-tab-context-menu"]',
    ) as HTMLElement;
    expect(reconnectMenu).toHaveStyle({ left: "140px", top: "72px" });
    fireEvent.click(
      within(reconnectMenu).getByRole("menuitem", { name: "sshReconnect" }),
    );
    expect(terminalProps.get("alpha")?.sessionId).toBe(first?.sessionId);
    expect(terminalProps.get("alpha")?.retryToken).toBe(1);

    fireEvent.contextMenu(tab, { clientX: 140, clientY: 72 });
    const closeMenu = container.querySelector(
      '[data-region="ssh-session-tab-context-menu"]',
    ) as HTMLElement;
    fireEvent.click(
      within(closeMenu).getByRole("menuitem", { name: "sshClose" }),
    );

    expect(screen.queryByTestId("terminal-alpha")).not.toBeInTheDocument();
    expect(
      screen.getByText("sshConnections").closest("aside"),
    ).toBeInTheDocument();
    expect(credentialApi.close).toHaveBeenCalledWith(first?.sessionId);
  });

  it("confines host-key trust confirmation to the terminal canvas", () => {
    const { container } = render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "host_key",
        sessionId: session.sessionId,
        preview: {
          host: "alpha.example.com",
          port: 22,
          status: "unknown",
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:test-fingerprint",
          publicKey: "ssh-ed25519 AAAATEST",
        },
      });
    });

    const terminalCanvas = screen
      .getByTestId("terminal-alpha")
      .closest('[data-region="ssh-terminal-canvas"]');
    const prompt = container.querySelector(
      '[data-region="ssh-host-key-prompt"]',
    );
    const information = screen.getByRole("complementary", {
      name: "sshSessionInformation",
    });

    expect(terminalCanvas).toContainElement(prompt as HTMLElement);
    expect(information).not.toContainElement(prompt as HTMLElement);
    expect(prompt).toHaveClass("absolute", "inset-0");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "SHA256:test-fingerprint",
    );
  });

  it("keeps manual reconnect visible inside the terminal canvas after disconnect", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const first = terminalProps.get("alpha");

    act(() => {
      first?.onEvent({
        kind: "state",
        sessionId: first.sessionId,
        state: "disconnected",
      });
    });

    const terminalCanvas = screen
      .getByTestId("terminal-alpha")
      .closest('[data-region="ssh-terminal-canvas"]') as HTMLElement;
    const reconnect = within(terminalCanvas).getByRole("button", {
      name: "sshReconnect",
    });

    fireEvent.click(reconnect);
    expect(terminalProps.get("alpha")?.retryToken).toBe(1);
    expect(
      within(
        screen.getByRole("complementary", {
          name: "sshSessionInformation",
        }),
      ).getByText("sshRouteResolving"),
    ).toBeInTheDocument();
  });

  it("opens the SFTP browser by default once the SSH session is connected", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");
    const filesButton = screen.getByRole("button", { name: "sftpCloseFiles" });
    expect(filesButton).toBeDisabled();

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
      });
    });
    expect(filesButton).toBeEnabled();

    const sftpPanel = screen.getByTestId(`sftp-${session?.sessionId}`);
    const sftpDrawer = sftpPanel.closest('[data-region="ssh-sftp-drawer"]');
    const sessionContent = sftpPanel.closest(
      '[data-region="ssh-session-content"]',
    );
    const information = screen.getByRole("complementary", {
      name: "sshSessionInformation",
    });
    expect(sftpPanel).toHaveAttribute("data-visible", "true");
    expect(sftpDrawer).toHaveClass("w-full", "border-t");
    expect(sftpDrawer).not.toHaveClass("hidden");
    expect(information.nextElementSibling?.nextElementSibling).toBe(
      sessionContent,
    );
    expect(sessionContent).toContainElement(
      screen.getByTestId("terminal-alpha"),
    );
    fireEvent.click(screen.getByRole("button", { name: "sftpCloseFiles" }));
    expect(sftpPanel).toHaveAttribute("data-visible", "false");
    expect(sftpDrawer).toHaveClass("hidden");
    fireEvent.click(screen.getByRole("button", { name: "sftpOpenFiles" }));
    expect(sftpPanel).toHaveAttribute("data-visible", "true");
    expect(sftpDrawer).not.toHaveClass("hidden");
  });

  it("resizes and persists the information panel and bottom dock with accessible separators", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
      });
    });

    const information = screen.getByRole("complementary", {
      name: "sshSessionInformation",
    });
    const informationHandle = screen.getByRole("separator", {
      name: "sshResizeInformationPanel",
    });
    fireEvent.keyDown(informationHandle, { key: "ArrowRight" });
    expect(information).toHaveStyle({ width: "248px" });

    const dockHandle = screen.getByRole("separator", { name: "sshResizeDock" });
    const dock = dockHandle.closest('[data-region="ssh-sftp-drawer"]');
    fireEvent.keyDown(dockHandle, { key: "ArrowUp" });
    expect(dock).toHaveStyle({ height: "276px" });

    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem(SSH_WORKSPACE_LAYOUT_STORAGE_KEY) ?? "{}",
        ),
      ).toEqual({ infoPanelWidth: 248, dockHeight: 276 }),
    );
  });

  it("sends commands from the PixShell-style command bar and keeps session history", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
      });
    });

    const input = screen.getByRole("textbox", { name: "sshCommandInputLabel" });
    fireEvent.change(input, { target: { value: "uptime" } });
    fireEvent.click(screen.getByRole("button", { name: "sshCommandSend" }));

    await waitFor(() => expect(credentialApi.input).toHaveBeenCalledOnce());
    expect(credentialApi.input.mock.calls[0][0]).toBe(session?.sessionId);
    expect(Array.from(credentialApi.input.mock.calls[0][1])).toEqual(
      Array.from(new TextEncoder().encode("uptime\r")),
    );
    expect(input).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "sshCommandHistory" }),
    ).toBeEnabled();
  });

  it("completes remote paths from the command bar with Tab", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");
    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
      });
    });

    const input = screen.getByRole("textbox", { name: "sshCommandInputLabel" });
    fireEvent.change(input, { target: { value: "cd lo" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => expect(input).toHaveValue("cd logs/"));
    expect(workspaceApi.sshSftpList).toHaveBeenCalledWith(
      session?.sessionId,
      "/home/root",
    );
  });

  it("shows the active SSH connection information beside the terminal", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
        routeLabel: "cloud",
      });
    });

    const information = screen.getByRole("complementary", {
      name: "sshSessionInformation",
    });
    const details = within(information);
    expect(details.getByText("Alpha")).toBeInTheDocument();
    expect(details.getByText("root@alpha.example.com:22")).toBeInTheDocument();
    expect(details.getByText("sshCloudRoute")).toBeInTheDocument();
    fireEvent.click(
      details.getByRole("button", { name: "sshConnectionDetails" }),
    );
    expect(details.getByText("alpha.example.com")).toBeInTheDocument();
    expect(details.getByText("22")).toBeInTheDocument();
    expect(details.getByText("root")).toBeInTheDocument();
    expect(details.getByText("sshPassword")).toBeInTheDocument();
    expect(details.getByText("sshRouteAuto")).toBeInTheDocument();
    expect(details.getByText("sshStateConnected")).toBeInTheDocument();
  });

  it("edits a saved connection from the right-click menu without opening a session", () => {
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
      {
        clientX: 120,
        clientY: 80,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "sshEdit" }));

    expect(
      screen.getByRole("heading", { name: "sshEditConnection" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("sshName")).toHaveValue("Alpha");
    expect(screen.getByLabelText("sshHost")).toHaveValue("alpha.example.com");
    expect(screen.getByLabelText("port")).toHaveValue(22);
    expect(screen.getByLabelText("sshUsername")).toHaveValue("root");

    fireEvent.change(screen.getByLabelText("sshName"), {
      target: { value: "Alpha Updated" },
    });
    fireEvent.change(screen.getByLabelText("sshHost"), {
      target: { value: "new-alpha.example.com" },
    });
    fireEvent.change(screen.getByLabelText("port"), {
      target: { value: "2222" },
    });
    fireEvent.change(screen.getByLabelText("sshUsername"), {
      target: { value: "deploy" },
    });
    fireEvent.change(screen.getByLabelText("sshRoutePolicy"), {
      target: { value: "direct" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sshSave" }));

    expect(screen.getByText("Alpha Updated")).toBeInTheDocument();
    expect(
      screen.getByText("deploy@new-alpha.example.com:2222"),
    ).toBeInTheDocument();
    expect(terminalProps.get("alpha")).toBeUndefined();

    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    expect(saved[0]).toMatchObject({
      id: "alpha",
      name: "Alpha Updated",
      host: "new-alpha.example.com",
      port: 2222,
      username: "deploy",
      routePolicy: "direct",
      credentialReference: "ssh-alpha",
    });
  });

  it("selects a group while editing an SSH connection", () => {
    localStorage.setItem(
      SSH_GROUPS_STORAGE_KEY,
      JSON.stringify([
        { id: SSH_DEFAULT_GROUP_ID, name: "", isExpanded: true },
        { id: "production", name: "Production", isExpanded: true },
      ]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshEdit" }));
    fireEvent.change(screen.getByLabelText("sshGroup"), {
      target: { value: "production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sshSave" }));

    expect(
      screen.getByRole("button", { name: "sshToggleGroup Production" }),
    ).toHaveTextContent("1");
    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    );
    expect(
      saved.find((connection: { id: string }) => connection.id === "alpha"),
    ).toEqual(expect.objectContaining({ groupId: "production" }));
  });

  it("uses an in-app authentication control and stores pasted private keys outside connection metadata", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "sshNewConnection" })[0],
    );

    expect(
      screen.getByRole("radiogroup", { name: "sshAuthentication" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "sshAuthentication" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "sshPrivateKey" }));
    fireEvent.change(screen.getByLabelText("sshHost"), {
      target: { value: "key.example.com" },
    });
    fireEvent.change(screen.getByLabelText("sshPrivateKeyLabel"), {
      target: { value: "Deployment key" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "sshPrivateKeyContent" }),
      {
        target: {
          value:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----",
        },
      },
    );
    fireEvent.change(screen.getByLabelText("sshPublicKey"), {
      target: { value: "ssh-ed25519 AAAATEST deployment@example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sshSaveAndConnect" }));

    await waitFor(() =>
      expect(credentialApi.storePrivateKeyCredential).toHaveBeenCalledOnce(),
    );
    const [
      credentialReference,
      storedLabel,
      storedPrivateKey,
      storedPublicKey,
      storedPassphrase,
    ] = credentialApi.storePrivateKeyCredential.mock.calls[0];
    expect(credentialReference).toMatch(/^ssh-/);
    expect(storedLabel).toBe("Deployment key");
    expect(storedPrivateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(storedPublicKey).toBe("ssh-ed25519 AAAATEST deployment@example");
    expect(storedPassphrase).toBeUndefined();

    const savedRaw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "";
    expect(savedRaw).not.toContain("private-material");
    expect(JSON.parse(savedRaw).at(-1)).toMatchObject({
      authMethod: "private_key",
      privateKeyLabel: "Deployment key",
      publicKey: "ssh-ed25519 AAAATEST deployment@example",
      credentialReference,
    });
  });

  it("versions a replacement credential without changing an active session snapshot", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshShowConnections" }));

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshEdit" }));
    fireEvent.change(screen.getByPlaceholderText("sshKeepSavedCredential"), {
      target: { value: "replacement-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sshSave" }));

    await waitFor(() =>
      expect(credentialApi.storeCredential).toHaveBeenCalledOnce(),
    );
    const [newReference] = credentialApi.storeCredential.mock.calls[0];
    expect(newReference).not.toBe("ssh-alpha");
    expect(terminalProps.get("alpha")?.connection.credentialReference).toBe(
      "ssh-alpha",
    );
    expect(credentialApi.deleteCredential).not.toHaveBeenCalled();

    const savedRaw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "";
    expect(savedRaw).not.toContain("replacement-secret");
    expect(JSON.parse(savedRaw)[0].credentialReference).toBe(newReference);

    fireEvent.click(screen.getByRole("button", { name: "sshClose Alpha" }));
    await waitFor(() =>
      expect(credentialApi.deleteCredential).toHaveBeenCalledWith("ssh-alpha"),
    );
  });

  it("persists detected OS metadata without replacing the active terminal connection", async () => {
    credentialApi.monitorSnapshot.mockResolvedValue({
      supported: true,
      platform: "linux",
      uptimeSeconds: 1,
      loadAverage: [0, 0, 0],
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      processes: [],
      networkReceiveBytesPerSecond: 0,
      networkTransmitBytesPerSecond: 0,
      latencyMs: 1,
      disks: [],
    });
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");
    const originalConnection = session?.connection;

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "connected",
      });
    });

    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]")[0]
          .detectedOs,
      ).toBe("linux"),
    );
    expect(terminalProps.get("alpha")?.connection).toBe(originalConnection);
    expect(terminalProps.get("alpha")?.connection).not.toHaveProperty(
      "detectedOs",
    );
  });

  it("keeps an active session credential when the saved connection changes authentication", async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshShowConnections" }));

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshEdit" }));
    fireEvent.click(screen.getByRole("radio", { name: "sshPrivateKey" }));
    fireEvent.change(screen.getByLabelText("sshPrivateKeyLabel"), {
      target: { value: "Alpha deployment key" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "sshPrivateKeyContent" }),
      {
        target: {
          value:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nreplacement-key\n-----END OPENSSH PRIVATE KEY-----",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "sshSave" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "sshEditConnection" }),
      ).not.toBeInTheDocument(),
    );
    expect(terminalProps.get("alpha")?.connection.credentialReference).toBe(
      "ssh-alpha",
    );
    expect(credentialApi.deleteCredential).not.toHaveBeenCalled();
    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    )[0];
    expect(saved.credentialReference).not.toBe("ssh-alpha");
    expect(saved.privateKeyLabel).toBe("Alpha deployment key");
  });

  it("keeps a legacy private-key path when adding its passphrase", async () => {
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "legacy-key",
          name: "Legacy key",
          host: "legacy.example.com",
          port: 22,
          username: "root",
          authMethod: "private_key",
          privateKeyPath: "~/.ssh/id_ed25519",
          routePolicy: "direct",
        },
      ]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "sshConnect Legacy key" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sshEdit" }));
    fireEvent.change(screen.getByLabelText("sshPassphraseOptional"), {
      target: { value: "legacy-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sshSave" }));

    await waitFor(() =>
      expect(credentialApi.storeCredential).toHaveBeenCalledOnce(),
    );
    expect(credentialApi.storePrivateKeyCredential).not.toHaveBeenCalled();
    const saved = JSON.parse(
      localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? "[]",
    )[0];
    expect(saved.privateKeyPath).toBe("~/.ssh/id_ed25519");
    expect(saved.credentialReference).toMatch(/^ssh-legacy-key-/);
  });

  it("shows direct fallback distinctly and retries the same session lease", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const first = terminalProps.get("alpha");
    expect(first).toBeDefined();

    act(() => {
      first?.onEvent({
        kind: "state",
        sessionId: first.sessionId,
        state: "error",
        routeLabel: "cloud_fallback",
        message: "ssh_transport_connect_failed:connection reset",
      });
    });

    expect(screen.getByText("sshCloudFallback")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sshReconnect" }));
    const retried = terminalProps.get("alpha");
    const information = screen.getByRole("complementary", {
      name: "sshSessionInformation",
    });
    expect(retried?.sessionId).toBe(first?.sessionId);
    expect(retried?.retryToken).toBe(1);
    expect(
      within(information).getByText("sshRouteResolving"),
    ).toBeInTheDocument();
    expect(
      within(information).queryByText("sshCloudFallback"),
    ).not.toBeInTheDocument();
  });

  it("renders session failures as an opaque in-flow alert with a specific message", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "error",
        message: "ssh_session_already_exists",
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("sshErrorSessionBusy");
    expect(alert).toHaveClass("bg-popover");
    expect(alert).not.toHaveClass("absolute", "bg-destructive/10");
  });

  it("does not present a normal remote exit status as a session error", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "exited",
        message: "0",
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("sshErrorGeneric")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sshReconnect" }),
    ).toBeInTheDocument();
  });

  it("preserves the first transport failure when a lifecycle error arrives later", () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sshConnect Alpha" }),
    );
    const session = terminalProps.get("alpha");

    act(() => {
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "error",
        routeLabel: "cloud_fallback",
        message: "ssh_transport_connect_failed",
      });
      session?.onEvent({
        kind: "state",
        sessionId: session.sessionId,
        state: "error",
        message: "ssh_session_closed",
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("sshErrorTransport");
    expect(screen.getByText("sshCloudFallback")).toBeInTheDocument();
  });
});
