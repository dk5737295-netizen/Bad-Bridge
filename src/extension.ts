import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as cp from "child_process";
import { BridgeClient } from "./bridge";
import { BridgeWebviewProvider } from "./webview";
import { LogTreeProvider } from "./logs";

let client: BridgeClient;
let logProvider: LogTreeProvider;
let statusBar: vscode.StatusBarItem;
let serverTerminal: vscode.Terminal | undefined;
let mcpTerminal: vscode.Terminal | undefined;
let outputChannel: vscode.OutputChannel;
let extensionPath: string; // absolute path to the extension install directory
let _depsWarned = false; // only warn about missing node_modules once

export function activate(ctx: vscode.ExtensionContext): void {
  extensionPath = ctx.extensionPath;
  const cfg = vscode.workspace.getConfiguration("bad-bridge");
  const port = cfg.get<number>("port", 3001);
  const autoConnect = cfg.get<boolean>("autoConnect", true);
  const logInterval = cfg.get<number>("logPollInterval", 3);
  const autoInstallPlugin = cfg.get<boolean>("autoInstallPlugin", true);
  const autoStartServer = cfg.get<boolean>("autoStartServer", true);

  client = new BridgeClient(port);
  const output = vscode.window.createOutputChannel("BAD Bridge");
  outputChannel = output;

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

  // ── Auto-install Studio plugin ──
  if (autoInstallPlugin) {
    autoInstallStudioPlugin(ctx, output);
  }

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

  reg("bad-bridge.startServer", () => {
    startBridgeServer(port);
  });

  reg("bad-bridge.startMCP", () => {
    startMCPServer(cfg);
  });

  reg("bad-bridge.startAll", async () => {
    startBridgeServer(port);
    // Give bridge server a moment to start before launching MCP
    await new Promise(r => setTimeout(r, 1000));
    startMCPServer(cfg);
    vscode.window.showInformationMessage("BAD Bridge: All servers starting.");
  });

  reg("bad-bridge.installDeps", () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { vscode.window.showWarningMessage("No workspace folder open."); return; }
    if (!checkNodeJs()) { showNodeJsMissing(); return; }
    const t = vscode.window.createTerminal({ name: "BAD Bridge: Install Dependencies", cwd: ws });
    t.show(true);
    t.sendText("npm install && cd bridge && npm install");
    t.sendText("echo ''");
    t.sendText("echo '✓ All dependencies installed. You can close this terminal.'");
    vscode.window.showInformationMessage("BAD Bridge: Installing all dependencies...");
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

  reg("bad-bridge.filterLogs", async () => {
    const filter = await vscode.window.showQuickPick(
      [
        { label: "All", description: "Show all log entries", value: "all" },
        { label: "Errors Only", description: "Show only errors", value: "errors" },
        { label: "Warnings + Errors", description: "Show warnings and errors", value: "warnings" },
        { label: "Output Only", description: "Show only output (no warnings/errors)", value: "output" },
      ],
      { placeHolder: `Current filter: ${logProvider.filter}` }
    );
    if (filter) {
      logProvider.setFilter((filter as any).value);
      vscode.window.showInformationMessage(`Log filter: ${filter.label}`);
    }
  });

  reg("bad-bridge.searchLogs", async () => {
    const term = await vscode.window.showInputBox({
      prompt: "Search logs for text (leave empty to clear)",
      placeHolder: "Search term...",
    });
    if (term !== undefined) {
      logProvider.setSearchTerm(term);
    }
  });

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

  // ── Setup & diagnostic commands ──

  reg("bad-bridge.installPlugin", async () => {
    if (os.platform() !== "win32") {
      vscode.window.showWarningMessage("Auto-install only works on Windows. Copy plugin/BridgePlugin.server.luau to your Studio plugins folder manually.");
      return;
    }
    // Find plugin source — extension bundle first, then workspace
    let pluginSrc: string | undefined;
    const extPlugin = path.join(ctx.extensionPath, "plugin", "BridgePlugin.server.luau");
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsPlugin = ws ? path.join(ws, "plugin", "BridgePlugin.server.luau") : undefined;

    if (fs.existsSync(extPlugin)) {
      pluginSrc = extPlugin;
    } else if (wsPlugin && fs.existsSync(wsPlugin)) {
      pluginSrc = wsPlugin;
    }
    if (!pluginSrc) {
      vscode.window.showErrorMessage("BAD Bridge: Plugin source file not found.");
      return;
    }

    const pluginDir = path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins");
    const dest = path.join(pluginDir, "BAD_BridgePlugin.lua");
    try {
      if (!fs.existsSync(pluginDir)) {
        fs.mkdirSync(pluginDir, { recursive: true });
      }
      fs.copyFileSync(pluginSrc, dest);
      vscode.window.showInformationMessage(`BAD Bridge: Plugin installed to ${dest}. Restart Studio if it was open.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`BAD Bridge: Failed to install plugin — ${e.message}`);
    }
  });

  reg("bad-bridge.exportPlugin", async () => {
    const dest = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Export Plugin Here",
      title: "Choose a folder to export the plugin to",
    });
    if (!dest || dest.length === 0) { return; }
    const folder = dest[0].fsPath;
    const pluginSrc = path.join(ctx.extensionPath, "plugin", "BridgePlugin.server.luau");
    const pluginDest = path.join(folder, "BAD_BridgePlugin.server.luau");
    try {
      fs.copyFileSync(pluginSrc, pluginDest);
      const installScript = [
        `# BAD Bridge — Install Studio Plugin`,
        `# Run this script on the target machine:  .\\install-plugin.ps1`,
        ``,
        `$pluginSrc = Join-Path $PSScriptRoot "BAD_BridgePlugin.server.luau"`,
        `$pluginDir = Join-Path $env:LOCALAPPDATA "Roblox\\Plugins"`,
        `if (-not (Test-Path $pluginDir)) { New-Item -ItemType Directory -Path $pluginDir | Out-Null }`,
        `Copy-Item -Path $pluginSrc -Destination (Join-Path $pluginDir "BAD_BridgePlugin.server.luau") -Force`,
        `Write-Host "Plugin installed! Restart Roblox Studio to use it." -ForegroundColor Green`,
      ].join("\n");
      fs.writeFileSync(path.join(folder, "install-plugin.ps1"), installScript, "utf-8");
      output.appendLine(`[BAD Bridge] Plugin exported to: ${folder}`);
      vscode.window.showInformationMessage(
        `BAD Bridge: Plugin exported to ${folder}. Share the folder — the recipient runs install-plugin.ps1.`,
        "Open Folder"
      ).then((choice) => {
        if (choice === "Open Folder") {
          vscode.env.openExternal(vscode.Uri.file(folder));
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`BAD Bridge: Export failed — ${msg}`);
    }
  });

  reg("bad-bridge.setupMCP", async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { vscode.window.showWarningMessage("No workspace folder open."); return; }
    const vscodeDir = path.join(ws, ".vscode");
    const mcpPath = path.join(vscodeDir, "mcp.json");
    try {
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }
      let mcpConfig: Record<string, any> = {};
      if (fs.existsSync(mcpPath)) {
        try {
          const raw = fs.readFileSync(mcpPath, "utf8");
          const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
          mcpConfig = JSON.parse(cleaned);
        } catch { mcpConfig = {}; }
      }
      const servers = (mcpConfig.servers || {}) as Record<string, any>;
      // Use absolute path to extension's bundled MCP script so it works in any workspace
      const mcpScriptPath = findBridgeFile(path.join("bridge", "mcp-server.mjs"))
        || findBridgeFile(path.join("bridge", "mcp-bridge.cjs"))
        || path.join(extensionPath, "bridge", "mcp-bridge.cjs");
      servers["bad-bridge"] = {
        type: "stdio",
        command: "node",
        args: [mcpScriptPath],
        env: {
          BRIDGE_URL: "http://127.0.0.1:" + cfg.get<number>("port", 3001),
          ROJO_PROJECT_ROOT: "${workspaceFolder}",
          ROJO_PROJECT_FILE: cfg.get<string>("rojoProjectFile", "") || ""
        }
      };
      mcpConfig.servers = servers;
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      vscode.window.showInformationMessage("BAD Bridge: MCP configured in .vscode/mcp.json. Reload the window to activate.");
    } catch (e: any) {
      vscode.window.showErrorMessage(`BAD Bridge: Failed to configure MCP — ${e.message}`);
    }
  });

  reg("bad-bridge.diagnose", async () => {
    const results: string[] = [];
    results.push("═══ BAD Bridge Diagnostic ═══\n");

    // 1. Check bridge server
    const ping = await client.ping();
    results.push(ping
      ? "✓ Bridge server is running on port " + cfg.get<number>("port", 3001)
      : "✗ Bridge server is NOT running — it should auto-start, or use Ctrl+Shift+P → 'BAD Bridge: Start Server'");

    // 2. Check Studio plugin connected
    if (ping) {
      const status = await client.getServerStatus();
      if (status) {
        const connected = (status as any).studioConnected || (status as any).pluginConnected || false;
        results.push(connected
          ? "✓ Studio plugin is connected"
          : "✗ Studio plugin is NOT connected — open Studio with the plugin installed");
        results.push(`  Server version: ${(status as any).version || "unknown"}`);
        results.push(`  Queue depth: ${(status as any).pending ?? (status as any).queueDepth ?? "unknown"}`);
      }
    }

    // 3. Check plugin installed
    if (os.platform() === "win32") {
      const pluginPath = path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins", "BAD_BridgePlugin.lua");
      if (fs.existsSync(pluginPath)) {
        const stat = fs.statSync(pluginPath);
        const age = Date.now() - stat.mtimeMs;
        const ageStr = age < 60000 ? "just now" : age < 3600000 ? `${Math.floor(age / 60000)}m ago` : `${Math.floor(age / 3600000)}h ago`;
        results.push(`✓ Studio plugin installed at ${pluginPath} (updated ${ageStr})`);
      } else {
        results.push("✗ Studio plugin NOT installed — auto-install may have failed, try Ctrl+Shift+P → 'BAD Bridge: Install Studio Plugin'");
      }
    }

    // 4. Check MCP config
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      const mcpJsonPath = path.join(ws, ".vscode", "mcp.json");
      const settingsPath = path.join(ws, ".vscode", "settings.json");
      let mcpOk = false;
      // Check mcp.json first (preferred), then settings.json
      for (const checkPath of [mcpJsonPath, settingsPath]) {
        if (fs.existsSync(checkPath)) {
          try {
            const raw = fs.readFileSync(checkPath, "utf8");
            const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
            const s = JSON.parse(cleaned);
            const hasBridge = checkPath === mcpJsonPath
              ? !!(s?.servers?.["bad-bridge"])
              : !!(s?.mcp?.servers?.["bad-bridge"]);
            if (hasBridge) { mcpOk = true; break; }
          } catch { /* ignore */ }
        }
      }
      results.push(mcpOk
        ? "✓ MCP configured" + (fs.existsSync(mcpJsonPath) ? " in .vscode/mcp.json" : " in .vscode/settings.json")
        : "✗ MCP NOT configured — use Ctrl+Shift+P → 'BAD Bridge: Setup MCP (AI Tools)'");

      // Check bridge server.js exists (extension path first, then workspace)
      const serverScript = findBridgeFile(path.join("bridge", "server.js"));
      results.push(serverScript
        ? `✓ Bridge server script found (${serverScript})`
        : "✗ bridge/server.js not found — try reinstalling the extension");

      // Check MCP script exists (extension path first, then workspace)
      const mcpScript = findBridgeFile(path.join("bridge", "mcp-bridge.cjs"))
        || findBridgeFile(path.join("bridge", "mcp-server.mjs"));
      results.push(mcpScript
        ? `✓ MCP server script found (${mcpScript})`
        : "✗ MCP server script not found — try reinstalling the extension");

      // 5. Rojo compatibility check
      const rojoProjectFiles = ["default.project.json", "*.project.json"];
      let rojoFound = false;
      for (const pattern of rojoProjectFiles) {
        const files = fs.readdirSync(ws).filter(f => {
          if (pattern.startsWith("*")) { return f.endsWith(pattern.slice(1)); }
          return f === pattern;
        });
        if (files.length > 0) { rojoFound = true; break; }
      }
      if (rojoFound) {
        results.push("✓ Rojo project detected — BAD Bridge is compatible (plugin lives in Studio's Plugins folder, outside Rojo's tree)");
      }
    }

    // 6. Check Node.js
    const nodeVersion = checkNodeJs();
    if (nodeVersion) {
      results.push(`✓ Node.js ${nodeVersion}`);
    } else {
      results.push("✗ Node.js NOT FOUND — BAD Bridge requires Node.js to run the bridge and MCP servers.");
      results.push("  Download from https://nodejs.org or install via your system package manager.");
    }

    // 6b. Check bridge dependencies
    {
      const extNodeModules = path.join(extensionPath, "bridge", "node_modules");
      const wsNodeModules = ws ? path.join(ws, "bridge", "node_modules") : "";
      if (fs.existsSync(extNodeModules)) {
        results.push("✓ Bridge dependencies installed (extension path)");
      } else if (wsNodeModules && fs.existsSync(wsNodeModules)) {
        results.push("✓ Bridge dependencies installed (workspace path)");
      } else {
        results.push("⚠ Bridge SDK dependencies not found — zero-dep MCP server (mcp-bridge.cjs) will still work");
      }
    }

    // 7. Settings summary
    results.push("\n── Settings ──");
    results.push(`  Auto-connect: ${cfg.get<boolean>("autoConnect", true) ? "ON" : "OFF"}`);
    results.push(`  Auto-start server: ${cfg.get<boolean>("autoStartServer", true) ? "ON" : "OFF"}`);
    results.push(`  Auto-install plugin: ${cfg.get<boolean>("autoInstallPlugin", true) ? "ON" : "OFF"}`);
    results.push(`  Port: ${cfg.get<number>("port", 3001)}`);
    results.push(`  Log poll interval: ${cfg.get<number>("logPollInterval", 3)}s`);
    const rojoFile = cfg.get<string>("rojoProjectFile", "");
    results.push(`  Rojo project file: ${rojoFile ? rojoFile : "(auto-detect default.project.json)"}`);

    results.push("\n═══ End Diagnostic ═══");

    output.appendLine("\n" + results.join("\n"));
    output.show(true);
    vscode.window.showInformationMessage(
      ping ? "BAD Bridge: Diagnostic complete — check output panel." : "BAD Bridge: Issues found — check output panel.",
      "Show Output"
    ).then(c => { if (c) { output.show(true); } });
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

  // Auto-connect on startup — auto-start server if needed
  if (autoConnect) {
    setTimeout(async () => {
      let ok = await client.ping();
      if (!ok && autoStartServer) {
        // Server not running — start it automatically
        startBridgeServer(port, false);
        // Wait for server to be ready
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          ok = await client.ping();
          if (ok) { break; }
        }
      }
      if (ok) {
        setStatus(true);
        logProvider.startPolling(logInterval);
      } else {
        setStatus(false);
      }
    }, 1000);
  }

  // First-run detection — show guided setup
  const firstRunKey = "bad-bridge.setupComplete";
  if (!ctx.globalState.get<boolean>(firstRunKey)) {
    showFirstRunWalkthrough(ctx, firstRunKey);
  }
}

export function deactivate(): void {
  logProvider?.stopPolling();
  serverTerminal?.dispose();
  mcpTerminal?.dispose();
}

/** Check if Node.js is available. Returns the version string, or null if not installed. */
function checkNodeJs(): string | null {
  try {
    const result = cp.execSync("node --version", { timeout: 5000, encoding: "utf8" }).trim();
    return result; // e.g. "v20.11.0"
  } catch {
    return null;
  }
}

/** Show a user-friendly error when Node.js is not found, with auto-install options. */
function showNodeJsMissing(): void {
  const platform = os.platform();
  const buttons: string[] = ["Open nodejs.org"];
  if (platform === "win32") {
    buttons.unshift("Install with winget");
  } else if (platform === "darwin") {
    buttons.unshift("Install with Homebrew");
  } else {
    buttons.unshift("Install with apt");
  }
  vscode.window.showErrorMessage(
    "BAD Bridge requires Node.js but it was not found on your system.",
    ...buttons
  ).then(choice => {
    if (choice === "Open nodejs.org") {
      vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
    } else if (choice === "Install with winget") {
      installNodeViaTerminal("winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements");
    } else if (choice === "Install with Homebrew") {
      installNodeViaTerminal("brew install node");
    } else if (choice === "Install with apt") {
      installNodeViaTerminal("sudo apt update && sudo apt install -y nodejs npm");
    }
  });
}

/** Run a Node.js install command in a visible terminal, then prompt to reload. */
function installNodeViaTerminal(command: string): void {
  const t = vscode.window.createTerminal({ name: "Install Node.js" });
  t.show(true);
  t.sendText(command);
  // After install, user needs to reload VS Code for PATH to update
  t.sendText("echo ''");
  t.sendText("echo '✓ Installation complete. Please reload VS Code (Ctrl+Shift+P → Reload Window) for changes to take effect.'");
  vscode.window.showInformationMessage(
    "Node.js installation started. After it finishes, reload VS Code for the PATH to update.",
    "Reload Window"
  ).then(choice => {
    if (choice === "Reload Window") {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  });
}

/**
 * Ensure bridge/ npm dependencies are installed.
 * The MCP server needs @modelcontextprotocol/sdk and zod.
 * Returns true if deps are ready, false if install was triggered (async).
 */
/**
 * Find a bridge file by checking extension path first (shipped in VSIX), then workspace.
 * Returns the absolute path if found, or undefined.
 */
function findBridgeFile(relativePath: string): string | undefined {
  const extPath = path.join(extensionPath, relativePath);
  if (fs.existsSync(extPath)) { return extPath; }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    const wsPath = path.join(ws, relativePath);
    if (fs.existsSync(wsPath)) { return wsPath; }
  }
  return undefined;
}

/**
 * Ensure MCP server dependencies are installed.
 * Only needed for mcp-server.mjs (SDK-based). mcp-bridge.cjs is zero-dep.
 * Checks extension path first, then workspace.
 */
function ensureBridgeDeps(output: vscode.OutputChannel): boolean {
  // Check extension path first
  const extNodeModules = path.join(extensionPath, "bridge", "node_modules");
  if (fs.existsSync(extNodeModules)) { return true; }
  // Check workspace
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    const wsNodeModules = path.join(ws, "bridge", "node_modules");
    if (fs.existsSync(wsNodeModules)) { return true; }
  }
  // mcp-bridge.cjs is zero-dep and always works — only warn once
  if (!_depsWarned) {
    _depsWarned = true;
    output.appendLine("[BAD Bridge] Checking workspace... SDK dependencies not installed, using lightweight MCP server.");
  }
  return true;
}

