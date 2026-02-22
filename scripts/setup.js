#!/usr/bin/env node
// BAD Bridge — One-command setup script
// Usage: node scripts/setup.js   or   npm run setup
// Does everything a non-scripter needs: build, package, install extension, install plugin, configure MCP.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function log(msg) { console.log(`  ${msg}`); }
function step(n, msg) { console.log(`\n${bold(`[${n}]`)} ${cyan(msg)}`); }
function ok(msg) { log(green(`✓ ${msg}`)); }
function warn(msg) { log(yellow(`⚠ ${msg}`)); }
function fail(msg) { log(red(`✗ ${msg}`)); }

function run(cmd, opts = {}) {
  const result = execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8", ...opts });
  return result ? result.trim() : "";
}

function tryRun(cmd) {
  try { return run(cmd); } catch { return null; }
}

// ── Check prerequisites ──

function checkNode() {
  const v = process.version;
  const major = parseInt(v.slice(1));
  if (major < 16) {
    fail(`Node.js ${v} is too old. Need 16+.`);
    process.exit(1);
  }
  ok(`Node.js ${v}`);
}

function checkCode() {
  const r = tryRun("code --version");
  if (!r) {
    warn("VS Code CLI not found in PATH. Will skip auto-install of extension.");
    return false;
  }
  ok(`VS Code ${r.split("\n")[0]}`);
  return true;
}

// ── Steps ──

function installDeps() {
  step(1, "Cleaning old builds & installing dependencies");
  // Clean old build artifacts
  const distDir = path.join(ROOT, "dist");
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
    ok("Removed old dist/ folder");
  }
  const oldVsix = fs.readdirSync(ROOT).filter(f => f.endsWith(".vsix"));
  for (const f of oldVsix) {
    fs.unlinkSync(path.join(ROOT, f));
  }
  if (oldVsix.length > 0) ok(`Removed ${oldVsix.length} old .vsix file(s)`);
  // Clean node_modules and reinstall fresh
  run("npm install", { stdio: "inherit" });
  ok("Dependencies installed (including bridge/)");
}

function buildExtension() {
  step(2, "Building extension");
  run("npm run build", { stdio: "inherit" });
  ok("Extension built → dist/extension.js");
}

function packageVSIX() {
  step(3, "Packaging .vsix");
  // Remove old .vsix files
  const oldVsix = fs.readdirSync(ROOT).filter(f => f.endsWith(".vsix"));
  for (const f of oldVsix) {
    fs.unlinkSync(path.join(ROOT, f));
  }
  run("npx @vscode/vsce package --no-dependencies --allow-missing-repository", { stdio: "inherit" });
  const vsix = fs.readdirSync(ROOT).find(f => f.endsWith(".vsix"));
  if (!vsix) {
    fail("VSIX file not created");
    process.exit(1);
  }
  ok(`Packaged → ${vsix}`);
  return vsix;
}

function installExtension(vsix, hasCode) {
  step(4, "Installing VS Code extension");
  if (!hasCode) {
    warn("Skipping auto-install (VS Code CLI not in PATH)");
    log(`Manual install: Open VS Code → Ctrl+Shift+P → "Extensions: Install from VSIX…" → select ${vsix}`);
    return;
  }
  try {
    run(`code --install-extension "${path.join(ROOT, vsix)}" --force`, { stdio: "inherit" });
    ok("Extension installed in VS Code");
  } catch {
    warn("Auto-install failed. Install manually:");
    log(`  Ctrl+Shift+P → "Extensions: Install from VSIX…" → select ${vsix}`);
  }
}

function installPlugin() {
  step(5, "Installing Roblox Studio plugin");
  if (os.platform() !== "win32") {
    warn("Plugin auto-install only works on Windows. Copy plugin/BridgePlugin.server.luau manually.");
    return;
  }
  const pluginSrc = path.join(ROOT, "plugin", "BridgePlugin.server.luau");
  const pluginDir = path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins");
  const dest = path.join(pluginDir, "BAD_BridgePlugin.rbxmx");

  if (!fs.existsSync(pluginSrc)) {
    fail("Plugin source not found: plugin/BridgePlugin.server.luau");
    return;
  }
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
    log("Created Roblox plugins folder");
  }

  // Remove old .lua version if it exists
  const oldLua = path.join(pluginDir, "BAD_BridgePlugin.lua");
  if (fs.existsSync(oldLua)) {
    fs.unlinkSync(oldLua);
    ok("Removed old .lua plugin");
  }

  // Read source and wrap in .rbxmx (Roblox XML Model)
  let source = fs.readFileSync(pluginSrc, "utf8");
  // Escape for CDATA (handle the rare ]]> in source)
  source = source.replace(/\]\]>/g, "]]]]><![CDATA[>");

  const rbxmx = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
