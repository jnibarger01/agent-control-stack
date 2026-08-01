[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Notification,

  [Parameter(Mandatory = $true)]
  [string]$Payload,

  [switch]$Execute
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) {
  throw 'Payload file not found.'
}

$item = Get-Item -LiteralPath $Payload
if ($item.Length -gt 262144) {
  throw 'Payload exceeds 256 KiB.'
}

$raw = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8
$parsed = $raw | ConvertFrom-Json
if ($null -eq $parsed -or $parsed -is [System.Array]) {
  throw 'Payload must be a JSON object.'
}

$encodedName = [Uri]::EscapeDataString($Notification)
$endpoint = "https://api.pushcut.io/v1/notifications/$encodedName"

if (-not $Execute) {
  [pscustomobject]@{
    Mode = 'DRY RUN'
    Method = 'POST'
    Endpoint = $endpoint
    Payload = $Payload
    Auth = 'API-Key from PUSHCUT_API_KEY (not displayed)'
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($env:PUSHCUT_API_KEY)) {
  throw 'PUSHCUT_API_KEY is required with -Execute.'
}

if ($env:PUSHCUT_API_KEY -notmatch '^[A-Za-z0-9._-]{8,512}$') {
  throw 'PUSHCUT_API_KEY contains unexpected characters.'
}

$headers = @{ 'API-Key' = $env:PUSHCUT_API_KEY }
Invoke-RestMethod `
  -Method Post `
  -Uri $endpoint `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $raw `
  -TimeoutSec 15

