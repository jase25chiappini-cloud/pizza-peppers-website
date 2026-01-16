$ErrorActionPreference = "Stop"

param(
  [string]$BackendUrl = "http://127.0.0.1:5055"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "server"
$envPath = Join-Path $serverDir ".env.local"

function Read-EnvFile([string]$path) {
  if (-not (Test-Path -Path $path)) {
    return @()
  }
  return Get-Content -Path $path
}

function Get-EnvValue([string[]]$lines, [string]$name) {
  foreach ($line in $lines) {
    if ($line -match "^\s*$name\s*=\s*(.*)\s*$") {
      $raw = $Matches[1].Trim()
      if ($raw.StartsWith('"') -and $raw.EndsWith('"')) {
        return $raw.Trim('"')
      }
      if ($raw.StartsWith("'") -and $raw.EndsWith("'")) {
        return $raw.Trim("'")
      }
      return $raw
    }
  }
  return $null
}

function Set-EnvValue([string]$path, [string]$name, [string]$value) {
  $lines = Read-EnvFile $path
  $updated = $false
  $out = @()
  foreach ($line in $lines) {
    if ($line -match "^\s*$name\s*=") {
      $out += "$name=$value"
      $updated = $true
    } else {
      $out += $line
    }
  }
  if (-not $updated) {
    if ($out.Count -gt 0 -and $out[-1] -ne "") {
      $out += ""
    }
    $out += "$name=$value"
  }
  $out | Set-Content -Path $path -Encoding UTF8
}

function New-UrlSafeKey([int]$bytesLen = 32) {
  $bytes = New-Object byte[] $bytesLen
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $raw = [Convert]::ToBase64String($bytes)
  return $raw.TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$lines = Read-EnvFile $envPath
$existing = Get-EnvValue $lines "POS_ADMIN_SETUP_KEY"
if (-not $existing) {
  $existing = New-UrlSafeKey 32
  Set-EnvValue -path $envPath -name "POS_ADMIN_SETUP_KEY" -value $existing
  Write-Host "Generated POS_ADMIN_SETUP_KEY and saved to $envPath"
} else {
  Write-Host "Using existing POS_ADMIN_SETUP_KEY from $envPath"
}

Write-Host "If the backend is already running, restart it so the new key is loaded."

try {
  Invoke-WebRequest -Uri "$BackendUrl/" -Method Get -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
  Write-Host "Backend is not reachable at $BackendUrl. Start it and try again."
  exit 1
}

$phone = Read-Host "Admin phone (+614... or 04...)"
$passwordSecure = Read-Host "Admin password" -AsSecureString
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure)
$password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)

$body = @{
  setupKey = $existing
  phone = $phone
  password = $password
} | ConvertTo-Json

try {
  $resp = Invoke-RestMethod -Method Post -Uri "$BackendUrl/admin/bootstrap" `
    -ContentType "application/json" -Body $body
  Write-Host "Bootstrap response:"
  $resp | ConvertTo-Json -Depth 5
} catch {
  Write-Host "Bootstrap failed:"
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  exit 1
}
