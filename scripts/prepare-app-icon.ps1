# Requires Windows PowerShell (the Windows packaging runner).
# Generate a multi-resolution Windows ICO from the image used in the app header.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourcePath = Join-Path $projectRoot "assets/app-icon.jpg"
$targetPath = Join-Path $projectRoot "build/icon.ico"
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "App icon source not found: $sourcePath"
}
$image = $null
$writer = $null
$stream = $null
try {
  $image = [System.Drawing.Image]::FromFile($sourcePath)
  if ($image.Width -lt 128 -or $image.Height -lt 128 -or $image.Width -ne $image.Height) {
    throw "App icon must be a square image at least 128px: $($image.Width)x$($image.Height)"
  }
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $frames = [System.Collections.Generic.List[byte[]]]::new()
  foreach ($size in $sizes) {
    $bmp = [System.Drawing.Bitmap]::new([int]$size, [int]$size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $buffer = [System.IO.MemoryStream]::new()
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.DrawImage($image, 0, 0, $size, $size)
      $bmp.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames.Add($buffer.ToArray())
    } finally {
      $buffer.Dispose()
      $graphics.Dispose()
      $bmp.Dispose()
    }
  }
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($targetPath)) | Out-Null
  $stream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = [System.IO.BinaryWriter]::new($stream)
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $n = [int]$sizes[$i]
    $bytes = $frames[$i]
    $writer.Write([byte]($n % 256)) # zero means 256px for an ICO directory entry
    $writer.Write([byte]($n % 256))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $bytes.Length
  }
  foreach ($bytes in $frames) { $writer.Write([byte[]]$bytes) }
  $writer.Flush()
  Write-Host "Created Windows app icon: $targetPath ($($sizes -join ',')px)"
} finally {
  if ($writer) { $writer.Dispose() }
  elseif ($stream) { $stream.Dispose() }
  if ($image) { $image.Dispose() }
}
if ((Get-Item -LiteralPath $targetPath).Length -lt 10000) { throw "Generated ICO is unexpectedly small." }
