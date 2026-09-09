param(
  [string]$Ref = $(if ($env:KITT_PROXY_REF) { $env:KITT_PROXY_REF } else { 'main' }),
  [ValidateSet('auto','bundled','system')][string]$Browser = 'auto',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Repo = if ($env:KITT_PROXY_REPO) { $env:KITT_PROXY_REPO } else { 'https://github.com/rfdetoni/kitt-reverse-proxy.git' }
$Root = if ($env:KITT_PROXY_HOME) { $env:KITT_PROXY_HOME } else { Join-Path $env:LOCALAPPDATA 'KITT\reverse-proxy' }
$Bin = if ($env:KITT_BIN_DIR) { $env:KITT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'KITT\bin' }
$Src = Join-Path $Root 'src'
$ProxyCmd = Join-Path $Bin 'kitt-reverse-proxy.cmd'
$GatewayCmd = Join-Path $Bin 'kitt-agent-gateway.cmd'

if ($Uninstall) {
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ProxyCmd,$GatewayCmd -Force -ErrorAction SilentlyContinue
  Write-Host 'K.I.T.T. Reverse Proxy removed.'
  exit 0
}
foreach ($Tool in @('git','node','npm')) {
  if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "$Tool is required" }
}
& node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 20+ is required' }

New-Item -ItemType Directory -Force -Path $Root,$Bin | Out-Null
if (-not (Test-Path (Join-Path $Src '.git'))) {
  Remove-Item $Src -Recurse -Force -ErrorAction SilentlyContinue
  & git clone --filter=blob:none --no-checkout $Repo $Src
}
& git -C $Src remote set-url origin $Repo
& git -C $Src fetch --force --depth 1 origin $Ref
& git -C $Src checkout --detach --force FETCH_HEAD
& git -C $Src clean -ffd
Push-Location $Src
try {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  & npm prune --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm prune failed' }
  $ChromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $HasChrome = $ChromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($Browser -eq 'bundled' -or ($Browser -eq 'auto' -and -not $HasChrome)) {
    & npx --yes playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium installation failed' }
  }
} finally { Pop-Location }

Set-Content -Path $ProxyCmd -Encoding Ascii -Value "@echo off`r`nnode `"$Src\dist\cli.js`" %*"
Set-Content -Path $GatewayCmd -Encoding Ascii -Value "@echo off`r`nnode `"$Src\dist\gateway\cli.js`" %*"
$UserPath = [Environment]::GetEnvironmentVariable('Path','User')
$Parts = @($UserPath -split ';' | Where-Object { $_ })
if ($Parts -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable('Path', (($Parts + $Bin) -join ';'), 'User')
  $env:Path = "$Bin;$env:Path"
}
& $ProxyCmd --help | Out-Null
Write-Host "K.I.T.T. Reverse Proxy installed/updated at $Root."
Write-Host 'Open a new terminal and run: kitt-reverse-proxy start chatgpt'
