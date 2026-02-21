#!/usr/bin/env node
// BAD Bridge MCP Server — zero dependencies, instant startup
// Implements MCP stdio protocol directly without the SDK

const http = require("http");
const readline = require("readline");

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:3001";

// ── HTTP helper ──

function bridgeRun(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(cmd);
    const url = new URL(`/run?timeout=${timeoutMs}`, BRIDGE);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: timeoutMs + 5000,
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ success: false, error: "Bad JSON", raw: d }); }
      });
    });
    req.on("error", e => resolve({ success: false, error: `Bridge down: ${e.message}` }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

function bridgeGet(path) {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE}${path}`, { timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on("error", e => resolve({ error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: "bridge_status",
    description: "Check if the BAD Bridge server and Studio plugin are connected.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const s = await bridgeGet("/status");
      if (s.error) return `Bridge not reachable: ${s.error}`;
      return `Bridge v${s.version} | Queue: ${s.queue} | Logs: ${s.logs} | Commands: ${s.commands}`;
    }
  },
  {
    name: "bridge_run",
    description: "Execute Luau code in Roblox Studio (edit mode). Use 'return ...' to get values back. Requires LoadStringEnabled.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Luau code to execute" } },
      required: ["code"]
    },
    handler: async ({ code }) => {
      const r = await bridgeRun({ type: "run", code });
      return r.success ? (r.output ? `${r.output}\n\nResult: ${r.result}` : r.result) : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_tree",
    description: "Get the instance tree from Roblox Studio.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game.Workspace", description: "Instance path" },
        depth: { type: "number", default: 2, description: "Levels deep" },
        props: { type: "boolean", default: false, description: "Include properties" }
      },
      required: []
    },
    handler: async ({ path = "game.Workspace", depth = 2, props = false }) => {
      const r = await bridgeRun({ type: "get_tree", path, depth, props });
      if (!r.success) return `Error: ${r.error}`;
      try { return JSON.stringify(JSON.parse(r.result), null, 2); } catch { return r.result; }
    }
  },
  {
    name: "bridge_find",
    description: "Search for instances by name pattern or ClassName.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name substring (case-insensitive)" },
        className: { type: "string", description: "Exact ClassName" },
        path: { type: "string", default: "game", description: "Root to search" },
        limit: { type: "number", default: 30, description: "Max results" }
      },
      required: []
    },
    handler: async ({ name, className, path = "game", limit = 30 }) => {
      const cmd = { type: "find", path, limit };
      if (name) cmd.name = name;
      if (className) cmd.class = className;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      try {
        const items = JSON.parse(r.result);
        return `Found ${items.length}:\n` + items.map(i => `  ${i.FullName} (${i.ClassName})`).join("\n");
      } catch { return r.result; }
    }
  },
  {
    name: "bridge_props",
    description: "Get properties of a specific instance.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        properties: { type: "array", items: { type: "string" }, description: "Property names (optional)" }
      },
      required: ["path"]
    },
    handler: async ({ path, properties }) => {
      const cmd = { type: "get_properties", path };
      if (properties) cmd.properties = properties;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      try { return JSON.stringify(JSON.parse(r.result), null, 2); } catch { return r.result; }
    }
  },
  {
    name: "bridge_play",
    description: "Run a Luau script in play mode. Returns logs, errors, and return value.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau code" },
        mode: { type: "string", enum: ["start_play", "run_server"], default: "start_play" },
        timeout: { type: "number", default: 30, description: "Script timeout seconds" }
      },
      required: ["code"]
    },
    handler: async ({ code, mode = "start_play", timeout = 30 }) => {
      const wait = (timeout + 60) * 1000;
      const r = await bridgeRun({ type: "run_script_in_play_mode", code, mode, timeout }, wait);
      if (!r.success) return `Error: ${r.error}`;
      try {
        const d = JSON.parse(r.result);
        const lines = [];
        if (d.error && d.error !== "nil") lines.push(`Error: ${d.error}`);
        if (d.isTimeout) lines.push("TIMED OUT");
        lines.push(`Duration: ${(d.duration || 0).toFixed(1)}s`);
        if (d.errors?.length) { lines.push("Errors:"); d.errors.forEach(e => lines.push(`  ${e.message}`)); }
        if (d.logs?.length) { lines.push("Logs:"); d.logs.forEach(l => lines.push(`  [${l.level}] ${l.message}`)); }
        return lines.join("\n");
      } catch { return r.result; }
    }
  },
  {
    name: "bridge_create",
    description: "Create a new instance in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string", description: "ClassName" },
        parent: { type: "string", default: "game.Workspace", description: "Parent path" },
        name: { type: "string", description: "Instance name" },
        properties: { type: "object", description: "Properties dict" }
      },
      required: ["className"]
    },
    handler: async ({ className, parent = "game.Workspace", name, properties }) => {
      const cmd = { type: "create_instance", className, parent };
      if (name) cmd.name = name;
      if (properties) cmd.properties = properties;
      const r = await bridgeRun(cmd);
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_set_property",
    description: "Set a property on an instance.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }, property: { type: "string" }, value: {}
      },
      required: ["path", "property", "value"]
    },
    handler: async ({ path, property, value }) => {
      const r = await bridgeRun({ type: "set_property", path, property, value });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_delete",
    description: "Delete an instance.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async ({ path }) => {
      const r = await bridgeRun({ type: "delete_instance", path });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_move",
    description: "Move (reparent) an instance.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, parent: { type: "string" } },
      required: ["path", "parent"]
    },
    handler: async ({ path, parent }) => {
      const r = await bridgeRun({ type: "move_instance", path, parent });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_rename",
    description: "Rename an instance.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, name: { type: "string" } },
      required: ["path", "name"]
    },
    handler: async ({ path, name }) => {
      const r = await bridgeRun({ type: "rename_instance", path, name });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_clone",
    description: "Clone an instance, optionally to a different parent.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, parent: { type: "string" } },
      required: ["path"]
    },
    handler: async ({ path, parent }) => {
      const cmd = { type: "clone_instance", path };
      if (parent) cmd.parent = parent;
      const r = await bridgeRun(cmd);
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_script_source",
    description: "Read a script's source code from Studio.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async ({ path }) => {
      const r = await bridgeRun({ type: "get_script_source", path });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_set_script_source",
    description: "Write source code to a script in Studio.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, source: { type: "string" } },
      required: ["path", "source"]
    },
    handler: async ({ path, source }) => {
      const r = await bridgeRun({ type: "set_script_source", path, source });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_console",
    description: "Get console output from Studio.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", default: false } },
      required: []
    },
    handler: async ({ clear = false }) => {
      const r = await bridgeRun({ type: "get_console_output", clear });
      return r.success ? (r.result || "(empty)") : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_logs",
    description: "Get log entries from the bridge plugin.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", default: 50 },
        filter: { type: "string" }
      },
      required: []
    },
    handler: async ({ count = 50, filter }) => {
      const cmd = { type: "get_logs", count, clear: false };
      if (filter) cmd.filter = filter;
      const r = await bridgeRun(cmd);
      if (!r.success) return `Error: ${r.error}`;
      try {
        const logs = JSON.parse(r.result);
        return logs.map(l => `[${l.type}] ${l.message}`).join("\n") || "(no logs)";
      } catch { return r.result || "(no logs)"; }
    }
  },
  {
    name: "bridge_selection",
    description: "Get or set selected instances in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], default: "get" },
        paths: { type: "array", items: { type: "string" } }
      },
      required: []
    },
    handler: async ({ action = "get", paths }) => {
      if (action === "set") {
        if (!paths?.length) return "Error: 'set' needs paths";
        const r = await bridgeRun({ type: "set_selection", paths });
        return r.success ? r.result : `Error: ${r.error}`;
      }
      const r = await bridgeRun({ type: "get_selection" });
      if (!r.success) return `Error: ${r.error}`;
      try {
        const items = JSON.parse(r.result);
        return items.length ? items.map(i => `${i.FullName} (${i.ClassName})`).join("\n") : "(nothing selected)";
      } catch { return r.result; }
    }
  },
  {
    name: "bridge_play_control",
    description: "Start or stop play mode: start_play, run_server, or stop.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["start_play", "run_server", "stop"] } },
      required: ["mode"]
    },
    handler: async ({ mode }) => {
      const r = await bridgeRun({ type: "start_stop_play", mode });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_undo",
    description: "Undo action(s) in Studio.",
    inputSchema: { type: "object", properties: { steps: { type: "number", default: 1 } }, required: [] },
    handler: async ({ steps = 1 }) => {
      const r = await bridgeRun({ type: "undo", steps });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_redo",
    description: "Redo action(s) in Studio.",
    inputSchema: { type: "object", properties: { steps: { type: "number", default: 1 } }, required: [] },
    handler: async ({ steps = 1 }) => {
      const r = await bridgeRun({ type: "redo", steps });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_batch",
    description: "Run multiple bridge commands in one round trip.",
    inputSchema: {
      type: "object",
      properties: { commands: { type: "array", items: { type: "object" }, description: "Array of command objects with 'type' field" } },
      required: ["commands"]
    },
    handler: async ({ commands }) => {
      const r = await bridgeRun({ type: "batch", commands }, 30000);
      if (!r.success) return `Error: ${r.error}`;
      try { return JSON.stringify(JSON.parse(r.result), null, 2); } catch { return r.result; }
    }
  },
  {
    name: "bridge_insert_model",
    description: "Search marketplace and insert a model into Workspace.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async ({ query }) => {
      const r = await bridgeRun({ type: "insert_model", query }, 30000);
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_get_attributes",
    description: "Get all attributes on an instance.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Instance path" } }, required: ["path"] },
    handler: async ({ path }) => {
      const r = await bridgeRun({ type: "get_attributes", path });
      if (!r.success) return `Error: ${r.error}`;
      try { return JSON.stringify(JSON.parse(r.result), null, 2); } catch { return r.result; }
    }
  },
  {
    name: "bridge_set_attribute",
    description: "Set an attribute on an instance.",
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
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_delete_attribute",
    description: "Remove an attribute from an instance.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance path" },
        attribute: { type: "string", description: "Attribute name" }
      },
      required: ["path", "attribute"]
    },
    handler: async ({ path, attribute }) => {
      const r = await bridgeRun({ type: "delete_attribute", path, attribute });
      return r.success ? r.result : `Error: ${r.error}`;
    }
  },
  {
    name: "bridge_get_children",
    description: "Get a lightweight list of children (name, class, child count) without full tree serialization.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", default: "game", description: "Instance path" } },
      required: []
    },
    handler: async ({ path = "game" }) => {
      const r = await bridgeRun({ type: "get_children", path });
      if (!r.success) return `Error: ${r.error}`;
      try {
        const items = JSON.parse(r.result);
        return items.map(i => `${i.Name} (${i.ClassName}) [${i.ChildCount} children]`).join("\n") || "(empty)";
      } catch { return r.result; }
    }
  },
];

// ── MCP stdio protocol ──

const toolMap = {};
for (const t of TOOLS) toolMap[t.name] = t;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bad-bridge", version: "1.0.0" }
      }
    });
    return;
  }

  if (method === "notifications/initialized") return; // no response needed

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0", id,
      result: {
        tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      }
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const tool = toolMap[toolName];
    if (!tool) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true } });
      return;
    }
    tool.handler(args).then(text => {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }] } });
    }).catch(err => {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Tool error: ${err.message}` }], isError: true } });
    });
    return;
  }

  // Ping
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Unknown method
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ── Read stdin line by line ──

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleRequest(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`Parse error: ${e.message}\n`);
  }
});
rl.on("close", () => process.exit(0));