function startBridgeServer(port: number, show: boolean = true): void {
  if (!checkNodeJs()) { showNodeJsMissing(); return; }
  // Don't start a second terminal if one already exists
  if (serverTerminal) {
    try {
      if (show) { serverTerminal.show(true); }
      return;
    } catch {
      serverTerminal = undefined;
    }
  }
  // Find server.js — extension path first, then workspace
  const serverScript = findBridgeFile(path.join("bridge", "server.js"));
  if (!serverScript) {
    vscode.window.showErrorMessage("BAD Bridge: bridge/server.js not found. Try reinstalling the extension.");
    return;
  }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  serverTerminal = vscode.window.createTerminal({
    name: "BAD Bridge Server",
    cwd: ws || extensionPath,
    hideFromUser: !show,
  });
  serverTerminal.sendText(`node "${serverScript}" --port ${port}`);
  if (show) { serverTerminal.show(true); }

  // Listen for terminal close so we can clear the reference
  const closeListener = vscode.window.onDidCloseTerminal((t) => {
    if (t === serverTerminal) {
      serverTerminal = undefined;
      closeListener.dispose();
    }
  });
}

function startMCPServer(cfg: vscode.WorkspaceConfiguration, show: boolean = true): void {
  if (!checkNodeJs()) { showNodeJsMissing(); return; }
  ensureBridgeDeps(outputChannel);
  if (mcpTerminal) {
    try {
      if (show) { mcpTerminal.show(true); }
      return;
    } catch {
      mcpTerminal = undefined;
    }
  }
  // Find MCP script — prefer mcp-server.mjs (SDK-based) if deps exist, else mcp-bridge.cjs (zero-dep)
  let mcpScript = findBridgeFile(path.join("bridge", "mcp-server.mjs"));
  if (mcpScript) {
    // Check if its node_modules exist (SDK-based needs them)
    const mcpDir = path.dirname(mcpScript);
    if (!fs.existsSync(path.join(mcpDir, "node_modules"))) {
      mcpScript = undefined; // fall through to mcp-bridge.cjs
    }
  }
  if (!mcpScript) {
    mcpScript = findBridgeFile(path.join("bridge", "mcp-bridge.cjs"));
  }
  if (!mcpScript) {
    vscode.window.showErrorMessage("BAD Bridge: MCP server script not found. Try reinstalling the extension.");
    return;
  }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rojoProjectFile = cfg.get<string>("rojoProjectFile", "");
  const port = cfg.get<number>("port", 3001);
  const env: Record<string, string> = {
    BRIDGE_URL: `http://127.0.0.1:${port}`,
    ROJO_PROJECT_ROOT: ws || extensionPath,
  };
  if (rojoProjectFile && rojoProjectFile.toLowerCase() !== "disabled") {
    env.ROJO_PROJECT_FILE = rojoProjectFile;
  } else if (rojoProjectFile.toLowerCase() === "disabled") {
    env.ROJO_DISABLED = "true";
  }
  mcpTerminal = vscode.window.createTerminal({
    name: "BAD Bridge MCP",
    cwd: ws || extensionPath,
    hideFromUser: !show,
    env,
  });
  mcpTerminal.sendText(`node "${mcpScript}"`);
  if (show) { mcpTerminal.show(true); }

  const closeListener = vscode.window.onDidCloseTerminal((t) => {
    if (t === mcpTerminal) {
      mcpTerminal = undefined;
      closeListener.dispose();
    }
  });
}

