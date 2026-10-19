import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'yitoken-release-policy-')); temporary.push(root); return root; }
function embeddedScript(step: string, delimiter: string) {
  const start = workflow.indexOf(`- name: ${step}`);
  const script = workflow.slice(start).split(`<<'${delimiter}'\n`)[1]?.split(`\n          ${delimiter}\n`)[0];
  if (start < 0 || !script) throw new Error(`Missing workflow script: ${step}`);
  return script.replace(/^          /gm, '');
}
const identity = embeddedScript('Require exact version tag and freeze commit identity', 'NODE');
const publish = embeddedScript('Verify every platform manifest and generate aggregate SHA256', 'PY');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function validateFixture(version = '0.1.0-alpha.2') {
  const root = fixture(); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'scripts/mac-signing.mjs'), 'export const MAC_SIGNING_PIPELINE_VERSION=1; export function prepareMacSigning(){}');
  writeFileSync(join(root, 'scripts/build-desktop.mjs'), 'prepareMacSigning; verifyMacSigningOutput;');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic policy fixture'], ['tag', `v${version}`]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, env: { SOURCE_REF: `v${version}`, REQUEST_PUBLISH: 'true', MAC_SIGNING_MODE: 'adhoc', ALLOW_ADHOC_PRERELEASE: 'false', RELEASE_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: join(root, 'output') } };
}
function runIdentity(version: string, changes: Record<string, string>) {
  const { root, env } = validateFixture(version);
  return spawnSync(process.execPath, ['--input-type=module'], { cwd: root, input: identity, env: { ...process.env, ...env, ...changes }, encoding: 'utf8' });
}

test.each([
  ['default ad-hoc publication denied', '0.1.0-alpha.2', {}, false],
  ['explicit alpha2 ad-hoc publication allowed', '0.1.0-alpha.2', { ALLOW_ADHOC_PRERELEASE: 'true' }, true],
  ['stable ad-hoc publication denied', '0.1.0', { ALLOW_ADHOC_PRERELEASE: 'true' }, false],
  ['frozen alpha1 publication denied', '0.1.0-alpha.1', { ALLOW_ADHOC_PRERELEASE: 'true' }, false],
  ['push cannot publish even with override', '0.1.0-alpha.2', { ALLOW_ADHOC_PRERELEASE: 'true', RELEASE_EVENT_NAME: 'push' }, false],
  ['Developer ID publication remains available', '0.1.0-alpha.2', { MAC_SIGNING_MODE: 'developer-id' }, true],
  ['ad-hoc build-only remains available', '0.1.0-alpha.2', { REQUEST_PUBLISH: 'false' }, true],
] as const)('%s', (_label, version, changes, accepted) => {
  const result = runIdentity(version, changes as Record<string, string>);
  expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
}, 15_000);

