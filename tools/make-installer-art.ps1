# Draws installer artwork for NSIS (24-bit BMP, as NSIS requires):
#   assets/installer/sidebar.bmp  164x314  welcome / finish pages (installer and uninstaller)
#   assets/installer/header.bmp   150x57   header strip on the other pages
# Drawn at 2x and downscaled for smooth edges.
Add-Type -AssemblyName System.Drawing
$root = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
$out = Join-Path $root 'installer'
New-Item -ItemType Directory -Force $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'icon-512.png'))

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Save-Bmp($big, $w, $h, $file) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($big, 0, 0, $w, $h); $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
}
function New-Canvas($w, $h) {
  $b = New-Object System.Drawing.Bitmap ($w * 2), ($h * 2)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.InterpolationMode = 'HighQualityBicubic'
  $g.ScaleTransform(2, 2)
  return @($b, $g)
}

# ---- sidebar: graphite, the icon, the name, a quiet note, one orange hairline ----
$b, $g = New-Canvas 164 314
$g.Clear((C '#141415'))
# a soft lighter step at the top, like a lit surface (one neutral, no hue gradient)
$top = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 0, 200), (C '#1d1d1f'), (C '#141415')
$g.FillRectangle($top, 0, 0, 164, 200)
$g.DrawImage($icon, 24, 40, 56, 56)
$fTitle = New-Object System.Drawing.Font 'Segoe UI Semibold', 13, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fName  = New-Object System.Drawing.Font 'Segoe UI', 20, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fNote  = New-Object System.Drawing.Font 'Segoe UI', 11, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('SoundCloud', $fName, (New-Object System.Drawing.SolidBrush (C '#ededed')), 22, 112)
$g.DrawString('Desktop', $fName, (New-Object System.Drawing.SolidBrush (C '#a1a1a6')), 22, 138)
$g.FillRectangle((New-Object System.Drawing.SolidBrush (C '#ff5500')), 24, 176, 24, 2)
# mini player sketch: the signature volume ladder
$x0 = 24; $y0 = 262
for ($i = 0; $i -lt 10; $i++) {
  $col = if ($i -lt 7) { C '#ff5500' } else { C '#2e2e31' }
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $col), ($x0 + $i * 11), $y0, 9, 6)
}
$g.DrawString('Unofficial client', $fNote, (New-Object System.Drawing.SolidBrush (C '#85858b')), 22, 280)
$g.Dispose()
Save-Bmp $b 164 314 (Join-Path $out 'sidebar.bmp'); $b.Dispose()

# ---- header: matches the white MUI header, icon on the right ----
$b, $g = New-Canvas 150 57
$g.Clear((C '#ffffff'))
$g.DrawImage($icon, 106, 12, 32, 32)
$g.Dispose()
Save-Bmp $b 150 57 (Join-Path $out 'header.bmp'); $b.Dispose()

$icon.Dispose()
Get-ChildItem $out | Select-Object Name, Length
