import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { BridgeClient } from "./bridge";
import { BridgeWebviewProvider } from "./webview";
import { LogTreeProvider } from "./logs";

let client: BridgeClient;
let logProvider: LogTreeProvider;
let statusBar: vscode.StatusBarItem;
let serverTerminal: vscode.Terminal | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("bad-bridge");
  const port = cfg.get<number>("port", 3001);
  const autoConnect = cfg.get<boolean>("autoConnect", true);
  const logInterval = cfg.get<number>("logPollInterval", 3);

  client = new BridgeClient(port);
  const output = vscode.window.createOutputChannel("BAD Bridge");

  // Auto-install Studio plugin on first activation / update
  autoInstallStudioPlugin(ctx, output);

  // Status bar
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "bad-bridge.connect";
  statusBar.text = "$(plug) BAD Bridge";
  statusBar.tooltip = "Click to check connection";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  // Webview sidebar
  const webviewProvider = new BridgeWebviewProvider(client, output);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BridgeWebviewProvider.viewType, webviewProvider)
  );

  // Logs tree
  logProvider = new LogTreeProvider(client);
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("bad-bridge.logs", logProvider)
  );
  ctx.subscriptions.push(logProvider as any);

  // ── Commands ──
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("bad-bridge.connect", async () => {
    const ok = await client.ping();
    if (ok) {
      setStatus(true);
      logProvider.startPolling(logInterval);
      vscode.window.showInformationMessage("BAD Bridge: Connected!");
    } else {
      setStatus(false);
      vscode.window.showWarningMessage(
        "BAD Bridge: Server not reachable. Start the server first.",
        "Start Server"
      ).then((choice) => {
        if (choice === "Start Server") {
          vscode.commands.executeCommand("bad-bridge.startServer");
        }
      });
    }
  });

  reg("bad-bridge.disconnect", () => {
    logProvider.stopPolling();
    setStatus(false);
    vscode.window.showInformationMessage("BAD Bridge: Disconnected.");
  });

  reg("bad-bridge.installPlugin", () => {
    installStudioPlugin(ctx.extensionPath, output, true);
  });

  reg("bad-bridge.startServer", () => {
    const extDir = ctx.extensionPath;
    serverTerminal?.dispose();
    serverTerminal = vscode.window.createTerminal({ name: "BAD Bridge Server" });
    // Use the server bundled with the extension — works in any workspace
    const nodeScript = path.join(extDir, "bridge", "server.js");
    serverTerminal.sendText(`node "${nodeScript}" --port ${port}`);
    serverTerminal.show(true);
    // Auto-connect after a short delay
    setTimeout(async () => {
      const ok = await client.ping();
      if (ok) {
        setStatus(true);
        logProvider.startPolling(logInterval);
      }
    }, 2000);
  });

  reg("bad-bridge.run", async () => {
    const code = await vscode.window.showInputBox({
      prompt: "Luau code to execute in Studio",
      placeHolder: 'return game.Workspace:GetChildren()',
      ignoreFocusOut: true,
    });
    if (!code) { return; }
    await executeAndShow("Run", () => client.run(code), output);
  });

  reg("bad-bridge.runSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const sel = editor.document.getText(editor.selection);
    if (!sel.trim()) {
      vscode.window.showWarningMessage("No text selected.");
      return;
    }
    await executeAndShow("Run Selection", () => client.run(sel), output);
  });

  reg("bad-bridge.tree", async () => {
    const path = await vscode.window.showInputBox({
      prompt: "Instance path",
      value: "game.Workspace",
    });
    if (!path) { return; }
    const depthStr = await vscode.window.showInputBox({
      prompt: "Tree depth",
      value: "3",
    });
    const depth = parseInt(depthStr || "3") || 3;
    await executeAndShow("Tree", () => client.getTree(path, depth, false), output);
  });

  reg("bad-bridge.find", async () => {
    const rootPath = await vscode.window.showInputBox({
      prompt: "Search root",
      value: "game",
    });
    if (!rootPath) { return; }
    const name = await vscode.window.showInputBox({ prompt: "Name filter (optional)" });
    const cls = await vscode.window.showInputBox({ prompt: "Class filter (optional)" });
    await executeAndShow("Find", () =>
      client.find(rootPath, {
        name: name || undefined,
        class: cls || undefined,
        limit: 50,
      }), output
    );
  });

  reg("bad-bridge.undo", async () => {
    await executeAndShow("Undo", () => client.undo(), output);
  });

  reg("bad-bridge.redo", async () => {
    await executeAndShow("Redo", () => client.redo(), output);
  });

  reg("bad-bridge.refreshLogs", () => logProvider.refresh());

  reg("bad-bridge.clearLogs", () => logProvider.clear());

  reg("bad-bridge.clearQueue", async () => {
    await client.clearQueue();
    vscode.window.showInformationMessage("BAD Bridge: Command queue cleared.");
  });

  // ── MCP-derived commands ──

  reg("bad-bridge.insertModel", async () => {
    const query = await vscode.window.showInputBox({
      prompt: "Search query for marketplace model",
      placeHolder: "e.g. tree, car, sword",
      ignoreFocusOut: true,
    });
    if (!query) { return; }
    await executeAndShow("Insert Model", () => client.insertModel(query), output);
  });

  reg("bad-bridge.startPlay", async () => {
    await executeAndShow("Start Play", () => client.startStopPlay("start_play"), output);
  });

  reg("bad-bridge.runServer", async () => {
    await executeAndShow("Run Server", () => client.startStopPlay("run_server"), output);
  });

  reg("bad-bridge.stopPlay", async () => {
    await executeAndShow("Stop Play", () => client.startStopPlay("stop"), output);
  });

  reg("bad-bridge.runScriptInPlayMode", async () => {
    const code = await vscode.window.showInputBox({
      prompt: "Luau code to run in play mode",
      placeHolder: 'print("Hello from play mode!")',
      ignoreFocusOut: true,
    });
    if (!code) { return; }
    const modeChoice = await vscode.window.showQuickPick(
      ["start_play", "run_server"],
      { placeHolder: "Select play mode" }
    );
    const mode = modeChoice || "start_play";
    await executeAndShow("Run Script in Play Mode", () => client.runScriptInPlayMode(code, mode), output);
  });

  reg("bad-bridge.getStudioMode", async () => {
    await executeAndShow("Studio Mode", () => client.getStudioMode(), output);
  });

  reg("bad-bridge.getConsoleOutput", async () => {
    await executeAndShow("Console Output", () => client.getConsoleOutput(false), output);
  });

  // ── Instance manipulation commands ──

  reg("bad-bridge.createInstance", async () => {
    const className = await vscode.window.showInputBox({
      prompt: "Class name (e.g. Part, Model, Script)",
      placeHolder: "Part",
    });
    if (!className) { return; }
    const parent = await vscode.window.showInputBox({
      prompt: "Parent path",
      value: "game.Workspace",
    });
    const name = await vscode.window.showInputBox({
      prompt: "Instance name (optional)",
    });
    await executeAndShow("Create", () => client.createInstance(className, parent || "game.Workspace", name || undefined), output);
  });

  reg("bad-bridge.deleteInstance", async () => {
    const path = await vscode.window.showInputBox({
      prompt: "Path to instance to delete",
      placeHolder: "game.Workspace.Part",
    });
    if (!path) { return; }
    await executeAndShow("Delete", () => client.deleteInstance(path), output);
  });

  reg("bad-bridge.cloneInstance", async () => {
    const path = await vscode.window.showInputBox({
      prompt: "Path to instance to clone",
      placeHolder: "game.Workspace.Part",
    });
    if (!path) { return; }
    const parent = await vscode.window.showInputBox({
      prompt: "Clone destination parent (optional, default: same parent)",
    });
    await executeAndShow("Clone", () => client.cloneInstance(path, parent || undefined), output);
  });

  reg("bad-bridge.setProperty", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    const prop = await vscode.window.showInputBox({ prompt: "Property name", placeHolder: "Name" });
    if (!prop) { return; }
    const valStr = await vscode.window.showInputBox({ prompt: "Value (JSON or string)", placeHolder: '"MyPart"' });
    if (valStr === undefined) { return; }
    let value: unknown;
    try { value = JSON.parse(valStr); } catch { value = valStr; }
    await executeAndShow("Set Property", () => client.setProperty(path, prop, value), output);
  });

  reg("bad-bridge.moveInstance", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance to move", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    const parent = await vscode.window.showInputBox({ prompt: "New parent path", placeHolder: "game.ServerStorage" });
    if (!parent) { return; }
    await executeAndShow("Move", () => client.moveInstance(path, parent), output);
  });

  reg("bad-bridge.renameInstance", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    const name = await vscode.window.showInputBox({ prompt: "New name" });
    if (!name) { return; }
    await executeAndShow("Rename", () => client.renameInstance(path, name), output);
  });

  reg("bad-bridge.getSelection", async () => {
    await executeAndShow("Selection", () => client.getSelection(), output);
  });

  reg("bad-bridge.getScriptSource", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Script path", placeHolder: "game.ServerScriptService.Script" });
    if (!path) { return; }
    const result = await client.getScriptSource(path);
    if (result?.success && result.result) {
      const doc = await vscode.workspace.openTextDocument({ content: String(result.result), language: "luau" });
      vscode.window.showTextDocument(doc);
      output.appendLine(`\n\u2501\u2501\u2501 Script Source: ${path} \u2501\u2501\u2501`);
      output.appendLine(String(result.result));
    } else {
      vscode.window.showWarningMessage(`BAD Bridge: ${result?.error || "No response"}`);
    }
  });

  reg("bad-bridge.setScriptSource", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a file with the script source first.");
      return;
    }
    const path = await vscode.window.showInputBox({ prompt: "Target script path in Studio", placeHolder: "game.ServerScriptService.Script" });
    if (!path) { return; }
    const source = editor.document.getText();
    await executeAndShow("Set Script Source", () => client.setScriptSource(path, source), output);
  });

  // ── Attribute commands ──

  reg("bad-bridge.getAttributes", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    await executeAndShow("Get Attributes", () => client.getAttributes(path), output);
  });

  reg("bad-bridge.setAttribute", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    const attr = await vscode.window.showInputBox({ prompt: "Attribute name" });
    if (!attr) { return; }
    const valStr = await vscode.window.showInputBox({ prompt: "Value (JSON or string)", placeHolder: '42 or "hello" or true' });
    if (valStr === undefined) { return; }
    let value: unknown;
    try { value = JSON.parse(valStr); } catch { value = valStr; }
    await executeAndShow("Set Attribute", () => client.setAttribute(path, attr, value), output);
  });

  reg("bad-bridge.deleteAttribute", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", placeHolder: "game.Workspace.Part" });
    if (!path) { return; }
    const attr = await vscode.window.showInputBox({ prompt: "Attribute name to delete" });
    if (!attr) { return; }
    await executeAndShow("Delete Attribute", () => client.deleteAttribute(path, attr), output);
  });

  reg("bad-bridge.getChildren", async () => {
    const path = await vscode.window.showInputBox({ prompt: "Instance path", value: "game.Workspace" });
    if (!path) { return; }
    await executeAndShow("Get Children", () => client.getChildren(path), output);
  });

  // Config change listener
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bad-bridge.port")) {
        const newPort = vscode.workspace.getConfiguration("bad-bridge").get<number>("port", 3001);
        client.setPort(newPort);
      }
      if (e.affectsConfiguration("bad-bridge.logPollInterval")) {
        const interval = vscode.workspace.getConfiguration("bad-bridge").get<number>("logPollInterval", 3);
        logProvider.startPolling(interval);
      }
    })
  );

  // Auto-connect on startup
  if (autoConnect) {
    setTimeout(async () => {
      const ok = await client.ping();
      if (ok) {
        setStatus(true);
        logProvider.startPolling(logInterval);
      } else {
        setStatus(false);
      }
    }, 2000);
  }
}

