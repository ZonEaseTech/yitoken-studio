# Media toolchain sources and licences

The release media tools must be built using `npm run build:media` or
`npm run build:media:win` from the exact archives in `sources/` and the lock
in `media-toolchain.json`. Source SHA256 is checked before executing tools;
FFmpeg's release signature is verified against its declared public fingerprint.

- FFmpeg 9.0.2: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- x264 exact commit: b35605ace3ddf7c1a5d67a2eb553f034aef41d55
- x264 upstream: https://code.videolan.org/videolan/x264
- Build configuration: GPL version 3, x264 encoding; FFmpeg network protocols
  and physical devices disabled. Internal lavfi test signals are enabled.

Both exact source archives, licence texts and the build script are included in
the YITOKEN corresponding-source archive; no dependency on unavailable source
from an old prebuilt binary is used for a public release. `MEDIA-PROVENANCE.json`
in each built tool directory records target, revision/configuration and hashes.
The build script depends on standard compiler/make/nasm/pkg-config/tar/gpg
build prerequisites; they are not runtime dependencies of the desktop client.

The eugeneware b6.1.1 tools obtained during development are *not* the release
toolchain: its Linux payload is actually FFmpeg 7.0.2, its Windows payload 6.1.1.
They stay excluded under `.cache/` and must not be distributed as release tools.

FFmpeg and x264 are separate executables from the AGPL application. Their GPL
licences and corresponding source obligations still apply to binary distribution.
Read the included original licence texts; this notice is not legal advice and
is not a patent-clearance or commercial licensing certification.
