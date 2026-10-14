# YITOKEN Studio download relay

AGPL-3.0-or-later; original client based on Moyin Creator / MemeCalculate.
This independent Go 1.25.1 standard-library service changes only public download delivery. It does not handle authentication, API keys, billing or databases.

## Build and check

```sh
./package-source.sh
GOWORK=off go test -race ./...
GOWORK=off go vet ./...
CGO_ENABLED=0 GOWORK=off go build -trimpath -o /tmp/download-relay .
```

A deployment context must copy the static executable as `download-relay` and supply `BASE_IMAGE` as the approved digest-pinned runtime with CA certificates. Runtime is unprivileged, requires no writable filesystem, and never downloads or writes mirror files itself. Listen port is 8080; internal readiness is GET /healthz. The runtime image's unrelated inherited files are never served.

## Paths and delivery

GET/HEAD only. `/downloads/` serves embedded HTML; `/downloads/manifest.json`, `/downloads/version.json`, and `/downloads/relay-source.tar.gz` serve local embedded metadata and this relay's complete corresponding source. `/downloads/assets/<name>` accepts only the 15 exact ASCII filenames in manifest.json and serves verified mirror files when configured, otherwise fetching only the fixed GitHub repository/tag `ZonEaseTech/yitoken-studio`, `v0.1.0-alpha.1`.

No arbitrary URL, version, query string, escaped filename, encoded slash or traversal is accepted. The only query exception is `/downloads/version.json?_ts=<1..16 decimal digits>`, matching the frozen Electron updater's cache-buster; it serves local metadata only and is never forwarded upstream. Duplicate/encoded/empty/nondecimal cache-busters and all asset queries remain rejected. GitHub redirects are bounded to five and allow HTTPS/443 only to the exact repository filename or `release-assets.githubusercontent.com` / `objects.githubusercontent.com`. TLS certificates are verified. No browser cookies, authorization, API keys, referrers or arbitrary headers are forwarded. Signed redirect URLs, upstream errors, Location and Set-Cookie are not exposed or logged. Environment HTTP/HTTPS proxies are deliberately ignored; the service connects directly to the fixed public HTTPS hosts.

Range supports exactly one `bytes=start-end`, `bytes=start-`, or `bytes=-suffix` interval; unsatisfiable/malformed intervals return local 416 with the trusted size. A matching 206 must have the exact expected Content-Range and length. A valid full 200 may be returned when the upstream ignores Range or If-Range mismatches. HEAD has the corresponding GET headers without a body. Upstream validators ETag / Last-Modified are preserved so clients can send If-Range; they are not proof of SHA-256 identity.

Responses are streamed, not downloaded to disk or buffered in memory as full installers. Eight simultaneous asset transfers per process maximum (local mirror and GitHub share the same limit); excess requests immediately return 503 and Retry-After. Client disconnect cancels upstream or stops local reads; per-request total timeout is two hours; connection/TLS timeout 10 seconds and response-header timeout 30 seconds. Incoming headers have a 16 KiB limit, 10-second header timeout, 15-second request-read timeout, 60-second idle timeout and 121-minute response-write deadline. Stream errors after response headers force connection/stream abort, never an apparently successful short response with an appended error message.

**Integrity limit:** metadata is pinned from release asset names, byte sizes and SHA-256 digests. Configured local mirror files receive a full SHA-256 check at startup, not on each request; requests check file identity, size and modification time against the startup snapshot. GitHub fallback checks status, size, encoding and range before sending a body, without hashing the complete upstream installer before streaming. Users must verify the completed download's SHA-256 locally using `SHA256SUMS-GITHUB.txt`. This corrected checklist covers public GitHub-normalized filenames; the original SHA256SUMS.txt remains an audit artifact only.

## Optional verified server mirror

Unset `YITOKEN_DOWNLOAD_MIRROR_DIR` preserves the previous GitHub-only asset route. When set, it must name an existing non-symlink directory; an empty value, unavailable directory, empty mirror or any present allowlisted file with a wrong type, byte size or SHA-256 fails startup. No partial or unverified file is served. A partial mirror is allowed only with at least one verified allowlisted file; genuinely absent assets keep the fixed GitHub fallback. Unlisted files are ignored, never scanned or served. There is no automatic download, arbitrary URL handling or directory-listing endpoint.