export function deactivate(): void {
  logProvider?.stopPolling();
  serverTerminal?.dispose();
}

function setStatus(connected: boolean): void {
  if (connected) {
    statusBar.text = "$(plug) BAD Bridge ●";
    statusBar.tooltip = "Connected — click to refresh";
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = "$(plug) BAD Bridge ○";
    statusBar.tooltip = "Disconnected — click to connect";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

async function executeAndShow(
  label: string,
  fn: () => Promise<unknown>,
  output: vscode.OutputChannel
): Promise<void> {
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `BAD Bridge: ${label}…` },
    async () => {
      const result = await fn();
      if (!result) {
        vscode.window.showWarningMessage("BAD Bridge: Timeout — no response from Studio.");
        return;
      }
      const pretty = JSON.stringify(result, null, 2) ?? "(null)";
      output.appendLine(`\n━━━ ${label} ━━━`);
      output.appendLine(pretty);
      output.show(true);
    }
  );
}

// ── Studio Plugin Auto-Installer ──

function getStudioPluginsDir(): string | null {
  const platform = os.platform();
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) { return null; }
    return path.join(local, "Roblox", "Plugins");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Roblox", "Plugins");
  }
  // Linux — Roblox doesn't officially support it, but try common path
  return path.join(os.homedir(), ".local", "share", "Roblox", "Plugins");
}

