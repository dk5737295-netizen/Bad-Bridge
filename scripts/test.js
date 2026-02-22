// Basic integration test: verify server starts, responds to status, and MCP syntax is valid
const http = require("http");
const { spawn, execSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on("error", reject);
  });
}

async function run() {
  console.log("\n=== BAD Bridge Test Suite ===\n");

  // Test 1: Syntax checks
  console.log("1. Syntax Checks");
  try {
    execSync("node -c bridge/server.js", { cwd: ROOT, stdio: "pipe" });
    assert(true, "server.js syntax OK");
  } catch (e) {
    assert(false, "server.js syntax: " + e.stderr?.toString());
  }

  try {
    execSync("node -c bridge/mcp-bridge.cjs", { cwd: ROOT, stdio: "pipe" });
    assert(true, "mcp-bridge.cjs syntax OK");
  } catch (e) {
    assert(false, "mcp-bridge.cjs syntax: " + e.stderr?.toString());
  }

  // Test 2: Extension build
  console.log("\n2. Extension Build");
  try {
    execSync("npx esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --sourcemap", {
      cwd: ROOT, stdio: "pipe"
    });
    assert(true, "Extension builds without errors");
  } catch (e) {
    assert(false, "Extension build failed: " + e.stderr?.toString().slice(0, 200));
  }

  // Test 3: Server starts and responds
  console.log("\n3. Bridge Server");
  const testPort = 3099;
  const server = spawn("node", ["bridge/server.js", "--port", String(testPort)], {
    cwd: ROOT, stdio: "pipe"
  });

  await new Promise(r => setTimeout(r, 1500));

  try {
    const status = await httpGet(`http://localhost:${testPort}/status`);
    assert(status.ok === true, "Server responds to /status");
    assert(status.version === 4, "Server version is 4");
    assert(typeof status.queue === "number", "Queue field exists");

    // Test ping
    const ping = await httpGet(`http://localhost:${testPort}/ping`);
    assert(ping.pong === true, "Server responds to /ping");

    // Test control endpoints exist
    const controlState = await httpGet(`http://localhost:${testPort}/control/state`);
    assert(controlState.active === false, "Control state returns inactive by default");

  } catch (e) {
    assert(false, "Server HTTP test: " + e.message);
  }

  server.kill();

  // Test 4: MCP tool count
  console.log("\n4. MCP Tools");
  try {
    const mcpSrc = require("fs").readFileSync(path.join(ROOT, "bridge", "mcp-bridge.cjs"), "utf8");
    const toolCount = (mcpSrc.match(/name: "bridge_/g) || []).length;
    assert(toolCount >= 40, `Has ${toolCount} bridge tools (≥40)`);
  } catch (e) {
    assert(false, "MCP tool count: " + e.message);
  }

  // Test 5: Plugin file exists and has strict mode
  console.log("\n5. Plugin");
  try {
    const pluginSrc = require("fs").readFileSync(path.join(ROOT, "plugin", "BridgePlugin.server.luau"), "utf8");
    assert(pluginSrc.startsWith("--!strict"), "Plugin starts with --!strict");
    assert(pluginSrc.includes("PLUGIN_VERSION"), "Plugin has version constant");
    const cmdCount = (pluginSrc.match(/elseif cmdType ==/g) || []).length;
    assert(cmdCount >= 25, `Has ${cmdCount} command handlers (≥25)`);
  } catch (e) {
    assert(false, "Plugin: " + e.message);
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
