param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$ServerHost = "172.20.20.251",
  [string]$ServerUser = "truenas_admin",
  [string]$ServerRepoPath = "/mnt/tank/apps/photo-importer",
  [string]$AdminEndpoint = "https://admin.culler.z2hs.au",
  [string]$ReleaseBaseUrl = "https://updates.culler.z2hs.au/artifacts/windows",
  [string]$Rollout = "live",
  [string]$Channel = "stable",
  [string]$ReleaseName,
  [string]$ReleaseNotes = "",
  [string]$AdminToken,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if (-not $ReleaseName) {
  $ReleaseName = "Photo Importer $Version"
}

$adminToken = $AdminToken
if (-not $adminToken) {
  $adminToken = $env:UPDATE_ADMIN_API_TOKEN
}
if (-not $adminToken) {
  throw "Set UPDATE_ADMIN_API_TOKEN in your environment before running this script, or pass -AdminToken."
}

$root = Split-Path -Parent $PSScriptRoot
$makeRoot = Join-Path $root "out\make\squirrel.windows\x64"
$setupSrc = Join-Path $makeRoot "PhotoImporter-Setup.exe"
$releasesSrc = Join-Path $makeRoot "RELEASES"
$nupkgCandidates = @(
  Join-Path $makeRoot "photo-importer-$Version-full.nupkg"
)
$zipCandidates = @(
  Join-Path $root "out\make\zip\win32\x64\Photo Importer-win32-x64-$Version.zip"
)

if (-not $SkipBuild) {
  Write-Host "Building Windows release..." -ForegroundColor Cyan
  Push-Location $root
  try {
    npm run make
    if ($LASTEXITCODE -ne 0) {
      throw "npm run make failed."
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $setupSrc)) {
  throw "Required build artifact missing: $setupSrc"
}
if (-not (Test-Path $releasesSrc)) {
  throw "Required build artifact missing: $releasesSrc"
}

$nupkgSrc = $nupkgCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nupkgSrc) {
  $nupkgMatch = Get-ChildItem $makeRoot -Filter "photo-importer-*-full.nupkg" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($nupkgMatch) {
    $nupkgSrc = $nupkgMatch.FullName
  }
}
if (-not $nupkgSrc) {
  throw "Required build artifact missing: no matching photo-importer-*-full.nupkg found in $makeRoot"
}

$zipSrc = $zipCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $zipSrc) {
  $zipDir = Join-Path $root "out\make\zip\win32\x64"
  if (Test-Path $zipDir) {
    $zipMatch = Get-ChildItem $zipDir -Filter "Photo Importer-win32-x64-*.zip" -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($zipMatch) {
      $zipSrc = $zipMatch.FullName
    }
  }
}

foreach ($path in @($setupSrc, $releasesSrc, $nupkgSrc)) {
  if (-not (Test-Path $path)) {
    throw "Required build artifact missing: $path"
  }
}

$remoteDir = "$ServerRepoPath/artifacts/windows"
$setupRemote = "PhotoImporter-Setup-$Version.exe"

Write-Host "Creating remote artifact directory..." -ForegroundColor Cyan
ssh "$ServerUser@$ServerHost" "mkdir -p '$remoteDir'"
if ($LASTEXITCODE -ne 0) {
  throw "Could not create remote directory $remoteDir"
}

Write-Host "Uploading Windows artifacts to $ServerHost..." -ForegroundColor Cyan
scp $setupSrc "$ServerUser@${ServerHost}:$remoteDir/$setupRemote"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload setup exe." }
scp $releasesSrc "$ServerUser@${ServerHost}:$remoteDir/RELEASES"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload RELEASES." }
scp $nupkgSrc "$ServerUser@${ServerHost}:$remoteDir/"
if ($LASTEXITCODE -ne 0) { throw "Failed to upload NUPKG." }
if (Test-Path $zipSrc) {
  scp $zipSrc "$ServerUser@${ServerHost}:$remoteDir/"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload ZIP." }
}

$artifactUrl = "$ReleaseBaseUrl/$setupRemote"
$releaseUrl = "$AdminEndpoint/releases/$Version"

Write-Host "Registering hosted update..." -ForegroundColor Cyan
Push-Location $root
try {
  node scripts/publish-update-release.mjs `
    --endpoint $AdminEndpoint `
    --token $adminToken `
    --version $Version `
    --platform windows `
    --release-name $ReleaseName `
    --artifact-url $artifactUrl `
    --release-url $releaseUrl `
    --notes $ReleaseNotes `
    --channel $Channel `
    --rollout $Rollout
  if ($LASTEXITCODE -ne 0) {
    throw "Release registration failed."
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Windows release published successfully." -ForegroundColor Green
Write-Host "Artifact URL: $artifactUrl"