/**
 * Auto-install/update the Studio plugin to %LOCALAPPDATA%\Roblox\Plugins\.
 * Only copies when the file is missing or its content has changed (hash compare).
 * This runs silently on every activation — no user interaction needed.
 * 
 * Rojo compatibility: The plugin lives in Studio's standalone Plugins folder,
 * completely outside any Rojo project tree. They never conflict.
 */
function autoInstallStudioPlugin(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  if (os.platform() !== "win32") { return; } // Only Windows has this path

  const pluginDir = path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins");
  const dest = path.join(pluginDir, "BAD_BridgePlugin.lua");

  // Find the plugin source — check extension path first (shipped in VSIX), then workspace
  let pluginSrc: string | undefined;
  const extensionPluginPath = path.join(ctx.extensionPath, "plugin", "BridgePlugin.server.luau");
  const wsPluginPath = vscode.workspace.workspaceFolders?.[0]
    ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "plugin", "BridgePlugin.server.luau")
    : undefined;

  if (fs.existsSync(extensionPluginPath)) {
    pluginSrc = extensionPluginPath;
  } else if (wsPluginPath && fs.existsSync(wsPluginPath)) {
    pluginSrc = wsPluginPath;
  }

  if (!pluginSrc) {
    // Plugin source not found — skip silently
    return;
  }

  try {
    // Compare source content directly against installed file
    const srcContent = fs.readFileSync(pluginSrc);

    if (fs.existsSync(dest)) {
      const destContent = fs.readFileSync(dest);
      if (srcContent.equals(destContent)) {
        // Plugin is identical — do nothing
        return;
      }
    }

    // Install or update
    const isUpdate = fs.existsSync(dest);
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }
    fs.copyFileSync(pluginSrc, dest);

    const action = isUpdate ? "updated" : "installed";
    output.appendLine(`[BAD Bridge] Studio plugin ${action}: ${dest}`);

    if (!isUpdate) {
      vscode.window.showInformationMessage(
        "BAD Bridge: Studio plugin installed automatically! Restart Studio if it was already open.",
        "OK"
      );
    }
  } catch (e: any) {
    output.appendLine(`[BAD Bridge] Failed to auto-install plugin: ${e.message}`);
    // Don't show error — non-critical, user can install manually
  }
}

