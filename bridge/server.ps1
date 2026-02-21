# Build And Defend — Studio Bridge Server v3 (PowerShell)
# FIFO queue, log streaming, graceful shutdown.

param([int]$Port = 3001)

$ErrorActionPreference = "Stop"
$PSDir = $PSScriptRoot

$QueueDir   = Join-Path $PSDir "queue"
$ResultFile = Join-Path $PSDir "result.json"
$LogsFile   = Join-Path $PSDir "logs.json"

if (-not (Test-Path $QueueDir)) { New-Item -ItemType Directory -Path $QueueDir | Out-Null }
# Init logs as empty array
if (-not (Test-Path $LogsFile)) { Set-Content -Path $LogsFile -Value "[]" -Encoding UTF8 }

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

$script:cmdIndex = 0

Write-Host "[Bridge] Server v3 running on http://localhost:$Port" -ForegroundColor Green
Write-Host "[Bridge] Queue dir: $QueueDir"
Write-Host "[Bridge] Press Ctrl+C to stop.`n"

function Send-Response($ctx, [int]$code, [string]$body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = "application/json"
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}

function Read-Body($ctx) {
    $reader = [System.IO.StreamReader]::new($ctx.Request.InputStream)
    return $reader.ReadToEnd()
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $method = $ctx.Request.HttpMethod
        $url    = $ctx.Request.Url.AbsolutePath

        # ── GET /poll  (Studio plugin polls - takes oldest queued command) ──
        if ($method -eq "GET" -and $url -eq "/poll") {
            $files = Get-ChildItem $QueueDir -Filter "*.json" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
            if ($files) {
                $content = Get-Content $files.FullName -Raw
                Remove-Item $files.FullName -Force
                Send-Response $ctx 200 $content
            } else {
                Send-Response $ctx 200 "null"
            }

        # ── POST /result  (Studio plugin posts result) ────────────────────
        } elseif ($method -eq "POST" -and $url -eq "/result") {
            $body = Read-Body $ctx
            Set-Content -Path $ResultFile -Value $body -Encoding UTF8
            Send-Response $ctx 200 '{"ok":true}'
            $preview = if ($body.Length -gt 300) { $body.Substring(0,300) + "..." } else { $body }
            Write-Host "[Bridge] Result received: $preview`n" -ForegroundColor Cyan

        # ── GET /result  (Copilot reads result, auto-clears to prevent stale reads) ──
        } elseif ($method -eq "GET" -and $url -eq "/result") {
            if (Test-Path $ResultFile) {
                $resultContent = Get-Content $ResultFile -Raw
                Remove-Item $ResultFile -Force
                Send-Response $ctx 200 $resultContent
            } else {
                Send-Response $ctx 200 "null"
            }

        # ── POST /command  (Copilot queues a command - FIFO) ──────────────
        } elseif ($method -eq "POST" -and $url -eq "/command") {
            $body = Read-Body $ctx
            if (Test-Path $ResultFile) { Remove-Item $ResultFile -Force }
            $script:cmdIndex++
            $cmdFile = Join-Path $QueueDir ("{0:D6}.json" -f $script:cmdIndex)
            Set-Content -Path $cmdFile -Value $body -Encoding UTF8
            Send-Response $ctx 200 ('{"ok":true,"queued":true,"id":' + $script:cmdIndex + '}')
            try {
                $type = ($body | ConvertFrom-Json).type
                Write-Host "[Bridge] Command #$($script:cmdIndex) queued: $type" -ForegroundColor Yellow
            } catch { Write-Host "[Bridge] Command #$($script:cmdIndex) queued" -ForegroundColor Yellow }

        # ── GET /queue  (check queue depth) ───────────────────────────────
        } elseif ($method -eq "GET" -and $url -eq "/queue") {
            $count = (Get-ChildItem $QueueDir -Filter "*.json" -ErrorAction SilentlyContinue | Measure-Object).Count
            Send-Response $ctx 200 ('{"pending":' + $count + '}')

        # ── DELETE /queue  (clear queue) ──────────────────────────────────
        } elseif ($method -eq "DELETE" -and $url -eq "/queue") {
            Get-ChildItem $QueueDir -Filter "*.json" -ErrorAction SilentlyContinue | Remove-Item -Force
            if (Test-Path $ResultFile) { Remove-Item $ResultFile -Force }
            Send-Response $ctx 200 '{"ok":true,"cleared":true}'
            Write-Host "[Bridge] Queue cleared" -ForegroundColor Magenta

        # ── GET /ping ──────────────────────────────────────────────────────
        } elseif ($method -eq "GET" -and $url -eq "/ping") {
            Send-Response $ctx 200 '{"ok":true,"version":3}'

        # ── POST /logs  (Studio plugin pushes log entries) ────────────────
        } elseif ($method -eq "POST" -and $url -eq "/logs") {
            $body = Read-Body $ctx
            try {
                $incoming = $body | ConvertFrom-Json
                $existing = @()
                if (Test-Path $LogsFile) {
                    try { $existing = @(Get-Content $LogsFile -Raw | ConvertFrom-Json) } catch { $existing = @() }
                }
                $merged = @($existing) + @($incoming)
                # Keep last 2000 entries
                if ($merged.Count -gt 2000) { $merged = $merged[($merged.Count - 2000)..($merged.Count - 1)] }
                Set-Content -Path $LogsFile -Value ($merged | ConvertTo-Json -Depth 5 -Compress) -Encoding UTF8
                Send-Response $ctx 200 ('{"ok":true,"stored":' + $incoming.Count + '}')
            } catch {
                Send-Response $ctx 200 '{"ok":false,"error":"parse error"}'
            }

        # ── GET /logs  (read buffered logs, optional ?clear=true) ─────────
        } elseif ($method -eq "GET" -and $url -eq "/logs") {
            if (Test-Path $LogsFile) {
                $content = Get-Content $LogsFile -Raw
                $qs = $ctx.Request.QueryString
                if ($qs["clear"] -eq "true") {
                    Set-Content -Path $LogsFile -Value "[]" -Encoding UTF8
                }
                Send-Response $ctx 200 $content
            } else {
                Send-Response $ctx 200 "[]"
            }

        # ── DELETE /logs  (clear log buffer) ──────────────────────────────
        } elseif ($method -eq "DELETE" -and $url -eq "/logs") {
            Set-Content -Path $LogsFile -Value "[]" -Encoding UTF8
            Send-Response $ctx 200 '{"ok":true,"cleared":true}'
            Write-Host "[Bridge] Logs cleared" -ForegroundColor Magenta

        } else {
            Send-Response $ctx 404 '{"error":"not found"}'
        }
    }
} finally {
    $listener.Stop()
    Write-Host "[Bridge] Server stopped."
}
