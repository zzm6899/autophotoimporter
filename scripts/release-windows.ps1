param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$ServerHost = "172.20.20.251",
  [string]$ServerUser = "truenas_admin",
  # SSH password for truenas_admin — can also be set via $env:TRUENAS_SSH_PASSWORD.
  # Requires plink/pscp (PuTTY) on PATH. Falls back to key-based ssh/scp if not found.
  [string]$ServerPassword,
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

# ---------------------------------------------------------------------------
# Resolve SSH password and choose ssh tool
# ---------------------------------------------------------------------------
if (-not $ServerPassword) {
  $ServerPassword = $env:TRUENAS_SSH_PASSWORD
}

$UsePlink = $false
if ($ServerPassword) {
  if (Get-Command plink -ErrorAction SilentlyContinue) {
    $UsePlink = $true
    Write-Host "Using plink/pscp with password auth." -ForegroundColor DarkGray
  } else {
    Write-Warning "plink not found — ignoring password and using key-based ssh/scp."
    Write-Warning "Install PuTTY and add it to PATH to enable password auth."
  }
}

function Invoke-RemoteSsh {
  param([string]$Command)
  if ($UsePlink) {
    plink -ssh -batch -pw $ServerPassword "$ServerUser@$ServerHost" $Command
  } else {
    ssh "$ServerUser@$ServerHost" $Command
  }
  return $LASTEXITCODE
}

function Invoke-RemoteScp {
  param([string]$LocalPath, [string]$RemotePath)
  if ($UsePlink) {
    pscp -pw $ServerPassword -batch $LocalPath "$ServerUser@${ServerHost}:$RemotePath"
  } else {
    scp $LocalPath "$ServerUser@${ServerHost}:$RemotePath"
  }
  return $LASTEXITCODE
}

# ---------------------------------------------------------------------------

function Parse-SemVer {
  param([string]$Value)

  if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Version must use semantic version format like 1.1.1."
  }

  return [PSCustomObject]@{
    Major = [int]$matches[1]
    Minor = [int]$matches[2]
    Patch = [int]$matches[3]
  }
}

function Compare-SemVer {
  param(
    [string]$Left,
    [string]$Right
  )

  $leftParsed = Parse-SemVer $Left
  $rightParsed = Parse-SemVer $Right

  foreach ($part in @('Major', 'Minor', 'Patch')) {
    if ($leftParsed.$part -lt $rightParsed.$part) { return -1 }
    if ($leftParsed.$part -gt $rightParsed.$part) { return 1 }
  }

  return 0
}

function Get-NextPatchVersion {
  param([string]$Value)

  $parsed = Parse-SemVer $Value
  return "$($parsed.Major).$($parsed.Minor).$($parsed.Patch + 1)"
}

$adminToken = $AdminToken
if (-not $adminToken) {
  $adminToken = $env:UPDATE_ADMIN_API_TOKEN
}
if (-not $adminToken) {
  throw "Set UPDATE_ADMIN_API_TOKEN in your environment before running this script, or pass -AdminToken."
}

$root = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $root "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$currentPackageVersion = [string]$packageJson.version

$versionComparison = Compare-SemVer $Version $currentPackageVersion
if ($versionComparison -le 0) {
  $suggestedVersion = Get-NextPatchVersion $currentPackageVersion
  Write-Host "Requested version $Version is not newer than current package version $currentPackageVersion." -ForegroundColor Yellow
  $response = Read-Host "Use suggested version $suggestedVersion instead? [Y/n]"
  if ([string]::IsNullOrWhiteSpace($response) -or $response.Trim().ToLowerInvariant() -in @('y', 'yes')) {
    $Version = $suggestedVersion
  } elseif ($versionComparison -lt 0) {
    throw "Requested version $Version is older than current package version $currentPackageVersion."
  }
}

if (-not $ReleaseName) {
  $ReleaseName = "Photo Importer $Version"
}

$packageVersionChanged = $currentPackageVersion -ne $Version
if ($packageVersionChanged) {
  Write-Host "Updating app version from $currentPackageVersion to $Version..." -ForegroundColor Cyan
  Push-Location $root
  try {
    npm version $Version --no-git-tag-version
    if ($LASTEXITCODE -ne 0) {
      throw "npm version $Version failed."
    }
  } finally {
    Pop-Location
  }
}

if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  Push-Location $root
  try {
    $latestCommit = git log -1 --pretty=%B
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($latestCommit)) {
      $ReleaseNotes = $latestCommit.Trim()
    } else {
      $ReleaseNotes = "Release $Version"
    }
  } finally {
    Pop-Location
  }
}

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
$exitCode = Invoke-RemoteSsh "mkdir -p '$remoteDir'"
if ($exitCode -ne 0) {
  throw "Could not create remote directory $remoteDir"
}

Write-Host "Uploading Windows artifacts to $ServerHost..." -ForegroundColor Cyan
$exitCode = Invoke-RemoteScp $setupSrc "$remoteDir/$setupRemote"
if ($exitCode -ne 0) { throw "Failed to upload setup exe." }
$exitCode = Invoke-RemoteScp $releasesSrc "$remoteDir/RELEASES"
if ($exitCode -ne 0) { throw "Failed to upload RELEASES." }
$exitCode = Invoke-RemoteScp $nupkgSrc "$remoteDir/"
if ($exitCode -ne 0) { throw "Failed to upload NUPKG." }
if ($zipSrc -and (Test-Path $zipSrc)) {
  $exitCode = Invoke-RemoteScp $zipSrc "$remoteDir/"
  if ($exitCode -ne 0) { throw "Failed to upload ZIP." }
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
