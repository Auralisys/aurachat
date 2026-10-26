# Builds the distributable AuraChat Windows installer and copies it to the user's Desktop.
# Usage: powershell -ExecutionPolicy Bypass -File desktop\scripts\package-installer.ps1 [-SkipBuild]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $desktop 'src-tauri\target\release\bundle\nsis'

if (-not $SkipBuild) {
  Push-Location $desktop
  try { node (Join-Path $PSScriptRoot 'release.cjs'); if ($LASTEXITCODE -ne 0) { throw "Signed release build failed ($LASTEXITCODE)" } }
  finally { Pop-Location }
}
$setup = Get-ChildItem $bundle -Filter 'AuraChat_*_x64-setup.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'NSIS installer not found: run without -SkipBuild.' }

# Resolves redirected Desktops too (e.g. OneDrive).
$target = Join-Path ([Environment]::GetFolderPath('Desktop')) $setup.Name
Copy-Item $setup.FullName $target -Force
if ((Get-FileHash $target).Hash -ne (Get-FileHash $setup.FullName).Hash) { throw 'Copied installer does not match the build.' }
Write-Host ("Installer ready: {0} ({1:N1} MB)" -f $target, ((Get-Item $target).Length / 1MB))
