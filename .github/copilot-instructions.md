# BAD Bridge — Copilot Development Instructions

> These instructions are automatically loaded by GitHub Copilot for every conversation in this workspace.

---

## 0. CRITICAL AGENT BEHAVIOR RULES (READ FIRST)

**These rules override all other behavior. Follow them without exception.**

### ALWAYS Use Bridge Tools — NEVER Generate Scripts for Manual Execution

When the user asks you to create, modify, inspect, or interact with anything in Roblox Studio:

1. **ALWAYS use BAD Bridge MCP tools** (`bridge_create`, `bridge_set_property`, `bridge_batch`, `bridge_tree`, etc.) to perform the action directly in Studio.
2. **NEVER generate a Luau script and tell the user to paste/run it** — that defeats the purpose of the bridge.
3. **NEVER suggest the user manually do something in Studio** if a bridge tool can do it.
4. **NEVER write code to a file and ask the user to execute it** unless they explicitly asked for a standalone script.

### Decision Flow for Every User Request

```
User wants something in Studio
  ├─ Can bridge tools do it? (create, set_property, batch, script_write, etc.)
  │   └─ YES → Use bridge tools directly. Done.
  ├─ Needs complex logic that only Luau can do?
  │   ├─ Is LoadStringEnabled ON? (check with bridge_capabilities)
  │   │   └─ YES → Use bridge_run to execute Luau in Studio
  │   └─ NO → Break it into bridge tool calls (create, set_property, batch)
  │           Even 50+ bridge_create calls is better than asking the user to paste a script.
  └─ Is it a permanent game script? (gameplay logic, server code, etc.)
      └─ YES → Use bridge_script_write or bridge_create_script to write the .luau file
```

### What Works WITHOUT LoadStringEnabled (use these ALWAYS)

| Category | Tools | Notes |
|---|---|---|
| **Create things** | `bridge_create`, `bridge_batch` | Create Parts, Models, Lights, GUIs, etc. |
| **Modify things** | `bridge_set_property`, `bridge_set_properties`, `bridge_rename`, `bridge_move`, `bridge_clone` | Set Position, Color, Size, Material, etc. |
| **Delete things** | `bridge_delete` | Remove instances |
| **Scripts** | `bridge_script_write`, `bridge_script_edit`, `bridge_create_script`, `bridge_script_read` | Full script CRUD |
| **Inspect** | `bridge_tree`, `bridge_props`, `bridge_find`, `bridge_game_map`, `bridge_scan_scripts`, `bridge_bulk_inspect`, `bridge_get_children` | Read game state |
| **Search** | `bridge_search_code`, `bridge_require_graph` | Find code patterns |
| **Attributes** | `bridge_get_attributes`, `bridge_set_attribute`, `bridge_delete_attribute` | Custom attributes |
| **Tags** | `bridge_tags` | CollectionService tag management (get/add/remove/find) |
| **Animation** | `bridge_tween` | Animate properties with TweenService |
| **Physics** | `bridge_raycast` | Cast rays, check line-of-sight, detect geometry |
| **Selection** | `bridge_selection` | Get/set Studio selection |
| **Undo/Redo** | `bridge_undo`, `bridge_redo` | Revert changes |
| **Marketplace** | `bridge_insert_model` | Insert free models |
| **API Reference** | `bridge_api_lookup` | Look up any Roblox class properties/methods/events from API dump |
| **Terrain** | `bridge_terrain` | Fill/clear/replace terrain regions with any material |
| **Lighting** | `bridge_lighting` | Configure Lighting + post-processing effects |
| **Sound** | `bridge_sound` | Create, play, stop, pause sounds |
| **GUI Builder** | `bridge_gui_builder` | Create entire UI hierarchies from declarative JSON |
| **Constraints** | `bridge_constraint` | Create physics constraints with auto-attachments |
| **Particles** | `bridge_particles` | Create particle emitters with presets |
| **Snapshots** | `bridge_diff` | Save/compare subtree state for diffing |
| **Export** | `bridge_export` | Export subtree as JSON with properties |
| **Animate** | `bridge_animate` | Create KeyframeSequence animations |
| **Memory** | `bridge_memory` | Persistent context memory across sessions |
| **History** | `bridge_history` | View recent command history |
| **Meta** | `bridge_status`, `bridge_capabilities`, `bridge_class_info`, `bridge_rojo_status`, `bridge_studio_mode` | System info |

