param(
  [string]$BaseUrl = "https://pizzapepperspos.onrender.com",
  [string]$OutDir = "public\uploads"
)

$ApiKey = $env:PP_IMAGES_API_KEY
if (-not $ApiKey) {
  $ApiKey = Read-Host "Enter X-API-Key (will not be saved)"
}
$ApiKey = ($ApiKey ?? "").Trim()

$Headers = @{ "X-API-Key" = $ApiKey }

$ListUrl = "$BaseUrl/api/images/"
Write-Host "Connecting to $ListUrl..."
try {
  $Response = Invoke-RestMethod -Uri $ListUrl -Headers $Headers -Method Get
} catch {
  $status = $null
  try { $status = $_.Exception.Response.StatusCode.value__ } catch {}
  Write-Host "ERROR: list request failed (status=$status)"
  throw
}

if (-not $Response.ok) {
  throw "Server returned ok:false"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Count = 0

foreach ($img in $Response.images) {
  $FullUrl = if ($img.url -match '^https?://') { $img.url } else { "$BaseUrl$($img.url)" }
  $OutputPath = Join-Path $OutDir $img.filename

  Write-Host "Downloading $($img.filename)..."
  try {
    # Include headers just in case the image URLs require the key too
    Invoke-WebRequest -Uri $FullUrl -OutFile $OutputPath -Headers $Headers
    $Count++
  } catch {
    Write-Host "  X Failed to download $($img.filename) ($($_.Exception.Message))"
  }
}

Write-Host "`nSuccess! Downloaded $Count images to $OutDir"
