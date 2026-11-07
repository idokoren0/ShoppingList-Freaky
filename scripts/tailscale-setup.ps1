<#
  Puts the shopping list behind Tailscale with HTTPS and closes the plain-HTTP port.

  Run once, in PowerShell as Administrator, after Tailscale is installed and signed in:
      powershell -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1

  Undo (back to plain http://<pc-ip>:8080 on the home network):
      powershell -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1 -Undo
#>
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root '.env'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'

function Set-BindAddr([string]$value) {
  $lines = @()
  if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*BIND_ADDR=' }) }
  if ($value) { $lines += "BIND_ADDR=$value" }
  [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
}

function Restart-App {
  Push-Location $root
  try {
    # The old container's port can take a few seconds to free up after a port change; retry.
    for ($i = 1; $i -le 5; $i++) {
      docker compose up -d 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return }
      Start-Sleep 3
    }
    throw 'The app container failed to start. Run "docker compose up -d" in this folder to see why.'
  } finally { Pop-Location }
}

if (-not (Test-Path $ts)) { throw 'Tailscale is not installed. Get it from https://tailscale.com/download and sign in first.' }

if ($Undo) {
  & $ts serve reset
  Set-BindAddr ''
  Restart-App
  Write-Host 'Done. Tailscale HTTPS removed; the app is back on http://<pc-ip>:8080 for the home network.'
  return
}

$status = & $ts status --json | ConvertFrom-Json
if ($status.BackendState -ne 'Running') { throw "Tailscale is not connected (state: $($status.BackendState)). Open Tailscale and sign in." }
$name = $status.Self.DNSName.TrimEnd('.')
if (-not $name -or $name -notmatch '\.ts\.net$') { throw 'MagicDNS is off. Turn it on in the Tailscale admin console > DNS, then run this again.' }

# Keep Tailscale connected even when nobody is signed in to Windows
& $ts set --unattended=true

# HTTPS front door: https://<pc>.<tailnet>.ts.net -> the app on this PC
& $ts serve --bg 8080
if ($LASTEXITCODE -ne 0) { throw 'tailscale serve failed. Turn on "HTTPS Certificates" in the Tailscale admin console > DNS, then run this again.' }

# Only Tailscale may reach the app from now on
Set-BindAddr '127.0.0.1'
Restart-App

$url = "https://$name"
Write-Host "Checking $url (first certificate can take up to a minute)..."
$ok = $false
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
  try { $null = Invoke-WebRequest "$url/api/config" -UseBasicParsing -TimeoutSec 10; $ok = $true } catch { Start-Sleep 5 }
}
if ($ok) { Write-Host "`nReady. Open on both phones (with Tailscale on):`n  $url`n" -ForegroundColor Green }
else { Write-Host "`nServe is set up but $url didn't answer yet. Try it in a minute; if it still fails, run: tailscale serve status" -ForegroundColor Yellow }
