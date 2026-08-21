<#
.SYNOPSIS
  Builds the distributable zip that accountants unzip and run Setup from.

.DESCRIPTION
  Run this on the development machine to produce release\TallyPrime-for-Claude-<version>.zip.

  The zip is self-contained: it carries its own Node runtime, so the user needs
  nothing installed. Layout inside:

      TallyPrime for Claude\
        Setup.bat              <- they double-click this once
        Check-Tally.bat        <- they double-click this when something is wrong
        Run-Export.bat         <- double-click to export now, and watch it run
        Run-Export-Hidden.vbs  <- what the scheduled task runs, with no window
        READ ME FIRST.txt
        node\node.exe          <- bundled runtime
        dist\                  <- the built server
        node_modules\          <- production dependencies only
        scripts\
        package.json           <- the version, read at runtime

  Note the flattening: in this repo the installer lives under installer\, but
  the launchers MUST sit at the top of the folder the user unzips, because
  finding and double-clicking them is the whole interface. So installer\*.bat
  and installer\scripts\ are copied to the payload ROOT, not nested.

  Production dependencies are installed fresh from package-lock.json rather than
  copied from the working node_modules, so a stray dev dependency or a local
  experiment cannot end up in a release.

.PARAMETER NodeVersion
  Node runtime to bundle. Must satisfy the "engines" field in package.json.

.PARAMETER SkipRuntime
  Assemble everything except the bundled runtime. Useful for checking the layout
  offline; the resulting folder falls back to a system Node and is NOT shippable.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\package.ps1
#>