async function showFirstRunWalkthrough(ctx: vscode.ExtensionContext, key: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Welcome to BAD Bridge! Let's get everything set up.",
    "Run Setup Wizard",
    "Skip"
  );
  if (choice === "Skip") {
    ctx.globalState.update(key, true);
    return;
  }
  if (choice !== "Run Setup Wizard") { return; }

  // Step 1: Install plugin
  const installPlugin = await vscode.window.showInformationMessage(
    "Step 1/3: Install the Roblox Studio plugin?",
    "Install Plugin",
    "Already Installed"
  );
  if (installPlugin === "Install Plugin") {
    await vscode.commands.executeCommand("bad-bridge.installPlugin");
  }

  // Step 2: Configure MCP
  const setupMcp = await vscode.window.showInformationMessage(
    "Step 2/3: Configure MCP for AI assistant tools (Copilot, etc)?",
    "Setup MCP",
    "Skip"
  );
  if (setupMcp === "Setup MCP") {
    await vscode.commands.executeCommand("bad-bridge.setupMCP");
  }

  // Step 3: Remind about Studio settings
  await vscode.window.showInformationMessage(
    "Step 3/3: In Roblox Studio, enable:\n• Game Settings → Security → Allow HTTP Requests\n• Game Settings → Security → LoadStringEnabled\n\nThen restart Studio.",
    "Done!"
  );

  ctx.globalState.update(key, true);
  vscode.window.showInformationMessage("BAD Bridge setup complete! The server auto-starts when you open this workspace.");
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
