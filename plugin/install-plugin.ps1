# Install the Bridge Plugin into Roblox Studio
# Run this from the workspace root: .\bridge\install-plugin.ps1

$pluginSrc = Join-Path $PSScriptRoot "BridgePlugin.server.luau"

# Roblox Studio looks for plugins in this folder
$pluginDir = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"

if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Path $pluginDir | Out-Null
    Write-Host "Created plugins folder: $pluginDir"
}

$dest = Join-Path $pluginDir "BAD_BridgePlugin.lua"
Copy-Item -Path $pluginSrc -Destination $dest -Force

Write-Host ""
Write-Host "Plugin installed to: $dest" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open (or restart) Roblox Studio"
Write-Host "  2. Open your game place"
Write-Host "  3. Studio > Settings > Security > Allow HTTP Requests = ON"
Write-Host "  4. Start the bridge server in VS Code (Run Task: Start Bridge Server)"
Write-Host "  5. Watch the Output window - you should see [Bridge] Connected after ~2 seconds"
