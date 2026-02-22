#!/usr/bin/env node
// BAD Bridge MCP Server v2 — zero dependencies, instant startup
// Implements MCP stdio protocol directly without the SDK
// Rojo-aware: script edits write .luau files to disk when default.project.json exists

const http = require("http");
const https = require("https");
const readline = require("readline");
const fs = require("fs");
const pathModule = require("path");

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const ROJO_PROJECT_ROOT = process.env.ROJO_PROJECT_ROOT || process.cwd();
const ROJO_PROJECT_FILE = process.env.ROJO_PROJECT_FILE || "";
const ROJO_DISABLED = (process.env.ROJO_DISABLED || "").toLowerCase() === "true";
const MCP_VERSION = "2024-11-05";
const SERVER_VERSION = "2.1.0";

// ── Rojo integration ──

let rojoTree = null;
let rojoEnabled = false;

function loadRojoProject() {
  if (ROJO_DISABLED) {
    process.stderr.write(`[BAD Bridge] Rojo mode explicitly disabled — using Studio Plugin for DataModel info.\n`);
    rojoEnabled = false;
    return;
  }
  const projectFile = ROJO_PROJECT_FILE
    ? (pathModule.isAbsolute(ROJO_PROJECT_FILE) ? ROJO_PROJECT_FILE : pathModule.join(ROJO_PROJECT_ROOT, ROJO_PROJECT_FILE))
    : pathModule.join(ROJO_PROJECT_ROOT, "default.project.json");
  if (!fs.existsSync(projectFile)) {
    rojoEnabled = false;
    return;
  }
  try {
    const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
    rojoTree = project.tree || {};
    rojoEnabled = true;
    process.stderr.write(`[BAD Bridge] Rojo project loaded — script edits write to disk.\n`);
  } catch (e) {
    process.stderr.write(`[BAD Bridge] Failed to parse default.project.json: ${e.message}\n`);
    rojoEnabled = false;
  }
}

function rojoResolve(instancePath) {
  if (!rojoEnabled || !rojoTree) return null;
  const parts = instancePath.split(".");
  if (parts[0] === "game") parts.shift();
  let node = rojoTree;
  let fsBase = null;
  let consumed = 0;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (node[key]) {
      node = node[key];
      consumed = i + 1;
      if (node["$path"]) fsBase = node["$path"];
    } else break;
  }
  if (!fsBase) return null;
  const remaining = parts.slice(consumed);
  const fsDir = pathModule.join(ROJO_PROJECT_ROOT, fsBase, ...remaining.slice(0, -1));
  const scriptName = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  return { fsBase: pathModule.join(ROJO_PROJECT_ROOT, fsBase), fsDir, scriptName, remaining };
}

function scriptExtension(className) {
  if (className === "Script") return ".server.luau";
  if (className === "LocalScript") return ".client.luau";
  return ".luau";
}

function guessClassFromPath(instancePath) {
  if (instancePath.includes("ServerScriptService") || instancePath.includes("ServerStorage")) return "Script";
  if (instancePath.includes("StarterPlayerScripts") || instancePath.includes("StarterCharacterScripts") || instancePath.includes("StarterGui")) return "LocalScript";
  return "ModuleScript";
}

function writeScriptToDisk(instancePath, source, className) {
  const resolved = rojoResolve(instancePath);
  if (!resolved) return null;
  const { fsBase, fsDir, scriptName } = resolved;
  if (!scriptName) {
    const initFile = pathModule.join(fsBase, "init" + scriptExtension(className || "ModuleScript"));
    fs.mkdirSync(pathModule.dirname(initFile), { recursive: true });
    fs.writeFileSync(initFile, source, "utf-8");
    return { success: true, filePath: initFile, message: `Wrote ${initFile}` };
  }
  const ext = scriptExtension(className || guessClassFromPath(instancePath));
  const filePath = pathModule.join(fsDir, scriptName + ext);
  fs.mkdirSync(fsDir, { recursive: true });
  fs.writeFileSync(filePath, source, "utf-8");
  return { success: true, filePath, message: `Wrote ${filePath}` };
}

function readScriptFromDisk(instancePath) {
  const resolved = rojoResolve(instancePath);
  if (!resolved) return null;
  const { fsBase, fsDir, scriptName } = resolved;
  const exts = [".server.luau", ".client.luau", ".luau", ".server.lua", ".client.lua", ".lua"];
  if (!scriptName) {
    for (const ext of exts) {
      const initFile = pathModule.join(fsBase, "init" + ext);
      if (fs.existsSync(initFile)) return { success: true, source: fs.readFileSync(initFile, "utf-8"), filePath: initFile };
    }
    return null;
  }
  for (const ext of exts) {
    const filePath = pathModule.join(fsDir, scriptName + ext);
    if (fs.existsSync(filePath)) return { success: true, source: fs.readFileSync(filePath, "utf-8"), filePath };
  }
  const folderPath = pathModule.join(fsDir, scriptName);
  if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
    for (const ext of exts) {
      const initFile = pathModule.join(folderPath, "init" + ext);
      if (fs.existsSync(initFile)) return { success: true, source: fs.readFileSync(initFile, "utf-8"), filePath: initFile };
    }
  }
  return null;
}

loadRojoProject();

// ── Roblox API dump cache ──

let apiDumpCache = null;
let apiDumpLoading = false;
const API_DUMP_URL = "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Mini-API-Dump.json";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function getApiDump() {
  if (apiDumpCache) return apiDumpCache;
  if (apiDumpLoading) {
    for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 200)); if (apiDumpCache) return apiDumpCache; }
    return null;
  }
  apiDumpLoading = true;
  try {
    const raw = await httpsGet(API_DUMP_URL);
    apiDumpCache = JSON.parse(raw);
    process.stderr.write(`[BAD Bridge] Roblox API dump loaded (${apiDumpCache.Classes.length} classes)\n`);
  } catch (e) {
    process.stderr.write(`[BAD Bridge] Failed to fetch Roblox API dump: ${e.message}\n`);
  }
  apiDumpLoading = false;
  return apiDumpCache;
}

function apiLookupClass(dump, className) {
  if (!dump || !dump.Classes) return null;
  return dump.Classes.find(c => c.Name === className) || null;
}

function apiGetClassChain(dump, className) {
  if (!dump) return [];
  const chain = [];
  let current = className;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const cls = dump.Classes.find(c => c.Name === current);
    if (!cls) break;
    chain.push(cls);
    current = cls.Superclass;
  }
  return chain;
}

function apiGetAllProperties(dump, className) {
  const chain = apiGetClassChain(dump, className);
  const props = [];
  const seen = new Set();
  for (const cls of chain) {
    for (const member of (cls.Members || [])) {
      if (member.MemberType === "Property" && !seen.has(member.Name)) {
        seen.add(member.Name);
        const tags = member.Tags || [];
        if (tags.includes("Deprecated") || tags.includes("NotScriptable")) continue;
        const writeSecurity = member.Security?.Write || "None";
        const writable = !tags.includes("ReadOnly") && (writeSecurity === "None" || writeSecurity === "PluginSecurity");
        props.push({
          Name: member.Name,
          ValueType: member.ValueType?.Name || "unknown",
          Category: member.Category || "",
          From: cls.Name,
          Writable: writable,
          Tags: tags.length > 0 ? tags : undefined,
        });
      }
    }
  }
  return props;
}

function apiGetMethods(dump, className) {
  const chain = apiGetClassChain(dump, className);
  const methods = [];
  const seen = new Set();
  for (const cls of chain) {
    for (const member of (cls.Members || [])) {
      if (member.MemberType === "Function" && !seen.has(member.Name)) {
        seen.add(member.Name);
        const tags = member.Tags || [];
        if (tags.includes("Deprecated")) continue;
        const security = member.Security || "None";
        if (typeof security === "string" && security !== "None") continue;
        if (typeof security === "object" && security.Read && security.Read !== "None") continue;
        methods.push({
          Name: member.Name,
          Parameters: (member.Parameters || []).map(p => ({ Name: p.Name, Type: p.Type?.Name || "any" })),
          ReturnType: member.ReturnType?.Name || "void",
          From: cls.Name,
        });
      }
    }
  }
  return methods;
}

function apiGetEvents(dump, className) {
  const chain = apiGetClassChain(dump, className);
  const events = [];
  const seen = new Set();
  for (const cls of chain) {
    for (const member of (cls.Members || [])) {
      if (member.MemberType === "Event" && !seen.has(member.Name)) {
        seen.add(member.Name);
        const tags = member.Tags || [];
        if (tags.includes("Deprecated")) continue;
        events.push({
          Name: member.Name,
          Parameters: (member.Parameters || []).map(p => ({ Name: p.Name, Type: p.Type?.Name || "any" })),
          From: cls.Name,
        });
      }
    }
  }
  return events;
}

//  HTTP helpers 

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _bridgeRunOnce(cmd, timeoutMs) {
  const zlib = require("zlib");
  return new Promise((resolve) => {
    const body = JSON.stringify(cmd);
    const url = new URL(`/run?timeout=${timeoutMs}`, BRIDGE);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Accept-Encoding": "gzip" },
      timeout: timeoutMs + 5000,
    }, (res) => {
      const chunks = [];
      const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => {
        const d = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(d)); } catch { resolve({ success: false, error: "Invalid JSON from bridge", raw: d }); }
      });
      stream.on("error", () => { resolve({ success: false, error: "Decompression error" }); });
    });
    req.on("error", e => resolve({ success: false, error: `Bridge server unreachable (${e.code || e.message}). Start bridge with: node bridge/server.js`, _retryable: true }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: `Command timed out after ${timeoutMs}ms. The Studio plugin may be disconnected or the operation is taking too long.`, _retryable: true }); });
    req.write(body);
    req.end();
  });
}

