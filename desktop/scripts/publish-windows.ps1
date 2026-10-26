$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Eseguire questo script su Windows.' }
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    $bundled = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'copilot-desktop-gh-*\gh.exe') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bundled) { throw 'GitHub CLI mancante. Installare GitHub CLI e autorizzarlo con gh auth login.' }
    $env:PATH = "$($bundled.DirectoryName);$env:PATH"
}
$oldGhToken = $env:GH_TOKEN
$oldGithubToken = $env:GITHUB_TOKEN
try {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
    & node (Join-Path $root 'desktop\scripts\release.cjs') --publish
    if ($LASTEXITCODE -ne 0) { throw 'Pubblicazione Windows fallita. Controllare il draft prima di riprovare.' }
    $installer = Get-ChildItem -LiteralPath (Join-Path $root 'desktop\src-tauri\target\release\updater') -Filter '*-setup.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw 'Installer pubblicato non trovato sul disco.' }
    $destination = Join-Path ([Environment]::GetFolderPath('Desktop')) $installer.Name
    Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $installer.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
        throw 'La copia sul Desktop non coincide con il pacchetto pubblicato.'
    }
    Write-Output "Installer sul Desktop: $destination"
} finally {
    $env:GH_TOKEN = $oldGhToken
    $env:GITHUB_TOKEN = $oldGithubToken
}