### What REQUIRES LoadStringEnabled

| Tool | Why |
|---|---|
| `bridge_run` | Executes arbitrary Luau code via `loadstring()` |
| `bridge_play` | Runs Luau in play mode (uses loadstring internally) |
| `bridge_character_control` | Real-time character control (injects control loop via loadstring) |

### Efficiency: Use `bridge_batch` for Multiple Operations

Instead of 10 separate tool calls, batch them:
```json
{
  "commands": [
    {"type": "create_instance", "className": "Part", "parent": "game.Workspace", "name": "Wall1", "properties": {"Size": {"x":20,"y":10,"z":1}, "Position": {"x":0,"y":5,"z":10}, "Anchored": true}},
    {"type": "create_instance", "className": "Part", "parent": "game.Workspace", "name": "Wall2", "properties": {"Size": {"x":20,"y":10,"z":1}, "Position": {"x":0,"y":5,"z":-10}, "Anchored": true}},
    {"type": "create_instance", "className": "PointLight", "parent": "game.Workspace.Wall1", "properties": {"Brightness": 2, "Range": 30}}
  ]
}
```

### Session Startup Checklist

Every new conversation, BEFORE doing anything:
1. `bridge_status` → Is Studio connected?
2. `bridge_capabilities` → Is LoadStringEnabled on? What's the plugin version?
3. `bridge_game_map` → What's already in the game?

### NEVER Use Terminal HTTP Workarounds

If MCP bridge tools are not available in the current session:
- **DO NOT** use `Invoke-RestMethod`, `curl`, or any terminal HTTP calls to `localhost:3001` as a workaround
- **TELL THE USER** to restart the MCP server: `Ctrl+Shift+P → MCP: List Servers → restart bad-bridge`
- **TELL THE USER** to start a new chat session after restarting
- The MCP tools MUST be properly loaded — there is no acceptable workaround

---

## 1. Roblox API Reference (MANDATORY)

**Always consult the official Roblox Engine API documentation before writing or suggesting any Roblox-specific code:**

- **Engine Reference:** https://create.roblox.com/docs/reference/engine
- **Classes:** https://create.roblox.com/docs/reference/engine/classes
- **Enums:** https://create.roblox.com/docs/reference/engine/enums
- **Data Types:** https://create.roblox.com/docs/reference/engine/datatypes
- **Libraries:** https://create.roblox.com/docs/reference/engine/libraries
- **Globals:** https://create.roblox.com/docs/reference/engine/globals

When writing or suggesting Roblox APIs, services, methods, properties, or events:
- **Verify they exist** in the current Roblox engine API (fetch the doc page if unsure).
- Use **correct method signatures**, parameter types, and return types from the docs.
- **Never hallucinate** Roblox API methods, properties, or events — if unsure, look them up.
- Prefer **modern Roblox APIs** over deprecated ones (e.g., `task.spawn` over `spawn`, `task.wait` over `wait`).
- Use `bridge_class_info` to check what properties are settable on a given ClassName.
- Use `bridge_capabilities` to check if `LoadStringEnabled` is on before trying `bridge_run`.

---

## 2. MCP Bridge Tools — Workflow Guide

When working with Roblox Studio through the BAD Bridge MCP tools, follow this workflow:

### First Steps (Every Session)
1. **`bridge_status`** — Always call first to verify connection + see if LoadStringEnabled is on.
2. **`bridge_game_map`** — Get a bird's-eye view of the game structure before doing anything.
3. **`bridge_capabilities`** — Check what features are available (LoadStringEnabled, plugin version).

### Understanding the Game
- **`bridge_scan_scripts`** with `sources=true` — Read ALL scripts in one call to understand the codebase.
- **`bridge_require_graph`** — Trace module dependencies to understand architecture.
- **`bridge_search_code`** — Find where functions, variables, or patterns are used (like grep).
- **`bridge_tree`** — Explore instance hierarchy for a specific path.
- **`bridge_props`** with `types=true` — Read properties WITH their Roblox types (Vector3, Color3, etc.).

### Making Changes
- **`bridge_class_info`** — Look up settable properties for a class BEFORE setting them.
- **`bridge_script_edit`** — Find-and-replace in scripts (works without LoadStringEnabled).
- **`bridge_script_write`** — Write full script source (works without LoadStringEnabled).
- **`bridge_create`** — Create instances with properties.
- **`bridge_set_property`** — Set instance properties (use correct type format).
- **`bridge_batch`** — Combine multiple operations in one round trip for efficiency.

