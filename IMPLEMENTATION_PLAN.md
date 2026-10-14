# YITOKEN Studio Implementation Plan — 2026-10-14

Approved scope: user approved AGPL corresponding-source distribution and the proposed first-version scope in this conversation. Work is in an independent clone on feat/yitoken-studio; /workspace/new-api and all existing user changes remain untouched. No commits/pushes will be made without a separately justified publishing step.

Goal: YITOKEN-branded desktop AI storyboard/assets client, blank user-supplied key, real YITOKEN protocol integration, protected credentials, explicit uploads, honest asset export, and reproducible downloadable source.
Architecture: keep upstream React/Electron project/media workflow; replace provider defaults and align generation with the declared YITOKEN APIs; protect persisted API settings via Electron main-process encryption, tighten IPC/path/external-link boundaries. Package independently; never bundle operator credentials. No new production schema or billing change. No full-movie rendering.
Baseline: upstream main 7e5c5655de94d49885e13c369f0a71212893a0aa; production files match release V0.2.9, but package version was 0.2.3. Local source tag/commit and build provenance will be retained.

## Task 1 — Baseline and checks (root)
- [ ] Install locked upstream dependencies without upstream lifecycle scripts; identify baseline type/build failures before changes.
- [ ] Add Vitest and focused tests; add typecheck/test/build-renderer scripts, a consistent local version, platform packaging config, and build provenance.
- [ ] Every change gets fail-first focused tests for observable contracts; re-run complete affected checks after final integration.

