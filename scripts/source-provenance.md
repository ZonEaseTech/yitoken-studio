# Source and release provenance

This application is an AGPL-3.0-or-later derivative of Moyin Creator.
Upstream repository: https://github.com/MemeCalculate/moyin-creator
Upstream source commit: 7e5c5655de94d49885e13c369f0a71212893a0aa
Upstream release reference: V0.2.9 (its source manifest still declared 0.2.3).

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build:app`.
First run `npm run build:media` (native), or `npm run build:media:win`
(Linux with MinGW, for Windows x64). Exact FFmpeg/x264 sources, signature, licences
and compiler flags are included under `third_party/`. Each platform media pair
records binary hashes in MEDIA-PROVENANCE.json; packaging refuses mismatches.
Build the selected platform with `npm run build:win`, or on a Mac
`npm run build:mac:arm64` / `npm run build:mac:x64`.
`npm run release:source` creates a complete application-source archive with
SHA256 hashes for all included inputs; generated binaries, local credentials,
cache directories, and dependency installs are not copied into that archive.
The lockfile identifies the publicly available dependency sources; npm ci is
required. No YITOKEN operator key, server password or private signing key is
required or included.

The source distribution includes the application source and build scripts, the
upstream AGPL license and notices, and the immutable dependency lockfile. Each
public binary must link to its matching source archive and checksums. A source
archive alone does not certify any platform installation or a paid API request.
Upstream identity and copyright notices remain in the source. The separate
YITOKEN desktop name/application ID does not overwrite an existing Moyin app.