### Property Type Formats (for set_property / create)
| Roblox Type | JSON Format | Example |
|---|---|---|
| Color3 | `{r, g, b}` (0-255) | `{"r": 255, "g": 0, "b": 0}` |
| Vector3 | `{x, y, z}` | `{"x": 0, "y": 5, "z": 0}` |
| CFrame | `{x, y, z, rx, ry, rz}` (degrees) | `{"x": 0, "y": 5, "z": 0, "rx": 0, "ry": 45, "rz": 0}` |
| Vector2 | `{x, y}` | `{"x": 0.5, "y": 0.5}` |
| UDim2 | `{sx, ox, sy, oy}` | `{"sx": 1, "ox": 0, "sy": 0.5, "oy": 0}` |
| UDim | `{s, o}` | `{"s": 1, "o": 0}` |
| BrickColor | String name | `"Bright red"` |
| NumberRange | `{min, max}` | `{"min": 5, "max": 10}` |
| Rect | `{minX, minY, maxX, maxY}` | `{"minX": 0, "minY": 0, "maxX": 100, "maxY": 100}` |
| EnumItem | String | `"Enum.Material.Neon"` |
| boolean/number/string | Literal | `true`, `42`, `"Hello"` |

---

## 3. Project Overview

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

## 4. Tech Stack

| Tool | Purpose |
|---|---|
| **TypeScript** | VS Code extension source |
| **esbuild** | Extension bundler |
| **@vscode/vsce** | Extension packaging (.vsix) |
| **Node.js** | Bridge server + MCP server runtime |
| **Luau** | Studio plugin (Roblox scripting language) |

---

## 5. Naming Conventions

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

## 6. Extension Development

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

## 7. Bridge Server (`bridge/server.js`)

- Zero dependencies, pure Node.js `http` module
- In-memory FIFO command queue
- Long-poll support via `/result/wait` and `/run`
- Tracks Studio connection via last poll timestamp (`studioConnected` in `/status`)
- Endpoints: `/poll`, `/result`, `/command`, `/run`, `/logs`, `/ping`, `/status`, `/queue`
- Cross-platform (Windows, macOS, Linux)

---

## 8. MCP Server (`bridge/mcp-bridge.cjs`)

- Implements MCP stdio protocol directly (no SDK dependency)
- Wraps bridge HTTP API as tool calls
- Each tool maps to a bridge command type
- Protocol version: `2024-11-05`
- Tool descriptions use present-tense action format for clear agent logs

### Adding New MCP Tools

1. Add tool object to the `TOOLS` array with `name`, `description`, `inputSchema`, `handler`
2. Handler should call `bridgeRun()` with the appropriate command object
3. Format the result as a human-readable string
4. Use action-oriented descriptions (e.g., "Searching for instances..." not "Search for instances")

### MCP Tools Reference

