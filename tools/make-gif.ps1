# Encodes frames from tools/capture-docs.js into docs/widget.gif (needs ffmpeg in PATH)
# Usage: powershell -File tools/make-gif.ps1 <workdir>
param([Parameter(Mandatory)] [string]$Work)
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'docs\widget.gif'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$first = Get-ChildItem (Join-Path $Work 'frames') -Filter *.png | Select-Object -First 1
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($first.FullName); $w = $img.Width; $h = $img.Height; $img.Dispose()
$W = $w + 80; $H = $h + 60
# frames over a soft gradient "desktop", palette tuned per GIF
$filter = "color=c=0x1d2233:s=${W}x${H}:r=10[bg];[bg][0:v]overlay=(W-w)/2:(H-h)/2:shortest=1,split[a][b];[a]palettegen=stats_mode=diff:max_colors=200[p];[b][p]paletteuse=dither=sierra2_4a"
ffmpeg -y -loglevel error -framerate 10 -i (Join-Path $Work 'frames\f%04d.png') -filter_complex $filter -loop 0 $out
Get-Item $out | Select-Object Name, Length
