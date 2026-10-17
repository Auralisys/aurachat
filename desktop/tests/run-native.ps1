$ErrorActionPreference = 'Stop'
$auraManifest = Join-Path $PSScriptRoot '../src-tauri/Cargo.toml'
$auraExecutables = @()
& cargo test --lib --no-run --message-format=json --manifest-path $auraManifest | ForEach-Object {
    $auraArtifact = $_ | ConvertFrom-Json
    if ($auraArtifact.reason -eq 'compiler-artifact' -and $auraArtifact.profile.test -and $auraArtifact.executable) {
        $auraExecutables += $auraArtifact.executable
    }
}
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed' }
if (-not $auraExecutables.Count) { throw 'No native test executable found' }
$auraSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$auraManifestTool = Get-ChildItem -LiteralPath $auraSdkRoot -Directory -Filter '10.*' |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64/mt.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $auraManifestTool) { throw 'Windows SDK manifest tool is required' }
foreach ($auraExecutable in $auraExecutables) {
    # Tauri embeds the app manifest in the app binary; lib test runners need their own Common Controls v6 activation.
    & $auraManifestTool -nologo -manifest (Join-Path $PSScriptRoot 'windows-test.manifest') "-outputresource:$auraExecutable;#1"
    if ($LASTEXITCODE -ne 0) { throw 'Could not embed the native test manifest' }
    & $auraExecutable
    if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
}
