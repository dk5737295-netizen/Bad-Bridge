# BAD Bridge — PowerShell Helpers
# Dot-source this: . .\bridge\helpers.ps1
# Then use: Bridge-Run "return 1+1"   or   Bridge-Tree "game.Workspace" 2

$script:BRIDGE = "http://127.0.0.1:3001"

function Bridge-Ping {
    Invoke-RestMethod -Uri "$script:BRIDGE/ping" -TimeoutSec 3
}

function Bridge-Run {
    <# Send Luau code and wait for result in one call. #>
    param(
        [Parameter(Mandatory)][string]$Code,
        [int]$Timeout = 10000
    )
    $body = @{ type = "run"; code = $Code } | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=$Timeout" -Method Post -Body $body -ContentType "application/json" -TimeoutSec ([math]::Ceiling($Timeout / 1000) + 5)
    if ($r.success) { $r.result } else { Write-Warning "Bridge error: $($r.error)"; $r }
}

function Bridge-Tree {
    <# Get instance tree. #>
    param(
        [string]$Path = "game.Workspace",
        [int]$Depth = 2,
        [switch]$Props
    )
    $body = @{ type = "get_tree"; path = $Path; depth = $Depth; props = [bool]$Props } | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=10000" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
    if ($r.success) { $r.result | ConvertFrom-Json -Depth 20 | ConvertTo-Json -Depth 20 } else { Write-Warning $r.error }
}

function Bridge-Find {
    <# Search instances by name or class. #>
    param(
        [string]$Name,
        [string]$Class,
        [string]$Path = "game",
        [int]$Limit = 20
    )
    $body = @{ type = "find"; path = $Path; limit = $Limit }
    if ($Name) { $body.name = $Name }
    if ($Class) { $body.class = $Class }
    $json = $body | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=10000" -Method Post -Body $json -ContentType "application/json" -TimeoutSec 15
    if ($r.success) { $r.result | ConvertFrom-Json -Depth 10 | Format-Table Name, ClassName, FullName -AutoSize } else { Write-Warning $r.error }
}

function Bridge-Props {
    <# Get properties of a single instance. #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Properties
    )
    $body = @{ type = "get_properties"; path = $Path }
    if ($Properties) { $body.properties = $Properties }
    $json = $body | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=10000" -Method Post -Body $json -ContentType "application/json" -TimeoutSec 15
    if ($r.success) { $r.result | ConvertFrom-Json -Depth 10 } else { Write-Warning $r.error }
}

function Bridge-Play {
    <# Run a script in play mode and wait for result. #>
    param(
        [Parameter(Mandatory)][string]$Code,
        [string]$Mode = "start_play",
        [int]$ScriptTimeout = 30,
        [int]$WaitMs = 120000
    )
    $body = @{ type = "run_script_in_play_mode"; code = $Code; mode = $Mode; timeout = $ScriptTimeout } | ConvertTo-Json -Compress -Depth 5
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=$WaitMs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec ([math]::Ceiling($WaitMs / 1000) + 10)
    if ($r.success) {
        try { $r.result | ConvertFrom-Json -Depth 10 } catch { $r.result }
    } else {
        Write-Warning "Play mode error: $($r.error)"; $r
    }
}

function Bridge-Console {
    <# Get console output. #>
    param([switch]$Clear)
    $body = @{ type = "get_console_output"; clear = [bool]$Clear } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=10000" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
    if ($r.success) { $r.result } else { Write-Warning $r.error }
}

function Bridge-Stop {
    <# Stop play mode. #>
    $body = '{"type":"start_stop_play","mode":"stop"}'
    $r = Invoke-RestMethod -Uri "$script:BRIDGE/run?timeout=10000" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
    if ($r.success) { $r.result } else { Write-Warning $r.error }
}

function Bridge-Logs {
    <# Get recent logs from the bridge server. #>
    param([int]$Count = 50, [string]$Filter)
    $uri = "$script:BRIDGE/logs?count=$Count"
    if ($Filter) { $uri += "&filter=$Filter" }
    $r = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10
    if ($r) {
        try { $r | Format-Table type, message -AutoSize -Wrap } catch { $r }
    } else { Write-Host "(no logs)" }
}

Write-Host "[Bridge Helpers] Loaded. Commands: Bridge-Ping, Bridge-Run, Bridge-Tree, Bridge-Find, Bridge-Props, Bridge-Play, Bridge-Console, Bridge-Stop, Bridge-Logs" -ForegroundColor Green