| Tool | Purpose |
|---|---|
| `bridge_status` | Check connection + LoadStringEnabled + Studio mode |
| `bridge_capabilities` | Full capability report (plugin version, LoadString, known classes) |
| `bridge_game_map` | High-level game structure overview |
| `bridge_tree` | Instance hierarchy explorer |
| `bridge_find` | Search instances by name/class |
| `bridge_props` | Read properties (with optional type info) |
| `bridge_class_info` | Look up settable properties for a ClassName |
| `bridge_bulk_inspect` | Full tree + all properties |
| `bridge_run` | Execute Luau code (requires LoadStringEnabled) |
| `bridge_batch` | Multiple commands in one round trip |
| `bridge_create` | Create instances with properties |
| `bridge_set_property` | Set a property on an instance |
| `bridge_delete` | Delete an instance |
| `bridge_move` | Move/reparent an instance |
| `bridge_rename` | Rename an instance |
| `bridge_clone` | Clone an instance |
| `bridge_script_read` | Read script source (Rojo-aware) |
| `bridge_script_write` | Write script source (Rojo-aware) |
| `bridge_script_edit` | Find-and-replace in scripts |
| `bridge_create_script` | Create new scripts (Rojo-aware) |
| `bridge_scan_scripts` | List all scripts with metadata |
| `bridge_search_code` | Grep across all scripts |
| `bridge_require_graph` | Trace require() dependencies |
| `bridge_selection` | Get/set Studio selection |
| `bridge_play_control` | Start/stop play mode |
| `bridge_play` | Run code in play mode |
| `bridge_studio_mode` | Check current Studio mode |
| `bridge_console` | Read console output |
| `bridge_logs` | Read log entries |
| `bridge_get_attributes` | Read custom attributes |
| `bridge_set_attribute` | Set custom attributes |
| `bridge_delete_attribute` | Remove custom attributes |
| `bridge_get_children` | Lightweight child list |
| `bridge_insert_model` | Insert marketplace model |
| `bridge_undo` / `bridge_redo` | Undo/redo changes |
| `bridge_rojo_status` | Check Rojo integration status |
| `bridge_api_lookup` | Look up ALL Roblox API properties/methods/events for any class |
| `bridge_tags` | CollectionService tag management (get/add/remove/find by tag) |
| `bridge_tween` | Animate properties with TweenService (easing, duration, wait) |
| `bridge_raycast` | Cast rays for line-of-sight, ground detection, collision checks |
| `bridge_set_properties` | Set multiple properties on one instance in one call |
| `bridge_character_control` | Real-time character control — walk, jump, interact, equip tools, read surroundings |
| `bridge_terrain` | Fill/clear/replace terrain (block, ball, cylinder shapes) |
| `bridge_lighting` | Configure Lighting + create/modify post-processing effects |
| `bridge_sound` | Create, play, stop, pause, resume sounds |
| `bridge_gui_builder` | Create complex UI hierarchies from declarative JSON in one call |
| `bridge_constraint` | Create physics constraints with auto-attachment creation |
| `bridge_particles` | Create particle emitters with presets (fire, smoke, sparkle, rain, snow) |
| `bridge_diff` | Save/compare subtree snapshots for change detection |
| `bridge_export` | Export subtree as JSON with properties and optional script source |
| `bridge_animate` | Create KeyframeSequence animations with poses |
| `bridge_memory` | Persistent context memory — save/recall facts across sessions |
| `bridge_history` | View recent command history |
| `bridge_test_runner` | Run Luau test scripts in play mode with pass/fail reporting |

---

## 9. Studio Plugin (`plugin/BridgePlugin.server.luau`)

- **Must start with `--!strict`**
- Polls bridge server at 0.25s intervals (with 3-failure tolerance before disconnection)
- Auto-reconnects with gentle backoff (0.5s → 5s max)
- All commands go through the `execute()` function
- Uses `ChangeHistoryService` recording for undo/redo support
- Read-only commands skip change history recording
- Smart value deserialization: converts JSON objects to Color3, Vector3, CFrame, UDim2, BrickColor, etc.
- Detects `LoadStringEnabled` at startup and reports via `get_capabilities`
- Has a built-in property database (`KNOWN_PROPS`) for 40+ common classes

### Adding New Plugin Commands

1. Add `elseif cmdType == "new_command" then` branch in `execute()`
2. If read-only, add to the `readOnly` check list in the poll loop
3. Return `{ success = true/false, result = "...", error = "..." }`
4. Use `resolvePath()` for instance path resolution
5. Use `serializeValue()` for return value serialization
6. Use `deserializeValue()` for incoming value deserialization

---

## 10. Coding Standards

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

- Zero external dependencies for bridge server — use only Node.js built-ins
- MCP server is also zero-dependency (mcp-bridge.cjs)
- Use `http` module directly, not Express or similar
- JSON-only communication
- CORS headers on all responses

---

## 11. Rojo Integration

The MCP server is **Rojo-aware**. When a `default.project.json` exists in the workspace root, script operations write `.luau` files to disk instead of pushing `.Source` into Studio. Rojo syncs them automatically.

### How It Works

| Operation | Without Rojo | With Rojo |
|---|---|---|
| **Create script** | `create_instance` in Studio | Creates `.luau` file on disk |
| **Edit script** | `set_script_source` in Studio | Writes `.luau` file on disk |
| **Read script** | `get_script_source` from Studio | Reads `.luau` file from disk (fallback: Studio) |
| **Create Part/Model** | Bridge → Studio | Bridge → Studio (unchanged) |
| **Set property** | Bridge → Studio | Bridge → Studio (unchanged) |

### File Naming Convention (Rojo standard)