[CmdletBinding()]
param(
  [string]$NodeVersion = '22.14.0',
  [switch]$SkipRuntime
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $RepoRoot 'release'
$CacheDir = Join-Path $ReleaseDir '.runtime-cache'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Note { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }

# --- Version, from the single source of truth -------------------------------
$manifest = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$Version = $manifest.version
if ([string]::IsNullOrWhiteSpace($Version)) { throw 'package.json has no version.' }
Write-Step "Packaging version $Version"

$PayloadName = 'TallyPrime for Claude'
$StageRoot = Join-Path $ReleaseDir "stage-$Version"
$PayloadDir = Join-Path $StageRoot $PayloadName
$ZipPath = Join-Path $ReleaseDir "TallyPrime-for-Claude-$Version.zip"

# --- Gate the release on the tests and the typechecker ---------------------
# A broken release is far more expensive here than anywhere else: the audience
# cannot diagnose it, and every copy has to be re-sent by hand.
Write-Step 'Running typecheck and lint'
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed. Release stopped.' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'Lint failed. Release stopped.' }

# BUILD BEFORE TESTS. tests/integration/stdio.test.ts spawns dist\index.js to
# exercise the real stdio transport, and it deliberately FAILS rather than
# skips when dist\ is absent, so that end-to-end coverage cannot go quietly
# missing. Nothing else creates dist\ — npm ci does not, and there is no
# prepare script — so on a clean checkout, tests-then-build meant the release
# died on that assertion while the integration tests never ran. Found when the
# release workflow first built this on a fresh runner; it passed on developer
# machines only because dist\ was already lying around from earlier work.
Write-Step 'Building'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Release stopped.' }
if (-not (Test-Path (Join-Path $RepoRoot 'dist\index.js'))) { throw 'dist\index.js missing after build.' }

Write-Step 'Running tests'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Release stopped.' }

# --- Clean staging ---------------------------------------------------------
Write-Step 'Preparing staging folder'
if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $PayloadDir -Force | Out-Null

# --- The server itself ----------------------------------------------------
# installer\ is flattened into the payload root here — see the note above.
Write-Step 'Copying the server'
$InstallerDir = $PSScriptRoot

# THE app\ LAYER IS WHAT MAKES UPDATES POSSIBLE.
#
# Everything that changes with a version goes in app\; everything durable stays
# at the payload root. An update is then a folder rename -- app.next\ becomes
# app\ -- rather than an edit to claude_desktop_config.json, and the user's .env
# and scheduled task are untouched because they live a level above.
# See installer/launch.mjs and installer/scripts/lib/update.mjs.
$AppDir = Join-Path $PayloadDir 'app'
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

Copy-Item (Join-Path $RepoRoot 'dist') (Join-Path $AppDir 'dist') -Recurse
Copy-Item (Join-Path $InstallerDir 'scripts') (Join-Path $AppDir 'scripts') -Recurse
Copy-Item (Join-Path $RepoRoot 'package.json') $AppDir

# Stable: the launchers a user double-clicks, the runtime, and the indirection
# Claude Desktop is pointed at. Their paths must never change across versions.
Copy-Item (Join-Path $InstallerDir 'Setup.bat') $PayloadDir
Copy-Item (Join-Path $InstallerDir 'Check-Tally.bat') $PayloadDir
Copy-Item (Join-Path $InstallerDir 'Run-Export.bat') $PayloadDir
# The scheduled task points at this. Without it the task falls back to the .bat
# and flashes a console window on every run -- see launcherFor in exportSetup.mjs.
Copy-Item (Join-Path $InstallerDir 'Run-Export-Hidden.vbs') $PayloadDir
Copy-Item (Join-Path $InstallerDir 'launch.mjs') $PayloadDir
Copy-Item (Join-Path $InstallerDir 'READ ME FIRST.txt') $PayloadDir
Copy-Item (Join-Path $RepoRoot 'LICENSE') $PayloadDir

# package.ps1 is a developer tool and must never reach a user's folder. It lives
# beside scripts\ rather than inside it, so this is belt-and-braces.
Remove-Item (Join-Path $AppDir 'scripts\package.ps1') -Force -ErrorAction SilentlyContinue

# --- Production dependencies ----------------------------------------------
# Into app\, beside the package.json that declares them, so node_modules travels
# with the version that was tested against it.
Write-Step 'Installing production dependencies'
Copy-Item (Join-Path $RepoRoot 'package-lock.json') $AppDir
Push-Location $AppDir
try {
  npm ci --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while assembling the release.' }
} finally {
  Pop-Location
}
# The lockfile was only needed for that install.
Remove-Item (Join-Path $AppDir 'package-lock.json') -Force

# --- Bundled Node runtime -------------------------------------------------
if ($SkipRuntime) {
  Write-Step 'Skipping the bundled runtime (-SkipRuntime)'
  Write-Note 'This folder is NOT shippable: it will fall back to a system Node.'
} else {
  Write-Step "Bundling Node $NodeVersion"
  New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null

  $zipName = "node-v$NodeVersion-win-x64.zip"
  $cachedZip = Join-Path $CacheDir $zipName

  if (-not (Test-Path $cachedZip)) {
    $url = "https://nodejs.org/dist/v$NodeVersion/$zipName"
    Write-Note "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $cachedZip -UseBasicParsing
  } else {
    Write-Note 'Using the cached download.'
  }

  $extractDir = Join-Path $CacheDir "extract-$NodeVersion"
  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  Expand-Archive -Path $cachedZip -DestinationPath $extractDir -Force

  $nodeExe = Get-ChildItem -Path $extractDir -Filter 'node.exe' -Recurse |
    Select-Object -First 1
  if (-not $nodeExe) { throw "node.exe not found inside $zipName." }

  # node.exe on Windows is self-contained, so the runtime folder stays tiny —
  # only the executable is shipped, not the whole distribution.
  New-Item -ItemType Directory -Path (Join-Path $PayloadDir 'node') -Force | Out-Null
  Copy-Item $nodeExe.FullName (Join-Path $PayloadDir 'node\node.exe')

  $bundledVersion = & (Join-Path $PayloadDir 'node\node.exe') --version
  Write-Note "Bundled runtime reports $bundledVersion"
}

# --- Smoke test the assembled folder --------------------------------------
# Proves the shipped layout can load its own code before anyone downloads it.
Write-Step 'Smoke testing the assembled folder'
$smokeNode = if ($SkipRuntime) { 'node' } else { Join-Path $PayloadDir 'node\node.exe' }
$probeCheck = & $smokeNode -e @"
import('file:///' + process.argv[1].replace(/\\/g, '/'))
  .then((m) => { if (typeof m.probeTally !== 'function') { process.exit(3); } })
  .catch(() => process.exit(4));
"@ (Join-Path $AppDir 'scripts\lib\probe.mjs')
if ($LASTEXITCODE -ne 0) { throw "The assembled folder could not load its own code (exit $LASTEXITCODE)." }
Write-Note 'The shipped folder loads correctly.'

# --- Zip ------------------------------------------------------------------
Write-Step 'Creating the zip'
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path $PayloadDir -DestinationPath $ZipPath -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
$hash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash

# --- Checksum file --------------------------------------------------------
# UPLOAD THIS ALONGSIDE THE ZIP. An installed copy refuses to unpack a download
# whose digest it cannot verify, so a release published without this file is one
# that no existing install will update to -- deliberately, because the
# alternative is unverified code running against somebody's books. See
# CHECKSUM_ASSET in installer/scripts/lib/update.mjs.
$SumsPath = Join-Path $ReleaseDir 'SHA256SUMS.txt'
"$($hash.ToLower())  $(Split-Path $ZipPath -Leaf)" |
  Set-Content -Path $SumsPath -Encoding ascii

Write-Step 'Done'
Write-Host "    $ZipPath" -ForegroundColor Green
Write-Note "$sizeMb MB"
Write-Note "SHA256 $hash"
Write-Host ''
Write-Host ''
Write-Host "    $SumsPath" -ForegroundColor Green
Write-Note 'Attach BOTH files to the GitHub release. Without SHA256SUMS.txt no'
Write-Note 'existing install will update itself to this version.'
Write-Host ''
Write-Note 'Before sending it out, unzip it somewhere clean and run Setup.bat once.'
