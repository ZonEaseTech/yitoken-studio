// SPDX-License-Identifier: AGPL-3.0-or-later
// Signing is a build-time trust boundary, not a Gatekeeper bypass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const MAC_SIGNING_PIPELINE_VERSION = 1;
export async function prepareMacSigning({ environment = process.env, root = process.cwd() } = {}) {
  const mode = environment.YITOKEN_MAC_SIGNING_MODE ?? 'adhoc';
  if (!['adhoc', 'developer-id'].includes(mode)) throw new Error('Unsupported Mac signing mode');
  const clean = { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const name of Object.keys(clean)) if (/^(CSC_|WIN_CSC_|APPLE_|MAC_CERTIFICATE_)/.test(name)) delete clean[name];
  clean.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const builderArgs = ['-c.forceCodeSigning=true', '-c.mac.strictVerify=true', '-c.afterPack=' + resolve(root, 'scripts/verify-mac-resources.mjs'), '-c.dmg.writeUpdateInfo=false'];
  if (mode === 'adhoc') return { mode, teamId: null, environment: clean, builderArgs: [...builderArgs, '-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false', '-c.dmg.sign=false'] };
  const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  for (const name of required) if (typeof environment[name] !== 'string' || !environment[name].trim()) throw new Error('Developer ID signing requires ' + name);
  const teamId = environment.APPLE_TEAM_ID;
  const identity = environment.CSC_NAME.replace(/^Developer ID Application:\s*/, '').trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !identity.endsWith('(' + teamId + ')') || /[\x00-\x1f]/.test(identity) || identity === '-') throw new Error('Signing identity must match the explicit Apple Team ID');
  if (!/^[A-Z0-9]{10}$/.test(environment.APPLE_API_KEY_ID) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environment.APPLE_API_ISSUER)) throw new Error('Invalid APPLE_API_KEY_ID or APPLE_API_ISSUER');
  for (const name of ['CSC_LINK', 'APPLE_API_KEY']) {
    const path = environment[name];
    if (!isAbsolute(path)) throw new Error(name + ' must be an absolute local credential file');
    const file = await lstat(path).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new Error(name + ' must be a private regular local file (mode 0600)');
  }
  for (const name of required) clean[name] = environment[name];
  clean.CSC_NAME = identity;
  return { mode, teamId, environment: clean, builderArgs: [...builderArgs, '-c.mac.identity=' + identity, '-c.mac.hardenedRuntime=true', '-c.mac.notarize=true', '-c.mac.entitlements=' + resolve(root, 'build/entitlements.mac.plist'), '-c.mac.entitlementsInherit=' + resolve(root, 'build/entitlements.mac.plist'), '-c.dmg.sign=true'] };
}

