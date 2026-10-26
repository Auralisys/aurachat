# Regenerates the committed NSIS bitmaps from AuraChat's existing Windows logo.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$desktop = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $desktop 'assets\installer'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
$logo = [Drawing.Image]::FromFile((Join-Path $desktop 'src-tauri\icons\windows\icon.png'))

function New-InstallerBitmap {
    param([string]$Name, [int]$Width, [int]$Height, [scriptblock]$Paint)
    $bitmap = New-Object Drawing.Bitmap($Width, $Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        & $Paint $graphics
        $bitmap.Save((Join-Path $assets $Name), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Draw-InstallerText {
    param($Graphics, [string]$Text, [int]$Size, [string]$Color, [int]$X, [int]$Y, [switch]$Bold)
    $style = [Drawing.FontStyle]::Regular
    if ($Bold) { $style = [Drawing.FontStyle]::Bold }
    $font = New-Object Drawing.Font('Segoe UI', $Size, $style, [Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($Color))
    try { $Graphics.DrawString($Text, $font, $brush, $X, $Y) }
    finally { $font.Dispose(); $brush.Dispose() }
}

try {
    New-InstallerBitmap 'sidebar.bmp' 164 314 {
        param($g)
        $g.Clear([Drawing.ColorTranslator]::FromHtml('#1b191f'))
        $g.DrawImage($logo, 20, 28, 68, 68)
        Draw-InstallerText $g 'AuraChat' 25 '#f5f0ff' 17 116 -Bold
        Draw-InstallerText $g 'Desktop' 14 '#b4aebd' 18 151
        Draw-InstallerText $g 'Auralisys' 13 '#bb93fb' 18 257 -Bold
        Draw-InstallerText $g 'auralisys.com' 11 '#b4aebd' 18 279
    }
    New-InstallerBitmap 'header.bmp' 150 57 {
        param($g)
        $g.Clear([Drawing.Color]::White)
        $g.DrawImage($logo, 8, 12, 32, 32)
        Draw-InstallerText $g 'AuraChat' 18 '#1b191f' 47 16 -Bold
    }
} finally { $logo.Dispose() }
Write-Host 'Generated NSIS branding: sidebar.bmp (164x314), header.bmp (150x57).'
