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

[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($vendorRoot) | Out-Null
if ([System.IO.Directory]::Exists($runtimeRoot)) {
    [System.IO.Directory]::Delete($runtimeRoot, $true)
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
    if ([System.IO.File]::Exists($archivePath)) {
        [System.IO.File]::Delete($archivePath)
    }
    throw "Streamlink archive SHA-256 mismatch. Expected $expectedSha256 but received $actualSha256."
}

Write-Host "SHA-256 verified. Extracting the portable runtime..."
[System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $runtimeRoot)

$streamlinkCandidates = [System.IO.Directory]::GetFiles(
    $runtimeRoot,
    "streamlink.exe",
    [System.IO.SearchOption]::AllDirectories
)
$ffmpegCandidates = [System.IO.Directory]::GetFiles(
    $runtimeRoot,
    "ffmpeg.exe",
    [System.IO.SearchOption]::AllDirectories
)

if ($streamlinkCandidates.Length -eq 0) {
    throw "The official portable archive did not contain streamlink.exe."
}
if ($ffmpegCandidates.Length -eq 0) {
    throw "The official portable archive did not contain ffmpeg.exe."
}

$streamlinkExe = $streamlinkCandidates[0]
$ffmpegExe = $ffmpegCandidates[0]

Write-Host "Checking Streamlink executable..."
& $streamlinkExe --version
if ($LASTEXITCODE -ne 0) {
    throw "The bundled Streamlink executable failed its version check."
}

Write-Host "Checking FFmpeg executable..."
& $ffmpegExe -version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "The bundled FFmpeg executable failed its version check."
}

if ([System.IO.File]::Exists($archivePath)) { [System.IO.File]::Delete($archivePath) }
Write-Host "Streamlink $version and FFmpeg are ready in $runtimeRoot"
