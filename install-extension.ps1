# BAD Bridge — One-click VS Code Extension Installer
# Run from the workspace root:  .\install-extension.ps1

Write-Host ""
Write-Host "=== BAD Bridge Extension Installer ===" -ForegroundColor Cyan
Write-Host ""

# 1. Install npm deps (if needed)
Write-Host "[1/4] Installing dependencies..." -ForegroundColor Yellow
npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed. Make sure Node.js is installed." -ForegroundColor Red
    exit 1
}
Write-Host "  Done." -ForegroundColor Green

# 2. Build
Write-Host "[2/4] Building extension..." -ForegroundColor Yellow
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Build failed." -ForegroundColor Red
    exit 1
}
Write-Host "  Done." -ForegroundColor Green

# 3. Package .vsix
Write-Host "[3/4] Packaging .vsix..." -ForegroundColor Yellow
npx @vscode/vsce package --no-dependencies 2>&1 | Out-Null
$vsix = Get-ChildItem -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    Write-Host "ERROR: .vsix file not created." -ForegroundColor Red
    exit 1
}
Write-Host "  Created: $($vsix.Name)" -ForegroundColor Green

# 4. Install into VS Code
Write-Host "[4/4] Installing into VS Code..." -ForegroundColor Yellow
code --install-extension $vsix.FullName --force 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not install. Make sure 'code' is in your PATH." -ForegroundColor Red
    Write-Host "  You can install manually: code --install-extension $($vsix.FullName)" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=== INSTALLED! ===" -ForegroundColor Green
Write-Host "Reload VS Code (Ctrl+Shift+P > 'Reload Window') and you're good to go." -ForegroundColor Cyan
Write-Host ""