| Script Class | File Extension |
|---|---|
| `Script` (server) | `.server.luau` |
| `LocalScript` (client) | `.client.luau` |
| `ModuleScript` | `.luau` |

### Configuration

The MCP server reads `ROJO_PROJECT_ROOT` env var (defaults to `cwd`). Set in `.vscode/mcp.json`:

```json
{
  "env": {
    "ROJO_PROJECT_ROOT": "${workspaceFolder}"
  }
}
```

---

## 12. Luau Coding Standards (for scripts written via bridge)

When writing Luau code that will be pushed to Studio via bridge tools:

- **Every file starts with `--!strict`**
- **Type-annotate all functions:**
  ```luau
  function Module:GetCash(player: Player): number
  ```
- **Modern idioms only:**
  - `task.spawn()` not `spawn()`
  - `task.wait()` not `wait()`
  - `task.delay()` not `delay()`
  - `game:GetService("ServiceName")` — never `game.ServiceName`
- **Use `pcall` for external calls** (DataStore, HTTP, etc.)
- **Early returns** for nil guards: `if not x then return end`
- **Compact code** — no excessive blank lines or boilerplate comments
- **Never use deprecated `table` type** — use `{[string]: any}` or typed tables
- **Use `Debris:AddItem()` or Maid** for cleanup

---

## 13. Security

- Bridge runs on `127.0.0.1` only (localhost) — not exposed to network
- No authentication (local-only by design)
- Plugin is installed as `.rbxmx` or `.lua` in `%LOCALAPPDATA%\Roblox\Plugins\`
- Plugin requires **Allow HTTP Requests** in Studio settings
- `bridge_run` requires **LoadStringEnabled** — use `bridge_capabilities` to check
- Never send sensitive data through the bridge

---

## 14. Real-Time Character Control

The `bridge_character_control` tool lets the AI agent control a player character during play mode for testing, navigation, and gameplay validation.

### Architecture

```
Agent → MCP bridge_character_control → POST /control/input → Bridge Server queue
                                                                    ↓
Agent ← MCP bridge_character_control ← GET  /control/state ← Play mode script pushes state
```

A persistent control loop runs inside play mode, polling the bridge server for inputs and pushing character state back every 0.3s.

### Workflow

1. **Start**: `action: "start"` — enters play mode, injects control script, waits for character spawn
2. **Navigate**: Send `move_to`, `move_direction`, `jump`, `look_at`, `teleport`, `stop_moving`
3. **Interact**: `equip`/`unequip` tools, `use_tool`, `interact` with ProximityPrompts/ClickDetectors
4. **Observe**: `state` returns position, health, velocity, nearby objects, raycasts, backpack
5. **Stop**: `action: "stop"` — exits play mode, clears control state

### State Data Returned

The control loop reports rich environmental data:
- **Character**: position, health, velocity, moveState (idle/walking/jumping/falling), isGrounded, walkSpeed, facing direction
- **Equipment**: equipped tool name, backpack contents
- **Nearby objects**: instances within scan radius with name, class, distance, position
- **Spatial raycasts**: 8 compass directions + down + forward, reporting hit distance, instance, and material
- **Timestamp**: game time for tracking

### Key Constraints

- Requires **LoadStringEnabled** (injects control loop via loadstring)
- Character must be alive for movement commands to work
- Session timeout defaults to 5 minutes
- The control script auto-reports death and stops on character removal

---

## 15. Testing

- Test extension commands manually via `Ctrl+Shift+P`
- Test bridge server via `curl` or `Invoke-RestMethod`
- Test plugin by connecting from VS Code and running commands
- Verify new commands work end-to-end: Extension → Server → Plugin → Server → Extension

---

## 16. Version History

| Plugin | Extension | Server | Changes |
|---|---|---|---|
| v5 | v2.3.0 | v4 | Property type info, LoadString detection, class_info/capabilities commands, improved reconnection, better agent UX |
| v5 | v2.2.0 | v4 | Rojo-aware MCP server, disk-based script editing, bridge_create_script, bridge_rojo_status, .rbxmx plugin format |
| v5 | v2.1.0 | v4 | Smart value deserialization, attributes, CFrame rotation, auto-reconnect, get_children |
| v4 | v2.0.0 | v4 | Instance manipulation, script editing, play mode, MCP, console output, marketplace |

---

*This document is the source of truth for BAD Bridge development standards.*
