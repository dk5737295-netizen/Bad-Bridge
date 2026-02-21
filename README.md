# BAD Bridge

**VS Code ↔ Roblox Studio bridge** — execute Luau code, inspect/manipulate instances, control play mode, and stream logs between VS Code and Roblox Studio in real time.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/davixx24.bad-bridge)](https://marketplace.visualstudio.com/items?itemName=davixx24.bad-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Run Luau code** directly from VS Code in edit or play mode
- **Browse & search** the instance tree without leaving your editor
- **Create, delete, clone, move, rename** instances remotely
- **Set properties** with smart type support (Color3, Vector3, CFrame, UDim2, BrickColor)
- **Read/write script source** between VS Code and Studio
- **Control play mode** — start, stop, run server
- **Stream Studio logs** to the VS Code sidebar in real time
- **Undo/redo** support via ChangeHistoryService
- **MCP server** for AI assistant integration (GitHub Copilot, etc.)
- **Insert marketplace models** by asset ID

## Installation

### From the VS Code Marketplace

1. Open VS Code
2. Go to **Extensions** (`Ctrl+Shift+X`)
3. Search for **BAD Bridge**
4. Click **Install**

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/dk5737295-netizen/Bad-Bridge/releases)
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the file

### From Source

```bash
git clone https://github.com/dk5737295-netizen/Bad-Bridge.git
cd Bad-Bridge
npm install
npm run build
npm run package
# Then install the generated .vsix
```

## Setup

### 1. Install the Studio Plugin

Run the installer script to copy the plugin to your Roblox Studio plugins folder:

```powershell
.\plugin\install-plugin.ps1
```

Or manually copy `plugin/BridgePlugin.server.luau` to:
- **Windows:** `%LOCALAPPDATA%\Roblox\Plugins\`
- **macOS:** `~/Library/Roblox/Plugins/`

### 2. Studio Settings

In Roblox Studio, enable these under **Game Settings → Security**:

- **Allow HTTP Requests** = ✅ ON
- **Allow Server Scripts To Use LoadString** = ✅ ON *(required for the `run` command)*

### 3. Start the Bridge

In VS Code: `Ctrl+Shift+P` → **BAD Bridge: Start Server**

Or start manually:

```bash
node bridge/server.js --port 3001
```

The Studio plugin auto-connects within ~2 seconds.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`):

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
| **Undo / Redo** | ChangeHistoryService |
| **Insert Model** | Search + insert marketplace model |

## Settings

| Setting | Default | Description |
|---|---|---|
| `bad-bridge.port` | `3001` | Port the bridge server listens on |
| `bad-bridge.autoConnect` | `true` | Auto-connect on startup |
| `bad-bridge.logPollInterval` | `3` | Log poll interval (seconds) |

## MCP Server (AI Integration)

The MCP server exposes all bridge functionality as tools for AI assistants like GitHub Copilot.

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

### Available MCP Tools

`bridge_status`, `bridge_run`, `bridge_tree`, `bridge_find`, `bridge_props`, `bridge_play`, `bridge_create`, `bridge_set_property`, `bridge_delete`, `bridge_move`, `bridge_rename`, `bridge_clone`, `bridge_script_source`, `bridge_set_script_source`, `bridge_console`, `bridge_logs`, `bridge_selection`, `bridge_play_control`, `bridge_undo`, `bridge_redo`, `bridge_batch`, `bridge_insert_model`, `bridge_get_attributes`, `bridge_set_attribute`, `bridge_delete_attribute`, `bridge_get_children`

## Smart Value Types

`set_property` and `create_instance` accept rich types as JSON:

```jsonc
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

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE)
