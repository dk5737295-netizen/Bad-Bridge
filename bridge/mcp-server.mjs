#!/usr/bin/env node
// BAD Bridge MCP Server — exposes Roblox Studio bridge commands as native MCP tools
// Uses stdio transport for direct integration with VS Code Copilot
// Rojo-aware: script edits write .luau files to disk instead of pushing Source into Studio

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "http";
import fs from "fs";
import path from "path";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";

// ── Rojo integration ──

const ROJO_PROJECT_ROOT = process.env.ROJO_PROJECT_ROOT || process.cwd();
const ROJO_PROJECT_FILE = process.env.ROJO_PROJECT_FILE || "";
const ROJO_DISABLED = (process.env.ROJO_DISABLED || "").toLowerCase() === "true";
let rojoTree = null; // parsed project tree
let rojoEnabled = false;

/**
 * Load and parse the Rojo project file from the project root.
 * Respects ROJO_PROJECT_FILE env var for custom path, and ROJO_DISABLED to skip entirely.
 * Builds a map of DataModel paths → filesystem paths.
 */
function loadRojoProject() {
  if (ROJO_DISABLED) {
    process.stderr.write(`[BAD Bridge] Rojo mode explicitly disabled — using Studio Plugin for DataModel info.\n`);
    rojoEnabled = false;
    return;
  }
  const projectFile = ROJO_PROJECT_FILE
    ? (path.isAbsolute(ROJO_PROJECT_FILE) ? ROJO_PROJECT_FILE : path.join(ROJO_PROJECT_ROOT, ROJO_PROJECT_FILE))
    : path.join(ROJO_PROJECT_ROOT, "default.project.json");
  if (!fs.existsSync(projectFile)) {
    process.stderr.write(`[BAD Bridge] No project file found at ${projectFile} — Rojo mode disabled, using Studio Plugin for DataModel info.\n`);
    rojoEnabled = false;
    return;
  }
  try {
    const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
    rojoTree = project.tree || {};
    rojoEnabled = true;
    process.stderr.write(`[BAD Bridge] Rojo project loaded from ${projectFile} — script edits will write to disk.\n`);
  } catch (e) {
    process.stderr.write(`[BAD Bridge] Failed to parse default.project.json: ${e.message}\n`);
    rojoEnabled = false;
  }
}

/**
 * Map a DataModel instance path (e.g. "game.ServerScriptService.MyScript")
 * to a filesystem path using the Rojo project tree.
 * Returns { filePath, scriptType } or null if not mapped.
 */
function rojoResolve(instancePath) {
  if (!rojoEnabled || !rojoTree) return null;

  const parts = instancePath.split(".");
  // Strip leading "game" if present
  if (parts[0] === "game") parts.shift();

  // Walk the Rojo tree to find the $path for the root service
  let node = rojoTree;
  let fsBase = null;
  let consumed = 0;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (node[key]) {
      node = node[key];
      consumed = i + 1;
      if (node["$path"]) {
        fsBase = node["$path"];
      }
    } else {
      break;
    }
  }

  if (!fsBase) return null;

  // Remaining path segments become filesystem directories/files
  const remaining = parts.slice(consumed);
  const fsDir = path.join(ROJO_PROJECT_ROOT, fsBase, ...remaining.slice(0, -1));
  const scriptName = remaining.length > 0 ? remaining[remaining.length - 1] : null;

  return { fsBase: path.join(ROJO_PROJECT_ROOT, fsBase), fsDir, scriptName, remaining };
}

/**
 * Determine the correct file extension based on script class.
 */
function scriptExtension(className) {
  if (className === "Script") return ".server.luau";
  if (className === "LocalScript") return ".client.luau";
  return ".luau"; // ModuleScript
}

/**
 * Detect script class from file extension.
 */
function classFromExtension(filePath) {
  if (filePath.endsWith(".server.luau") || filePath.endsWith(".server.lua")) return "Script";
  if (filePath.endsWith(".client.luau") || filePath.endsWith(".client.lua")) return "LocalScript";
  return "ModuleScript";
}

