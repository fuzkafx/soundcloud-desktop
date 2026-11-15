# Draws the app icon (assets/icon.ico) and taskbar thumbnail buttons (assets/icons/*.png)
Add-Type -AssemblyName System.Drawing
$root = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
New-Item -ItemType Directory -Force (Join-Path $root 'icons') | Out-Null

function New-AppPng([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0,0), (New-Object System.Drawing.Point $s,$s), ([System.Drawing.Color]::FromArgb(255,255,136,0)), ([System.Drawing.Color]::FromArgb(255,255,60,0))
  $g.FillEllipse($grad, 0, 0, $s-1, $s-1)
  # "cloud" of three circles + sound bars on the left
  $w = [System.Drawing.Brushes]::White
  $u = $s / 16.0
  $g.FillEllipse($w, 7*$u, 5*$u, 5*$u, 5*$u)
  $g.FillEllipse($w, 9.5*$u, 7*$u, 3.5*$u, 3.5*$u)
  $g.FillRectangle($w, 8*$u, 8*$u, 4.5*$u, 2.5*$u)
  foreach ($i in 0..3) { $h = (1.5 + $i*0.7)*$u; $g.FillRectangle($w, (3.2+$i*1.0)*$u, 10.5*$u-$h, 0.6*$u, $h) }
  $g.Dispose(); $bmp
}

# ICO with PNG frames 16..256
$sizes = 16,24,32,48,64,128,256
$pngs = foreach ($s in $sizes) { $b = New-AppPng $s; $ms = New-Object IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); ,$ms.ToArray() }
$out = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16*$sizes.Count
for ($i=0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = if ($s -ge 256) {0} else {$s}
  $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
[IO.File]::WriteAllBytes((Join-Path $root 'icon.ico'), $out.ToArray())

# Thumbnail buttons 32x32
function New-Btn($name, [scriptblock]$draw) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  & $draw $g ([System.Drawing.Brushes]::White)
  $g.Dispose(); $bmp.Save((Join-Path $root "icons\$name.png"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
function P($pts) { [System.Drawing.PointF[]]($pts | ForEach-Object { New-Object System.Drawing.PointF $_[0], $_[1] }) }
New-Btn 'play'  { param($g,$b) $g.FillPolygon($b, (P @(@(9,6),@(26,16),@(9,26)))) }
New-Btn 'pause' { param($g,$b) $g.FillRectangle($b, 8,6,6,20); $g.FillRectangle($b, 18,6,6,20) }
New-Btn 'next'  { param($g,$b) $g.FillPolygon($b, (P @(@(6,7),@(20,16),@(6,25)))); $g.FillRectangle($b, 21,7,4,18) }
New-Btn 'prev'  { param($g,$b) $g.FillPolygon($b, (P @(@(26,7),@(12,16),@(26,25)))); $g.FillRectangle($b, 7,7,4,18) }
"ok"

