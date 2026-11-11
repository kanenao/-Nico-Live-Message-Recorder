$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "8.6.3-1"
$assetName = "streamlink-8.6.3-1-py315-x86_64.zip"
$downloadUrl = "https://github.com/streamlink/windows-builds/releases/download/$version/$assetName"
$expectedSha256 = "3b1f1470d4b135080a8107ca2917379ca3ff5acadbcdc215568b79eea1450497"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$vendorRoot = Join-Path $repositoryRoot "vendor"
$runtimeRoot = Join-Path $vendorRoot "streamlink"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "nlmr-streamlink-$version"
$archivePath = Join-Path $tempRoot $assetName

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
if (Test-Path $runtimeRoot) {
    Remove-Item -Path $runtimeRoot -Recurse -Force
}

Write-Host "Downloading official Streamlink Windows portable package $version..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$fileStream = [System.IO.File]::OpenRead($archivePath)
try {
    $actualSha256 = [System.BitConverter]::ToString($sha256.ComputeHash($fileStream)).Replace("-", "").ToLowerInvariant()
}
finally {
    $fileStream.Dispose()
    $sha256.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw "Streamlink archive SHA-256 mismatch. Expected $expectedSha256 but received $actualSha256."
}

Write-Host "SHA-256 verified. Extracting the portable runtime..."
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force

$streamlinkExe = Get-ChildItem -LiteralPath $runtimeRoot -Filter "streamlink.exe" -File -Recurse |
    Select-Object -First 1
$ffmpegExe = Get-ChildItem -LiteralPath $runtimeRoot -Filter "ffmpeg.exe" -File -Recurse |
    Select-Object -First 1

if (-not $streamlinkExe) {
    throw "The official portable archive did not contain streamlink.exe."
}
if (-not $ffmpegExe) {
    throw "The official portable archive did not contain ffmpeg.exe."
}

Write-Host "Checking Streamlink executable..."
& $streamlinkExe.FullName --version
if ($LASTEXITCODE -ne 0) {
    throw "The bundled Streamlink executable failed its version check."
}

Write-Host "Checking FFmpeg executable..."
& $ffmpegExe.FullName -version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "The bundled FFmpeg executable failed its version check."
}

Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
Write-Host "Streamlink $version and FFmpeg are ready in $runtimeRoot"