The process opens an `os.Root` and reads only fixed allowlisted basenames within it. Startup hashes the complete contents of each present file and retains its verified identity/size/modification-time snapshot. Later deletion, replacement, size/time changes or a symbolic link returns local 503 with Retry-After, never an upstream fallback for an asset already recorded as mirrored. Hash verification is **startup-only**: in-place changes with restored metadata are not detected by a full per-request hash. Operators must therefore make the files and directory immutable to the running service and other writers.

Provision and independently verify the approved release files outside the running container, then bind-mount that version directory read-only, for example `--mount type=bind,src=/approved/version-dir,dst=/srv/download-mirror,readonly` with `YITOKEN_DOWNLOAD_MIRROR_DIR=/srv/download-mirror`. Give the service UID only read permission on files and traverse/read permission on that directory (for example operator-owned files 0444 and directory 0555); keep the service unprivileged, retain the read-only container filesystem, and grant no host write capability. Do not copy or modify files in a live mounted version directory; stage a complete candidate directory and deploy a new process against it so startup verification runs before readiness. No database or application credentials are needed.

Mirrored GET/HEAD requests use the same URL, method/query/path checks, strict single-Range validation, security headers and shared eight-transfer limit as fallback. GET streams from a read-only file; HEAD reads no body. A strong `"sha256-<manifest digest>"` ETag supports If-Range: exact matching ETag gives the requested 206, while nonmatching/weak/date validators give full 200. Cancellation and short reads abort the stream rather than append an error body. This is a server-local mirror, not a CDN, and no fixed speed improvement is promised.

Rollback: restore the preceding image/configuration and omit `YITOKEN_DOWNLOAD_MIRROR_DIR` plus the mirror mount to return to GitHub-only delivery without changing the public URLs, release metadata or files. A failed candidate startup must not replace the currently healthy process. Preserve existing downloads until normal completion when switching traffic; the concurrency cap is per process, not a global cross-version limit.

## Public download page

The embedded, script-free green download portal has a plain-language AI-video-software introduction (scripts/storyboards, image/video generation, local MP4 assembly), a manual `#platforms` system selector, four platform cards (four columns on desktop, two up to 1000px, one up to 640px) with six installer links, and three usage steps. It performs no device detection or automatic downloads. The real version remains `0.1.0-alpha.1`; prerelease/unsigned/unnotarized status is disclosed in collapsed release details, not a first-screen warning badge. The hero states that users supply their own YITOKEN API Key and voluntary generation charges their own account. Installer filenames, byte sizes, SHA-256 digests, manifest/version documents, fixed allowlist and CSP are unchanged. SHA-256 verification, the corrected checklist and both ordinary AGPL corresponding-source links remain available.

The former first-screen installation-warning banner is removed. Its alpha release, unsigned/unnotarized-package status, existing test acceptance limits, export constraints and privacy/API-Key safeguards remain in native collapsed details, together with Moyin Creator attribution and GPL/AGPL licensing information. Expanding these sections does not request an API, read credentials or start a download. The API-Key link goes to the existing `/keys` page; voluntary generation may charge the user's own account, while local concatenation adds no AI-generation charge.

## Source and deployment safety

`package-source.sh` deterministically packs this directory's source, tests, module, metadata, page, README, Dockerfile, license and packaging script, excluding itself as an archive, executable, caches and unrelated internal files. The package is embedded; regenerate after any source/metadata/page modification **before** tests/build. The source-consistency test verifies archive member bytes against the checkout. The release client/source assets remain on GitHub; approved installation assets may additionally be provisioned in the local read-only mirror. This service's source download is independent and always available without GitHub. Regenerating the archive does not modify the frozen application or legacy downloads site.

Caddy must preserve the /downloads/ prefix and proxy rather than redirect. Do not use a negative flush_interval, which disables upstream cancellation on client disconnect. Do not compress or transform attachment responses: application/octet-stream, Content-Encoding identity and Cache-Control no-store, no-transform are intentional. No production deployment is performed by this module.
