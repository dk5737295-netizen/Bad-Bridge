# Install the Bridge Plugin into Roblox Studio as .rbxmx
# Run from anywhere: .\plugin\install-plugin.ps1

$pluginSrc = Join-Path $PSScriptRoot "BridgePlugin.server.luau"

if (-not (Test-Path $pluginSrc)) {
    Write-Host "ERROR: Plugin source not found: $pluginSrc" -ForegroundColor Red
    exit 1
}

# Roblox Studio looks for plugins in this folder
$pluginDir = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"

if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Path $pluginDir | Out-Null
    Write-Host "Created plugins folder: $pluginDir"
}

# Remove old .lua version if it exists
$oldLua = Join-Path $pluginDir "BAD_BridgePlugin.lua"
if (Test-Path $oldLua) {
    Remove-Item $oldLua -Force
    Write-Host "Removed old .lua plugin" -ForegroundColor Yellow
}

# Read source and wrap in .rbxmx (Roblox XML Model)
$source = Get-Content $pluginSrc -Raw

# Escape for CDATA (handle the rare case of ]]> in source)
$source = $source -replace '\]\]>', ']]]]><![CDATA[>'

$rbxmx = @"
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
	<External>null</External>
	<External>nil</External>
	<Item class="Script" referent="RBX0000000000">
		<Properties>
			<BinaryString name="AttributesSerialize"></BinaryString>
			<bool name="Disabled">false</bool>
			<Content name="LinkedSource"><null></null></Content>
			<string name="Name">BAD_BridgePlugin</string>
			<token name="RunContext">0</token>
			<ProtectedString name="Source"><![CDATA[$source]]></ProtectedString>
			<BinaryString name="Tags"></BinaryString>
		</Properties>
	</Item>
</roblox>
"@

$dest = Join-Path $pluginDir "BAD_BridgePlugin.rbxmx"
[System.IO.File]::WriteAllText($dest, $rbxmx, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Plugin installed to: $dest" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open (or restart) Roblox Studio"
Write-Host "  2. Open your game place"
Write-Host "  3. Studio > Settings > Security > Allow HTTP Requests = ON"
Write-Host "  4. Start the bridge server in VS Code (Run Task: Start Bridge Server)"
Write-Host "  5. Watch the Output window - you should see [Bridge] Connected after ~2 seconds"
