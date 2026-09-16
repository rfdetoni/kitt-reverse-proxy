param(
  [string]$Ref = $(if ($env:KITT_PROXY_REF) { $env:KITT_PROXY_REF } else { 'stable' }),
  [ValidateSet('auto','bundled','system')][string]$Browser = 'auto',
  [int]$Jobs = $(if ($env:KITT_INSTALL_JOBS) { [int]$env:KITT_INSTALL_JOBS } else { 0 }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Timer = [System.Diagnostics.Stopwatch]::StartNew()

$Repo = if ($env:KITT_PROXY_REPO) { $env:KITT_PROXY_REPO } else { 'https://github.com/rfdetoni/kitt-reverse-proxy.git' }
$Root = if ($env:KITT_PROXY_HOME) { $env:KITT_PROXY_HOME } else { Join-Path $env:LOCALAPPDATA 'KITT\reverse-proxy' }
$CacheRoot = if ($env:KITT_PROXY_CACHE) { $env:KITT_PROXY_CACHE } else { Join-Path $env:LOCALAPPDATA 'KITT\cache\reverse-proxy' }
$Bin = if ($env:KITT_BIN_DIR) { $env:KITT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'KITT\bin' }
$Runtime = Join-Path $Root 'runtime'
$Src = Join-Path $Root 'src'
$ProxyCmd = Join-Path $Bin 'kitt-reverse-proxy.cmd'
$GatewayCmd = Join-Path $Bin 'kitt-agent-gateway.cmd'

function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = '') {
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Get-PackageVersion([string]$PackageJsonPath) {
  if (-not (Test-Path $PackageJsonPath)) { return $null }
  $Value = & node -e "try { const p=require(process.argv[1]); if(typeof p.version==='string' && p.version.trim()) process.stdout.write(p.version.trim()); else process.exit(2); } catch { process.exit(2); }" $PackageJsonPath
  if ($LASTEXITCODE -ne 0) { return $null }
  $Text = ($Value | Out-String).Trim()
  if ($Text) { return $Text }
  return $null
}

function Get-GitHubSlug([string]$Url) {
  if ($Url -match '^https://github\.com/([^/]+/[^/]+?)(?:\.git)?$') { return $Matches[1] }
  if ($Url -match '^git@github\.com:([^/]+/[^/]+?)(?:\.git)?$') { return $Matches[1] }
  return $null
}

function Get-RuntimePackagePath {
  $Direct = Join-Path $Runtime 'package.json'
  if (Test-Path $Direct) { return $Direct }
  $Nested = Join-Path $Runtime 'node_modules\kitt-reverse-proxy\package.json'
  if (Test-Path $Nested) { return $Nested }
  return $null
}

function Get-RuntimeAppPath {
  if (Test-Path (Join-Path $Runtime 'dist\cli.js')) { return $Runtime }
  $Nested = Join-Path $Runtime 'node_modules\kitt-reverse-proxy'
  if (Test-Path (Join-Path $Nested 'dist\cli.js')) { return $Nested }
  return $null
}

function Test-SystemBrowser {
  $Candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Chromium\Application\chrome.exe",
    "$env:LOCALAPPDATA\Chromium\Application\chrome.exe"
  )
  return [bool]($Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Start-DownloadJob([string]$Url, [string]$Destination) {
  return Start-Job -ArgumentList $Url,$Destination -ScriptBlock {
    param($DownloadUrl, $DownloadDestination)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $Temp = "$DownloadDestination.part.$PID"
    try {
      Invoke-WebRequest -Uri $DownloadUrl -OutFile $Temp -UseBasicParsing -Headers @{ 'User-Agent' = 'kitt-installer' }
      Move-Item -Force $Temp $DownloadDestination
    } finally {
      Remove-Item $Temp -Force -ErrorAction SilentlyContinue
    }
  }
}

function Wait-DownloadJobs([System.Management.Automation.Job[]]$DownloadJobs) {
  if (-not $DownloadJobs -or $DownloadJobs.Count -eq 0) { return }
  try {
    $DownloadJobs | Wait-Job | Out-Null
    foreach ($Job in $DownloadJobs) {
      Receive-Job $Job
      if ($Job.State -ne 'Completed') { throw "Parallel download failed: $($Job.State)" }
    }
  } finally {
    $DownloadJobs | Remove-Job -Force -ErrorAction SilentlyContinue
  }
}

function Download-File([string]$Url, [string]$Destination) {
  $Temp = "$Destination.part.$PID"
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Temp -UseBasicParsing -Headers @{ 'User-Agent' = 'kitt-installer' }
    Move-Item -Force $Temp $Destination
  } finally {
    Remove-Item $Temp -Force -ErrorAction SilentlyContinue
  }
}

function Test-ReleaseChecksum([string]$File, [string]$Sums) {
  if (-not (Test-Path $File) -or -not (Test-Path $Sums)) { return $false }
  $FileName = Split-Path $File -Leaf
  $EscapedName = [regex]::Escape($FileName)
  $Expected = $null
  foreach ($Line in Get-Content $Sums) {
    if ($Line -match "^([0-9a-fA-F]{64})\s+\*?$EscapedName$") {
      $Expected = $Matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $Expected) { return $false }
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLowerInvariant()
  return $Actual -eq $Expected
}

function Start-BrowserInstall([string]$PlaywrightVersion, [string]$LogPrefix) {
  $NpmCommand = (Get-Command npm -ErrorAction Stop).Source
  return Start-Process `
    -FilePath $NpmCommand `
    -ArgumentList @('exec','--yes',"--package=playwright@$PlaywrightVersion",'--','playwright','install','chromium') `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput "$LogPrefix.out.log" `
    -RedirectStandardError "$LogPrefix.err.log"
}

function Wait-BrowserInstall($Process, [string]$LogPrefix) {
  if (-not $Process) { return $true }
  $Process.WaitForExit()
  if ($Process.ExitCode -eq 0) { return $true }
  Write-Warning "Parallel Chromium install failed with exit code $($Process.ExitCode); local retry will be used."
  foreach ($Path in @("$LogPrefix.out.log", "$LogPrefix.err.log")) {
    if (Test-Path $Path) { Get-Content $Path -Tail 30 | ForEach-Object { Write-Warning $_ } }
  }
  return $false
}

function Write-Launchers([string]$AppDirectory) {
  Set-Content -Path $ProxyCmd -Encoding Ascii -Value "@echo off`r`nnode `"$AppDirectory\dist\cli.js`" %*"
  Set-Content -Path $GatewayCmd -Encoding Ascii -Value "@echo off`r`nnode `"$AppDirectory\dist\gateway\cli.js`" %*"
}

function Install-NpmArchive([string]$Archive, [string]$Stage) {
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  Set-Content -Path (Join-Path $Stage 'package.json') -Encoding Ascii -Value '{"private":true}'
  $PreviousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  try {
    Invoke-Native 'npm' @(
      'install','--prefix',$Stage,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',
      '--no-package-lock','--no-save','--prefer-offline','--progress=false',$Archive
    )
  } finally {
    if ($null -eq $PreviousSkip) { Remove-Item Env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue }
    else { $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $PreviousSkip }
  }
}

if ($Uninstall) {
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ProxyCmd,$GatewayCmd -Force -ErrorAction SilentlyContinue
  Write-Host 'K.I.T.T. Reverse Proxy removed.'
  exit 0
}

foreach ($Tool in @('node','npm')) {
  if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "$Tool is required" }
}
& node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24+ is required' }

$CpuCount = [Math]::Max(1, [Environment]::ProcessorCount)
if ($Jobs -le 0) { $Jobs = [Math]::Min(16, [Math]::Max(4, $CpuCount * 2)) }
$NpmSockets = if ($env:KITT_NPM_SOCKETS) { [int]$env:KITT_NPM_SOCKETS } else { [Math]::Min(64, [Math]::Max(16, $Jobs * 4)) }
$env:npm_config_maxsockets = [string]$NpmSockets
$env:npm_config_prefer_offline = 'true'
$env:npm_config_progress = 'false'
$env:npm_config_jobs = [string]$Jobs
$env:GOMAXPROCS = [string]$Jobs

New-Item -ItemType Directory -Force -Path $Root,$CacheRoot,$Bin | Out-Null
$TempRoot = Join-Path $Root ('.install.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
  $PreviousVersion = 'not installed'
  $RuntimePackage = Get-RuntimePackagePath
  $ExistingVersion = if ($RuntimePackage) { Get-PackageVersion $RuntimePackage } else { $null }
  if (-not $ExistingVersion) { $ExistingVersion = Get-PackageVersion (Join-Path $Src 'package.json') }
  if ($ExistingVersion) { $PreviousVersion = "v$ExistingVersion" }

  $GitHubSlug = Get-GitHubSlug $Repo
  if ($Ref -eq 'stable' -and $GitHubSlug) {
    try {
      $Release = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$GitHubSlug/releases/latest" `
        -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'kitt-installer' }
      if ($Release.tag_name -notmatch '^v\d+\.\d+\.\d+$') { throw "Invalid release tag: $($Release.tag_name)" }
      $Ref = [string]$Release.tag_name
      Write-Host "Resolved stable release: $Ref"
    } catch {
      Write-Warning 'Could not resolve latest published GitHub release; falling back to tag discovery.'
      $Ref = 'stable'
    }
  }

  if ($Ref -eq 'stable') {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      throw 'git is required when GitHub release discovery is unavailable'
    }
    $TagLines = & git ls-remote --refs --tags $Repo 'refs/tags/v*'
    if ($LASTEXITCODE -ne 0) { throw "Could not list stable release tags from $Repo" }
    $Versions = @(
      foreach ($Line in $TagLines) {
        if ($Line -match 'refs/tags/v(\d+\.\d+\.\d+)$') {
          [pscustomobject]@{ Tag = "v$($Matches[1])"; Version = [version]$Matches[1] }
        }
      }
    )
    if ($Versions.Count -eq 0) { throw "Could not resolve a stable release tag from $Repo" }
    $Ref = ($Versions | Sort-Object Version -Descending | Select-Object -First 1).Tag
    Write-Host "Resolved stable tag fallback: $Ref"
  }

  $NeedBrowser = $Browser -eq 'bundled' -or ($Browser -eq 'auto' -and -not (Test-SystemBrowser))
  $FastPath = [bool]($GitHubSlug -and $Ref -match '^v(\d+)\.(\d+)\.(\d+)$')
  $AppDir = $null
  $TargetVersion = $null

  if ($FastPath) {
    $TargetVersion = $Ref.Substring(1)
    Write-Host "Install mode: prebuilt release fast path ($Ref)"
    Write-Host "Parallelism: jobs=$Jobs, npm sockets=$NpmSockets"

    $CurrentRuntimeApp = Get-RuntimeAppPath
    $CurrentRuntimePackage = Get-RuntimePackagePath
    $CurrentRuntimeVersion = if ($CurrentRuntimePackage) { Get-PackageVersion $CurrentRuntimePackage } else { $null }

    if ($CurrentRuntimeApp -and $CurrentRuntimeVersion -eq $TargetVersion) {
      $AppDir = $CurrentRuntimeApp
      Write-Host "Package v$TargetVersion is already installed; skipping all package work."
      $LocalPlaywright = Join-Path $Runtime 'node_modules\playwright\cli.js'
      if ($NeedBrowser -and (Test-Path $LocalPlaywright)) {
        Invoke-Native 'node' @($LocalPlaywright,'install','chromium')
      }
    } else {
      $ReleaseCache = Join-Path $CacheRoot $Ref
      New-Item -ItemType Directory -Force -Path $ReleaseCache | Out-Null
      $Sums = Join-Path $ReleaseCache 'SHA256SUMS'
      $Meta = Join-Path $ReleaseCache 'package.json'
      $Bundle = Join-Path $ReleaseCache "kitt-reverse-proxy-runtime-$TargetVersion.zip"
      $NpmArchive = Join-Path $ReleaseCache "kitt-reverse-proxy-$TargetVersion.tgz"
      $ReleaseBase = "https://github.com/$GitHubSlug/releases/download/$Ref"
      $RawPackage = "https://raw.githubusercontent.com/$GitHubSlug/$Ref/package.json"

      $DownloadJobs = @()
      if (-not (Test-Path $Meta)) { $DownloadJobs += Start-DownloadJob $RawPackage $Meta }
      if (-not (Test-Path $Sums)) { $DownloadJobs += Start-DownloadJob "$ReleaseBase/SHA256SUMS" $Sums }
      Wait-DownloadJobs $DownloadJobs

      $MetaVersion = Get-PackageVersion $Meta
      if ($MetaVersion -ne $TargetVersion) {
        throw "Release metadata version mismatch: tag=$TargetVersion package=$MetaVersion"
      }
      $PlaywrightVersion = & node -e "const p=require(process.argv[1]); const v=p.dependencies?.playwright; if(typeof v==='string') process.stdout.write(v)" $Meta

      $BrowserProcess = $null
      $BrowserLog = Join-Path $TempRoot 'browser'
      if ($NeedBrowser -and $PlaywrightVersion) {
        Write-Host 'Starting Chromium download concurrently with runtime installation...'
        $BrowserProcess = Start-BrowserInstall $PlaywrightVersion $BrowserLog
      }

      $BundleValid = Test-ReleaseChecksum $Bundle $Sums
      if (-not $BundleValid) {
        Remove-Item $Bundle -Force -ErrorAction SilentlyContinue
        Write-Host 'Downloading portable precompiled runtime bundle...'
        try {
          Download-File "$ReleaseBase/$(Split-Path $Bundle -Leaf)" $Bundle
          $BundleValid = Test-ReleaseChecksum $Bundle $Sums
        } catch {
          Write-Host "Portable runtime bundle unavailable for $Ref; using npm release package fallback."
          Remove-Item $Bundle -Force -ErrorAction SilentlyContinue
          $BundleValid = $false
        }
      } else {
        Write-Host "Using verified runtime cache: $Bundle"
      }

      $Stage = Join-Path $TempRoot 'runtime'
      if ($BundleValid) {
        New-Item -ItemType Directory -Force -Path $Stage | Out-Null
        Expand-Archive -Path $Bundle -DestinationPath $Stage -Force
        $AppStage = $Stage
      } else {
        if (-not (Test-ReleaseChecksum $NpmArchive $Sums)) {
          Remove-Item $NpmArchive -Force -ErrorAction SilentlyContinue
          Download-File "$ReleaseBase/$(Split-Path $NpmArchive -Leaf)" $NpmArchive
          if (-not (Test-ReleaseChecksum $NpmArchive $Sums)) {
            throw "Release checksum validation failed for $Ref"
          }
        }
        Install-NpmArchive $NpmArchive $Stage
        $AppStage = Join-Path $Stage 'node_modules\kitt-reverse-proxy'
      }

      $InstalledVersion = Get-PackageVersion (Join-Path $AppStage 'package.json')
      if ($InstalledVersion -ne $TargetVersion) {
        throw "Installed package version mismatch: expected $TargetVersion got $InstalledVersion"
      }
      if (-not (Test-Path (Join-Path $AppStage 'dist\cli.js'))) {
        throw 'Release payload does not contain dist\cli.js'
      }

      if ($NeedBrowser -and $PlaywrightVersion) {
        if (-not (Wait-BrowserInstall $BrowserProcess $BrowserLog)) {
          Invoke-Native 'node' @((Join-Path $Stage 'node_modules\playwright\cli.js'),'install','chromium')
        }
      }

      $OldRuntime = Join-Path $Root '.runtime-old'
      Remove-Item $OldRuntime -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $Runtime) { Move-Item $Runtime $OldRuntime }
      Move-Item $Stage $Runtime
      Remove-Item $OldRuntime -Recurse -Force -ErrorAction SilentlyContinue
      $AppDir = if ($BundleValid) { $Runtime } else { Join-Path $Runtime 'node_modules\kitt-reverse-proxy' }
    }
  } else {
    Write-Host "Install mode: source ($Ref)"
    Write-Host "Parallelism: jobs=$Jobs, npm sockets=$NpmSockets"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required for source installation' }

    if (-not (Test-Path (Join-Path $Src '.git'))) {
      Remove-Item $Src -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $Src | Out-Null
      Invoke-Native 'git' @('-C',$Src,'init','-q')
      Invoke-Native 'git' @('-C',$Src,'remote','add','origin',$Repo)
    } else {
      Invoke-Native 'git' @('-C',$Src,'remote','set-url','origin',$Repo)
    }
    Invoke-Native 'git' @('-C',$Src,'fetch','--force','--depth','1','--no-tags','origin',$Ref)
    Invoke-Native 'git' @('-C',$Src,'checkout','--detach','--force','FETCH_HEAD')
    Invoke-Native 'git' @('-C',$Src,'clean','-ffd')

    $TargetVersion = Get-PackageVersion (Join-Path $Src 'package.json')
    if (-not $TargetVersion) { throw 'Could not determine installed package version' }
    $PlaywrightVersion = & node -e "const p=require(process.argv[1]); const v=p.dependencies?.playwright; if(typeof v==='string') process.stdout.write(v)" (Join-Path $Src 'package.json')

    $BrowserProcess = $null
    $BrowserLog = Join-Path $TempRoot 'browser'
    if ($NeedBrowser -and $PlaywrightVersion) {
      Write-Host 'Starting Chromium download concurrently with npm ci/build...'
      $BrowserProcess = Start-BrowserInstall $PlaywrightVersion $BrowserLog
    }

    $PreviousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    try {
      Invoke-Native 'npm' @('ci','--no-audit','--no-fund','--strict-allow-scripts','--prefer-offline','--progress=false') $Src
    } finally {
      if ($null -eq $PreviousSkip) { Remove-Item Env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue }
      else { $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $PreviousSkip }
    }

    Push-Location $Src
    try {
      & node scripts/build-fast.mjs
      if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Fast multicore build unavailable; falling back to TypeScript compiler.'
        Invoke-Native 'npm' @('run','build')
      }
    } finally { Pop-Location }

    if ($NeedBrowser -and $PlaywrightVersion) {
      if (-not (Wait-BrowserInstall $BrowserProcess $BrowserLog)) {
        Invoke-Native 'node' @((Join-Path $Src 'node_modules\playwright\cli.js'),'install','chromium')
      }
    }
    $AppDir = $Src
  }

  if (-not $TargetVersion -or -not $AppDir -or -not (Test-Path (Join-Path $AppDir 'dist\cli.js'))) {
    throw 'Installation did not produce a runnable dist\cli.js'
  }

  Write-Host "Version: $PreviousVersion -> v$TargetVersion"
  Write-Launchers $AppDir

  $UserPath = [Environment]::GetEnvironmentVariable('Path','User')
  $Parts = @($UserPath -split ';' | Where-Object { $_ })
  if ($Parts -notcontains $Bin) {
    [Environment]::SetEnvironmentVariable('Path', (($Parts + $Bin) -join ';'), 'User')
    $env:Path = "$Bin;$env:Path"
  }

  Invoke-Native $ProxyCmd @('--help')
  $Timer.Stop()
  Write-Host "K.I.T.T. Reverse Proxy v$TargetVersion installed/updated at $Root in $([Math]::Round($Timer.Elapsed.TotalSeconds,1))s."
  Write-Host 'Open a new terminal and run: kitt-reverse-proxy start chatgpt'
} finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
