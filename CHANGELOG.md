# Changelog

All notable changes to the **BAD Bridge** extension will be documented in this file.

## [2.1.0] — 2026-02-21

### Added
- Smart value deserialization — `set_property` and `create_instance` accept Color3, Vector3, CFrame, UDim2, and BrickColor as JSON objects
- Attribute commands: `get_attributes`, `set_attribute`, `delete_attribute`
- `get_children` command for lightweight child listing
- CFrame rotation export (rx, ry, rz in degrees)
- Auto-reconnect with exponential backoff (1 s → 10 s max)
- MCP tools for all new commands

## [2.0.0] — 2026-01-01

### Added
- Instance manipulation commands: create, delete, clone, move, rename
- Script source read/write
- Play mode control (start, run server, stop)
- MCP server for AI assistant integration
- Console output streaming
- Marketplace model insert
- Sidebar webview panel with bridge controls
- Studio log viewer tree

## [1.0.0] — Initial Release

### Added
- Bridge server (Node.js, zero dependencies)
- Studio plugin with HTTP polling
- Run Luau code from VS Code
- Instance tree browsing
- Instance search / find
- Undo / redo support