/**
 * Write a script to disk in the Rojo project structure.
 * instancePath: e.g. "game.ServerScriptService.MyScript"
 * source: Luau source code
 * className: "Script", "LocalScript", or "ModuleScript" (optional, auto-detected from path)
 * Returns { success, filePath, message } or null if Rojo can't map it.
 */
function writeScriptToDisk(instancePath, source, className) {
  const resolved = rojoResolve(instancePath);
  if (!resolved) return null;

  const { fsBase, fsDir, scriptName, remaining } = resolved;

  // If no remaining segments, we're writing to a root init file
  if (!scriptName) {
    const initFile = path.join(fsBase, "init" + scriptExtension(className || "ModuleScript"));
    fs.mkdirSync(path.dirname(initFile), { recursive: true });
    fs.writeFileSync(initFile, source, "utf-8");
    return { success: true, filePath: initFile, message: `Wrote ${initFile}` };
  }

  // Determine extension
  const ext = scriptExtension(className || guessClassFromPath(instancePath));
  const filePath = path.join(fsDir, scriptName + ext);

  fs.mkdirSync(fsDir, { recursive: true });
  fs.writeFileSync(filePath, source, "utf-8");
  return { success: true, filePath, message: `Wrote ${filePath}` };
}

/**
 * Read a script from disk in the Rojo project structure.
 * Returns { success, source, filePath } or null if not found.
 */
function readScriptFromDisk(instancePath) {
  const resolved = rojoResolve(instancePath);
  if (!resolved) return null;

  const { fsBase, fsDir, scriptName, remaining } = resolved;

  if (!scriptName) {
    // Root — look for init files
    for (const ext of [".server.luau", ".client.luau", ".luau", ".server.lua", ".client.lua", ".lua"]) {
      const initFile = path.join(fsBase, "init" + ext);
      if (fs.existsSync(initFile)) {
        return { success: true, source: fs.readFileSync(initFile, "utf-8"), filePath: initFile };
      }
    }
    return null;
  }

  // Try all extensions
  for (const ext of [".server.luau", ".client.luau", ".luau", ".server.lua", ".client.lua", ".lua"]) {
    const filePath = path.join(fsDir, scriptName + ext);
    if (fs.existsSync(filePath)) {
      return { success: true, source: fs.readFileSync(filePath, "utf-8"), filePath };
    }
  }

  // Could also be a folder with init file
  const folderPath = path.join(fsDir, scriptName);
  if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
    for (const ext of [".server.luau", ".client.luau", ".luau", ".server.lua", ".client.lua", ".lua"]) {
      const initFile = path.join(folderPath, "init" + ext);
      if (fs.existsSync(initFile)) {
        return { success: true, source: fs.readFileSync(initFile, "utf-8"), filePath: initFile };
      }
    }
  }

  return null;
}

/**
 * Guess script class from DataModel path.
 */
function guessClassFromPath(instancePath) {
  if (instancePath.includes("ServerScriptService") || instancePath.includes("ServerStorage")) return "Script";
  if (instancePath.includes("StarterPlayerScripts") || instancePath.includes("StarterCharacterScripts") || instancePath.includes("StarterGui")) return "LocalScript";
  return "ModuleScript";
}

// Load Rojo project on startup
loadRojoProject();

// ── HTTP helper — calls the bridge server's /run endpoint (send + wait) ──

function bridgeRun(cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(cmd);
    const url = new URL(`/run?timeout=${timeoutMs}`, BRIDGE_URL);

    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: timeoutMs + 5000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ success: false, error: "Invalid JSON from bridge", raw: data });
        }
      });
    });

    req.on("error", (e) => resolve({ success: false, error: `Bridge connection failed: ${e.message}. Is the bridge server running?` }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Bridge request timed out" }); });
    req.write(body);
    req.end();
  });
}

// ── MCP Server ──

const server = new McpServer({
  name: "bad-bridge",
  version: "1.0.0",
});

// ── Tool: bridge_run — Execute arbitrary Luau code in Studio ──