function publicationFixture(mode: 'adhoc' | 'developer-id', version = '0.1.0-alpha.2') {
  const root = fixture(), source = `yitoken-studio-${version}-source.tar.gz`, sourceDir = join(root, 'assets/release-source');
  mkdirSync(sourceDir, { recursive: true }); writeFileSync(join(sourceDir, source), 'synthetic source');
  writeFileSync(join(sourceDir, source + '.sha256'), `${hash('synthetic source')}  ${source}\n`);
  const manifests: Record<string, Record<string, any>> = {};
  for (const [platform, arch, suffixes] of [['win', 'x64', ['.exe']], ['linux', 'x64', ['.AppImage']], ['mac', 'arm64', ['.dmg', '.zip']], ['mac', 'x64', ['.dmg', '.zip']]] as const) {
    const directory = join(root, `assets/release-${platform}-${arch}`); mkdirSync(directory);
    const assets = suffixes.map(ext => { const filename = `fixture-${platform}-${arch}${ext}`; writeFileSync(join(directory, filename), filename); return { filename, sha256: hash(filename) }; });
    const developerId = mode === 'developer-id';
    const data: Record<string, any> = { version, sourceTag: `v${version}`, sourceCommit: 'a'.repeat(40), platform, arch, sourceArchive: source, unsigned: platform !== 'mac' || !developerId, notarized: platform === 'mac' && developerId, assets, resources: { artifactHashScope: 'source-build-before-code-signing' } };
    if (platform === 'mac') data.macSigning = { schemaVersion: 1, mode, signatureVerified: true, notarized: developerId, gatekeeperAccepted: developerId, teamId: developerId ? 'TEAM123456' : null, artifactHashScope: 'after-mac-code-signing', verificationScope: 'unpacked-app-and-final-dmg-zip', mediaArtifacts: ['ffmpeg', 'ffprobe'].map(filename => ({ filename, sha256: hash(filename) })) };
    manifests[`${platform}-${arch}`] = data;
  }
  return { root, manifests, env: { VERSION: version, SOURCE_TAG: `v${version}`, SOURCE_COMMIT: 'a'.repeat(40), MAC_SIGNING_MODE: mode, ALLOW_ADHOC_PRERELEASE: 'true', RELEASE_EVENT_NAME: 'workflow_dispatch' } };
}
function runPublish(mode: 'adhoc' | 'developer-id', change?: (data: Record<string, Record<string, any>>, env: Record<string, string>) => void, version?: string) {
  const { root, manifests, env } = publicationFixture(mode, version); change?.(manifests, env);
  for (const [identity, data] of Object.entries(manifests)) writeFileSync(join(root, `assets/release-${identity}/BUILD-PROVENANCE-${identity}.json`), JSON.stringify(data));
  return spawnSync('python3', ['-c', publish], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
}
test.each([
  ['explicit ad-hoc alpha2 proof accepted', 'adhoc', undefined, undefined, true],
  ['default ad-hoc proof denied', 'adhoc', (_d: any, e: any) => { e.ALLOW_ADHOC_PRERELEASE = 'false'; }, undefined, false],
  ['stable ad-hoc proof denied', 'adhoc', undefined, '0.1.0', false],
  ['frozen alpha1 proof denied', 'adhoc', undefined, '0.1.0-alpha.1', false],
  ['mixed architecture mode denied', 'adhoc', (d: any) => { d['mac-x64'].macSigning.mode = 'developer-id'; }, undefined, false],
  ['ad-hoc false notarization claim denied', 'adhoc', (d: any) => { d['mac-arm64'].macSigning.notarized = true; }, undefined, false],
  ['ad-hoc missing null team denied', 'adhoc', (d: any) => { delete d['mac-x64'].macSigning.teamId; }, undefined, false],
  ['ad-hoc false Gatekeeper claim denied', 'adhoc', (d: any) => { d['mac-x64'].macSigning.gatekeeperAccepted = true; }, undefined, false],
  ['ad-hoc false top-level trust claim denied', 'adhoc', (d: any) => { d['mac-arm64'].unsigned = false; }, undefined, false],
  ['publisher rejects push event', 'adhoc', (_d: any, e: any) => { e.RELEASE_EVENT_NAME = 'push'; }, undefined, false],
  ['ad-hoc fake trusted team denied', 'adhoc', (d: any) => { d['mac-x64'].macSigning.teamId = 'TEAM123456'; }, undefined, false],
  ['Developer ID verified proof accepted', 'developer-id', undefined, undefined, true],
  ['Developer ID cannot downgrade proof', 'developer-id', (d: any) => { d['mac-x64'].macSigning.mode = 'adhoc'; }, undefined, false],
  ['Developer ID without Gatekeeper denied', 'developer-id', (d: any) => { d['mac-x64'].macSigning.gatekeeperAccepted = false; }, undefined, false],
  ['Developer ID without notarization denied', 'developer-id', (d: any) => { d['mac-arm64'].macSigning.notarized = false; }, undefined, false],
  ['Developer ID teams must match', 'developer-id', (d: any) => { d['mac-x64'].macSigning.teamId = 'OTHER12345'; }, undefined, false],
] as const)('%s', (_label, mode, change, version, accepted) => {
  const result = runPublish(mode, change, version);
  expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
}, 15_000);

test('tag pushes are ad-hoc build-only and publication override defaults false', () => {
  expect(workflow).toContain("REQUEST_PUBLISH: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}");
  expect(workflow).toContain("MAC_SIGNING_MODE: ${{ github.event_name == 'push' && 'adhoc' || inputs.mac_signing_mode }}");
  expect(workflow).toMatch(/allow_adhoc_prerelease:\n(?:        [^\n]*\n)*?        default: false/);
});
