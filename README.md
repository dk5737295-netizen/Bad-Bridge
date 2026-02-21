# BAD Bridge

**VS Code ↔ Roblox Studio bridge** — execute Luau code, inspect/manipulate instances, control play mode, and stream logs between VS Code and Roblox Studio in real time.

## Components

| Component | Path | Description |
|---|---|---|
| **VS Code Extension** | `src/`, `dist/` | Sidebar UI, commands, log viewer |
| **Bridge Server** | `bridge/server.js` | Node.js HTTP relay (port 3001) |
| **MCP Server** | `bridge/mcp-bridge.cjs` | MCP tools for AI assistants (Copilot) |
| **Studio Plugin** | `plugin/BridgePlugin.server.luau` | v5 — polls server, executes commands |
| **Helpers** | `bridge/helpers.ps1` | PowerShell convenience functions |

## Quick Start

### 1. Install the VS Code Extension

```bash
# From source
npm install
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
# Then: Ctrl+Shift+P → "Extensions: Install from VSIX…"
```

Or install the pre-built `.vsix` from [Releases](../../releases).

### 2. Install the Studio Plugin

```powershell
.\plugin\install-plugin.ps1
```

This copies `BridgePlugin.server.luau` to your local Roblox Studio plugins folder.

### 3. Studio Settings

- **Game Settings → Security → Allow HTTP Requests** = ON
- **Game Settings → Security → Allow Server Scripts To Use LoadString** = ON (for `run` command)

### 4. Start the Bridge

In VS Code: `Ctrl+Shift+P` → **BAD Bridge: Start Server**

Or manually:

```bash
node bridge/server.js --port 3001
```

The Studio plugin auto-connects within ~2 seconds.

## Available Commands

### VS Code Command Palette (`Ctrl+Shift+P`)

| Command | Description |
|---|---|
| **Start Server** | Launch the bridge server |
| **Connect / Disconnect** | Manual connection control |
| **Run Luau Code** | Execute Luau in Studio (edit mode) |
| **Run Selected Code** | Right-click → run selection in Studio |
| **Run Script in Play Mode** | Inject & run a script in play mode |
| **Get Instance Tree** | Browse instance hierarchy |
| **Find Instances** | Search by name/class |
| **Create / Delete / Clone / Move / Rename Instance** | Instance manipulation |
| **Set Property** | Set a property (supports Color3, Vector3, CFrame, etc.) |
| **Get / Set / Delete Attribute** | Attribute manipulation |
| **Get Children** | Lightweight child list |
| **Get / Push Script Source** | Read/write script source |
| **Get Selection** | See selected instances in Studio |
| **Start Play / Run Server / Stop** | Play mode control |
| **Get Console Output** | Read Studio console |
| **Get Studio Mode** | Check current mode |
| **Undo / Redo** | ChangeHistoryService |
| **Insert Model** | Search + insert marketplace model |

### MCP Tools (for AI assistants)

The MCP server (`bridge/mcp-bridge.cjs`) exposes all bridge functionality as native tools:

`bridge_status`, `bridge_run`, `bridge_tree`, `bridge_find`, `bridge_props`, `bridge_play`, `bridge_create`, `bridge_set_property`, `bridge_delete`, `bridge_move`, `bridge_rename`, `bridge_clone`, `bridge_script_source`, `bridge_set_script_source`, `bridge_console`, `bridge_logs`, `bridge_selection`, `bridge_play_control`, `bridge_undo`, `bridge_redo`, `bridge_batch`, `bridge_insert_model`, `bridge_get_attributes`, `bridge_set_attribute`, `bridge_delete_attribute`, `bridge_get_children`

### MCP Configuration

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "bad-bridge": {
        "command": "node",
        "args": ["bridge/mcp-bridge.cjs"],
        "cwd": "${workspaceFolder}"
      }
    }
  }
}
```

## Smart Value Deserialization (v5)

`set_property` and `create_instance` now accept rich types as JSON:

```json
// Color3 (RGB 0-255)
{"r": 255, "g": 0, "b": 128}

// Vector3
{"x": 10, "y": 5, "z": -3}

// CFrame (position + rotation in degrees)
{"x": 0, "y": 10, "z": 0, "rx": 0, "ry": 45, "rz": 0}

// UDim2
{"sx": 0.5, "ox": 0, "sy": 1, "oy": -20}

// BrickColor (by name)
"Bright red"
```

## Architecture

```
VS Code Extension  ←→  Bridge Server (port 3001)  ←→  Studio Plugin
     (HTTP)                  (Node.js)                   (HTTP polling)
                                ↑
                           MCP Server
                        (stdio, for AI)
```

## Version History

| Version | Changes |
|---|---|
| **Plugin v5 / Extension v2.1.0** | Smart value deserialization, attribute commands, CFrame rotation export, auto-reconnect with backoff, `get_children` command |
| **Plugin v4 / Extension v2.0.0** | Instance manipulation, script editing, play mode control, MCP server, console output, marketplace insert |

## License

Private — for Build And Defend development.
