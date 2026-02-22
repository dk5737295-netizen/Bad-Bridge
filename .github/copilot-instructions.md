# BAD Bridge — Copilot Development Instructions

> These instructions are automatically loaded by GitHub Copilot for every conversation in this workspace.

---

## 1. Project Overview

**BAD Bridge** is a VS Code ↔ Roblox Studio bridge system with four components:

| Component | Path | Language | Description |
|---|---|---|---|
| **VS Code Extension** | `src/` | TypeScript | Sidebar UI, command palette commands, log viewer |
| **Bridge Server** | `bridge/server.js` | Node.js | HTTP relay server on port 3001, zero dependencies |
| **MCP Server** | `bridge/mcp-bridge.cjs` | Node.js | MCP stdio protocol for AI assistant tool access |
| **Studio Plugin** | `plugin/BridgePlugin.server.luau` | Luau | v5, polls bridge server, executes commands in Studio |

### Architecture

```
VS Code Extension  ←→  Bridge Server (port 3001)  ←→  Studio Plugin
     (HTTP)                  (Node.js)                   (HTTP polling)
                                ↑
                           MCP Server
                        (stdio, for AI)
```

---

## 2. Tech Stack

| Tool | Purpose |
|---|---|
| **TypeScript** | VS Code extension source |
| **esbuild** | Extension bundler |
| **@vscode/vsce** | Extension packaging (.vsix) |
| **Node.js** | Bridge server + MCP server runtime |
| **Luau** | Studio plugin (Roblox scripting language) |

---

## 3. Naming Conventions

| Element | Convention | Examples |
|---|---|---|
| **TypeScript files** | camelCase | `extension.ts`, `bridge.ts`, `logs.ts` |
| **TypeScript classes** | PascalCase | `BridgeClient`, `LogTreeProvider` |
| **TypeScript methods** | camelCase | `sendCommand()`, `getTree()`, `setProperty()` |
| **Bridge command types** | snake_case | `get_tree`, `set_property`, `create_instance` |
| **MCP tool names** | snake_case with prefix | `bridge_run`, `bridge_tree`, `bridge_find` |
| **Luau modules** | PascalCase | `BridgePlugin` |
| **Luau functions** | PascalCase | `resolvePath()`, `serializeValue()` |
| **Luau constants** | UPPER_SNAKE_CASE | `POLL_INTERVAL`, `MAX_DEPTH_DEFAULT` |
| **Luau privates** | underscore prefix | `_port`, `_connected`, `_logBuffer` |

---

## 4. Extension Development

