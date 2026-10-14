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

A deployment context must copy the static executable as `download-relay` and supply `BASE_IMAGE` as the approved digest-pinned runtime with CA certificates. Runtime is unprivileged, requires no writable filesystem, and performs no disk caching. Listen port is 8080; internal readiness is GET /healthz. The runtime image's unrelated inherited files are never served.

## Paths and delivery

GET/HEAD only. `/downloads/` serves embedded HTML; `/downloads/manifest.json`, `/downloads/version.json`, and `/downloads/relay-source.tar.gz` serve local embedded metadata and this relay's complete corresponding source. `/downloads/assets/<name>` accepts only the 15 exact ASCII filenames in manifest.json and fetches only the fixed GitHub repository/tag `ZonEaseTech/yitoken-studio`, `v0.1.0-alpha.1`.

No arbitrary URL, version, query string, escaped filename, encoded slash or traversal is accepted. The only query exception is `/downloads/version.json?_ts=<1..16 decimal digits>`, matching the frozen Electron updater's cache-buster; it serves local metadata only and is never forwarded upstream. Duplicate/encoded/empty/nondecimal cache-busters and all asset queries remain rejected. GitHub redirects are bounded to five and allow HTTPS/443 only to the exact repository filename or `release-assets.githubusercontent.com` / `objects.githubusercontent.com`. TLS certificates are verified. No browser cookies, authorization, API keys, referrers or arbitrary headers are forwarded. Signed redirect URLs, upstream errors, Location and Set-Cookie are not exposed or logged. Environment HTTP/HTTPS proxies are deliberately ignored; the service connects directly to the fixed public HTTPS hosts.

Range supports exactly one `bytes=start-end`, `bytes=start-`, or `bytes=-suffix` interval; unsatisfiable/malformed intervals return local 416 with the trusted size. A matching 206 must have the exact expected Content-Range and length. A valid full 200 may be returned when the upstream ignores Range or If-Range mismatches. HEAD has the corresponding GET headers without a body. Upstream validators ETag / Last-Modified are preserved so clients can send If-Range; they are not proof of SHA-256 identity.

Responses are streamed, not downloaded to disk or buffered in memory as full installers. Eight simultaneous upstream transfers maximum; excess requests immediately return 503 and Retry-After. Client disconnect cancels upstream; per-request total timeout is 30 minutes; connection/TLS timeout 10 seconds and response-header timeout 30 seconds. Incoming headers have a 16 KiB limit, 10-second header timeout, 15-second request-read timeout, 60-second idle timeout and 31-minute response-write deadline. Stream errors after response headers force connection/stream abort, never an apparently successful short response with an appended error message.

**Integrity limit:** metadata is pinned from release asset names, byte sizes and SHA-256 digests. The relay checks status, size, encoding and range before sending a body; it does not claim to hash a 200 MiB installer before streaming. Users must verify the completed download's SHA-256 locally using `SHA256SUMS-GITHUB.txt`. This corrected checklist covers public GitHub-normalized filenames; the original SHA256SUMS.txt remains an audit artifact only.

## Source and deployment safety

`package-source.sh` deterministically packs this directory's source, tests, module, metadata, page, README, Dockerfile, license and packaging script, excluding itself as an archive, executable, caches and unrelated internal files. The package is embedded; regenerate after any source/metadata/page modification **before** tests/build. The source-consistency test verifies archive member bytes against the checkout. The release client/source installers remain on GitHub. This service's source download is independent and always available without GitHub. Regenerating the archive does not modify the frozen application or legacy downloads site.

Caddy must preserve the /downloads/ prefix and proxy rather than redirect. Do not use a negative flush_interval, which disables upstream cancellation on client disconnect. Do not compress or transform attachment responses: application/octet-stream, Content-Encoding identity and Cache-Control no-store, no-transform are intentional. No production deployment is performed by this module.
