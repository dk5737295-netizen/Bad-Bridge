#!/usr/bin/env node
// Build And Defend — Studio Bridge Server v4 (Node.js)
// Cross-platform, in-memory FIFO queue, log streaming, zero dependencies.
// Usage: node server.js [--port 3001]

const http = require("http");
const zlib = require("zlib");

const args = process.argv.slice(2);
let PORT = 3001;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
    PORT = parseInt(args[i + 1], 10) || 3001;
  }
}

// ── In-memory state ─────────────────────────────────────────────────────

const queue = [];          // FIFO command queue
let result = null;         // Latest result from Studio
let logs = [];             // Log buffer
let cmdIndex = 0;          // Command counter
const MAX_LOGS = 2000;
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB
const VERSION = 4;
let lastStudioPoll = 0; // timestamp of last Studio /poll request

// Long-poll waiters for result
let resultWaiters = [];    // Array of { resolve, timer } for pending long-poll requests

// Character control state
let controlInputQueue = [];   // FIFO queue of control inputs from agent
let controlState = null;      // Last known character state from play mode
let controlActive = false;    // Whether a control session is active
let controlWaiters = [];      // Long-poll waiters for control inputs
const MAX_CONTROL_QUEUE = 50;

// ── Helpers ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, code, obj, req) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept-Encoding",
  };
  // Gzip responses > 4KB when client accepts it
  const acceptGzip = req && req.headers && (req.headers["accept-encoding"] || "").includes("gzip");
  if (acceptGzip && body.length > 4096) {
    zlib.gzip(body, (err, compressed) => {
      if (err) {
        res.writeHead(code, headers);
        res.end(body);
      } else {
        headers["Content-Encoding"] = "gzip";
        headers["Content-Length"] = compressed.length;
        res.writeHead(code, headers);
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(code, headers);
    res.end(body);
  }
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs = {};
  url.substring(idx + 1).split("&").forEach((pair) => {
    const [k, v] = pair.split("=");
    qs[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  return qs;
}

function getPath(url) {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.substring(0, idx);
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url || "/";
  const path = getPath(url);
  const qs = parseQuery(url);

  // CORS preflight
  if (method === "OPTIONS") {
    sendJSON(res, 200, { ok: true });
    return;
  }

  try {
    // ── GET /poll — Studio plugin takes oldest queued command ──
    if (method === "GET" && path === "/poll") {
      lastStudioPoll = Date.now();
      if (queue.length > 0) {
        const cmd = queue.shift();
        sendJSON(res, 200, cmd);
      } else {
        sendJSON(res, 200, "null");
      }
    }

    // ── POST /result — Studio plugin posts result ──
    else if (method === "POST" && path === "/result") {
      const body = await readBody(req) || "";
      try { result = JSON.parse(body); } catch (_e) { result = body; }
      sendJSON(res, 200, { ok: true });
      const preview = body.length > 300 ? body.substring(0, 300) + "..." : body;
      console.log(`\x1b[36m[${timestamp()}] Result received: ${preview}\x1b[0m`);

      // Resolve any long-poll waiters
      if (resultWaiters.length > 0) {
        const r = result;
        result = null;
        for (const waiter of resultWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(r);
        }
        resultWaiters = [];
      }
    }

    // ── GET /result — Extension reads result (auto-clears) ──
    else if (method === "GET" && path === "/result") {
      if (result !== null) {
        const r = result;
        result = null;
        sendJSON(res, 200, r, req);
      } else {
        sendJSON(res, 200, "null");
      }
    }

    // ── GET /result/wait — Long-poll: waits up to ?timeout=N ms for result ──
    else if (method === "GET" && path === "/result/wait") {
      const timeoutMs = parseInt(qs.timeout) || 30000;
      // If result already available, return immediately
      if (result !== null) {
        const r = result;
        result = null;
        sendJSON(res, 200, r);
      } else {
        // Hold connection open until result arrives or timeout
        const waiter = {};
        waiter.resolve = (r) => { sendJSON(res, 200, r, req); };
        waiter.timer = setTimeout(() => {
          resultWaiters = resultWaiters.filter(w => w !== waiter);
          sendJSON(res, 200, { success: false, error: "timeout", waited: timeoutMs });
        }, timeoutMs);
        resultWaiters.push(waiter);
      }
    }

    // ── POST /command — Extension queues a command ──
    else if (method === "POST" && path === "/command") {
      const body = await readBody(req) || "";
      result = null; // clear stale result
      cmdIndex++;
      let parsed;
      try { parsed = JSON.parse(body); } catch (_e) { parsed = body; }
      queue.push(parsed);
      sendJSON(res, 200, { ok: true, queued: true, id: cmdIndex });
      const type = parsed?.type || "?";
      console.log(`\x1b[33m[${timestamp()}] Command #${cmdIndex} queued: ${type}\x1b[0m`);
    }

    // ── POST /run — Send command AND wait for result in one call ──
    else if (method === "POST" && path === "/run") {
      const body = await readBody(req) || "";
      const timeoutMs = parseInt(qs.timeout) || 30000;
      result = null;
      cmdIndex++;
      let parsed;
      try { parsed = JSON.parse(body); } catch (_e) { parsed = body; }
      queue.push(parsed);
      const type = parsed?.type || "?";
      console.log(`\x1b[33m[${timestamp()}] Command #${cmdIndex} queued+wait: ${type} (timeout ${timeoutMs}ms)\x1b[0m`);

      // Wait for result via long-poll
      const waiter = {};
      waiter.resolve = (r) => { sendJSON(res, 200, r, req); };
      waiter.timer = setTimeout(() => {
        resultWaiters = resultWaiters.filter(w => w !== waiter);
        sendJSON(res, 200, { success: false, error: "timeout", waited: timeoutMs });
      }, timeoutMs);
      resultWaiters.push(waiter);
    }

    // ── GET /queue — Check queue depth ──
    else if (method === "GET" && path === "/queue") {
      sendJSON(res, 200, { pending: queue.length });
    }

    // ── DELETE /queue — Clear queue ──
    else if (method === "DELETE" && path === "/queue") {
      queue.length = 0;
      result = null;
      sendJSON(res, 200, { ok: true, cleared: true });
      console.log(`\x1b[35m[${timestamp()}] Queue cleared\x1b[0m`);
    }

    // ── GET /ping ──
    else if (method === "GET" && path === "/ping") {
      sendJSON(res, 200, { ok: true, version: VERSION });
    }

    // ── POST /logs — Studio plugin pushes log entries ──
    else if (method === "POST" && path === "/logs") {
      const body = await readBody(req) || "[]";
      try {
        const incoming = JSON.parse(body);
        if (Array.isArray(incoming)) {
          logs.push(...incoming);
          if (logs.length > MAX_LOGS) {
            logs = logs.slice(logs.length - MAX_LOGS);
          }
          sendJSON(res, 200, { ok: true, stored: incoming.length });
        } else {
          sendJSON(res, 200, { ok: false, error: "expected array" });
        }
      } catch (_e) {
        sendJSON(res, 200, { ok: false, error: "parse error" });
      }
    }

    // ── GET /logs — Read buffered logs ──
    else if (method === "GET" && path === "/logs") {
      sendJSON(res, 200, logs, req);
      if (qs.clear === "true") {
        logs = [];
      }
    }

    // ── DELETE /logs — Clear log buffer ──
    else if (method === "DELETE" && path === "/logs") {
      logs = [];
      sendJSON(res, 200, { ok: true, cleared: true });
      console.log(`\x1b[35m[${timestamp()}] Logs cleared\x1b[0m`);
    }

    // ── GET /status — Full server status ──
    else if (method === "GET" && path === "/status") {
      const studioConnected = lastStudioPoll > 0 && (Date.now() - lastStudioPoll) < 15000;
      sendJSON(res, 200, {
        ok: true,
        version: VERSION,
        queue: queue.length,
        logs: logs.length,
        commands: cmdIndex,
        hasResult: result !== null,
        studioConnected,
        lastStudioPoll: lastStudioPoll || null,
      });
    }

    // ── POST /control/input — Agent pushes a control command for the character ──
    else if (method === "POST" && path === "/control/input") {
      const body = await readBody(req) || "";
      try {
        const input = JSON.parse(body);
        if (controlInputQueue.length < MAX_CONTROL_QUEUE) {
          controlInputQueue.push(input);
        }
        // Resolve any waiting pollers
        if (controlWaiters.length > 0 && controlInputQueue.length > 0) {
          const cmd = controlInputQueue.shift();
          const waiter = controlWaiters.shift();
          clearTimeout(waiter.timer);
          waiter.resolve(cmd);
        }
        sendJSON(res, 200, { ok: true, queued: controlInputQueue.length });
      } catch (_e) {
        sendJSON(res, 400, { error: "Invalid JSON" });
      }
    }

    // ── GET /control/poll — Play mode script polls for next control input ──
    else if (method === "GET" && path === "/control/poll") {
      if (controlInputQueue.length > 0) {
        const cmd = controlInputQueue.shift();
        sendJSON(res, 200, cmd);
      } else {
        // Long-poll: wait up to 2s for an input
        const pollTimeout = parseInt(qs.timeout) || 2000;
        const waiter = {};
        waiter.resolve = (data) => { sendJSON(res, 200, data); };
        waiter.timer = setTimeout(() => {
          controlWaiters = controlWaiters.filter(w => w !== waiter);
          sendJSON(res, 200, "null");
        }, pollTimeout);
        controlWaiters.push(waiter);
      }
    }

    // ── POST /control/state — Play mode script pushes character state ──
    else if (method === "POST" && path === "/control/state") {
      const body = await readBody(req) || "";
      try {
        controlState = JSON.parse(body);
        controlState._timestamp = Date.now();
        controlActive = true;
        sendJSON(res, 200, { ok: true });
      } catch (_e) {
        sendJSON(res, 400, { error: "Invalid JSON" });
      }
    }

    // ── GET /control/state — Agent reads current character state ──
    else if (method === "GET" && path === "/control/state") {
      if (controlState) {
        sendJSON(res, 200, controlState, req);
      } else {
        sendJSON(res, 200, { active: false, error: "No control session active" });
      }
    }

    // ── DELETE /control — Clear control session ──
    else if (method === "DELETE" && path === "/control") {
      controlInputQueue = [];
      controlState = null;
      controlActive = false;
      for (const w of controlWaiters) { clearTimeout(w.timer); w.resolve("null"); }
      controlWaiters = [];
      sendJSON(res, 200, { ok: true, cleared: true });
      console.log(`\x1b[35m[${timestamp()}] Control session cleared\x1b[0m`);
    }

    // ── 404 ──
    else {
      sendJSON(res, 404, { error: "not found" });
    }
  } catch (err) {
    console.error(`\x1b[31m[${timestamp()}] Error: ${err.message}\x1b[0m`);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\x1b[32m╔══════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[32m║  BAD Bridge Server v${VERSION} — port ${PORT}        ║\x1b[0m`);
  console.log(`\x1b[32m║  http://localhost:${PORT}                   ║\x1b[0m`);
  console.log(`\x1b[32m║  Press Ctrl+C to stop                    ║\x1b[0m`);
  console.log(`\x1b[32m╚══════════════════════════════════════════╝\x1b[0m`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\x1b[33m[Bridge] Shutting down...\x1b[0m");
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
