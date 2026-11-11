# Third-party notices

Nico Live Message Recorder distributes the official Streamlink Windows portable runtime inside its Windows installer and portable ZIP.

## Streamlink

- Project: https://github.com/streamlink/streamlink
- Windows builds: https://github.com/streamlink/windows-builds
- License: BSD 2-Clause (see the license files in the bundled distribution and the upstream repositories).
- Bundled build: Streamlink Windows Portable 8.6.3-1, x86_64, Python 3.15 embedded build.
- Original archive: https://github.com/streamlink/windows-builds/releases/download/8.6.3-1/streamlink-8.6.3-1-py315-x86_64.zip
- SHA-256: 3b1f1470d4b135080a8107ca2917379ca3ff5acadbcdc215568b79eea1450497

## Python and FFmpeg

The official Streamlink Windows portable archive also contains an embedded Python runtime and FFmpeg for stream muxing. Their original license and notice files are retained in the bundled runtime directory. See the files distributed under the application's `resources/streamlink` directory.

## Build-time verification

The Windows build script downloads the archive from the official `streamlink/windows-builds` GitHub release, verifies its SHA-256 against the pinned official asset digest, and aborts the build if the digest does not match or the expected executables are missing.

No changes are made to the user's system PATH or system-wide Python installation.