function executeNative(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error('Mac verification command could not complete: ' + command);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
async function checked(execute, command, args, purpose) {
  const result = await execute(command, args);
  if (result.status !== 0) throw new Error(purpose + ' failed; candidate retained, do not publish. ' + (result.stderr || result.stdout || '').slice(0, 2000));
  return result.stdout + '\n' + result.stderr;
}
async function bundleTree(root) {
  const result = {};
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry), relative = prefix ? prefix + '/' + entry : entry, stat = await lstat(path);
      if (stat.isSymbolicLink()) result[relative] = ['link', await readlink(path)];
      else if (stat.isDirectory()) await walk(path, relative);
      else if (stat.isFile()) result[relative] = ['file', createHash('sha256').update(await readFile(path)).digest('hex'), stat.mode & 0o777];
      else throw new Error('Unsupported special file in Mac application');
    }
  }
  await walk(root, '');
  return result;
}
async function assertSameBundle(original, copy) {
  const actual = await bundleTree(copy);
  if (JSON.stringify(Object.entries(original).sort()) !== JSON.stringify(Object.entries(actual).sort())) throw new Error('Final installer application differs from the verified signed bundle');
}
export async function verifyMacSigningOutput({ staging, target, profile, execute = executeNative }) {
  if (!['darwin-arm64', 'darwin-x64'].includes(target) || !['adhoc', 'developer-id'].includes(profile.mode)) throw new Error('Invalid Mac signing verification target or mode');
  const unpacked = join(staging, target === 'darwin-arm64' ? 'mac-arm64' : 'mac');
  const apps = (await readdir(unpacked, { withFileTypes: true })).filter(e => e.isDirectory() && e.name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('Signature verification requires exactly one Mac application');
  const app = join(unpacked, apps[0].name);
  await checked(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', app], 'Bundle signature verification');
  const seal = await lstat(join(app, 'Contents/_CodeSignature/CodeResources')).catch(() => null);
  if (!seal?.isFile() || seal.isSymbolicLink() || seal.size === 0) throw new Error('Bundle signature is missing the resource seal');
  const description = await checked(execute, '/usr/bin/codesign', ['-d', '--verbose=4', app], 'Bundle signature display');
  if (/Info\.plist=not bound|Sealed Resources=none/.test(description) || !/^Identifier=cn\.com\.yitoken\.studio$/m.test(description)) throw new Error('Bundle signature does not bind the expected application');
  if (profile.mode === 'developer-id') {
    if (!/^[A-Z0-9]{10}$/.test(profile.teamId || '') || !description.includes('TeamIdentifier=' + profile.teamId + '\n') || !/^Authority=Developer ID Application:/m.test(description)) throw new Error('Signed bundle has the wrong Developer ID Team');
    if (!/flags=.*\bruntime\b/.test(description)) throw new Error('Developer ID release must use Hardened Runtime');
  } else if (!/^Signature=adhoc$/m.test(description)) throw new Error('Local Mac build must have a complete ad-hoc signature');
  const mediaArtifacts = [];
  for (const filename of ['ffmpeg', 'ffprobe']) {
    const tool = join(app, 'Contents/Resources/ffmpeg', filename);
    const stat = await lstat(tool);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Signed media must remain regular files');
    await checked(execute, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', tool], 'Media signature verification');
    if (profile.mode === 'developer-id') {
      const toolSignature = await checked(execute, '/usr/bin/codesign', ['-d', '--verbose=4', tool], 'Media signature display');
      if (!toolSignature.includes('TeamIdentifier=' + profile.teamId + '\n') || !/^Authority=Developer ID Application:/m.test(toolSignature)) throw new Error('Signed media has the wrong Developer ID Team');
    }
    mediaArtifacts.push({ filename, sha256: createHash('sha256').update(await readFile(tool)).digest('hex') });
  }
  if (profile.mode === 'developer-id') {
    await checked(execute, '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'Gatekeeper acceptance');
    await checked(execute, '/usr/bin/xcrun', ['stapler', 'validate', app], 'Application notarization ticket verification');
  }
  const files = (await readdir(staging, { withFileTypes: true })).filter(e => e.isFile());
  const dmgs = files.filter(e => e.name.endsWith('.dmg')), zips = files.filter(e => e.name.endsWith('.zip'));
  if (dmgs.length !== 1 || zips.length !== 1) throw new Error('Mac signature verification requires one final DMG and one ZIP');
  const dmg = join(staging, dmgs[0].name), zip = join(staging, zips[0].name);
  if (profile.mode === 'developer-id') {
    await checked(execute, '/usr/bin/codesign', ['--verify', '--verbose=2', dmg], 'DMG signature verification');
    const auth = profile.environment || {};
    for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) if (!auth[name]) throw new Error('Final DMG notarization requires ' + name);
    const result = await execute('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--key', auth.APPLE_API_KEY, '--key-id', auth.APPLE_API_KEY_ID, '--issuer', auth.APPLE_API_ISSUER, '--wait', '--output-format', 'json']);
    if (result.status !== 0) throw new Error('DMG notarization did not complete; check Apple submission status before retrying');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error('DMG notarization returned invalid status data'); }
    if (response.status !== 'Accepted') throw new Error('Apple did not accept DMG notarization; do not publish');
    await checked(execute, '/usr/bin/xcrun', ['stapler', 'staple', dmg], 'DMG notarization ticket attachment');
    await checked(execute, '/usr/bin/xcrun', ['stapler', 'validate', dmg], 'DMG notarization ticket verification');
    await checked(execute, '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], 'DMG Gatekeeper acceptance');
  }
  await checked(execute, '/usr/bin/hdiutil', ['verify', dmg], 'DMG container verification');
  const original = await bundleTree(app);
  const scratch = await mkdtemp(join(tmpdir(), 'yitoken-mac-final-verify-'));
  const mount = join(scratch, 'mount'), expanded = join(scratch, 'zip');
  await mkdir(mount); await mkdir(expanded);
  let mounted = false;
  try {
    await checked(execute, '/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], 'Read-only DMG attachment');
    mounted = true;
    await assertSameBundle(original, join(mount, apps[0].name));
    await checked(execute, '/usr/bin/ditto', ['-x', '-k', zip, expanded], 'Final ZIP expansion');
    const expandedEntries = await readdir(expanded, { withFileTypes: true });
    if (expandedEntries.length !== 1 || expandedEntries[0].name !== apps[0].name || !expandedEntries[0].isDirectory()) throw new Error('ZIP must contain only the expected application');
    await assertSameBundle(original, join(expanded, apps[0].name));
  } finally {
    if (mounted) await checked(execute, '/usr/bin/hdiutil', ['detach', mount], 'Audit disk-image detach');
    await rm(scratch, { recursive: true, force: true });
  }
  return { schemaVersion: 1, mode: profile.mode, signatureVerified: true, gatekeeperAccepted: profile.mode === 'developer-id', notarized: profile.mode === 'developer-id', teamId: profile.teamId, mediaArtifacts, artifactHashScope: 'after-mac-code-signing', verificationScope: 'unpacked-app-and-final-dmg-zip' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(' ') !== '--preflight') throw new Error('Usage: node scripts/mac-signing.mjs --preflight');
    const profile = await prepareMacSigning();
    console.log(JSON.stringify({ mode: profile.mode, ready: true, teamId: profile.teamId }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
