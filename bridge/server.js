#!/usr/bin/env node
// Build And Defend — Studio Bridge Server v4 (Node.js)
// Cross-platform, in-memory FIFO queue, log streaming, zero dependencies.
// Usage: node server.js [--port 3001]

const http = require("http");

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
const VERSION = 4;

// Long-poll waiters for result
let resultWaiters = [];    // Array of { resolve, timer } for pending long-poll requests

// ── Helpers ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
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
        sendJSON(res, 200, r);
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
        waiter.resolve = (r) => { sendJSON(res, 200, r); };
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

      // If result already available (unlikely), return immediately
      if (result !== null) {
        const r = result;
        result = null;
        sendJSON(res, 200, r);
      } else {
        const waiter = {};
        waiter.resolve = (r) => { sendJSON(res, 200, r); };
        waiter.timer = setTimeout(() => {
          resultWaiters = resultWaiters.filter(w => w !== waiter);
          sendJSON(res, 200, { success: false, error: "timeout", waited: timeoutMs });
        }, timeoutMs);
        resultWaiters.push(waiter);
      }
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
      sendJSON(res, 200, logs);
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
      sendJSON(res, 200, {
        ok: true,
        version: VERSION,
        queue: queue.length,
        logs: logs.length,
        commands: cmdIndex,
        hasResult: result !== null,
      });
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
