# install-windows-service.ps1
#
# Registers SkyTwin as a Windows Service using New-Service.
#
# REQUIREMENTS
#   - Run as Administrator.
#   - PowerShell 5.1 or later (ships with Windows 10 / Server 2016+).
#   - The signed SkyTwin binary must already be installed at $BinaryPath.
#     Issue #188 (turnkey distribution) provides the signed binary and
#     will call this script automatically during the installer run.
#     Do NOT run this script manually until #188 has placed the binary.
#
# USAGE
#   # Install the service:
#   .\install-windows-service.ps1
#
#   # Uninstall the service:
#   .\install-windows-service.ps1 -Uninstall
#
#   # Use a custom binary path:
#   .\install-windows-service.ps1 -BinaryPath "C:\Program Files\SkyTwin\skytwin.exe"
#
# LOGS
#   Standard output and error are written to %LOCALAPPDATA%\SkyTwin\Logs\.
#   The SkyTwin installer (#188) creates this directory.

param(
    [string] $ServiceName  = "SkyTwin",
    [string] $DisplayName  = "SkyTwin Headless Daemon",
    [string] $Description  = "SkyTwin personal AI assistant — background daemon. Provides the API and worker processes for all SkyTwin clients.",
    # PLACEHOLDER: #188 turnkey distribution will supply the real signed binary path.
    [string] $BinaryPath   = "C:\Program Files\SkyTwin\skytwin.exe",
    [string] $LogDir       = "$env:LOCALAPPDATA\SkyTwin\Logs",
    [switch] $Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Elevation check
# ---------------------------------------------------------------------------
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell and choose 'Run as administrator'."
    exit 1
}

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------
if ($Uninstall) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        Write-Host "Service '$ServiceName' is not installed. Nothing to do."
        exit 0
    }

    Write-Host "Stopping service '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue

    Write-Host "Removing service '$ServiceName'..."
    sc.exe delete $ServiceName | Out-Null

    Write-Host "Service '$ServiceName' removed."
    exit 0
}

# ---------------------------------------------------------------------------
# Pre-flight: verify binary exists
# ---------------------------------------------------------------------------
if (-not (Test-Path $BinaryPath)) {
    Write-Error @"
Binary not found at: $BinaryPath

The SkyTwin binary is installed by issue #188 (turnkey distribution).
Run the SkyTwin installer before registering the Windows Service, or
pass the correct path via -BinaryPath.
"@
    exit 1
}

# ---------------------------------------------------------------------------
# Create log directory
# ---------------------------------------------------------------------------
if (-not (Test-Path $LogDir)) {
    Write-Host "Creating log directory: $LogDir"
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ---------------------------------------------------------------------------
# Remove any previously registered service with the same name
# ---------------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Write-Host "Existing service '$ServiceName' found — removing before reinstall..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------------------
# Register the service
# ---------------------------------------------------------------------------
# The binary is called with --headless so it uses the headless.ts entry path.
# __HEADLESS_MAIN__=1 activates signal handling inside headless.ts.
$binPathWithArgs = "`"$BinaryPath`" --headless"

Write-Host "Registering service '$ServiceName'..."
New-Service `
    -Name        $ServiceName `
    -DisplayName $DisplayName `
    -Description $Description `
    -BinaryPathName $binPathWithArgs `
    -StartupType Automatic | Out-Null

# ---------------------------------------------------------------------------
# Configure environment variables for the service
# ---------------------------------------------------------------------------
# New-Service does not support per-service environment variables directly.
# We write them via the registry key that Service Control Manager reads.
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
$envValues = @(
    "SKYTWIN_API_PORT=4000",
    "__HEADLESS_MAIN__=1"
)
New-ItemProperty `
    -Path  $regPath `
    -Name  "Environment" `
    -Value $envValues `
    -PropertyType MultiString `
    -Force | Out-Null

Write-Host "Environment variables configured."

# ---------------------------------------------------------------------------
# Start the service
# ---------------------------------------------------------------------------
Write-Host "Starting service '$ServiceName'..."
Start-Service -Name $ServiceName

$svc = Get-Service -Name $ServiceName
Write-Host "Service '$ServiceName' status: $($svc.Status)"

if ($svc.Status -ne "Running") {
    Write-Warning "Service did not reach 'Running' state. Check the Windows Event Log for details."
    exit 1
}

Write-Host @"

SkyTwin Windows Service installed successfully.

  Service name : $ServiceName
  Binary       : $BinaryPath
  Logs         : $LogDir
  API port     : 4000 (override via HKLM registry Environment key)

Health check: http://localhost:4000/health
"@