### Building

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # watch mode
npm run package      # create .vsix
```

### File Structure

| File | Purpose |
|---|---|
| `src/extension.ts` | Extension entry point, command registrations |
| `src/bridge.ts` | `BridgeClient` class — HTTP client for bridge server |
| `src/logs.ts` | `LogTreeProvider` — Studio log viewer in sidebar |
| `src/webview.ts` | `BridgeWebviewProvider` — sidebar webview panel |
| `package.json` | Extension manifest, command declarations, settings |
| `.vscodeignore` | Files excluded from .vsix package |

### Adding New Commands

1. Add command declaration to `package.json` → `contributes.commands`
2. Add client method to `src/bridge.ts` → `BridgeClient`
3. Register handler in `src/extension.ts` using `reg("bad-bridge.commandName", ...)`
4. Add matching command type handler in `plugin/BridgePlugin.server.luau` → `execute()`
5. Add MCP tool definition in `bridge/mcp-bridge.cjs` → `TOOLS` array

---

## 5. Bridge Server (`bridge/server.js`)

- Zero dependencies, pure Node.js `http` module
- In-memory FIFO command queue
- Long-poll support via `/result/wait` and `/run`
- Endpoints: `/poll`, `/result`, `/command`, `/run`, `/logs`, `/ping`, `/status`, `/queue`
- Cross-platform (Windows, macOS, Linux)

---

## 6. MCP Server (`bridge/mcp-bridge.cjs`)

- Implements MCP stdio protocol directly (no SDK dependency)
- Wraps bridge HTTP API as tool calls
- Each tool maps to a bridge command type
- Protocol version: `2024-11-05`

### Adding New MCP Tools

1. Add tool object to the `TOOLS` array with `name`, `description`, `inputSchema`, `handler`
2. Handler should call `bridgeRun()` with the appropriate command object
3. Format the result as a human-readable string

---

## 7. Studio Plugin (`plugin/BridgePlugin.server.luau`)

- **Must start with `--!strict`**
- Polls bridge server at 0.15s intervals
- Auto-reconnects with exponential backoff (1s → 10s max)
- All commands go through the `execute()` function
- Uses `ChangeHistoryService` recording for undo/redo support
- Read-only commands skip change history recording
- Smart value deserialization: converts JSON objects to Color3, Vector3, CFrame, UDim2, BrickColor, etc.

### Adding New Plugin Commands

1. Add `elseif cmdType == "new_command" then` branch in `execute()`
2. If read-only, add to the `readOnly` check list in the poll loop
3. Return `{ success = true/false, result = "...", error = "..." }`
4. Use `resolvePath()` for instance path resolution
5. Use `serializeValue()` for return value serialization
6. Use `deserializeValue()` for incoming value deserialization

---

## 8. Coding Standards

### TypeScript (Extension)

- Use `async/await` for all bridge communication
- All public methods on `BridgeClient` return `Promise<BridgeResult | null>`
- Use `vscode.window.showInputBox()` for user input in commands
- Use `executeAndShow()` helper for consistent command result display
- Handle timeouts gracefully — bridge may be slow on play mode commands

### Luau (Plugin)

- **`--!strict` is mandatory** at the top of every file
- Type-annotate all function parameters and returns
- Use `pcall` for all external/HTTP calls
- Use `task.spawn`, `task.wait`, `task.delay` (never `spawn`, `wait`, `delay`)
- Use `game:GetService()` — never direct property access on `game`

### Node.js (Server/MCP)

- Zero external dependencies — use only Node.js built-ins
- Use `http` module directly, not Express or similar
- JSON-only communication
- CORS headers on all responses

---

## 9. Security

- Bridge runs on `127.0.0.1` only (localhost) — not exposed to network
- No authentication (local-only by design)
- Plugin requires **Allow HTTP Requests** in Studio settings
- `run` command requires **LoadStringEnabled** — warn users if disabled
- Never send sensitive data through the bridge

---

## 10. Testing — Deep Verification (MANDATORY)

When testing Roblox game features through the bridge, **never limit verification to console output alone**. Always inspect the actual game state to confirm things are working.

### Testing Philosophy

> **Don't just read the Output window — look at what's actually happening in the game.**

Console output tells you what the code *says* it did. Deep verification tells you what *actually* happened.

### Test Depth Levels

| Level | What to Check | How |
|---|---|---|
| **1. Console** | Errors, warnings, print statements | `bridge_console` / `get_console_output` — use this as a **starting point only** |
| **2. GUI / UI** | UI frames visible, correct text, correct values, buttons working | `bridge_play` → inspect `PlayerGui` descendants, check `.Visible`, `.Text`, `.Size`, child counts |
| **3. Instance State** | Objects exist where expected, correct properties, correct hierarchy | `bridge_tree`, `bridge_find`, `bridge_props`, `bridge_get_children` |
| **4. Data / Services** | Player data loaded, service state correct, configs parsed | `bridge_play` → `require()` services directly, read profile data, call service methods |
| **5. Remotes** | Remote events/functions exist and respond | `bridge_find` for remotes, invoke server methods directly in test scripts |

### Mandatory Test Checklist (for play-mode tests)

When testing a game feature in play mode, **always do ALL of these**:

1. **Wait for full load** — `task.wait(6-10)` after `PlayerAdded:Wait()` to let Bootstrap, ProfileService, and UI finish initializing.
2. **Inspect the GUI** — Walk `PlayerGui:GetDescendants()` and check:
   - Do the expected frames/buttons exist?
   - Are they `.Visible`?
   - Do `TextLabel.Text` values show correct data?
   - Are scroll frames populated with children?
3. **Inspect game state** — Check instances in Workspace, ServerStorage, ReplicatedStorage:
   - Were expected objects created/destroyed?
   - Are properties set to the right values?
4. **Query services directly** — `require()` the relevant service and call its public methods:
   - Does it return the expected data structure?
   - Are counts/values correct?
5. **Check profile data** — Load the player profile via `PlayerDataService:WaitForProfile()`:
   - Are expected keys present?
   - Are values the correct type and in valid ranges?
6. **Report structured results** — Return a structured summary, not just "it works":
   - List what was found, with counts and values
   - Flag any mismatches between expected and actual state

### Example: Deep Test of a Feature

```luau
-- BAD: Only checking console
print("Feature loaded!")  -- This tells you nothing

-- GOOD: Deep inspection
local player = Players.PlayerAdded:Wait()
task.wait(8)

local out = {}

-- Check GUI
local gui = player.PlayerGui:FindFirstChild("GUI")
local frame = gui and gui.Frames:FindFirstChild("FeatureFrame")
table.insert(out, "Frame exists: " .. tostring(frame ~= nil))
table.insert(out, "Frame visible: " .. tostring(frame and frame.Visible))

-- Check children populated
local list = frame and frame:FindFirstChild("ScrollList")
local childCount = list and #list:GetChildren() or 0
table.insert(out, "List items: " .. childCount)

-- Check service state
local FeatureService = require(SSS.Services.FeatureService)
local state = FeatureService:GetState(player)
table.insert(out, "Service state: " .. tostring(state))

-- Check data
local profile = PlayerDataService:WaitForProfile(player)
table.insert(out, "Data key exists: " .. tostring(profile.Data.FeatureKey ~= nil))

return table.concat(out, "\n")
```

### What NOT to Do

- **DON'T** only check `print()` output and call it tested
- **DON'T** assume a feature works because no errors appeared in console
- **DON'T** skip UI inspection — the UI is what the player sees
- **DON'T** return "it works" without evidence — return actual values, counts, and states
- **DON'T** test in edit mode when the feature requires a player/play mode

### Extension / Server Testing

- Test extension commands manually via `Ctrl+Shift+P`
- Test bridge server via `curl` or `Invoke-RestMethod`
- Test plugin by connecting from VS Code and running commands
- Verify new commands work end-to-end: Extension → Server → Plugin → Server → Extension

---

## 11. Version History

| Plugin | Extension | Server | Changes |
|---|---|---|---|
| v5 | v2.1.0 | v4 | Smart value deserialization, attributes, CFrame rotation, auto-reconnect, get_children |
| v4 | v2.0.0 | v4 | Instance manipulation, script editing, play mode, MCP, console output, marketplace |

---

*This document is the source of truth for BAD Bridge development standards.*
