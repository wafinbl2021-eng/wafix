<#
.SYNOPSIS
  Regenerates the Wafi X icon set from the original brand artwork.

.DESCRIPTION
  The source artwork is a 2816x1536 brand lockup: a circular emblem on top and a
  wordmark beneath it. Windows and Tauri want square icons, and a wordmark is
  unreadable at 16-32 px, so the emblem is what becomes the application icon and
  the full lockup is kept alongside it as a logo asset.

  Nothing here redraws, recolours or otherwise alters the artwork. The emblem is
  cropped from the source pixels, so what ships is exactly what was supplied,
  including the dark background it was drawn on (the source has no alpha
  channel, so there is no transparency to preserve).

  Crop geometry was measured from the source at a luminance threshold of 70:
    emblem content   x 1028..1788, y 228..986   (761 x 759, centre 1408, 607)
    lockup content   x 920..1896,  y 228..1271   (977 x 1044)
  The icon crop is a 800 px square centred on the emblem. 800 is the largest
  symmetric square that still clears the wordmark, which starts at y=1016: the
  emblem ends at y=986, so anything larger would pull the first rows of the
  wordmark into the icon.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/make-wafix-icons.ps1
  powershell -ExecutionPolicy Bypass -File scripts/make-wafix-icons.ps1 -Source D:\art\wafix.png
#>
[CmdletBinding()]
param(
  # Original 2816x1536 brand artwork. Optional: supply it to re-extract the
  # emblem and lockup. Omit it and this regenerates the Tauri icon set from the
  # committed src-tauri/icons/wafix-emblem.png, which needs nothing else.
  [string]$Source,

  # Skip `npx tauri icon` and only re-extract the emblem and lockup.
  [switch]$NoTauriIcon
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Resolve-Path "$PSScriptRoot/.."
$iconsDir = Join-Path $repo 'src-tauri/icons'
$emblemPng = Join-Path $iconsDir 'wafix-emblem.png'
$lockupPng = Join-Path $iconsDir 'wafix-lockup.png'

# ---------------------------------------------------------------------------
# Crop geometry, measured from the source artwork. See the file header.
# ---------------------------------------------------------------------------

# Emblem -> square icon source. 800 px, centred on the emblem.
$emblem = [pscustomobject]@{
  X = 1008
  Y = 207
  Size = 800
}

# Whole lockup, for logo use. Content box plus a small margin.
$lockup = [pscustomobject]@{
  X = 904
  Y = 212
  Width = 1009
  Height = 1076
}

function Save-Crop {
  param(
    [Parameter(Mandatory)] [System.Drawing.Bitmap]$Image,
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [int]$X,
    [Parameter(Mandatory)] [int]$Y,
    [Parameter(Mandatory)] [int]$Width,
    [Parameter(Mandatory)] [int]$Height
  )

  if ($X -lt 0 -or $Y -lt 0 -or ($X + $Width) -gt $Image.Width -or ($Y + $Height) -gt $Image.Height) {
    throw "Crop $X,$Y ${Width}x${Height} does not fit inside $($Image.Width)x$($Image.Height)."
  }

  $out = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  try {
    # Nearest-neighbour-free resample; the crop is 1:1 so this is a straight
    # blit in practice, but specifying it keeps the result deterministic.
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
    $g.DrawImage(
      $Image,
      (New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)),
      (New-Object System.Drawing.Rectangle($X, $Y, $Width, $Height)),
      [System.Drawing.GraphicsUnit]::Pixel
    )
  }
  finally {
    $g.Dispose()
  }

  $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host ("  wrote {0} ({1}x{2}, {3:N0} bytes)" -f (Split-Path $Path -Leaf), $Width, $Height, (Get-Item $Path).Length)
}

if ($Source) {
  if (-not (Test-Path $Source)) {
    throw "Source artwork not found: $Source"
  }

  $srcPath = (Resolve-Path $Source).Path
  Write-Host "Source: $srcPath"

  $image = New-Object System.Drawing.Bitmap($srcPath)
  try {
    Write-Host ("Source: {0}x{1} {2}" -f $image.Width, $image.Height, $image.PixelFormat)

    # The emblem, cropped 1:1 from the source pixels.
    Save-Crop -Image $image -Path $emblemPng `
      -X $emblem.X -Y $emblem.Y -Width $emblem.Size -Height $emblem.Size

    # The full lockup, emblem plus wordmark, for logo use.
    Save-Crop -Image $image -Path $lockupPng `
      -X $lockup.X -Y $lockup.Y -Width $lockup.Width -Height $lockup.Height
  }
  finally {
    $image.Dispose()
  }
}
elseif (Test-Path $emblemPng) {
  Write-Host 'No -Source given; using the committed wafix-emblem.png as-is.'
}
else {
  throw @"
No -Source given and $emblemPng does not exist.
Pass the original brand artwork once with -Source to extract it:
  powershell -ExecutionPolicy Bypass -File scripts/make-wafix-icons.ps1 -Source <path-to-artwork.png>
"@
}

if ($NoTauriIcon) {
  Write-Host 'Skipping `tauri icon` (-NoTauriIcon).'
  exit 0
}

# ---------------------------------------------------------------------------
# Full icon set.
#
# `tauri icon` writes exactly the filenames src-tauri/tauri.conf.json already
# lists in bundle.icon and bundle.windows.nsis.installerIcon, so this replaces
# the shipped artwork without editing tauri.conf.json at all. productName,
# identifier and publisher are therefore untouched.
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Generating the Tauri icon set...'
Push-Location $repo
try {
  & npx.cmd tauri icon $emblemPng --output $iconsDir
  if ($LASTEXITCODE -ne 0) { throw "`tauri icon` failed with exit code $LASTEXITCODE." }
}
finally {
  Pop-Location
}

# `tauri icon` also writes iOS and Android asset trees. This app bundles for
# Windows only (bundle.targets is "all" over Windows installers, there is no
# mobile target), so those directories would be dead weight in version control
# and would only ever drift out of date. Remove them and keep the desktop set.
foreach ($mobile in @('android', 'ios')) {
  $dir = Join-Path $iconsDir $mobile
  if (Test-Path $dir) {
    Remove-Item -Recurse -Force $dir
    Write-Host "  removed $mobile/ (not a target for this app)"
  }
}

Write-Host ''
Write-Host 'Done. Icon set:'
Get-ChildItem $iconsDir -File |
  Sort-Object Name |
  ForEach-Object { '  {0,-26} {1,9:N0} bytes' -f $_.Name, $_.Length }

Write-Host ''
Write-Host 'Changed files:'
Push-Location $repo
try { & git status --short -- src-tauri/icons }
finally { Pop-Location }