function installStudioPlugin(
  extensionPath: string,
  output: vscode.OutputChannel,
  showSuccess: boolean
): boolean {
  const src = path.join(extensionPath, "plugin", "BridgePlugin.server.luau");
  const pluginsDir = getStudioPluginsDir();

  if (!pluginsDir) {
    vscode.window.showErrorMessage("BAD Bridge: Could not determine Roblox Studio plugins folder.");
    return false;
  }

  try {
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    const dest = path.join(pluginsDir, "BAD_BridgePlugin.server.luau");
    fs.copyFileSync(src, dest);

    output.appendLine(`[BAD Bridge] Studio plugin installed to: ${dest}`);
    if (showSuccess) {
      vscode.window.showInformationMessage(
        `BAD Bridge: Studio plugin installed!\n${dest}`,
        "Open Plugins Folder"
      ).then((choice) => {
        if (choice === "Open Plugins Folder") {
          vscode.env.openExternal(vscode.Uri.file(pluginsDir));
        }
      });
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`BAD Bridge: Failed to install Studio plugin — ${msg}`);
    output.appendLine(`[BAD Bridge] Plugin install error: ${msg}`);
    return false;
  }
}

function autoInstallStudioPlugin(
  ctx: vscode.ExtensionContext,
  output: vscode.OutputChannel
): void {
  const currentVersion = ctx.extension.packageJSON.version as string;
  const installedVersion = ctx.globalState.get<string>("pluginInstalledVersion");

  // Only auto-install if version changed or never installed
  if (installedVersion === currentVersion) { return; }

  const ok = installStudioPlugin(ctx.extensionPath, output, false);
  if (ok) {
    ctx.globalState.update("pluginInstalledVersion", currentVersion);
    vscode.window.showInformationMessage(
      `BAD Bridge: Studio plugin v${currentVersion} installed automatically. Restart Studio to use it.`,
      "Open Plugins Folder"
    ).then((choice) => {
      if (choice === "Open Plugins Folder") {
        const dir = getStudioPluginsDir();
        if (dir) { vscode.env.openExternal(vscode.Uri.file(dir)); }
      }
    });
  }
}
