// Dev mode: watch for changes and auto-restart bridge server + rebuild extension
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let serverProcess = null;

function startServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  console.log("[dev] Starting bridge server...");
  serverProcess = spawn("node", ["bridge/server.js", "--port", "3001"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  serverProcess.on("exit", (code) => {
    if (code !== null) console.log(`[dev] Server exited with code ${code}`);
    serverProcess = null;
  });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const restartServer = debounce(() => {
  console.log("[dev] Server file changed — restarting...");
  startServer();
}, 500);

const rebuildMCP = debounce(() => {
  console.log("[dev] MCP file changed — syntax checking...");
  exec("node -c bridge/mcp-bridge.cjs", { cwd: ROOT }, (err, stdout, stderr) => {
    if (err) {
      console.error("[dev] MCP syntax error:", stderr);
    } else {
      console.log("[dev] MCP syntax OK");
    }
  });
}, 500);

const reinstallPlugin = debounce(() => {
  console.log("[dev] Plugin changed — reinstalling...");
  exec("node scripts/install-plugin.js", { cwd: ROOT }, (err, stdout, stderr) => {
    if (err) {
      console.error("[dev] Plugin install error:", stderr);
    } else {
      console.log(stdout.trim());
    }
  });
}, 500);

// Watch files
console.log("[dev] Watching for changes...");

fs.watch(path.join(ROOT, "bridge", "server.js"), restartServer);
fs.watch(path.join(ROOT, "bridge", "mcp-bridge.cjs"), rebuildMCP);
fs.watch(path.join(ROOT, "plugin", "BridgePlugin.server.luau"), reinstallPlugin);

// Also start esbuild in watch mode
const esbuild = spawn("npx", [
  "esbuild", "src/extension.ts",
  "--bundle", "--outfile=dist/extension.js",
  "--external:vscode", "--format=cjs", "--platform=node", "--sourcemap", "--watch"
], { cwd: ROOT, stdio: "inherit", shell: true });

esbuild.on("exit", () => {
  console.log("[dev] esbuild exited");
  process.exit(0);
});

// Start server
startServer();

// Cleanup
process.on("SIGINT", () => {
  if (serverProcess) serverProcess.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (serverProcess) serverProcess.kill();
  process.exit(0);
});
