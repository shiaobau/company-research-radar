param(
  [string]$OutputDirectory = "backtests/2026-Q2-market-factor-overlay-volume/source-cache",
  [string[]]$ObservationDates = @("2026-04-20", "2026-05-20", "2026-06-19"),
  [int]$RequiredVolumeDays = 21
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = (Get-Location).Path
$cacheDirectory = Join-Path $root $OutputDirectory
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null

function Get-DateParts([string]$Date) {
  $value = [DateTime]::ParseExact($Date, "yyyy-MM-dd", $null)
  return @{
    Twse = $value.ToString("yyyyMMdd")
    Tpex = "{0}/{1:00}/{2:00}" -f ($value.Year - 1911), $value.Month, $value.Day
  }
}

function Get-PreviousDate([string]$Date, [int]$Offset) {
  return ([DateTime]::ParseExact($Date, "yyyy-MM-dd", $null)).AddDays(-$Offset).ToString("yyyy-MM-dd")
}

function Get-CachePath([string]$Url) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Url)
    $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    return Join-Path $cacheDirectory "$hash.json"
  } finally {
    $sha.Dispose()
  }
}

function Get-CachedJson([string]$Url) {
  $path = Get-CachePath $Url
  if (Test-Path -LiteralPath $path) {
    return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
  }
  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 45 -Headers @{ "User-Agent" = "company-research-radar-backtest/1.0" }
      $payload = $response.Content | ConvertFrom-Json
      [IO.File]::WriteAllText($path, $response.Content, [Text.UTF8Encoding]::new($false))
      Start-Sleep -Milliseconds 250
      return $payload
    } catch {
      $lastError = $_
      Write-Warning "Request failed ($attempt/3): $Url"
      Start-Sleep -Seconds ($attempt * 2)
    }
  }
  throw $lastError
}

function Get-CoreUrls([string]$Date) {
  $parts = Get-DateParts $Date
  $encodedTpex = [Uri]::EscapeDataString($parts.Tpex)
  return @{
    twseValuation = "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_d?date=$($parts.Twse)"
    tpexValuation = "https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&d=$encodedTpex&s=0"
    twseMargin = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=$($parts.Twse)&selectType=ALL&response=json"
    tpexMargin = "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=$encodedTpex"
    twseInstitutional = "https://www.twse.com.tw/rwd/zh/fund/T86?date=$($parts.Twse)&selectType=ALLBUT0999&response=json"
    tpexInstitutional = "https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=$encodedTpex&se=AL"
  }
}

function Get-VolumeUrls([string]$Date) {
  $parts = Get-DateParts $Date
  $encodedTpex = [Uri]::EscapeDataString($parts.Tpex)
  return @{
    twseDailyVolume = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=$($parts.Twse)&type=ALLBUT0999&response=json"
    tpexDailyVolume = "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&o=json&d=$encodedTpex"
  }
}

function Get-TableRows($Payload, [int]$Index) {
  if ($null -eq $Payload.tables -or $Payload.tables.Count -le $Index -or $null -eq $Payload.tables[$Index].data) { return 0 }
  return $Payload.tables[$Index].data.Count
}

$manifest = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  observation_dates = $ObservationDates
  required_volume_days = $RequiredVolumeDays
  source_dates = @{}
  volume_dates = @{}
}

foreach ($observationDate in $ObservationDates) {
  $sourceDate = $null
  for ($offset = 0; $offset -lt 7; $offset += 1) {
    $candidate = Get-PreviousDate $observationDate $offset
    Write-Host "Core factors: $observationDate -> $candidate"
    $urls = Get-CoreUrls $candidate
    $payloads = @{}
    foreach ($entry in $urls.GetEnumerator()) { $payloads[$entry.Key] = Get-CachedJson $entry.Value }
    if ((Get-TableRows $payloads.tpexValuation 0) -gt 0 -and (Get-TableRows $payloads.twseMargin 1) -gt 0 -and $payloads.twseInstitutional.data.Count -gt 0) {
      $sourceDate = $candidate
      break
    }
  }
  if ($null -eq $sourceDate) { throw "No complete core market-data day found on or before $observationDate." }
  $manifest.source_dates[$observationDate] = $sourceDate

  $volumeDates = @()
  for ($offset = 0; $offset -lt 45 -and $volumeDates.Count -lt $RequiredVolumeDays; $offset += 1) {
    $candidate = Get-PreviousDate $sourceDate $offset
    Write-Host "Volume history: $observationDate -> $candidate ($($volumeDates.Count)/$RequiredVolumeDays)"
    $urls = Get-VolumeUrls $candidate
    $twse = Get-CachedJson $urls.twseDailyVolume
    $tpex = Get-CachedJson $urls.tpexDailyVolume
    if ((Get-TableRows $twse 8) -gt 1000 -and (Get-TableRows $tpex 0) -gt 1000) { $volumeDates += $candidate }
  }
  if ($volumeDates.Count -lt $RequiredVolumeDays) { throw "Only $($volumeDates.Count)/$RequiredVolumeDays full-market volume days were available by $sourceDate." }
  $manifest.volume_dates[$observationDate] = @($volumeDates | Sort-Object)
}

$manifestPath = Join-Path (Split-Path $cacheDirectory -Parent) "source-cache-manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Host "Cached official source responses in $cacheDirectory"