## Task 2 — YITOKEN API / settings (API agent)
Owned: src/lib/api-key-manager.ts, src/lib/ai/feature-router.ts, src/stores/api-config-store.ts, src/components/api-manager/*, src/components/panels/SettingsPanel.tsx, src/components/panels/director/use-video-generation.ts, src/lib/freedom/freedom-api.ts, src/lib/ai/image-generator.ts, src/components/panels/sclass/sclass-scenes.tsx; new domain modules/tests allowed.
- [ ] Test blank-key initialization, HTTPS root URL normalization, authenticated /v1/models sync, model feature mapping and explicit endpoint metadata.
- [ ] Add a true YITOKEN provider (not memefast masquerading). Root: https://yitoken.com.cn; recommended models gpt-6.1-sol, seedream-5.0-lite, seedance-2.0-mini. Only expose protocol-validated models/modes; otherwise explicit unavailable state.
- [ ] Map openai-video metadata to actual /v1/videos POST and /v1/videos/{id} query, preserve request model/options/reference inputs correctly; bounded polling and completed/failed/progress handling, no duplicate retry-submission on ambiguous errors.
- [ ] Keep image/chat protocols separate, free connection test only lists models. Never use a real key or paid generation without a defined test budget.
- [ ] First-run settings link to YITOKEN website/token page, truthful local-key/cost/privacy text. Default third-party image host disabled; explicit opt-in/custom storage for reference workflows, no silent public guest upload. Update old feature fallback and worker bindings during integration with root if needed.
- [ ] Leave credential storage injection to security agent/root integration; do not edit electron/* or package/lock.

## Task 3 — Desktop security (security agent)
Owned: electron/main.ts, electron/preload.ts, new electron credential/security modules; src/lib/secure-api-storage.ts and typings. Do not edit api-config-store until coordinated injection after API agent finishes.
- [ ] Write tests for HTTPS URL rules, IPC allowlist/sender, contained storage paths, encrypt/decrypt roundtrip and refusal of plaintext fallback, update/external URL restrictions.
- [ ] Encrypt entire persisted API configuration using safeStorage in main process and a narrow credential IPC. Return plaintext only to trusted application renderer that already performs the API requests; never expose generic encrypt/decrypt RPC or arbitrary paths. Stronger renderer-key isolation is not falsely claimed.
- [ ] Add async Zustand persist adapter; successful import migration removes legacy plaintext, failed encryption retains only session memory and clearly reports saving failure. Never lose old project data or silently clear keys.
- [ ] Remove raw universal IPC bridge and replace with explicit channel allowlist/typed APIs while preserving valid existing UI operations; validate sender and normalize bounded paths in every filesystem storage handler.
- [ ] Reject HTTP update manifests, restrict HTTPS external downloads/navigation, explicit context isolation/sandbox/permission handling, preserve required local-image protocol.
- [ ] Do not edit package/lock or API feature settings; send root integration instructions.

## Task 4 — Brand / honest exports (UI agent)
Owned: index.html, src/App.tsx, src/components/{Dashboard,TabBar,ProjectHeader,UpdateDialog,SimpleTimeline}.tsx, src/components/panels/export/index.tsx, src/lib/script/export-service.ts, src/components/panels/director/generation-progress.tsx, src/workers/ai-worker.ts, build icons and new release README/notices. Do not edit settings/API files/electron/package.
- [ ] Preserve copyright/license headers and third-party attribution; app-visible branding YITOKEN Studio, Y logo with code-native asset, help/update/website links owned by YITOKEN.
- [ ] Remove sensitive config/key logs and URL-query credentials in owned paths. Worker default YITOKEN (coordinate settings map compatibility with API agent).
- [ ] Test exports with a failed download: report partial failure, exact failed files, never false all-complete toast. Explicitly label material export, not whole-movie rendering. Keep valid upstream project compatibility.
- [ ] Download/source/license instructions, CHANGELOG/NOTICE with upstream revision, AGPL notices and changes; no unsupported automatic-update or installed-platform claims.

## Task 5 — Integration / verification / download (root)
- [ ] Review diffs/spec coverage independently, integrate secure persist in API store, grep all complete-key logging and old active vendor paths; inspect any residual route used by Sclass/worker.
- [ ] Re-run tests/typecheck/renderer+Electron build; headless local app smoke test with fake key, inspect storage for absent plaintext and verify local-only no-key workflow. No production data changes.
- [ ] Build Windows installer if host supports tooling; prepare Mac build commands but do not claim Mac validation without real build/runtime evidence. Check release signatures/provenance; unaudited platforms stay unavailable.
- [ ] Produce complete corresponding-source archive (excluding .git/node_modules/operator secrets) with lockfile, build scripts, AGPL and third-party notice, SHA256. No binary-to-source equivalence claim without successful reproducible build evidence.
- [ ] Create additive website download page with available artifacts/source/checksum and limitations. Do not point users to original vendor packages as YITOKEN packages.
- [ ] Deploy only to positively identified YITOKEN server/path after backup using the approved transport. Current AISSH target list does not include YITOKEN host; investigate local authorized connection before any deployment. Never hop via unrelated hosts.
- [ ] Verification + detailed HTML change report: every changed file, business rules, fields/no schema impact, page-operation-result, rollback, and unverified platform/API/deployment limits.

## Constraints / gates
No shared API key in app; no paid generation test yet authorized; no automatic reuse of stored operator secrets; no arbitrary deletion; no production DB migration; retain upstream AGPL identity notices; preserve /workspace/new-api/.happy-ai/; never describe tests/builds/platforms/deployment as successful without completed evidence. If public server/build access is unavailable, finish local work and report concrete blockers rather than fabricate a live download.

## Task 6 — Full-film MP4 assembly (scope amended and user said continue)
User required first-version full-film assembly, then instructed continuation after being told the remaining work. Default reviewed design: current-project timeline order, full clips, original audio retained, silent clips padded, local normalization/concat, H.264/AAC MP4, fixed 30fps, project aspect ratio; no extra subtitle/BGM/multi-track editing.
- [ ] Backend: narrow typed start/status/cancel/reveal IPC, native save dialog, immutable project/ordered clip snapshot, only controlled media files or checked HTTPS download, no arbitrary executable/shell/args. Resolve pinned bundled FFmpeg+FFprobe from a fixed application directory.
- [ ] Validate nonempty ordered clips, bounded size/count/duration, media root containment/symlinks, public-host DNS/redirect policy for downloads. ffprobe actual video duration; no reliance on estimated timeline duration. Normalize one clip at a time, black-pad correct aspect ratio, preserve/pad/trim original audio, concat normalized files in safe local list.
- [ ] Cancellation stops child process/download and deletes only job-specific temporary output; never delete source/previous output. Validate encoded output tracks/size/fps/actual summed duration and decode before successful final save. No overwrite of an existing file without separate explicit confirmation; first implementation rejects existing destination.
- [ ] UI: independently labelled full-film export next to material export; project-bound timeline store, serialize project switches, clear empty/error project timeline and global preview; snapshot at job start, project switch does not retarget active job.
- [ ] Integration tests generate synthetic clips with different sizes/frame rates, one with audio and one silent, duration not five seconds; verify order/frame colors/duration/streams, missing/corrupt input, cancellation, existing-file protection and project A→empty B→A.
- [ ] Bundling/provenance: acquire pinned platform tools, hash and license them, provide matching upstream source/build links/material; local Linux exercise is not Windows/Mac installation verification.