\t<External>null</External>
\t<External>nil</External>
\t<Item class="Script" referent="RBX0000000000">
\t\t<Properties>
\t\t\t<BinaryString name="AttributesSerialize"></BinaryString>
\t\t\t<bool name="Disabled">false</bool>
\t\t\t<Content name="LinkedSource"><null></null></Content>
\t\t\t<string name="Name">BAD_BridgePlugin</string>
\t\t\t<token name="RunContext">0</token>
\t\t\t<ProtectedString name="Source"><![CDATA[${source}]]></ProtectedString>
\t\t\t<BinaryString name="Tags"></BinaryString>
\t\t</Properties>
\t</Item>
</roblox>`;

  fs.writeFileSync(dest, rbxmx, "utf8");
  ok(`Plugin installed → ${dest}`);
}

function configureMCP() {
  step(6, "Configuring MCP for AI assistants");
  const vscodeDir = path.join(ROOT, ".vscode");
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  const mcpPath = path.join(vscodeDir, "mcp.json");
  let mcpConfig = {};
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, "utf8");
      const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      mcpConfig = JSON.parse(cleaned);
    } catch {
      mcpConfig = {};
    }
  }

  if (!mcpConfig.servers) mcpConfig.servers = {};
  mcpConfig.servers["bad-bridge"] = {
    type: "stdio",
    command: "node",
    args: ["bridge/mcp-bridge.cjs"],
    env: {
      BRIDGE_URL: "http://127.0.0.1:3001",
      ROJO_PROJECT_ROOT: "${workspaceFolder}"
    }
  };

  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
  ok("MCP configured in .vscode/mcp.json (Rojo-aware)");

  // Clean up old MCP config from settings.json if present
  const settingsPath = path.join(vscodeDir, "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const settings = JSON.parse(cleaned);
      if (settings?.mcp?.servers?.["bad-bridge"]) {
        delete settings.mcp.servers["bad-bridge"];
        if (Object.keys(settings.mcp.servers).length === 0) delete settings.mcp.servers;
        if (settings.mcp && Object.keys(settings.mcp).length === 0) delete settings.mcp;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        ok("Removed old MCP config from settings.json");
      }
    } catch { /* ignore */ }
  }
}

function printSummary() {
  console.log(`\n${bold("═══════════════════════════════════════════════")}`);
  console.log(bold(green("  BAD Bridge — Setup Complete!")));
  console.log(`${bold("═══════════════════════════════════════════════")}\n`);
  console.log("  Before you start, configure Roblox Studio:\n");
  console.log(`  ${bold("1.")} Open Roblox Studio`);
  console.log(`  ${bold("2.")} Game Settings → Security → ${bold("Allow HTTP Requests")} = ${green("ON")}`);
  console.log(`  ${bold("3.")} Game Settings → Security → ${bold("LoadStringEnabled")} = ${green("ON")}`);
  console.log(`  ${bold("4.")} Restart Studio if plugin doesn't appear\n`);
  console.log("  Then in VS Code:\n");
  console.log(`  ${bold("•")} The extension auto-starts the bridge server`);
  console.log(`  ${bold("•")} Studio plugin auto-connects within ~2 seconds`);
  console.log(`  ${bold("•")} Open the BAD Bridge sidebar (rocket icon) to control everything`);
  console.log(`  ${bold("•")} Run ${cyan("Ctrl+Shift+P")} → ${cyan("BAD Bridge: Diagnose Setup")} to verify\n`);
}

// ── Main ──

async function main() {
  console.log(`\n${bold("BAD Bridge — Automated Setup")}\n`);
  console.log("  This will build, package, and install everything.\n");

  checkNode();
  const hasCode = checkCode();

  installDeps();
  buildExtension();
  const vsix = packageVSIX();
  installExtension(vsix, hasCode);
  installPlugin();
  configureMCP();
  printSummary();
}

main().catch((err) => {
  fail(`Setup failed: ${err.message}`);
  process.exit(1);
});