async function bridgeRun(cmd, timeoutMs = 15000) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await _bridgeRunOnce(cmd, timeoutMs);
    if (r.success || !r._retryable || attempt === MAX_RETRIES) {
      delete r._retryable;
      return r;
    }
    process.stderr.write(`[BAD Bridge] Retry ${attempt + 1}/${MAX_RETRIES} for ${cmd.type || '?'}...\n`);
    await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
}

function bridgeGet(gpath) {
  const zlib = require("zlib");
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE}${gpath}`, { timeout: 8000, headers: { "Accept-Encoding": "gzip" } }, (res) => {
      const chunks = [];
      const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => { const d = Buffer.concat(chunks).toString(); try { resolve(JSON.parse(d)); } catch { resolve({ error: "Invalid JSON", raw: d }); } });
      stream.on("error", () => resolve({ error: "Decompression error" }));
    });
    req.on("error", e => resolve({ error: `Bridge unreachable: ${e.message}` }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

/** Pre-check: verify Studio is connected before running a command */
async function ensureStudioConnected() {
  const s = await bridgeGet("/status");
  if (s.error) return { ok: false, msg: `Bridge server not reachable: ${s.error}\n\nStart bridge: node bridge/server.js` };
  if (!s.studioConnected) return { ok: false, msg: `Studio plugin is NOT connected.\n\nEnsure:\n1. Roblox Studio is open\n2. BAD Bridge plugin is installed and connected\n3. Allow HTTP Requests is ON in Game Settings > Security` };
  return { ok: true };
}

//  Result formatting helpers 

function formatResult(r, label) {
  if (!r) return `${label}: No response from bridge`;
  if (r.error && !r.success) return `Error: ${r.error}`;
  return r.success ? (r.result || "(success)") : `Error: ${r.error || "Unknown error"}`;
}

function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return str; }
}

function prettyJSON(data) {
  if (typeof data === "string") {
    const parsed = tryParseJSON(data);
    if (typeof parsed === "object") return JSON.stringify(parsed, null, 2);
    return data;
  }
  return JSON.stringify(data, null, 2);
}

// ── Context Memory System ──

const MEMORY_DIR = pathModule.join(ROJO_PROJECT_ROOT, ".bridge");
const MEMORY_FILE = pathModule.join(MEMORY_DIR, "context-memory.json");
const SNAPSHOT_DIR = pathModule.join(MEMORY_DIR, "snapshots");
const HISTORY_FILE = pathModule.join(MEMORY_DIR, "command-history.json");

function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch (_e) { /* ignore */ }
  return { facts: [], architecture: null, lastScan: null };
}

function saveMemory(mem) {
  ensureMemoryDir();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (_e) { /* ignore */ }
  return [];
}

function saveHistory(history) {
  ensureMemoryDir();
  // Keep last 200 entries
  if (history.length > 200) history = history.slice(-200);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function addToHistory(tool, args, resultSummary) {
  const history = loadHistory();
  history.push({
    tool,
    args: typeof args === "object" ? JSON.stringify(args).slice(0, 200) : String(args).slice(0, 200),
    result: String(resultSummary).slice(0, 300),
    ts: new Date().toISOString(),
  });
  saveHistory(history);
}

//  Tool definitions 

const TOOLS = [
  {
    name: "bridge_status",
    description: "Checking connection to Roblox Studio — verifies the bridge server is running and the Studio plugin is connected. Always call this first before using any other tools.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const s = await bridgeGet("/status");
      if (s.error) return `Bridge server not reachable: ${s.error}\n\nTo start the bridge server, run: node bridge/server.js`;
      const lines = [
        `Bridge Server: Online (v${s.version})`,
        `Studio Plugin: ${s.studioConnected ? "Connected" : "Not connected — open Studio with the BAD Bridge plugin"}`,
        `Pending Commands: ${s.queue}`,
        `Total Commands Run: ${s.commands}`,
        `Buffered Logs: ${s.logs}`,
      ];
      // If Studio is connected, also fetch capabilities
      if (s.studioConnected) {
        try {
          const caps = await bridgeRun({ type: "get_capabilities" }, 5000);
          if (caps.success) {
            const c = tryParseJSON(caps.result);
            if (c && typeof c === "object") {
              lines.push(`LoadStringEnabled: ${c.LoadStringEnabled ? "YES" : "NO — bridge_run unavailable, use bridge_script_edit instead"}`);
              lines.push(`Studio Mode: ${c.IsRunning ? "Playing" : "Edit"}`);
            }
          }
        } catch { /* non-critical */ }
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_run",
    description: "Execute Luau code in Roblox Studio — inspects game state, tests logic, or makes quick changes. Requires LoadStringEnabled in Game Settings > Security. Use 'return <value>' to get values back.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau code to execute. Use 'return ...' to get a value back." }
      },
      required: ["code"]
    },
    handler: async ({ code }) => {
      if (!code || typeof code !== "string") return "Error: 'code' parameter is required and must be a string";
      const r = await bridgeRun({ type: "run", code });
      if (!r.success) {
        if (r.loadStringDisabled) {
          return `Error: LoadStringEnabled is OFF in Studio.\n\nTo fix: Game Settings > Security > Allow Server Scripts to use LoadString > ON\n\nAlternatives that work without LoadString:\n- bridge_script_edit: find-and-replace in scripts\n- bridge_script_write: write full script source\n- bridge_set_property: set instance properties\n- bridge_create: create instances with properties`;
        }
        return `Error: ${r.error}`;
      }
      const parts = [];
      if (r.output) parts.push(`Output:\n${r.output}`);
      if (r.result && r.result !== "nil") parts.push(`Result: ${r.result}`);
      return parts.length > 0 ? parts.join("\n\n") : "(executed successfully, no output)";
    }
  },
  {
    name: "bridge_tree",
    description: "Exploring the game's instance hierarchy — shows names, classnames, and optionally properties. Use bridge_game_map first for a high-level overview, then drill into specific paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game.Workspace", description: "Instance path (e.g. 'game.Workspace', 'game.ServerScriptService')" },
        depth: { type: "number", default: 2, description: "How many levels deep to traverse (1-10)" },
        props: { type: "boolean", default: false, description: "Include common properties for each instance" }
      },
      required: []
    },
    handler: async ({ path = "game.Workspace", depth = 2, props = false }) => {
      const r = await bridgeRun({ type: "get_tree", path, depth, props });
      if (!r.success) return `Error: ${r.error}`;
      return prettyJSON(r.result);
    }
  },
  {
    name: "bridge_find",
    description: "Searching for instances by name or class — finds matching objects anywhere in the game tree with their full paths.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name substring to match (case-insensitive)" },
        className: { type: "string", description: "Exact ClassName to filter by (e.g. 'Part', 'Script', 'Model')" },
        path: { type: "string", default: "game", description: "Root instance path to search from" },
        limit: { type: "number", default: 30, description: "Maximum number of results (1-100)" },
        props: { type: "boolean", default: false, description: "Include properties in results" }
      },
      required: []
    },
    handler: async ({ name, className, path = "game", limit = 30, props = false }) => {
      const cmd = { type: "find", path, limit, props };
      if (name) cmd.name = name;
      if (className) cmd.class = className;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      const items = tryParseJSON(r.result);
      if (!Array.isArray(items)) return r.result;
      if (items.length === 0) return "No instances found matching the search criteria.";
      const header = `Found ${items.length} instance(s):`;
      const list = items.map(i => `  ${i.FullName} [${i.ClassName}]`).join("\n");
      return `${header}\n${list}`;
    }
  },
  {
    name: "bridge_props",
    description: "Reading properties of an instance — returns property values like Name, Position, Size, Color, etc. Set types=true to also get the Roblox type (Vector3, Color3, etc.) of each property.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path (e.g. 'game.Workspace.Part')" },
        properties: { type: "array", items: { type: "string" }, description: "Specific property names to read (optional, reads common props if omitted)" },
        types: { type: "boolean", default: false, description: "Include the Roblox type of each property value (e.g. 'Vector3', 'Color3', 'number')" }
      },
      required: ["path"]
    },
    handler: async ({ path, properties, types = false }) => {
      const cmd = { type: "get_properties", path, types };
      if (properties) cmd.properties = properties;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      return prettyJSON(r.result);
    }
  },
  {
    name: "bridge_bulk_inspect",
    description: "Get the full instance tree with ALL properties included. Heavier than bridge_tree  use for deeply understanding a subtree's configuration.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game.Workspace", description: "Instance path to inspect" },
        depth: { type: "number", default: 3, description: "How many levels deep (be careful with large values)" }
      },
      required: ["path"]
    },
    handler: async ({ path, depth = 3 }) => {
      const r = await bridgeRun({ type: "bulk_inspect", path, depth });
      if (!r.success) return `Error: ${r.error}`;
      return prettyJSON(r.result);
    }
  },
  {
    name: "bridge_play",
    description: "Test game logic by running a Luau script inside play mode. Studio enters play mode, executes your script, then stops automatically. Returns captured logs, errors, duration, and the script's return value.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau code to execute in play mode" },
        mode: { type: "string", enum: ["start_play", "run_server"], default: "start_play", description: "Play mode type" },
        timeout: { type: "number", default: 30, description: "Script timeout in seconds before force-stopping" }
      },
      required: ["code"]
    },
    handler: async ({ code, mode = "start_play", timeout = 30 }) => {
      if (!code || typeof code !== "string") return "Error: 'code' parameter is required and must be a string";
      const wait = (timeout + 60) * 1000;
      const r = await bridgeRun({ type: "run_script_in_play_mode", code, mode, timeout }, wait);
      if (!r.success) return `Error: ${r.error}`;
      const d = tryParseJSON(r.result);
      if (typeof d !== "object" || d === null) return r.result;
      const lines = [];
      lines.push(`Status: ${d.success ? "Success" : "Failed"}`);
      if (d.value && d.value !== "nil") lines.push(`Return Value: ${d.value}`);
      if (d.error && d.error !== "nil") lines.push(`Error: ${d.error}`);
      if (d.isTimeout) lines.push("WARNING: Script timed out!");
      lines.push(`Duration: ${(d.duration || 0).toFixed(1)}s`);
      if (d.errors?.length) {
        lines.push(`\nErrors (${d.errors.length}):`);
        d.errors.forEach(e => lines.push(`  [${e.level || "error"}] ${e.message}`));
      }
      if (d.logs?.length) {
        lines.push(`\nLogs (${d.logs.length}):`);
        d.logs.forEach(l => lines.push(`  [${l.level}] ${l.message}`));
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_create",
    description: "Creating a new instance in Studio — supports setting Color3, Vector3, CFrame, UDim2, BrickColor and more.",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string", description: "Roblox ClassName (e.g. 'Part', 'Model', 'Script', 'SpawnLocation')" },
        parent: { type: "string", default: "game.Workspace", description: "Parent instance path" },
        name: { type: "string", description: "Name for the new instance" },
        properties: { type: "object", description: "Properties to set. Supports rich types: {\"Color\": {\"r\":255,\"g\":0,\"b\":0}, \"Position\": {\"x\":0,\"y\":5,\"z\":0}}" }
      },
      required: ["className"]
    },
    handler: async ({ className, parent = "game.Workspace", name, properties }) => {
      if (!className || typeof className !== "string") return "Error: 'className' parameter is required and must be a string";
      const cmd = { type: "create_instance", className, parent };
      if (name) cmd.name = name;
      if (properties) cmd.properties = properties;
      const r = await bridgeRun(cmd);
      return formatResult(r, "Create");
    }
  },
  {
    name: "bridge_set_property",
    description: "Setting a property on an instance — supports Color3 {r,g,b}, Vector3 {x,y,z}, CFrame, UDim2, BrickColor, and Enum values.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path (e.g. 'game.Workspace.Part')" },
        property: { type: "string", description: "Property name (e.g. 'Position', 'Color', 'Size', 'Anchored')" },
        value: { description: "Value to set. Use objects for rich types: {\"r\":255,\"g\":0,\"b\":0} for Color3" }
      },
      required: ["path", "property", "value"]
    },
    handler: async ({ path, property, value }) => {
      const r = await bridgeRun({ type: "set_property", path, property, value });
      return formatResult(r, "Set Property");
    }
  },
  {
    name: "bridge_delete",
    description: "Permanently delete an instance from Studio. This action can be undone with bridge_undo.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Instance path to delete" } },
      required: ["path"]
    },
    handler: async ({ path }) => {
      const r = await bridgeRun({ type: "delete_instance", path });
      return formatResult(r, "Delete");
    }
  },
  {
    name: "bridge_move",
    description: "Move (reparent) an instance to a different parent in the hierarchy.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path to move" },
        parent: { type: "string", description: "New parent path (e.g. 'game.ServerStorage')" }
      },
      required: ["path", "parent"]
    },
    handler: async ({ path, parent }) => {
      const r = await bridgeRun({ type: "move_instance", path, parent });
      return formatResult(r, "Move");
    }
  },
  {
    name: "bridge_rename",
    description: "Rename an instance in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        name: { type: "string", description: "New name" }
      },
      required: ["path", "name"]
    },
    handler: async ({ path, name }) => {
      const r = await bridgeRun({ type: "rename_instance", path, name });
      return formatResult(r, "Rename");
    }
  },
  {
    name: "bridge_clone",
    description: "Clone (duplicate) an instance, optionally to a different parent.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path to clone" },
        parent: { type: "string", description: "Destination parent (optional, clones to same parent if omitted)" }
      },
      required: ["path"]
    },
    handler: async ({ path, parent }) => {
      const cmd = { type: "clone_instance", path };
      if (parent) cmd.parent = parent;
      const r = await bridgeRun(cmd);
      return formatResult(r, "Clone");
    }
  },
  {
    name: "bridge_script_read",
    description: "Reading a script's source code — retrieves from disk (Rojo) or Studio.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Script path (e.g. 'game.ServerScriptService.MainScript')" },
        fromStudio: { type: "boolean", default: false, description: "Force reading from Studio instead of disk" }
      },
      required: ["path"]
    },
    handler: async ({ path, fromStudio = false }) => {
      if (rojoEnabled && !fromStudio) {
        const diskResult = readScriptFromDisk(path);
        if (diskResult) {
          const lineCount = diskResult.source.split("\n").length;
          return `[Rojo — ${diskResult.filePath}]\n-- Script: ${path} (${lineCount} lines, ${diskResult.source.length} chars)\n${diskResult.source}`;
        }
      }
      const r = await bridgeRun({ type: "get_script_source", path });
      if (!r.success) return `Error: ${r.error}`;
      const source = r.result || "";
      const lineCount = source.split("\n").length;
      return `-- Script: ${path} (${lineCount} lines, ${source.length} chars)\n${source}`;
    }
  },
  {
    name: "bridge_script_write",
    description: "Writing source code to a script — updates on disk (Rojo) or in Studio directly. Can be undone with bridge_undo.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Script path (e.g. 'game.ServerScriptService.MainScript')" },
        source: { type: "string", description: "Complete Luau source code to write" },
        className: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Script type (auto-detected from path if omitted)" },
        forceStudio: { type: "boolean", default: false, description: "Force writing to Studio directly" }
      },
      required: ["path", "source"]
    },
    handler: async ({ path, source, className, forceStudio = false }) => {
      if (!path || typeof path !== "string") return "Error: 'path' parameter is required and must be a string";
      if (!source || typeof source !== "string") return "Error: 'source' parameter is required and must be a string";
      if (rojoEnabled && !forceStudio) {
        const diskResult = writeScriptToDisk(path, source, className);
        if (diskResult) return `[Rojo] ${diskResult.message} (${source.length} chars) — Rojo will sync to Studio.`;
        return `Warning: Could not map '${path}' to a Rojo file path. Check your default.project.json tree.`;
      }
      const r = await bridgeRun({ type: "set_script_source", path, source });
      return formatResult(r, "Write Script");
    }
  },
  {
    name: "bridge_create_script",
    description: "Creating a new script — writes a .luau file (Rojo) or creates a Script instance in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Parent instance path, e.g. 'game.ServerScriptService'" },
        name: { type: "string", description: "Script name" },
        className: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], default: "Script", description: "Script class" },
        source: { type: "string", default: "", description: "Initial Luau source code" }
      },
      required: ["path", "name"]
    },
    handler: async ({ path, name, className = "Script", source = "" }) => {
      const instancePath = `${path}.${name}`;
      if (rojoEnabled) {
        const diskResult = writeScriptToDisk(instancePath, source, className);
        if (diskResult) return `[Rojo] Created ${diskResult.filePath} (${className}) — Rojo will sync to Studio.`;
        return `Warning: Could not map '${instancePath}' to a Rojo file path.`;
      }
      const r = await bridgeRun({ type: "create_instance", className, parent: path, name, properties: { Source: source } });
      return formatResult(r, "Create Script");
    }
  },
  {
    name: "bridge_console",
    description: "Get console/output window text from Studio. Captures print(), warn(), and error() output.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", default: false, description: "Clear the console buffer after reading" }
      },
      required: []
    },
    handler: async ({ clear = false }) => {
      const r = await bridgeRun({ type: "get_console_output", clear });
      if (!r.success) return `Error: ${r.error}`;
      return r.result || "(console is empty)";
    }
  },
  {
    name: "bridge_logs",
    description: "Get log entries from the Studio bridge plugin. Includes Output, Warning, and Error messages.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", default: 50, description: "Number of recent log entries to retrieve" },
        filter: { type: "string", description: "Filter by message text or type (e.g. 'Error', 'Warning')" },
        clear: { type: "boolean", default: false, description: "Clear logs after reading" }
      },
      required: []
    },
    handler: async ({ count = 50, filter, clear = false }) => {
      const logs = await bridgeGet(`/logs${clear ? "?clear=true" : ""}`);
      if (logs.error) return `Error: ${logs.error}`;
      if (!Array.isArray(logs)) return "(no logs available)";
      let entries = logs;
      if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(l =>
          (l.message && l.message.toLowerCase().includes(f)) ||
          (l.type && l.type.toLowerCase() === f)
        );
      }
      entries = entries.slice(-count);
      if (entries.length === 0) return "(no matching logs)";
      return entries.map(l => `[${l.type || "?"}] ${l.message}`).join("\n");
    }
  },
  {
    name: "bridge_selection",
    description: "Get or set the currently selected instances in Studio's Explorer panel.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], default: "get", description: "Get current selection or set new selection" },
        paths: { type: "array", items: { type: "string" }, description: "Instance paths to select (required for 'set' action)" }
      },
      required: []
    },
    handler: async ({ action = "get", paths }) => {
      if (action === "set") {
        if (!paths?.length) return "Error: 'set' action requires an array of instance paths";
        const r = await bridgeRun({ type: "set_selection", paths });
        return formatResult(r, "Set Selection");
      }
      const r = await bridgeRun({ type: "get_selection" });
      if (!r.success) return `Error: ${r.error}`;
      const items = tryParseJSON(r.result);
      if (!Array.isArray(items)) return r.result;
      if (items.length === 0) return "(nothing selected in Studio)";
      return `Selected ${items.length} instance(s):\n` + items.map(i => `  ${i.FullName} [${i.ClassName}]`).join("\n");
    }
  },
  {
    name: "bridge_play_control",
    description: "Control Studio's play mode: start play test, run server mode, or stop testing.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["start_play", "run_server", "stop"], description: "start_play = full play test, run_server = server only, stop = stop testing" }
      },
      required: ["mode"]
    },
    handler: async ({ mode }) => {
      const r = await bridgeRun({ type: "start_stop_play", mode });
      return formatResult(r, "Play Control");
    }
  },
  {
    name: "bridge_studio_mode",
    description: "Check Studio's current mode (edit, play, or server).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = await bridgeRun({ type: "get_studio_mode" });
      if (!r.success) return `Error: ${r.error}`;
      const mode = r.result || "unknown";
      const labels = { stop: "Edit Mode", start_play: "Play Mode", run_server: "Server Mode" };
      return `Studio Mode: ${labels[mode] || mode}`;
    }
  },
  {
    name: "bridge_undo",
    description: "Undo the last action(s) performed through the bridge in Studio.",
    inputSchema: {
      type: "object",
      properties: { steps: { type: "number", default: 1, description: "Number of steps to undo (1-20)" } },
      required: []
    },
    handler: async ({ steps = 1 }) => {
      const r = await bridgeRun({ type: "undo", steps: Math.min(steps, 20) });
      return formatResult(r, "Undo");
    }
  },
  {
    name: "bridge_redo",
    description: "Redo the last undone action(s) in Studio.",
    inputSchema: {
      type: "object",
      properties: { steps: { type: "number", default: 1, description: "Number of steps to redo (1-20)" } },
      required: []
    },
    handler: async ({ steps = 1 }) => {
      const r = await bridgeRun({ type: "redo", steps: Math.min(steps, 20) });
      return formatResult(r, "Redo");
    }
  },
  {
    name: "bridge_batch",
    description: "Execute multiple commands in one round trip for efficiency — e.g. inspecting multiple instances, setting multiple properties, or creating several objects at once. Each command needs a 'type' field. Supports up to 200 commands per batch.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: { type: "object", description: "Command object with 'type' field" },
          description: "Array of command objects"
        }
      },
      required: ["commands"]
    },
    handler: async ({ commands }) => {
      if (!Array.isArray(commands) || commands.length === 0) return "Error: 'commands' must be a non-empty array";
      // Scale timeout with batch size: 30s base + 200ms per command
      const batchTimeout = Math.max(30000, 30000 + commands.length * 200);
      const r = await bridgeRun({ type: "batch", commands }, batchTimeout);
      if (!r.success) return `Error: ${r.error}`;
      const results = tryParseJSON(r.result);
      if (!Array.isArray(results)) return r.result;
      const lines = results.map((res, i) => {
        const cmd = commands[i]?.type || "?";
        const status = res.success ? "OK" : "FAIL";
        const detail = res.success ? (res.result || "") : (res.error || "");
        return `[${i + 1}] ${cmd}: ${status}${detail ? " - " + detail : ""}`;
      });
      return `Batch results (${results.length} commands):\n${lines.join("\n")}`;
    }
  },
  {
    name: "bridge_insert_model",
    description: "Search the Roblox marketplace for a free model and insert it into Workspace near the camera.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query (e.g. 'sword', 'tree', 'car')" } },
      required: ["query"]
    },
    handler: async ({ query }) => {
      const r = await bridgeRun({ type: "insert_model", query }, 30000);
      return formatResult(r, "Insert Model");
    }
  },
  {
    name: "bridge_get_attributes",
    description: "Get all custom attributes on an instance.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Instance path" } },
      required: ["path"]
    },
    handler: async ({ path }) => {
      const r = await bridgeRun({ type: "get_attributes", path });
      if (!r.success) return `Error: ${r.error}`;
      const attrs = tryParseJSON(r.result);
      if (typeof attrs === "object" && attrs !== null && Object.keys(attrs).length === 0) return `(no attributes on ${path})`;
      return prettyJSON(r.result);
    }
  },
  {
    name: "bridge_set_attribute",
    description: "Set a custom attribute on an instance. Supports: string, number, boolean, Color3, Vector3, etc.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        attribute: { type: "string", description: "Attribute name" },
        value: { description: "Attribute value" }
      },
      required: ["path", "attribute", "value"]
    },
    handler: async ({ path, attribute, value }) => {
      const r = await bridgeRun({ type: "set_attribute", path, attribute, value });
      return formatResult(r, "Set Attribute");
    }
  },
  {
    name: "bridge_delete_attribute",
    description: "Remove a custom attribute from an instance.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        attribute: { type: "string", description: "Attribute name to remove" }
      },
      required: ["path", "attribute"]
    },
    handler: async ({ path, attribute }) => {
      const r = await bridgeRun({ type: "delete_attribute", path, attribute });
      return formatResult(r, "Delete Attribute");
    }
  },
  {
    name: "bridge_get_children",
    description: "Get a lightweight list of an instance's direct children (name, class, child count). Faster than bridge_tree for quick exploration.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", default: "game", description: "Instance path" } },
      required: []
    },
    handler: async ({ path = "game" }) => {
      const r = await bridgeRun({ type: "get_children", path });
      if (!r.success) return `Error: ${r.error}`;
      const items = tryParseJSON(r.result);
      if (!Array.isArray(items)) return r.result;
      if (items.length === 0) return `(${path} has no children)`;
      return `Children of ${path} (${items.length}):\n` +
        items.map(i => `  ${i.Name} [${i.ClassName}]${i.ChildCount > 0 ? ` (${i.ChildCount} children)` : ""}`).join("\n");
    }
  },
  {
    name: "bridge_game_map",
    description: "Scanning game structure — high-level overview of all services, script counts, and top children. Call this FIRST to orient yourself.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = await bridgeRun({ type: "game_map" }, 20000);
      if (!r.success) return `Error: ${r.error}`;
      const services = tryParseJSON(r.result);
      if (!Array.isArray(services)) return r.result;
      const lines = ["=== Game Structure Overview ===", ""];
      for (const svc of services) {
        const parts = [];
        if (svc.Scripts > 0) parts.push(`${svc.Scripts} Script`);
        if (svc.LocalScripts > 0) parts.push(`${svc.LocalScripts} LocalScript`);
        if (svc.ModuleScripts > 0) parts.push(`${svc.ModuleScripts} ModuleScript`);
        const scriptInfo = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        lines.push(`[${svc.Service}] ${svc.ChildCount} children, ${svc.DescendantCount} total${scriptInfo}`);
        if (svc.TopChildren?.length) {
          for (const child of svc.TopChildren) {
            lines.push(`   - ${child.Name} [${child.ClassName}]`);
          }
        }
        lines.push("");
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_scan_scripts",
    description: "Discovering all scripts — lists every Script, LocalScript, and ModuleScript with metadata. Set sources=true to read all code at once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game", description: "Root path to scan from (e.g. 'game' for everything, 'game.ServerScriptService' for server scripts only)" },
        sources: { type: "boolean", default: false, description: "Include full source code for each script (can be large for big games)" }
      },
      required: []
    },
    handler: async ({ path = "game", sources = false }) => {
      const r = await bridgeRun({ type: "scan_scripts", path, sources }, 30000);
      if (!r.success) return `Error: ${r.error}`;
      const scripts = tryParseJSON(r.result);
      if (!Array.isArray(scripts)) return r.result;
      if (scripts.length === 0) return "No scripts found under " + path;
      if (sources) {
        const parts = [`Found ${scripts.length} script(s):\n`];
        for (const s of scripts) {
          parts.push(`--- ${s.FullName} [${s.ClassName}] (${s.LineCount} lines) ---`);
          parts.push(s.Source || "(empty)");
          parts.push("");
        }
        return parts.join("\n");
      }
      const lines = [`Found ${scripts.length} script(s) under ${path}:\n`];
      for (const s of scripts) {
        lines.push(`  ${s.FullName} [${s.ClassName}] - ${s.LineCount} lines, ${s.CharCount} chars`);
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_search_code",
    description: "Searching all script source code — finds matching lines with script path and line number, like grep for Roblox.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text to search for (case-insensitive substring match)" },
        path: { type: "string", default: "game", description: "Root to search from" },
        limit: { type: "number", default: 50, description: "Maximum results to return" }
      },
      required: ["pattern"]
    },
    handler: async ({ pattern, path = "game", limit = 50 }) => {
      if (!pattern || typeof pattern !== "string") return "Error: 'pattern' is required and must be a string";
      const r = await bridgeRun({ type: "search_code", pattern, path, limit }, 30000);
      if (!r.success) return `Error: ${r.error}`;
      const results = tryParseJSON(r.result);
      if (!Array.isArray(results)) return r.result;
      if (results.length === 0) return `No matches found for "${pattern}"`;
      const lines = [`Found ${results.length} match(es) for "${pattern}":\n`];
      for (const m of results) {
        lines.push(`  ${m.Script}:${m.Line}: ${(m.Text || "").trim()}`);
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_script_edit",
    description: "Editing a script with find-and-replace — makes a precise text replacement in a script's source code. More efficient than rewriting the entire script.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Script path (e.g. 'game.ServerScriptService.MainScript')" },
        find: { type: "string", description: "Exact text to find in the script (plain text, first occurrence)" },
        replace: { type: "string", description: "Text to replace it with (use empty string to delete the matched text)" }
      },
      required: ["path", "find", "replace"]
    },
    handler: async ({ path, find, replace }) => {
      if (!path || typeof path !== "string") return "Error: 'path' is required";
      if (!find || typeof find !== "string") return "Error: 'find' is required";
      if (typeof replace !== "string") return "Error: 'replace' must be a string";
      const r = await bridgeRun({ type: "script_edit", path, find, replace });
      if (!r.success) return `Error: ${r.error}`;
      return r.result || "(edit applied)";
    }
  },
  {
    name: "bridge_require_graph",
    description: "Tracing require() dependencies across scripts — shows which scripts depend on which modules. Essential for understanding code architecture.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game", description: "Root path to scan from" }
      },
      required: []
    },
    handler: async ({ path = "game" }) => {
      const r = await bridgeRun({ type: "require_graph", path }, 30000);
      if (!r.success) return `Error: ${r.error}`;
      const graph = tryParseJSON(r.result);
      if (!Array.isArray(graph)) return r.result;
      if (graph.length === 0) return "No require() calls found in any scripts.";
      const lines = [`=== Require Dependency Graph (${graph.length} scripts with dependencies) ===\n`];
      for (const entry of graph) {
        lines.push(`${entry.Script} [${entry.ClassName}]`);
        for (const req of entry.Requires) {
          const resolved = req.Resolved ? ` -> ${req.Resolved}` : " (unresolved)";
          lines.push(`   requires ${req.Raw}${resolved}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_rojo_status",
    description: "Check if Rojo integration is active and where scripts will be written.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const lines = [];
      lines.push(`Rojo mode: ${rojoEnabled ? "ENABLED" : ROJO_DISABLED ? "EXPLICITLY DISABLED" : "DISABLED"}`);
      lines.push(`Project root: ${ROJO_PROJECT_ROOT}`);
      const projectFile = ROJO_PROJECT_FILE
        ? (pathModule.isAbsolute(ROJO_PROJECT_FILE) ? ROJO_PROJECT_FILE : pathModule.join(ROJO_PROJECT_ROOT, ROJO_PROJECT_FILE))
        : pathModule.join(ROJO_PROJECT_ROOT, "default.project.json");
      lines.push(`Project file: ${projectFile} (${fs.existsSync(projectFile) ? "found" : "NOT FOUND"})`);
      if (ROJO_DISABLED) {
        lines.push("\nRojo is explicitly disabled via settings. Using Studio Plugin for DataModel info.");
      } else if (rojoEnabled && rojoTree) {
        lines.push("\nMapped services:");
        for (const [key, value] of Object.entries(rojoTree)) {
          if (key.startsWith("$")) continue;
          const p = value?.["$path"];
          if (p) lines.push(`  ${key} → ${p}`);
        }
      }
      if (!rojoEnabled) {
        lines.push("\nScripts will be written directly to Studio.");
        if (!ROJO_DISABLED) {
          lines.push("To enable Rojo mode, create a default.project.json in your workspace root,");
          lines.push("or set bad-bridge.rojoProjectFile in VS Code settings to point to your project file.");
        }
      } else {
        lines.push("\nScripts will be written as .luau files to disk. Rojo syncs them to Studio.");
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_class_info",
    description: "Looking up settable properties for a Roblox ClassName — returns the list of known properties and their types. Use this before setting properties to know what's available and what format to use (e.g. Color3 vs BrickColor).",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string", description: "Roblox ClassName (e.g. 'Part', 'Model', 'TextLabel', 'PointLight')" },
        path: { type: "string", description: "Optional: path to a live instance to also read actual property types" }
      },
      required: ["className"]
    },
    handler: async ({ className, path }) => {
      const cmd = { type: "get_class_info", className };
      if (path) cmd.path = path;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      const info = tryParseJSON(r.result);
      if (typeof info !== "object" || !info) return r.result;
      const lines = [`=== ${info.ClassName} ===`];
      if (info.Known && info.Properties?.length) {
        lines.push(`\nPlugin Property Database (${info.Properties.length}):`);
        for (const prop of info.Properties) {
          const typeInfo = info.PropertyTypes?.[prop] ? ` : ${info.PropertyTypes[prop]}` : "";
          lines.push(`  ${prop}${typeInfo}`);
        }
      }
      // Supplement with Roblox API dump for full property coverage
      const dump = await getApiDump();
      if (dump) {
        const cls = apiLookupClass(dump, className);
        if (cls) {
          if (!info.Known) lines.push(`Superclass: ${cls.Superclass || "none"}`);
          const apiProps = apiGetAllProperties(dump, className);
          const writable = apiProps.filter(p => p.Writable);
          const extra = info.Known ? writable.filter(p => !info.Properties.includes(p.Name)) : writable;
          if (extra.length > 0) {
            lines.push(`\n${info.Known ? "Additional " : ""}Settable Properties from Roblox API (${extra.length}):`);
            for (const p of extra) {
              lines.push(`  ${p.Name} : ${p.ValueType}${p.From !== className ? ` (from ${p.From})` : ""}`);
            }
          }
          if (!info.Known) {
            const readOnly = apiProps.filter(p => !p.Writable);
            if (readOnly.length > 0) {
              lines.push(`\nRead-Only Properties (${readOnly.length}):`);
              for (const p of readOnly) {
                lines.push(`  ${p.Name} : ${p.ValueType}${p.From !== className ? ` (from ${p.From})` : ""}`);
              }
            }
          }
        } else if (!info.Known) {
          lines.push(`(Class '${className}' not found in Roblox API dump)`);
        }
      } else if (!info.Known) {
        lines.push("(Not in known property database and API dump unavailable — try bridge_props with specific property names)");
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_capabilities",
    description: "Checking Studio plugin capabilities — reports LoadStringEnabled status, plugin version, and which classes have known property databases. Call this to know what features are available before using bridge_run.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = await bridgeRun({ type: "get_capabilities" });
      if (!r.success) return `Error: ${r.error}`;
      const caps = tryParseJSON(r.result);
      if (typeof caps !== "object" || !caps) return r.result;
      const lines = [
        `=== Studio Plugin Capabilities ===`,
        `Plugin Version: v${caps.PluginVersion}`,
        `LoadStringEnabled: ${caps.LoadStringEnabled ? "YES — bridge_run is available" : "NO — bridge_run will not work. Use bridge_script_edit or bridge_script_write instead."}`,
        `Studio Running: ${caps.IsRunning ? "YES (play mode)" : "NO (edit mode)"}`,
      ];
      if (caps.KnownClasses?.length) {
        lines.push(`\nKnown Classes with property database (${caps.KnownClasses.length}):`);
        lines.push(`  ${caps.KnownClasses.join(", ")}`);
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_api_lookup",
    description: "Looking up Roblox API documentation — fetches the official API dump to get ALL properties, methods, and events for any ClassName including inherited members. Use this when you need complete information about a class.",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string", description: "Roblox ClassName (e.g. 'Part', 'Humanoid', 'PathfindingService', 'TweenService')" },
        members: { type: "string", enum: ["all", "properties", "methods", "events"], default: "all", description: "Which member types to return" },
        writableOnly: { type: "boolean", default: false, description: "Only show writable (settable) properties" }
      },
      required: ["className"]
    },
    handler: async ({ className, members = "all", writableOnly = false }) => {
      const dump = await getApiDump();
      if (!dump) return "Error: Could not fetch Roblox API dump. Check internet connection.";
      const cls = apiLookupClass(dump, className);
      if (!cls) return `Error: Class '${className}' not found in Roblox API. Check spelling.`;
      const lines = [`=== ${className} (extends ${cls.Superclass || "none"}) ===`];
      const clsTags = cls.Tags || [];
      if (clsTags.length > 0) lines.push(`Tags: ${clsTags.join(", ")}`);
      if (members === "all" || members === "properties") {
        let props = apiGetAllProperties(dump, className);
        if (writableOnly) props = props.filter(p => p.Writable);
        if (props.length > 0) {
          lines.push(`\nProperties (${props.length}):`);
          for (const p of props) {
            const flags = [];
            if (!p.Writable) flags.push("read-only");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            lines.push(`  ${p.Name} : ${p.ValueType}${flagStr}${p.From !== className ? ` (from ${p.From})` : ""}`);
          }
        }
      }
      if (members === "all" || members === "methods") {
        const methods = apiGetMethods(dump, className);
        if (methods.length > 0) {
          lines.push(`\nMethods (${methods.length}):`);
          for (const m of methods) {
            const params = m.Parameters.map(p => `${p.Name}: ${p.Type}`).join(", ");
            lines.push(`  ${m.Name}(${params}) -> ${m.ReturnType}${m.From !== className ? ` (from ${m.From})` : ""}`);
          }
        }
      }
      if (members === "all" || members === "events") {
        const events = apiGetEvents(dump, className);
        if (events.length > 0) {
          lines.push(`\nEvents (${events.length}):`);
          for (const e of events) {
            const params = e.Parameters.map(p => `${p.Name}: ${p.Type}`).join(", ");
            lines.push(`  ${e.Name}(${params})${e.From !== className ? ` (from ${e.From})` : ""}`);
          }
        }
      }
      return lines.join("\n");
    }
  },
  {
    name: "bridge_tags",
    description: "Managing CollectionService tags — get, add, remove tags on instances, or find all instances with a specific tag. Tags are used for grouping and identifying instances.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "add", "remove", "find"], description: "get = read tags, add = add tag, remove = remove tag, find = find instances by tag" },
        path: { type: "string", description: "Instance path (required for get/add/remove)" },
        tag: { type: "string", description: "Tag name (required for add/remove/find)" },
        limit: { type: "number", default: 50, description: "Max results for 'find' action" }
      },
      required: ["action"]
    },
    handler: async ({ action, path, tag, limit = 50 }) => {
      if (action === "get") {
        if (!path) return "Error: 'get' action requires 'path'";
        const r = await bridgeRun({ type: "get_tags", path });
        if (!r.success) return `Error: ${r.error}`;
        const tags = tryParseJSON(r.result);
        if (Array.isArray(tags) && tags.length === 0) return `(no tags on ${path})`;
        return `Tags on ${path}: ${Array.isArray(tags) ? tags.join(", ") : r.result}`;
      }
      if (action === "add") {
        if (!path || !tag) return "Error: 'add' action requires 'path' and 'tag'";
        const r = await bridgeRun({ type: "add_tag", path, tag });
        return formatResult(r, "Add Tag");
      }
      if (action === "remove") {
        if (!path || !tag) return "Error: 'remove' action requires 'path' and 'tag'";
        const r = await bridgeRun({ type: "remove_tag", path, tag });
        return formatResult(r, "Remove Tag");
      }
      if (action === "find") {
        if (!tag) return "Error: 'find' action requires 'tag'";
        const r = await bridgeRun({ type: "find_tagged", tag, limit });
        if (!r.success) return `Error: ${r.error}`;
        const items = tryParseJSON(r.result);
        if (!Array.isArray(items)) return r.result;
        if (items.length === 0) return `No instances found with tag "${tag}"`;
        return `Instances with tag "${tag}" (${items.length}):\n` + items.map(i => `  ${i.FullName} [${i.ClassName}]`).join("\n");
      }
      return "Error: action must be 'get', 'add', 'remove', or 'find'";
    }
  },
  {
    name: "bridge_tween",
    description: "Animate instance properties smoothly using TweenService — transitions Position, Color, Size, Transparency, etc. over time with easing. Great for testing visual feedback and UI animations.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path to tween" },
        properties: { type: "object", description: "Target property values: {\"Position\": {\"x\":10,\"y\":5,\"z\":0}, \"Transparency\": 0.5}" },
        duration: { type: "number", default: 1, description: "Duration in seconds" },
        easingStyle: { type: "string", enum: ["Linear","Sine","Back","Quad","Quart","Quint","Bounce","Elastic","Exponential","Circular","Cubic"], default: "Quad", description: "Easing style" },
        easingDirection: { type: "string", enum: ["In","Out","InOut"], default: "Out", description: "Easing direction" },
        wait: { type: "boolean", default: false, description: "Wait for the tween to complete before returning" }
      },
      required: ["path", "properties"]
    },
    handler: async ({ path, properties, duration = 1, easingStyle = "Quad", easingDirection = "Out", wait = false }) => {
      if (!path) return "Error: 'path' is required";
      if (!properties || typeof properties !== "object") return "Error: 'properties' must be an object with target values";
      const timeoutMs = wait ? (duration + 10) * 1000 : 15000;
      const r = await bridgeRun({ type: "tween", path, properties, duration, easingStyle, easingDirection, wait }, timeoutMs);
      return formatResult(r, "Tween");
    }
  },
  {
    name: "bridge_raycast",
    description: "Cast a ray in the 3D world to check what geometry exists — useful for line-of-sight checks, pathfinding validation, ground detection, and understanding the physical layout.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"], description: "Ray start position" },
        direction: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"], description: "Ray direction and length (magnitude = ray distance)" },
        filterType: { type: "string", enum: ["include", "exclude"], description: "Filter type for instances" },
        filterPaths: { type: "array", items: { type: "string" }, description: "Instance paths to include/exclude" }
      },
      required: ["origin", "direction"]
    },
    handler: async ({ origin, direction, filterType, filterPaths }) => {
      const cmd = { type: "raycast", origin, direction };
      if (filterType) cmd.filterType = filterType;
      if (filterPaths) cmd.filterPaths = filterPaths;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      const data = tryParseJSON(r.result);
      if (typeof data !== "object" || !data) return r.result;
      if (!data.Hit) return `Ray did not hit anything (traveled ${data.Distance?.toFixed?.(1) || data.Distance || "?"} studs)`;
      return `Hit: ${data.Instance} [${data.ClassName}]\nPosition: (${data.Position.x.toFixed(1)}, ${data.Position.y.toFixed(1)}, ${data.Position.z.toFixed(1)})\nNormal: (${data.Normal.x.toFixed(2)}, ${data.Normal.y.toFixed(2)}, ${data.Normal.z.toFixed(2)})\nMaterial: ${data.Material}\nDistance: ${data.Distance?.toFixed?.(1) || data.Distance} studs`;
    }
  },
  {
    name: "bridge_set_properties",
    description: "Set multiple properties on a single instance in one call — more efficient than calling bridge_set_property multiple times. Supports all rich types (Color3, Vector3, CFrame, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        properties: { type: "object", description: "Property name → value map. Same format as bridge_set_property values." }
      },
      required: ["path", "properties"]
    },
    handler: async ({ path, properties }) => {
      if (!path) return "Error: 'path' is required";
      if (!properties || typeof properties !== "object") return "Error: 'properties' must be an object";
      const r = await bridgeRun({ type: "set_properties", path, properties });
      return formatResult(r, "Set Properties");
    }
  },
  {
    name: "bridge_character_control",
    description: "Real-time character control in play mode — start a control session, then move the character around, jump, interact with objects, equip tools, and read back the character's state including nearby objects and spatial awareness via raycasts. The agent can navigate the game world, test mechanics, and validate gameplay.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "state", "move_to", "move_direction", "jump", "look_at", "teleport", "stop_moving", "equip", "unequip", "use_tool", "interact", "wait", "scan", "stop"],
          description: "start = begin control session (enters play mode), state = get character state + nearby objects, move_to = walk to {x,y,z}, move_direction = continuous move {x,z} like WASD, jump = jump, look_at = face {x,y,z}, teleport = instant move to {x,y,z}, stop_moving = stop, equip/unequip = manage tools, use_tool = activate equipped tool, interact = fire ProximityPrompt/ClickDetector, wait = pause, scan = get detailed surroundings, stop = end session"
        },
        x: { type: "number", description: "X coordinate (for move_to, teleport, look_at, move_direction)" },
        y: { type: "number", description: "Y coordinate (for move_to, teleport, look_at)" },
        z: { type: "number", description: "Z coordinate (for move_to, teleport, look_at, move_direction)" },
        tool: { type: "string", description: "Tool name (for equip action)" },
        target: { type: "string", description: "Instance path (for interact action, e.g. 'game.Workspace.Door.ProximityPrompt')" },
        duration: { type: "number", description: "Wait duration in seconds (for wait action)" },
        timeout: { type: "number", default: 300, description: "Session timeout in seconds (for start action, default 5 minutes)" },
        scanRadius: { type: "number", default: 30, description: "Nearby object scan radius in studs (for start action)" },
        mode: { type: "string", enum: ["start_play", "run_server"], default: "start_play", description: "Play mode type (for start action)" }
      },
      required: ["action"]
    },
    handler: async ({ action, x, y, z, tool, target, duration, timeout = 300, scanRadius = 30, mode = "start_play" }) => {
      // Start session
      if (action === "start") {
        // Clear any stale control state first
        await bridgeGet("/control"); // just to check
        const r = await bridgeRun({ type: "start_character_control", mode, timeout, scanRadius }, 30000);
        if (!r.success) return `Error: ${r.error}`;
        // Wait a moment for play mode to start and character to spawn
        await sleep(3000);
        // Get initial state
        const state = await bridgeGet("/control/state");
        if (state && state.active) {
          const lines = ["Control session started!", ""];
          lines.push(formatCharacterState(state));
          return lines.join("\n");
        }
        return r.result || "Control session starting... Use action='state' in a moment to check character status.";
      }

      // Stop session
      if (action === "stop") {
        const r = await bridgeRun({ type: "stop_character_control" }, 15000);
        return formatResult(r, "Stop Control");
      }

      // Get state
      if (action === "state" || action === "scan") {
        const state = await bridgeGet("/control/state");
        if (!state || state.error) return `Error: ${state?.error || "No control session active. Use action='start' first."}`;
        if (!state.active) return "No control session active. Use action='start' first.";
        return formatCharacterState(state);
      }

      // All other actions: push input to control queue
      const input = { action };
      if (x !== undefined) input.x = x;
      if (y !== undefined) input.y = y;
      if (z !== undefined) input.z = z;
      if (tool) input.tool = tool;
      if (target) input.target = target;
      if (duration) input.duration = duration;

      // Push the input
      const pushResult = await new Promise((resolve) => {
        const body = JSON.stringify(input);
        const req = http.request(`${BRIDGE}/control/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 5000,
        }, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: "bad response" }); } });
        });
        req.on("error", e => resolve({ error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
        req.write(body);
        req.end();
      });

      if (pushResult.error) return `Error sending control input: ${pushResult.error}`;

      // For movement actions, wait a moment then return updated state
      const waitTime = action === "wait" ? ((duration || 1) * 1000 + 500) :
                       action === "move_to" ? 1500 :
                       action === "teleport" ? 500 :
                       action === "interact" ? 2000 :
                       action === "jump" ? 800 :
                       600;
      await sleep(waitTime);

      const state = await bridgeGet("/control/state");
      if (state && state.active) {
        const actionDesc = {
          move_to: `Moving to (${x||0}, ${y||""}, ${z||0})`,
          move_direction: `Moving direction (${x||0}, ${z||0})`,
          jump: "Jumping",
          look_at: `Looking at (${x||0}, ${y||""}, ${z||0})`,
          teleport: `Teleported to (${x||0}, ${y||0}, ${z||0})`,
          stop_moving: "Stopped",
          equip: `Equipping ${tool}`,
          unequip: "Unequipped tools",
          use_tool: "Using tool",
          interact: `Interacting with ${target}`,
          wait: `Waited ${duration||1}s`,
        };
        return `${actionDesc[action] || action}\n\n${formatCharacterState(state)}`;
      }
      return `${action} command sent.`;
    }
  },
  // ── Terrain ──
  {
    name: "bridge_terrain",
    description: "Modify terrain — fill regions with materials (block, ball, cylinder shapes), clear terrain, or replace one material with another.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["fill", "replace", "clear"], description: "fill = add terrain, replace = swap materials, clear = remove terrain" },
        shape: { type: "string", enum: ["block", "ball", "cylinder"], default: "block", description: "Shape for fill action" },
        material: { type: "string", description: "Terrain material name (e.g. Grass, Sand, Rock, Water, Snow, Ice, Mud, Slate)" },
        position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "Center position" },
        size: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "Size for block/clear" },
        radius: { type: "number", description: "Radius for ball/cylinder" },
        height: { type: "number", description: "Height for cylinder" },
        from: { type: "string", description: "Material to replace (for replace action)" },
        to: { type: "string", description: "Replacement material (for replace action)" },
      },
      required: ["action"]
    },
    handler: async ({ action, shape, material, position, size, radius, height, from, to }) => {
      if (action === "fill") {
        const r = await bridgeRun({ type: "fill_terrain", shape: shape || "block", material: material || "Grass", position: position || {x:0,y:0,z:0}, size, radius, height });
        return formatResult(r, "Fill Terrain");
      } else if (action === "replace") {
        const r = await bridgeRun({ type: "replace_terrain", from: from || "Grass", to: to || "Sand", position: position || {x:0,y:0,z:0}, size: size || {x:100,y:100,z:100} });
        return formatResult(r, "Replace Terrain");
      } else if (action === "clear") {
        const r = await bridgeRun({ type: "fill_terrain", shape: "clear", position: position || {x:0,y:0,z:0}, size: size || {x:50,y:50,z:50} });
        return formatResult(r, "Clear Terrain");
      }
      return "Error: action must be fill, replace, or clear";
    }
  },
  // ── Lighting ──
  {
    name: "bridge_lighting",
    description: "Configure Lighting service properties and post-processing effects (Bloom, DepthOfField, ColorCorrection, SunRays, Atmosphere, Sky) in one call.",
    inputSchema: {
      type: "object",
      properties: {
        properties: { type: "object", description: "Lighting properties to set (e.g. Ambient, Brightness, ClockTime, FogColor, FogEnd, OutdoorAmbient, TimeOfDay, GeographicLatitude)" },
        effects: { type: "object", description: "Child effects to configure, keyed by instance name. E.g. {\"Bloom\": {\"Intensity\": 0.5, \"Size\": 24}}" },
        effectClasses: { type: "object", description: "Class names for effects to auto-create if missing. E.g. {\"Bloom\": \"BloomEffect\"}" },
      }
    },
    handler: async ({ properties, effects, effectClasses }) => {
      const r = await bridgeRun({ type: "set_lighting", properties: properties || {}, effects: effects || {}, effectClasses: effectClasses || {} });
      return formatResult(r, "Lighting");
    }
  },
  // ── Sound ──
  {
    name: "bridge_sound",
    description: "Create, play, stop, pause, or resume sounds in the game. Can create new Sound instances with properties or control existing ones.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "play", "stop", "pause", "resume"], description: "Sound action" },
        path: { type: "string", description: "Path to existing sound instance (for play/stop/pause/resume)" },
        parent: { type: "string", description: "Parent path for new sound (for create)" },
        name: { type: "string", description: "Sound name (for create)" },
        soundId: { type: "string", description: "Roblox asset ID (e.g. rbxassetid://123456)" },
        volume: { type: "number", description: "Volume 0-1" },
        looped: { type: "boolean", description: "Loop playback" },
        playbackSpeed: { type: "number", description: "Playback speed multiplier" },
        autoPlay: { type: "boolean", description: "Start playing immediately after creation" },
      },
      required: ["action"]
    },
    handler: async ({ action, path: soundPath, parent, name, soundId, volume, looped, playbackSpeed, autoPlay }) => {
      const r = await bridgeRun({ type: "play_sound", action, path: soundPath, parent, name, soundId, volume, looped, playbackSpeed, autoPlay });
      return formatResult(r, "Sound");
    }
  },
  // ── GUI Builder ──
  {
    name: "bridge_gui_builder",
    description: "Create entire UI hierarchies from a declarative JSON spec. Build complex UIs with nested Frames, TextLabels, TextButtons, ImageLabels, etc. in a single call instead of dozens of bridge_create calls.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", default: "game.StarterGui", description: "Parent instance path" },
        spec: {
          type: "object",
          description: "UI spec: {className, name, properties: {Size, Position, ...}, children: [{className, name, properties, children},...]}",
          properties: {
            className: { type: "string" },
            name: { type: "string" },
            properties: { type: "object" },
            children: { type: "array", items: { type: "object" } },
          }
        }
      },
      required: ["spec"]
    },
    handler: async ({ parent, spec }) => {
      const r = await bridgeRun({ type: "build_gui", parent: parent || "game.StarterGui", spec });
      return formatResult(r, "GUI Builder");
    }
  },
  // ── Constraint ──
  {
    name: "bridge_constraint",
    description: "Create physics constraints between two parts — WeldConstraint, HingeConstraint, RopeConstraint, SpringConstraint, RodConstraint, etc. Automatically creates Attachments for non-weld constraints.",
    inputSchema: {
      type: "object",
      properties: {
        constraintType: { type: "string", default: "WeldConstraint", description: "Constraint class name" },
        part0: { type: "string", description: "Path to first part" },
        part1: { type: "string", description: "Path to second part" },
        name: { type: "string", description: "Constraint name" },
        properties: { type: "object", description: "Extra properties (e.g. {ActuatorType: 'Motor', AngularSpeed: 10})" },
      },
      required: ["part0", "part1"]
    },
    handler: async ({ constraintType, part0, part1, name, properties }) => {
      const r = await bridgeRun({ type: "create_constraint", constraintType: constraintType || "WeldConstraint", part0, part1, name, properties });
      return formatResult(r, "Constraint");
    }
  },
  // ── Particles ──
  {
    name: "bridge_particles",
    description: "Create particle emitters with built-in presets (fire, smoke, sparkle, rain, snow) or custom properties. Attach to any BasePart.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "Part to attach particles to" },
        preset: { type: "string", enum: ["fire", "smoke", "sparkle", "rain", "snow", "custom"], default: "custom", description: "Preset template" },
        name: { type: "string", description: "Emitter name" },
        properties: { type: "object", description: "Override/custom properties (Rate, Lifetime, Speed, Color, etc.)" },
      },
      required: ["parent"]
    },
    handler: async ({ parent, preset, name, properties }) => {
      const r = await bridgeRun({ type: "create_particles", parent, preset: preset || "custom", name, properties });
      return formatResult(r, "Particles");
    }
  },
  // ── Snapshot/Diff ──
  {
    name: "bridge_diff",
    description: "Save a snapshot of a subtree's state, then compare it later to detect what changed. Use 'save' to capture state, 'compare' to find differences, 'list' to see saved snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "compare", "list"], description: "save = capture snapshot, compare = diff against saved, list = show saved snapshots" },
        path: { type: "string", default: "game.Workspace", description: "Instance path to snapshot" },
        name: { type: "string", description: "Snapshot name (for save/compare)" },
        depth: { type: "number", default: 10, description: "Max depth to capture" },
      },
      required: ["action"]
    },
    handler: async ({ action, path: instPath, name: snapName, depth }) => {
      if (action === "list") {
        ensureMemoryDir();
        if (!fs.existsSync(SNAPSHOT_DIR)) return "No snapshots saved yet.";
        const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith(".json"));
        if (files.length === 0) return "No snapshots saved yet.";
        return "Saved snapshots:\n" + files.map(f => "  - " + f.replace(".json", "")).join("\n");
      }
      if (!snapName) return "Error: 'name' is required for save/compare";
      const snapPath = pathModule.join(SNAPSHOT_DIR, snapName + ".json");

      if (action === "save") {
        const r = await bridgeRun({ type: "save_snapshot", path: instPath || "game.Workspace", depth: depth || 10 });
        if (!r.success) return `Error: ${r.error}`;
        ensureMemoryDir();
        if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
        fs.writeFileSync(snapPath, r.result);
        return `Snapshot '${snapName}' saved (${instPath || "game.Workspace"})`;
      }

      if (action === "compare") {
        if (!fs.existsSync(snapPath)) return `Error: Snapshot '${snapName}' not found. Use action='list' to see available snapshots.`;
        const snapshot = JSON.parse(fs.readFileSync(snapPath, "utf8"));
        const r = await bridgeRun({ type: "compare_snapshot", path: instPath || "game.Workspace", snapshot });
        if (!r.success) return `Error: ${r.error}`;
        if (r.result === "No differences found") return "No differences found.";
        try {
          const diffs = JSON.parse(r.result);
          const lines = [`=== ${diffs.length} Difference(s) ===`];
          for (const d of diffs.slice(0, 50)) {
            if (d.change) {
              lines.push(`  ${d.change.toUpperCase()}: ${d.path}.${d.name} (${d.className})`);
            } else {
              lines.push(`  CHANGED: ${d.path}.${d.field}: ${JSON.stringify(d.expected)} → ${JSON.stringify(d.actual)}`);
            }
          }
          if (diffs.length > 50) lines.push(`  ... and ${diffs.length - 50} more`);
          return lines.join("\n");
        } catch { return r.result; }
      }
      return "Error: action must be save, compare, or list";
    }
  },
  // ── Export ──
  {
    name: "bridge_export",
    description: "Export a subtree as JSON (with all properties and optionally script sources). Useful for version control, backup, or transferring between places.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game.Workspace", description: "Instance path to export" },
        depth: { type: "number", default: 20, description: "Max depth" },
        includeSource: { type: "boolean", default: false, description: "Include script source code" },
        saveTo: { type: "string", description: "Optional filename to save to .bridge/exports/ directory" },
      }
    },
    handler: async ({ path: instPath, depth, includeSource, saveTo }) => {
      const r = await bridgeRun({ type: "export_tree", path: instPath || "game.Workspace", depth: depth || 20, includeSource: includeSource || false });
      if (!r.success) return `Error: ${r.error}`;
      if (saveTo) {
        ensureMemoryDir();
        const exportDir = pathModule.join(MEMORY_DIR, "exports");
        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
        const exportPath = pathModule.join(exportDir, saveTo.endsWith(".json") ? saveTo : saveTo + ".json");
        fs.writeFileSync(exportPath, r.result);
        return `Exported to ${exportPath}`;
      }
      return r.result;
    }
  },
  // ── Animate ──
  {
    name: "bridge_animate",
    description: "Create KeyframeSequence animations with poses for character parts. Define keyframes with time, part poses (CFrame offsets), and easing.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", default: "game.Workspace", description: "Where to create the animation" },
        name: { type: "string", default: "Animation", description: "Animation name" },
        loop: { type: "boolean", default: false },
        priority: { type: "string", default: "Action", description: "AnimationPriority (Core, Idle, Movement, Action)" },
        keyframes: {
          type: "array",
          description: "Array of keyframes: [{time: 0, name: 'Start', poses: [{part: 'RightArm', cframe: {rx: 45}, weight: 1, easing: 'Linear'}]}]",
          items: { type: "object" }
        },
      },
      required: ["keyframes"]
    },
    handler: async ({ parent, name, loop, priority, keyframes }) => {
      const r = await bridgeRun({ type: "create_animation", parent: parent || "game.Workspace", name: name || "Animation", loop, priority, keyframes });
      return formatResult(r, "Animation");
    }
  },
  // ── Context Memory ──
  {
    name: "bridge_memory",
    description: "Persistent context memory — save/recall facts about the game across sessions. Store architecture notes, conventions, important instance locations, or any knowledge that helps future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "recall", "list", "clear", "save_architecture"], description: "save = store a fact, recall = search facts, list = show all, clear = remove all, save_architecture = store game architecture summary" },
        fact: { type: "string", description: "The fact to save (for save action)" },
        category: { type: "string", description: "Category tag (e.g. 'scripts', 'layout', 'conventions', 'bugs')" },
        query: { type: "string", description: "Search term (for recall action)" },
        architecture: { type: "string", description: "Architecture summary text (for save_architecture)" },
      },
      required: ["action"]
    },
    handler: async ({ action, fact, category, query, architecture }) => {
      const mem = loadMemory();

      if (action === "save") {
        if (!fact) return "Error: 'fact' is required";
        mem.facts.push({ fact, category: category || "general", ts: new Date().toISOString() });
        saveMemory(mem);
        return `Saved: "${fact}" [${category || "general"}]`;
      }

      if (action === "recall") {
        if (!mem.facts.length) return "No facts stored yet.";
        let results = mem.facts;
        if (query) {
          const q = query.toLowerCase();
          results = results.filter(f => f.fact.toLowerCase().includes(q) || (f.category || "").toLowerCase().includes(q));
        }
        if (category) {
          results = results.filter(f => f.category === category);
        }
        if (results.length === 0) return "No matching facts found.";
        return results.map((f, i) => `${i + 1}. [${f.category}] ${f.fact}`).join("\n");
      }

      if (action === "list") {
        if (!mem.facts.length) return "No facts stored yet.";
        const byCategory = {};
        for (const f of mem.facts) {
          const cat = f.category || "general";
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(f.fact);
        }
        const lines = [];
        for (const [cat, facts] of Object.entries(byCategory)) {
          lines.push(`\n=== ${cat} ===`);
          for (const f of facts) lines.push(`  - ${f}`);
        }
        if (mem.architecture) lines.push("\n=== Architecture ===\n" + mem.architecture);
        return lines.join("\n");
      }

      if (action === "save_architecture") {
        if (!architecture) return "Error: 'architecture' text is required";
        mem.architecture = architecture;
        mem.lastScan = new Date().toISOString();
        saveMemory(mem);
        return "Architecture summary saved.";
      }

      if (action === "clear") {
        saveMemory({ facts: [], architecture: null, lastScan: null });
        return "Memory cleared.";
      }
      return "Error: unknown action";
    }
  },
  // ── Command History ──
  {
    name: "bridge_history",
    description: "View recent bridge command history — see what tools were called, with what arguments, and what results they produced. Useful for reviewing past actions.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", default: 20, description: "Number of recent entries to show" },
        filter: { type: "string", description: "Filter by tool name substring" },
      }
    },
    handler: async ({ count, filter }) => {
      const history = loadHistory();
      let entries = history.slice(-(count || 20));
      if (filter) entries = entries.filter(e => e.tool.includes(filter));
      if (entries.length === 0) return "No command history yet.";
      return entries.map((e, i) => `${i + 1}. [${e.ts?.slice(11, 19) || "?"}] ${e.tool} → ${e.result}`).join("\n");
    }
  },
  // ── Test Runner ──
  {
    name: "bridge_test_runner",
    description: "Run multiple test scripts in sequence in play mode, collecting pass/fail results. Each test is a Luau snippet that should error on failure. Returns a summary report.",
    inputSchema: {
      type: "object",
      properties: {
        tests: {
          type: "array",
          description: "Array of test objects: [{name: 'test name', code: 'assert(condition, msg)'}]",
          items: {
            type: "object",
            properties: { name: { type: "string" }, code: { type: "string" } },
            required: ["name", "code"]
          }
        },
        mode: { type: "string", default: "start_play", description: "Play mode type" },
        timeout: { type: "number", default: 30, description: "Timeout per test in seconds" },
      },
      required: ["tests"]
    },
    handler: async ({ tests, mode, timeout: testTimeout }) => {
      if (!tests || !tests.length) return "Error: at least one test required";
      const results = [];
      for (const test of tests) {
        const wrappedCode = `
local testName = "${(test.name || "unnamed").replace(/"/g, '\\"')}"
local ok, err = pcall(function()
${test.code}
end)
if ok then
  return "PASS: " .. testName
else
  return "FAIL: " .. testName .. " — " .. tostring(err)
end`;
        const r = await bridgeRun({
          type: "run_script_in_play_mode",
          code: wrappedCode,
          mode: mode || "start_play",
          timeout: (testTimeout || 30) * 1000,
        }, ((testTimeout || 30) + 10) * 1000);

        if (r.success) {
          const val = r.result || "";
          results.push(val.includes("FAIL") ? val : (val || `PASS: ${test.name}`));
        } else {
          results.push(`FAIL: ${test.name} — ${r.error || "unknown error"}`);
        }
      }
      const passed = results.filter(r => r.startsWith("PASS")).length;
      const failed = results.filter(r => r.startsWith("FAIL")).length;
      return `=== Test Results: ${passed} passed, ${failed} failed ===\n${results.join("\n")}`;
    }
  },
];

function formatCharacterState(state) {
  const lines = [];
  if (!state.alive && state.alive !== undefined) {
    lines.push("STATUS: DEAD");
    if (state.position) lines.push(`Last position: (${state.position.x}, ${state.position.y}, ${state.position.z})`);
    return lines.join("\n");
  }
  lines.push(`=== Character State (${state.timestamp?.toFixed?.(1) || "?"}s) ===`);
  if (state.position) lines.push(`Position: (${state.position.x}, ${state.position.y}, ${state.position.z})`);
  if (state.health !== undefined) lines.push(`Health: ${state.health}/${state.maxHealth}`);
  if (state.moveState) lines.push(`State: ${state.moveState}${state.isGrounded ? " (grounded)" : " (airborne)"}`);
  if (state.velocity !== undefined) lines.push(`Speed: ${state.velocity} studs/s`);
  if (state.facing) lines.push(`Facing: (${state.facing.x}, ${state.facing.y}, ${state.facing.z})`);
  if (state.walkSpeed) lines.push(`WalkSpeed: ${state.walkSpeed}, JumpPower: ${state.jumpPower || "?"}`);
  if (state.equippedTool) lines.push(`Equipped: ${state.equippedTool}`);
  if (state.backpack?.length) lines.push(`Backpack: ${state.backpack.join(", ")}`);
  return lines.join("\n");
}

//  MCP stdio protocol 

const toolMap = {};
for (const t of TOOLS) toolMap[t.name] = t;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "bad-bridge-mcp", version: SERVER_VERSION }
    });
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") return;

  if (method === "tools/list") {
    sendResult(id, {
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const tool = toolMap[toolName];
    if (!tool) {
      sendResult(id, {
        content: [{ type: "text", text: `Unknown tool: ${toolName}. Use tools/list to see available tools.` }],
        isError: true
      });
      return;
    }
    tool.handler(args).then(text => {
      const result = String(text);
      addToHistory(toolName, args, result.slice(0, 200));
      sendResult(id, { content: [{ type: "text", text: result }] });
    }).catch(err => {
      addToHistory(toolName, args, `ERROR: ${err.message}`);
      sendResult(id, {
        content: [{ type: "text", text: `Tool error (${toolName}): ${err.message}` }],
        isError: true
      });
    });
    return;
  }

  if (method === "resources/list") {
    sendResult(id, { resources: [] });
    return;
  }

  if (method === "prompts/list") {
    sendResult(id, { prompts: [] });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

//  Read stdin line by line 

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleRequest(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`MCP parse error: ${e.message}\nInput: ${line.substring(0, 200)}\n`);
  }
});
rl.on("close", () => process.exit(0));

process.stderr.write(`BAD Bridge MCP Server v${SERVER_VERSION} started (protocol ${MCP_VERSION})\n`);