server.tool(
  "bridge_run",
  "Execute Luau code in Roblox Studio (edit mode). Returns the result. Requires LoadStringEnabled.",
  { code: z.string().describe("Luau code to execute. Use 'return ...' to get a value back.") },
  async ({ code }) => {
    const r = await bridgeRun({ type: "run", code });
    const text = r.success
      ? (r.output ? `${r.output}\n\nResult: ${r.result}` : `Result: ${r.result}`)
      : `Error: ${r.error}`;
    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: bridge_tree — Get instance hierarchy ──

server.tool(
  "bridge_tree",
  "Get the instance tree from Roblox Studio. Returns names, classNames, and optionally properties.",
  {
    path: z.string().default("game.Workspace").describe("Instance path, e.g. 'game.Workspace' or 'game.ReplicatedStorage'"),
    depth: z.number().default(2).describe("How many levels deep to traverse (default 2)"),
    props: z.boolean().default(false).describe("Include common properties for each instance"),
  },
  async ({ path, depth, props }) => {
    const r = await bridgeRun({ type: "get_tree", path, depth, props });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    // result is JSON string from Studio
    let formatted;
    try {
      formatted = JSON.stringify(JSON.parse(r.result), null, 2);
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_find — Search instances by name or class ──

server.tool(
  "bridge_find",
  "Search for instances in Roblox Studio by name pattern or ClassName.",
  {
    name: z.string().optional().describe("Name pattern to search for (case-insensitive substring match)"),
    className: z.string().optional().describe("Exact ClassName to match, e.g. 'Part', 'Model', 'Script'"),
    path: z.string().default("game").describe("Root path to search under"),
    limit: z.number().default(30).describe("Max results to return"),
    props: z.boolean().default(false).describe("Include properties"),
  },
  async ({ name, className, path, limit, props }) => {
    const cmd = { type: "find", path, limit, props };
    if (name) cmd.name = name;
    if (className) cmd.class = className;
    const r = await bridgeRun(cmd);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const items = JSON.parse(r.result);
      formatted = items.map(i => `${i.FullName} (${i.ClassName})`).join("\n");
      formatted = `Found ${items.length} instance(s):\n${formatted}`;
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_props — Get properties of a specific instance ──

server.tool(
  "bridge_props",
  "Get properties of a specific instance in Roblox Studio.",
  {
    path: z.string().describe("Instance path, e.g. 'game.Workspace.Baseplate'"),
    properties: z.array(z.string()).optional().describe("Specific property names to read. If omitted, reads common properties."),
  },
  async ({ path, properties }) => {
    const cmd = { type: "get_properties", path };
    if (properties) cmd.properties = properties;
    const r = await bridgeRun(cmd);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      formatted = JSON.stringify(JSON.parse(r.result), null, 2);
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_play — Run a script in play mode ──

server.tool(
  "bridge_play",
  "Inject a script into ServerScriptService and run it in play mode. Returns captured logs, errors, and the script's return value. Use for testing gameplay features.",
  {
    code: z.string().describe("Luau code to run in play mode. Use 'return ...' to get a value back."),
    mode: z.enum(["start_play", "run_server"]).default("start_play").describe("Play mode type"),
    timeout: z.number().default(30).describe("Script timeout in seconds"),
  },
  async ({ code, mode, timeout }) => {
    // Play mode takes much longer — Studio needs to enter play mode, load, execute
    const waitMs = (timeout + 60) * 1000;
    const r = await bridgeRun({ type: "run_script_in_play_mode", code, mode, timeout }, waitMs);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const data = JSON.parse(r.result);
      const lines = [];
      if (data.error && data.error !== "nil") lines.push(`Script Error: ${data.error}`);
      if (data.isTimeout) lines.push("⚠ Script timed out");
      lines.push(`Duration: ${(data.duration || 0).toFixed(1)}s`);
      if (data.errors && data.errors.length > 0) {
        lines.push(`\nErrors (${data.errors.length}):`);
        for (const e of data.errors) lines.push(`  ${e.level}: ${e.message}`);
      }
      if (data.logs && data.logs.length > 0) {
        lines.push(`\nLogs (${data.logs.length}):`);
        for (const l of data.logs) lines.push(`  [${l.level}] ${l.message}`);
      }
      formatted = lines.join("\n");
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_create — Create an instance in Studio ──

server.tool(
  "bridge_create",
  "Create a new instance in Roblox Studio. For Script/LocalScript/ModuleScript with Rojo active, use bridge_create_script instead (writes to disk).",
  {
    className: z.string().describe("ClassName of the instance to create, e.g. 'Part', 'Model', 'Folder'. For scripts with Rojo, prefer bridge_create_script."),
    parent: z.string().default("game.Workspace").describe("Parent instance path"),
    name: z.string().optional().describe("Name for the new instance"),
    properties: z.record(z.any()).optional().describe("Properties to set, e.g. {Anchored: true, BrickColor: 'Bright red'}"),
  },
  async ({ className, parent, name, properties }) => {
    // If creating a script type and Rojo is active, redirect to disk
    const scriptTypes = ["Script", "LocalScript", "ModuleScript"];
    if (rojoEnabled && scriptTypes.includes(className)) {
      const instancePath = name ? `${parent}.${name}` : parent;
      const source = properties?.Source || "";
      const diskResult = writeScriptToDisk(instancePath, source, className);
      if (diskResult) {
        return { content: [{ type: "text", text: `[Rojo] Created ${diskResult.filePath} (${className}) — Rojo will sync to Studio. Use bridge_create_script for full control.` }] };
      }
      // Couldn't map, fall through to Studio
      process.stderr.write(`[BAD Bridge] Rojo could not map ${instancePath}, creating in Studio instead.\n`);
    }
    const cmd = { type: "create_instance", className, parent };
    if (name) cmd.name = name;
    if (properties) cmd.properties = properties;
    const r = await bridgeRun(cmd);
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_set_property — Set a property on an instance ──

server.tool(
  "bridge_set_property",
  "Set a property on an instance in Roblox Studio.",
  {
    path: z.string().describe("Instance path"),
    property: z.string().describe("Property name"),
    value: z.any().describe("Value to set"),
  },
  async ({ path, property, value }) => {
    const r = await bridgeRun({ type: "set_property", path, property, value });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_delete — Delete an instance ──

server.tool(
  "bridge_delete",
  "Delete an instance in Roblox Studio.",
  { path: z.string().describe("Instance path to delete") },
  async ({ path }) => {
    const r = await bridgeRun({ type: "delete_instance", path });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_move — Reparent an instance ──

server.tool(
  "bridge_move",
  "Move (reparent) an instance in Roblox Studio.",
  {
    path: z.string().describe("Instance path to move"),
    parent: z.string().describe("New parent path"),
  },
  async ({ path, parent }) => {
    const r = await bridgeRun({ type: "move_instance", path, parent });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_rename — Rename an instance ──

server.tool(
  "bridge_rename",
  "Rename an instance in Roblox Studio.",
  {
    path: z.string().describe("Instance path"),
    name: z.string().describe("New name"),
  },
  async ({ path, name }) => {
    const r = await bridgeRun({ type: "rename_instance", path, name });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_clone — Clone an instance ──

server.tool(
  "bridge_clone",
  "Clone an instance in Roblox Studio, optionally to a different parent.",
  {
    path: z.string().describe("Instance path to clone"),
    parent: z.string().optional().describe("New parent path (if different from original parent)"),
  },
  async ({ path, parent }) => {
    const cmd = { type: "clone_instance", path };
    if (parent) cmd.parent = parent;
    const r = await bridgeRun(cmd);
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_script_source — Read a script's source ──

server.tool(
  "bridge_script_source",
  "Read the Source of a script. When Rojo is active, reads from disk first. Falls back to reading from Studio.",
  {
    path: z.string().describe("Script instance path, e.g. 'game.ServerScriptService.Main'"),
    fromStudio: z.boolean().default(false).describe("Force reading from Studio instead of disk (useful to check what's actually running)"),
  },
  async ({ path: scriptPath, fromStudio }) => {
    // Try disk first when Rojo is active
    if (rojoEnabled && !fromStudio) {
      const diskResult = readScriptFromDisk(scriptPath);
      if (diskResult) {
        return { content: [{ type: "text", text: `[Rojo — ${diskResult.filePath}]\n\n${diskResult.source}` }] };
      }
    }
    // Fall back to Studio
    const r = await bridgeRun({ type: "get_script_source", path: scriptPath });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_set_script_source — Write a script's source ──

server.tool(
  "bridge_set_script_source",
  "Write new source code to a script. When Rojo is active, writes a .luau file to disk (Rojo syncs it to Studio). Otherwise pushes directly to Studio.",
  {
    path: z.string().describe("Script instance path, e.g. 'game.ServerScriptService.MyScript'"),
    source: z.string().describe("New Luau source code"),
    className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional().describe("Script type (auto-detected from path if omitted)"),
    forceStudio: z.boolean().default(false).describe("Force writing to Studio directly, bypassing Rojo disk write"),
  },
  async ({ path: scriptPath, source, className, forceStudio }) => {
    // Rojo mode: write to disk
    if (rojoEnabled && !forceStudio) {
      const diskResult = writeScriptToDisk(scriptPath, source, className);
      if (diskResult) {
        return { content: [{ type: "text", text: `[Rojo] ${diskResult.message} (${source.length} chars) — Rojo will sync to Studio.` }] };
      }
      // If Rojo couldn't map the path, fall through to Studio
      return { content: [{ type: "text", text: `Warning: Could not map '${scriptPath}' to a Rojo file path. Check your default.project.json tree. Falling back to Studio.` }] };
    }
    // Non-Rojo: push to Studio directly
    const r = await bridgeRun({ type: "set_script_source", path: scriptPath, source });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_create_script — Create a new script file (Rojo-aware) ──

server.tool(
  "bridge_create_script",
  "Create a new script. When Rojo is active, creates a .luau file on disk. Otherwise creates a Script instance in Studio. Rojo syncs disk files to Studio automatically.",
  {
    path: z.string().describe("Parent instance path, e.g. 'game.ServerScriptService'"),
    name: z.string().describe("Script name"),
    className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("Script").describe("Script class"),
    source: z.string().default("").describe("Initial Luau source code"),
  },
  async ({ path: parentPath, name, className, source }) => {
    const instancePath = `${parentPath}.${name}`;

    // Rojo mode: create file on disk
    if (rojoEnabled) {
      const diskResult = writeScriptToDisk(instancePath, source, className);
      if (diskResult) {
        return { content: [{ type: "text", text: `[Rojo] Created ${diskResult.filePath} (${className}) — Rojo will sync to Studio.` }] };
      }
      return { content: [{ type: "text", text: `Warning: Could not map '${instancePath}' to a Rojo file path. Check your default.project.json tree.` }] };
    }

    // Non-Rojo: create instance in Studio
    const cmd = { type: "create_instance", className, parent: parentPath, name, properties: { Source: source } };
    const r = await bridgeRun(cmd);
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_console — Get console output ──

server.tool(
  "bridge_console",
  "Get accumulated console output from Roblox Studio (from play mode or edit mode).",
  { clear: z.boolean().default(false).describe("Clear the console buffer after reading") },
  async ({ clear }) => {
    const r = await bridgeRun({ type: "get_console_output", clear });
    return { content: [{ type: "text", text: r.success ? (r.result || "(empty)") : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_logs — Get log entries ──

server.tool(
  "bridge_logs",
  "Get buffered log entries from the bridge plugin.",
  {
    count: z.number().default(50).describe("Number of recent logs to return"),
    filter: z.string().optional().describe("Filter by message content or log type"),
  },
  async ({ count, filter }) => {
    // Logs are served via HTTP GET /logs, not via the command queue
    const params = new URLSearchParams({ count: String(count) });
    if (filter) params.set("filter", filter);
    const data = await bridgeGet(`/logs?${params}`);
    if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
    let formatted;
    try {
      const logs = Array.isArray(data) ? data : (data.logs || []);
      formatted = logs.map(l => `[${l.type}] ${l.message}`).join("\n") || "(no logs)";
    } catch {
      formatted = JSON.stringify(data) || "(no logs)";
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_selection — Get/set selected instances ──

server.tool(
  "bridge_selection",
  "Get or set the currently selected instances in Roblox Studio.",
  {
    action: z.enum(["get", "set"]).default("get").describe("'get' to read selection, 'set' to select instances"),
    paths: z.array(z.string()).optional().describe("Instance paths to select (only for 'set' action)"),
  },
  async ({ action, paths }) => {
    if (action === "set") {
      if (!paths || paths.length === 0) return { content: [{ type: "text", text: "Error: 'set' requires 'paths'" }] };
      const r = await bridgeRun({ type: "set_selection", paths });
      return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
    }
    const r = await bridgeRun({ type: "get_selection" });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const items = JSON.parse(r.result);
      formatted = items.length === 0 ? "(nothing selected)" : items.map(i => `${i.FullName} (${i.ClassName})`).join("\n");
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_play_control — Start/stop play mode ──

server.tool(
  "bridge_play_control",
  "Start or stop play mode in Roblox Studio.",
  {
    mode: z.enum(["start_play", "run_server", "stop"]).describe("'start_play' to enter play mode, 'run_server' for server-only, 'stop' to stop"),
  },
  async ({ mode }) => {
    const r = await bridgeRun({ type: "start_stop_play", mode });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_studio_mode — Check Studio's current mode ──

server.tool(
  "bridge_studio_mode",
  "Check Studio's current mode (edit, play, or server).",
  {},
  async () => {
    const r = await bridgeRun({ type: "get_studio_mode" });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    const mode = r.result || "unknown";
    const labels = { stop: "Edit Mode", start_play: "Play Mode", run_server: "Server Mode" };
    return { content: [{ type: "text", text: `Studio Mode: ${labels[mode] || mode}` }] };
  }
);

// ── Tool: bridge_get_attributes — Read custom attributes ──

server.tool(
  "bridge_get_attributes",
  "Get all custom attributes on an instance.",
  { path: z.string().describe("Instance path") },
  async ({ path: instPath }) => {
    const r = await bridgeRun({ type: "get_attributes", path: instPath });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const attrs = JSON.parse(r.result);
      if (typeof attrs === "object" && attrs !== null && Object.keys(attrs).length === 0) {
        formatted = `(no attributes on ${instPath})`;
      } else {
        formatted = JSON.stringify(attrs, null, 2);
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_set_attribute — Set a custom attribute ──

server.tool(
  "bridge_set_attribute",
  "Set a custom attribute on an instance. Supports: string, number, boolean, Color3, Vector3, etc.",
  {
    path: z.string().describe("Instance path"),
    attribute: z.string().describe("Attribute name"),
    value: z.any().describe("Attribute value"),
  },
  async ({ path: instPath, attribute, value }) => {
    const r = await bridgeRun({ type: "set_attribute", path: instPath, attribute, value });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_delete_attribute — Remove a custom attribute ──

server.tool(
  "bridge_delete_attribute",
  "Remove a custom attribute from an instance.",
  {
    path: z.string().describe("Instance path"),
    attribute: z.string().describe("Attribute name to remove"),
  },
  async ({ path: instPath, attribute }) => {
    const r = await bridgeRun({ type: "delete_attribute", path: instPath, attribute });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_get_children — Lightweight child listing ──

server.tool(
  "bridge_get_children",
  "Get a lightweight list of an instance's direct children (name, class, child count). Faster than bridge_tree for quick exploration.",
  { path: z.string().default("game").describe("Instance path") },
  async ({ path: instPath }) => {
    const r = await bridgeRun({ type: "get_children", path: instPath });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const items = JSON.parse(r.result);
      if (!Array.isArray(items)) { formatted = r.result; }
      else if (items.length === 0) { formatted = `(${instPath} has no children)`; }
      else {
        formatted = `Children of ${instPath} (${items.length}):\n` +
          items.map(i => `  ${i.Name} [${i.ClassName}]${i.ChildCount > 0 ? ` (${i.ChildCount} children)` : ""}`).join("\n");
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_bulk_inspect — Deep instance inspection ──

server.tool(
  "bridge_bulk_inspect",
  "Get the full instance tree with ALL properties included. Heavier than bridge_tree — use for deeply understanding a subtree's configuration.",
  {
    path: z.string().default("game.Workspace").describe("Instance path to inspect"),
    depth: z.number().default(3).describe("How many levels deep (be careful with large values)"),
  },
  async ({ path: instPath, depth }) => {
    const r = await bridgeRun({ type: "bulk_inspect", path: instPath, depth });
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try { formatted = JSON.stringify(JSON.parse(r.result), null, 2); } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_game_map — Bird's-eye game overview ──

server.tool(
  "bridge_game_map",
  "Get a bird's-eye overview of the entire game: all services, script type breakdown, descendant counts, and top-level children. Call this FIRST to orient yourself before making any changes.",
  {},
  async () => {
    const r = await bridgeRun({ type: "game_map" }, 20000);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const services = JSON.parse(r.result);
      if (!Array.isArray(services)) { formatted = r.result; }
      else {
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
        formatted = lines.join("\n");
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_scan_scripts — Discover all scripts ──

server.tool(
  "bridge_scan_scripts",
  "Discover every script in the game (or a subtree). Returns paths, types, and line counts. Set sources=true to read ALL scripts at once.",
  {
    path: z.string().default("game").describe("Root path to scan from"),
    sources: z.boolean().default(false).describe("Include full source code for each script (can be large)"),
  },
  async ({ path: instPath, sources }) => {
    const r = await bridgeRun({ type: "scan_scripts", path: instPath, sources }, 30000);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const scripts = JSON.parse(r.result);
      if (!Array.isArray(scripts)) { formatted = r.result; }
      else if (scripts.length === 0) { formatted = "No scripts found under " + instPath; }
      else if (sources) {
        const parts = [`Found ${scripts.length} script(s):\n`];
        for (const s of scripts) {
          parts.push(`--- ${s.FullName} [${s.ClassName}] (${s.LineCount} lines) ---`);
          parts.push(s.Source || "(empty)");
          parts.push("");
        }
        formatted = parts.join("\n");
      } else {
        const lines = [`Found ${scripts.length} script(s) under ${instPath}:\n`];
        for (const s of scripts) {
          lines.push(`  ${s.FullName} [${s.ClassName}] - ${s.LineCount} lines, ${s.CharCount} chars`);
        }
        formatted = lines.join("\n");
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_search_code — Grep across all scripts ──

server.tool(
  "bridge_search_code",
  "Search for text across ALL script source code in the game. Like grep for Roblox — find where functions are defined, variables are used, or patterns occur.",
  {
    pattern: z.string().describe("Text to search for (case-insensitive substring match)"),
    path: z.string().default("game").describe("Root to search from"),
    limit: z.number().default(50).describe("Maximum results to return"),
  },
  async ({ pattern, path: instPath, limit }) => {
    const r = await bridgeRun({ type: "search_code", pattern, path: instPath, limit }, 30000);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const results = JSON.parse(r.result);
      if (!Array.isArray(results)) { formatted = r.result; }
      else if (results.length === 0) { formatted = `No matches found for "${pattern}"`; }
      else {
        const lines = [`Found ${results.length} match(es) for "${pattern}":\n`];
        for (const m of results) {
          lines.push(`  ${m.Script}:${m.Line}: ${(m.Text || "").trim()}`);
        }
        formatted = lines.join("\n");
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_script_edit — Find and replace in a script ──

server.tool(
  "bridge_script_edit",
  "Make a precise find-and-replace edit in a script's source code. Replaces the first match only. Can be undone with bridge_undo.",
  {
    path: z.string().describe("Script path (e.g. 'game.ServerScriptService.MainScript')"),
    find: z.string().describe("Exact text to find in the script (first occurrence)"),
    replace: z.string().describe("Text to replace it with (use empty string to delete)"),
  },
  async ({ path: instPath, find, replace }) => {
    const r = await bridgeRun({ type: "script_edit", path: instPath, find, replace });
    return { content: [{ type: "text", text: r.success ? (r.result || "(edit applied)") : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_require_graph — Trace require() dependencies ──

server.tool(
  "bridge_require_graph",
  "Trace require() dependencies across all scripts. Shows which scripts depend on which ModuleScripts. Essential for understanding code architecture.",
  { path: z.string().default("game").describe("Root path to scan from") },
  async ({ path: instPath }) => {
    const r = await bridgeRun({ type: "require_graph", path: instPath }, 30000);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const graph = JSON.parse(r.result);
      if (!Array.isArray(graph)) { formatted = r.result; }
      else if (graph.length === 0) { formatted = "No require() calls found in any scripts."; }
      else {
        const lines = [`=== Require Dependency Graph (${graph.length} scripts with dependencies) ===\n`];
        for (const entry of graph) {
          lines.push(`${entry.Script} [${entry.ClassName}]`);
          for (const req of entry.Requires) {
            const resolved = req.Resolved ? ` -> ${req.Resolved}` : " (unresolved)";
            lines.push(`   requires ${req.Raw}${resolved}`);
          }
          lines.push("");
        }
        formatted = lines.join("\n");
      }
    } catch { formatted = r.result; }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_undo / bridge_redo ──

server.tool(
  "bridge_undo",
  "Undo the last action(s) in Roblox Studio.",
  { steps: z.number().default(1).describe("Number of steps to undo") },
  async ({ steps }) => {
    const r = await bridgeRun({ type: "undo", steps });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

server.tool(
  "bridge_redo",
  "Redo the last undone action(s) in Roblox Studio.",
  { steps: z.number().default(1).describe("Number of steps to redo") },
  async ({ steps }) => {
    const r = await bridgeRun({ type: "redo", steps });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_insert_model — Insert from marketplace ──

server.tool(
  "bridge_insert_model",
  "Search the Roblox marketplace and insert a model into Workspace.",
  { query: z.string().describe("Search query for the marketplace") },
  async ({ query }) => {
    const r = await bridgeRun({ type: "insert_model", query }, 30000);
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_batch — Run multiple commands at once ──

server.tool(
  "bridge_batch",
  "Run multiple bridge commands in a single round trip. Each command is an object with a 'type' field plus command-specific fields.",
  {
    commands: z.array(z.record(z.any())).describe("Array of command objects, e.g. [{type:'get_properties', path:'game.Workspace.Part', properties:['Name','Position']}, ...]"),
  },
  async ({ commands }) => {
    const r = await bridgeRun({ type: "batch", commands }, 30000);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      formatted = JSON.stringify(JSON.parse(r.result), null, 2);
    } catch {
      formatted = r.result;
    }
    return { content: [{ type: "text", text: formatted }] };
  }
);

// ── Tool: bridge_status — Check bridge server status ──

server.tool(
  "bridge_status",
  "Check if the BAD Bridge server is running and the Studio plugin is connected.",
  {},
  async () => {
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http.get(`${BRIDGE_URL}/status`, { timeout: 3000 }, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
        });
        req.on("error", e => resolve({ error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
      });
      if (data.error) return { content: [{ type: "text", text: `Bridge server not reachable: ${data.error}` }] };
      return { content: [{ type: "text", text: `Bridge v${data.version} | Queue: ${data.queue} | Logs: ${data.logs} | Commands: ${data.commands} | Has result: ${data.hasResult}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Bridge connection failed: ${e.message}` }] };
    }
  }
);

// ── Tool: bridge_rojo_status — Check Rojo integration status ──

server.tool(
  "bridge_rojo_status",
  "Check if Rojo integration is active and where scripts will be written.",
  {},
  async () => {
    const lines = [];
    lines.push(`Rojo mode: ${rojoEnabled ? "ENABLED" : ROJO_DISABLED ? "EXPLICITLY DISABLED" : "DISABLED"}`);
    lines.push(`Project root: ${ROJO_PROJECT_ROOT}`);

    const projectFile = ROJO_PROJECT_FILE
      ? (path.isAbsolute(ROJO_PROJECT_FILE) ? ROJO_PROJECT_FILE : path.join(ROJO_PROJECT_ROOT, ROJO_PROJECT_FILE))
      : path.join(ROJO_PROJECT_ROOT, "default.project.json");
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
      lines.push("\nScripts will be written directly to Studio via set_script_source.");
      if (!ROJO_DISABLED) {
        lines.push("To enable Rojo mode, create a default.project.json in your workspace root,");
        lines.push("or set bad-bridge.rojoProjectFile in VS Code settings to point to your project file.");
      }
    } else {
      lines.push("\nScripts will be written as .luau files to disk. Rojo syncs them to Studio.");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
