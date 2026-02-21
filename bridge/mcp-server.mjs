#!/usr/bin/env node
// BAD Bridge MCP Server — exposes Roblox Studio bridge commands as native MCP tools
// Uses stdio transport for direct integration with VS Code Copilot

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "http";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";

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
  "Create a new instance in Roblox Studio.",
  {
    className: z.string().describe("ClassName of the instance to create, e.g. 'Part', 'Model', 'Folder'"),
    parent: z.string().default("game.Workspace").describe("Parent instance path"),
    name: z.string().optional().describe("Name for the new instance"),
    properties: z.record(z.any()).optional().describe("Properties to set, e.g. {Anchored: true, BrickColor: 'Bright red'}"),
  },
  async ({ className, parent, name, properties }) => {
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
  "Read the Source of a script in Roblox Studio.",
  { path: z.string().describe("Script instance path, e.g. 'game.ServerScriptService.Main'") },
  async ({ path }) => {
    const r = await bridgeRun({ type: "get_script_source", path });
    return { content: [{ type: "text", text: r.success ? r.result : `Error: ${r.error}` }] };
  }
);

// ── Tool: bridge_set_script_source — Write a script's source ──

server.tool(
  "bridge_set_script_source",
  "Write new source code to a script in Roblox Studio.",
  {
    path: z.string().describe("Script instance path"),
    source: z.string().describe("New Luau source code"),
  },
  async ({ path, source }) => {
    const r = await bridgeRun({ type: "set_script_source", path, source });
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
    const cmd = { type: "get_logs", count, clear: false };
    if (filter) cmd.filter = filter;
    const r = await bridgeRun(cmd);
    if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }] };
    let formatted;
    try {
      const logs = JSON.parse(r.result);
      formatted = logs.map(l => `[${l.type}] ${l.message}`).join("\n") || "(no logs)";
    } catch {
      formatted = r.result || "(no logs)";
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

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
