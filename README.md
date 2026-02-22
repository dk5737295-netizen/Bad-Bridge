# BAD Bridge

**AI-powered Roblox Studio development** — your AI agent (Copilot, Claude, etc.) connects directly to Roblox Studio with 37 MCP tools. Create instances, edit scripts, inspect the game tree, control play mode — all through natural language.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  VS Code                                                        │
│                                                                 │
│  ┌──────────────┐    MCP stdio    ┌──────────────────────────┐  │
│  │  AI Agent     │◄══════════════►│  MCP Server              │  │
│  │  (Copilot /   │   37 tools     │  bridge/mcp-bridge.cjs   │  │
│  │   Claude)     │                │  Zero dependencies       │  │
│  └──────────────┘                 └────────────┬─────────────┘  │
│                                                │ HTTP           │
│  ┌──────────────┐                 ┌────────────▼─────────────┐  │
│  │  Extension    │◄══════════════►│  Bridge Server           │  │
│  │  Sidebar UI   │    HTTP        │  bridge/server.js        │  │
│  └──────────────┘                 └────────────┬─────────────┘  │
│                                                │                │
└────────────────────────────────────────────────┼────────────────┘
                                                 │ HTTP polling
                                    ┌────────────▼─────────────┐
                                    │  Studio Plugin v5        │
                                    │  BridgePlugin.luau       │
                                    └──────────────────────────┘
```

**The AI agent talks directly to Studio.** No copy-pasting scripts. No manual steps. The agent uses bridge tools to create Parts, edit scripts, set properties, inspect the game tree — everything happens automatically.

## One-Command Setup

```bash
npm run setup
```

This single command:
- ✅ Installs all dependencies
- ✅ Builds and installs the VS Code extension
- ✅ Installs the Studio plugin to your Roblox plugins folder
- ✅ Configures MCP so AI agents auto-discover all 37 bridge tools
- ✅ Sets up Rojo integration (if `default.project.json` exists)

### After Setup — Configure Roblox Studio

1. Open (or restart) Roblox Studio
2. **Game Settings → Security → Allow HTTP Requests** = ON
3. **Game Settings → Security → LoadStringEnabled** = ON (optional, for `bridge_run`)

### That's all. Open the workspace and everything auto-connects.

---

## What the Agent Can Do (37 MCP Tools)

The AI agent has **direct access** to Studio through these tools — no LoadStringEnabled required for most:

### Build & Modify (always available)
| Tool | What it does |
|---|---|
| `bridge_create` | Create any instance (Part, Model, Light, GUI, etc.) with properties |
| `bridge_batch` | Create/modify up to 200 instances in a single call |
| `bridge_set_property` | Set Position, Color, Size, Material, CFrame, etc. |
| `bridge_delete` / `bridge_clone` | Remove or duplicate instances |
| `bridge_move` / `bridge_rename` | Reorganize the hierarchy |
| `bridge_insert_model` | Insert free models from the marketplace |

### Scripts (Rojo-aware)
| Tool | What it does |
|---|---|
| `bridge_create_script` | Create new scripts (writes `.luau` to disk with Rojo) |
| `bridge_script_write` | Write full script source |
| `bridge_script_edit` | Find-and-replace in scripts |
| `bridge_script_read` | Read script source (disk or Studio) |

### Inspect & Search
| Tool | What it does |
|---|---|
| `bridge_game_map` | Bird's-eye overview of the entire game |
| `bridge_tree` / `bridge_props` | Navigate instance hierarchy and properties |
| `bridge_find` / `bridge_get_children` | Search for instances by name/class |
| `bridge_scan_scripts` | Discover all scripts with source code |
| `bridge_search_code` | Grep across all scripts |
| `bridge_require_graph` | Trace require() dependencies |
| `bridge_bulk_inspect` | Deep inspect with all properties |

### Play Mode & Testing
| Tool | What it does |
|---|---|
| `bridge_run` | Execute Luau code in Studio (needs LoadStringEnabled) |
| `bridge_play` | Run code in play mode |
| `bridge_play_control` | Start/stop play testing |
| `bridge_console` / `bridge_logs` | Read Studio output |

### Meta & Utilities
| Tool | What it does |
|---|---|
| `bridge_status` / `bridge_capabilities` | Connection status, feature detection |
| `bridge_class_info` | Look up settable properties for any class |
| `bridge_undo` / `bridge_redo` | Revert changes |
| `bridge_selection` | Get/set Studio selection |
| `bridge_studio_mode` | Check edit/play mode |
| `bridge_rojo_status` | Check Rojo integration |
| `bridge_get_attributes` / `bridge_set_attribute` / `bridge_delete_attribute` | Custom attributes |

## Smart Value Types

Properties accept rich JSON types:

```json
{"r": 255, "g": 0, "b": 128}                              // Color3
{"x": 10, "y": 5, "z": -3}                                // Vector3
{"x": 0, "y": 10, "z": 0, "rx": 0, "ry": 45, "rz": 0}   // CFrame
{"sx": 0.5, "ox": 0, "sy": 1, "oy": -20}                  // UDim2
"Bright red"                                               // BrickColor
"Enum.Material.Neon"                                       // EnumItem
```

## VS Code Commands

Use `Ctrl+Shift+P` or the **BAD Bridge sidebar** (rocket icon):

| Category | Commands |
|---|---|
| **Setup** | Diagnose Setup, Install Plugin, Setup MCP, Start Server |
| **Code** | Run Luau Code, Run Selected Code |
| **Instances** | Get Tree, Find, Create, Delete, Clone, Move, Rename, Set Property |
| **Scripts** | Get/Push Script Source, Get Attributes |
| **Play Mode** | Start Play, Run Server, Stop, Run Script in Play |
| **Meta** | Get Console, Get Selection, Get Studio Mode |

## Components

| Component | Path | Description |
|---|---|---|
| **MCP Server** | `bridge/mcp-bridge.cjs` | 37 tools for AI agents, zero dependencies, Rojo-aware |
| **Bridge Server** | `bridge/server.js` | Node.js HTTP relay (port 3001), auto-started by extension |
| **VS Code Extension** | `src/`, `dist/` | Sidebar UI, commands, log viewer |
| **Studio Plugin** | `plugin/BridgePlugin.server.luau` | v5 — auto-connects, 3-failure tolerance, smart reconnection |
| **Setup Script** | `scripts/setup.js` | One-command full installer |

## Troubleshooting

Run `Ctrl+Shift+P` → **BAD Bridge: Diagnose Setup** for automatic diagnostics.

| Problem | Fix |
|---|---|
| AI agent can't use bridge tools | `Ctrl+Shift+P` → MCP: List Servers → restart `bad-bridge` → start new chat |
| Server not running | Extension auto-starts it. Manual: `Ctrl+Shift+P` → Start Server |
| Plugin not connecting | Check "Allow HTTP Requests" is ON in Studio Game Settings |
| `bridge_run` fails | Enable "LoadStringEnabled" in Studio Security settings |
| Connection interrupted | Plugin auto-reconnects (tolerates up to 3 failures before disconnecting) |
| Extension not installed | Run `npm run setup` again |

## Manual Setup (Advanced)

```bash
npm install                    # Install deps
npm run build                  # Build extension
npm run package                # Create .vsix
# Ctrl+Shift+P → "Extensions: Install from VSIX…"
.\plugin\install-plugin.ps1   # Install Studio plugin
```

## License

Private — for Build And Defend development.
