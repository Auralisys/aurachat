# Builds AuraChat release, installs it for the current user and relaunches it.
# Usage: powershell -ExecutionPolicy Bypass -File desktop\scripts\install-prod.ps1 [-NoLaunch] [-SkipBuild]
param([switch]$NoLaunch, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$release = Join-Path $desktop 'src-tauri\target\release'
$exe = Join-Path $env:LOCALAPPDATA 'AuraChat\aurachat.exe'

if (-not $SkipBuild) {
  Push-Location $desktop
  try { node (Join-Path $PSScriptRoot 'release.cjs'); if ($LASTEXITCODE -ne 0) { throw "Signed release build failed ($LASTEXITCODE)" } }
  finally { Pop-Location }
}
$setup = Get-ChildItem (Join-Path $release 'bundle\nsis') -Filter 'AuraChat_*_x64-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'NSIS installer not found: run without -SkipBuild.' }

# Only the installed copy is stopped; dev builds and other apps are untouched.
$running = Get-Process | Where-Object { $_.Path -eq $exe }
$running | ForEach-Object { Stop-Process -Id $_.Id -Force }
if ($running) { Start-Sleep 2 }

$installerArgs = @('/S')
if (Test-Path $exe) { $installerArgs += @('/UPDATE', '/NS') }
$install = Start-Process $setup.FullName -ArgumentList $installerArgs -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer failed ($($install.ExitCode))" }

# Tauri patches the bundle type into the installed exe; normalize it before comparing.
$latin = [Text.Encoding]::GetEncoding(28591)
$normalize = { param($path) $latin.GetString([IO.File]::ReadAllBytes($path)).Replace('__TAURI_BUNDLE_TYPE_VAR_NSS', '__TAURI_BUNDLE_TYPE_VAR_UNK') }
if ((& $normalize $exe) -ne (& $normalize (Join-Path $release 'aurachat.exe'))) { throw 'Installed exe does not match the build.' }
if (-not (Test-Path (Join-Path (Split-Path $exe) 'DirectML.dll'))) { throw 'DirectML.dll missing from install.' }
Write-Host "Installed $($setup.Name) -> $exe"

if (-not $NoLaunch) { Start-Process $exe; Write-Host 'AuraChat relaunched.' }
