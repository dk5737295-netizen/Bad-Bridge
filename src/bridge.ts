import * as http from "http";

export interface BridgeCommand {
  type: string;
  [key: string]: unknown;
}

export interface BridgeResult {
  success?: boolean;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  type: "Output" | "Warning" | "Error";
  message: string;
  timestamp?: number;
}

export class BridgeClient {
  private port: number;

  constructor(port: number = 3001) {
    this.port = port;
  }

  setPort(port: number): void {
    this.port = port;
  }

  private request(method: string, path: string, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: this.port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        timeout: 5000,
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      if (body) { req.write(body); }
      req.end();
    });
  }

  async ping(): Promise<boolean> {
    try {
      const raw = await this.request("GET", "/ping");
      const data = JSON.parse(raw);
      return data?.ok === true;
    } catch {
      return false;
    }
  }

  async sendCommand(cmd: BridgeCommand, timeoutMs?: number): Promise<BridgeResult | null> {
    // Clear any stale result first
    try { await this.request("GET", "/result"); } catch { /* ignore */ }

    // Long-running commands get a longer timeout
    const longCommands = ["run_script_in_play_mode", "start_stop_play", "insert_model"];
    const defaultTimeout = longCommands.includes(cmd.type) ? 120000 : 15000;

    await this.request("POST", "/command", JSON.stringify(cmd));
    return this.waitForResult(timeoutMs ?? defaultTimeout);
  }

  private async waitForResult(timeoutMs: number = 15000): Promise<BridgeResult | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const raw = await this.request("GET", "/result");
        if (raw && raw !== "null") {
          return JSON.parse(raw) as BridgeResult;
        }
      } catch { /* retry */ }
    }
    return null;
  }

  async getQueueDepth(): Promise<number> {
    try {
      const raw = await this.request("GET", "/queue");
      return JSON.parse(raw).pending ?? 0;
    } catch {
      return -1;
    }
  }

  async clearQueue(): Promise<void> {
    await this.request("DELETE", "/queue");
  }

  async getLogs(clear: boolean = false): Promise<LogEntry[]> {
    try {
      const logPath = clear ? "/logs?clear=true" : "/logs";
      const raw = await this.request("GET", logPath);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) { return []; }
      // Filter out malformed entries
      return parsed.filter((e: any) => e && typeof e.message === "string");
    } catch {
      return [];
    }
  }

  async clearLogs(): Promise<void> {
    await this.request("DELETE", "/logs");
  }

  // High-level helpers
  async run(code: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "run", code });
  }

  async getTree(path: string, depth: number = 4, props: boolean = false): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_tree", path, depth, props });
  }

  async getProperties(path: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_properties", path });
  }

  async bulkInspect(path: string, depth: number = 4): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "bulk_inspect", path, depth });
  }

  async find(path: string, opts: { name?: string; class?: string; props?: boolean; limit?: number }): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "find", path, ...opts });
  }

  async undo(steps: number = 1): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "undo", steps });
  }

  async redo(steps: number = 1): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "redo", steps });
  }

  // ── MCP-derived features ──

  async insertModel(query: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "insert_model", query });
  }

  async startStopPlay(mode: "start_play" | "run_server" | "stop"): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "start_stop_play", mode });
  }

  async runScriptInPlayMode(code: string, mode: string = "start_play", timeout?: number): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "run_script_in_play_mode", code, mode, timeout: timeout ?? 1000000 });
  }

  async getStudioMode(): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_studio_mode" });
  }

  async getConsoleOutput(clear: boolean = false): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_console_output", clear });
  }

  // ── Instance manipulation ──

  async createInstance(className: string, parent: string = "game.Workspace", name?: string, properties?: Record<string, unknown>): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "create_instance", className, parent, name, properties });
  }

  async deleteInstance(path: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "delete_instance", path });
  }

  async cloneInstance(path: string, parent?: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "clone_instance", path, parent });
  }

  async setProperty(path: string, property: string, value: unknown): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "set_property", path, property, value });
  }

  async moveInstance(path: string, parent: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "move_instance", path, parent });
  }

  async renameInstance(path: string, name: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "rename_instance", path, name });
  }

  async getSelection(): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_selection" });
  }

  async setSelection(paths: string[]): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "set_selection", paths });
  }

  async getScriptSource(path: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_script_source", path });
  }

  async setScriptSource(path: string, source: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "set_script_source", path, source });
  }

  // ── Attributes ──

  async getAttributes(path: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_attributes", path });
  }

  async setAttribute(path: string, attribute: string, value: unknown): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "set_attribute", path, attribute, value });
  }

  async deleteAttribute(path: string, attribute: string): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "delete_attribute", path, attribute });
  }

  // ── Children ──

  async getChildren(path: string = "game"): Promise<BridgeResult | null> {
    return this.sendCommand({ type: "get_children", path });
  }

  // ── Server status ──

  async getServerStatus(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this.request("GET", "/status");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
