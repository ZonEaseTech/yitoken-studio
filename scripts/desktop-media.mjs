// YITOKEN changes: fail-closed, source-locked media resources for desktop packaging.
import { readFile, writeFile, mkdir, lstat, mkdtemp, rename, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { collectProductionNotices } from './production-notices.mjs';

const supportedTargets = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']);
const digest = value => createHash('sha256').update(value).digest('hex');
const validFilename = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const validVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
async function regularFile(file) {
  let stat;
  try { stat = await lstat(file); } catch { throw new Error(`Missing required packaging input: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Packaging input must be a regular file, not a symbolic link: ${file}`);
  const data = await readFile(file);
  if (!data.length) throw new Error(`Empty required packaging input: ${file}`);
  return data;
}
export function desktopMediaTarget(target, arch) {
  const platform = { mac: 'darwin', win: 'win32', linux: 'linux' }[target];
  const mediaTarget = `${platform}-${arch}`;
  if (!supportedTargets.has(mediaTarget)) throw new Error(`Unsupported source-built media target: ${target}-${arch}. Universal/other architectures require separately verified media tools.`);
  return mediaTarget;
}
export async function verifyDesktopMedia(root, target) {
  if (!supportedTargets.has(target)) throw new Error('Unsupported source-built media target');
  const lockBytes = await regularFile(join(root, 'third_party', 'media-toolchain.json'));
  const lock = JSON.parse(lockBytes.toString());
  if (!/^\d+\.\d+\.\d+$/.test(lock.ffmpegVersion) || !/^[a-f0-9]{40}$/.test(lock.x264Commit) || !/^[A-Fa-f0-9]{40}$/.test(lock.releaseSigningFingerprint)) throw new Error('Invalid locked media revisions');
  if (!Array.isArray(lock.sources) || !lock.sources.length) throw new Error('Locked media sources missing');
  const names = new Set();
  const sourceFiles = [];
  for (const entry of lock.sources) {
    if (!validFilename(entry.filename) || names.has(entry.filename) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid locked media source filename or checksum');
    names.add(entry.filename);
    const data = await regularFile(join(root, 'third_party', 'sources', entry.filename));
    if (digest(data) !== entry.sha256 || (entry.bytes !== undefined && data.length !== entry.bytes)) throw new Error(`Media source checksum mismatch: ${entry.filename}`);
    sourceFiles.push({ filename: entry.filename, data });
  }
  for (const filename of [`ffmpeg-${lock.ffmpegVersion}.tar.xz`, `ffmpeg-${lock.ffmpegVersion}.tar.xz.asc`, 'ffmpeg-devel.asc', `x264-${lock.x264Commit}.tar.gz`]) {
    if (!names.has(filename)) throw new Error(`Matching media source/signature missing from lock: ${filename}`);
  }
  const mediaDir = join(root, '.cache', 'ffmpeg', target);
  const provenanceBytes = await regularFile(join(mediaDir, 'MEDIA-PROVENANCE.json'));
  const provenance = JSON.parse(provenanceBytes.toString());
  if (provenance.target !== target || provenance.ffmpegVersion !== lock.ffmpegVersion || provenance.x264Commit !== lock.x264Commit || provenance.releaseSignatureFingerprint !== lock.releaseSigningFingerprint) throw new Error('Media provenance does not match target or locked source-built revisions; development/prebuilt tools cannot be packaged');
  const normalizeSources = sources => Array.isArray(sources) ? sources.map(entry => ({ filename: entry.filename, sha256: entry.sha256, bytes: entry.bytes, url: entry.url })).sort((a,b) => String(a.filename).localeCompare(String(b.filename))) : null;
  if (JSON.stringify(normalizeSources(provenance.sources)) !== JSON.stringify(normalizeSources(lock.sources))) throw new Error('Media provenance source hashes do not match the locked corresponding sources');
  if (typeof provenance.configuration !== 'string') throw new Error('Source-built media configuration missing');
  for (const flag of ['--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-static', '--disable-shared', '--disable-network', '--disable-devices']) {
    if (!provenance.configuration.replace(/^FFMPEG_CONFIGURATION=/m, '').split(/\s+/).includes(flag)) throw new Error(`Source-built media configuration missing: ${flag}`);
  }
  const suffix = target.startsWith('win32-') ? '.exe' : '';
  const expectedTools = ['ffmpeg', 'ffprobe'].map(tool => tool + suffix);
  if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length !== expectedTools.length || expectedTools.some(filename => provenance.artifacts.filter(artifact => artifact.filename === filename).length !== 1)) throw new Error('Media provenance must identify exactly both target tools');
  const mediaFiles = [{ filename: 'MEDIA-PROVENANCE.json', data: provenanceBytes }];
  for (const filename of expectedTools) {
    const artifact = provenance.artifacts.find(artifact => artifact.filename === filename);
    const data = await regularFile(join(mediaDir, filename));
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || digest(data) !== artifact.sha256) throw new Error(`Media binary checksum mismatch: ${filename}`);
    mediaFiles.push({ filename, data });
  }
  const licenseFiles = [];
  for (const [toolName, sourceName] of [['FFMPEG-LICENSE.txt', 'FFMPEG-GPL-3.0.txt'], ['X264-LICENSE.txt', 'X264-GPL.txt']]) {
    const toolLicense = await regularFile(join(mediaDir, toolName));
    const sourceLicense = await regularFile(join(root, 'third_party', 'licenses', sourceName));
    if (digest(toolLicense) !== digest(sourceLicense)) throw new Error(`Media license does not match corresponding source notice: ${toolName}`);
    mediaFiles.push({ filename: toolName, data: toolLicense });
    licenseFiles.push({ filename: sourceName, data: sourceLicense });
  }
  const readme = await regularFile(join(root, 'third_party', 'README.md'));
  return { target, ffmpegVersion: lock.ffmpegVersion, x264Commit: lock.x264Commit, lockBytes, lock, provenance, mediaFiles, sourceFiles, licenseFiles, readme };
}
export async function prepareDesktopResources(root, target, applicationVersion, stamp) {
  if (!validVersion(applicationVersion) || typeof stamp !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error('Invalid desktop resource version/stamp');
  // Validate before creating any release output, then snapshot the exact verified bytes.
  const media = await verifyDesktopMedia(root, target);
  const notices = await collectProductionNotices(root);
  const applicationLock = await regularFile(join(root, 'package-lock.json'));
  await mkdir(join(root, 'release'), { recursive: true });
  const bundleDir = await mkdtemp(join(root, 'release', `packaging-resources-${target}-${stamp}-`));
  const mediaDir = join(bundleDir, 'ffmpeg'), thirdPartyDir = join(bundleDir, 'third_party');
  await mkdir(mediaDir); await mkdir(join(thirdPartyDir, 'sources'), { recursive: true }); await mkdir(join(thirdPartyDir, 'licenses'));
  for (const input of media.mediaFiles) await writeFile(join(mediaDir, input.filename), input.data, { mode: input.filename.startsWith('ffmpeg') || input.filename.startsWith('ffprobe') ? 0o755 : 0o644, flag: 'wx' });
  for (const input of media.sourceFiles) await writeFile(join(thirdPartyDir, 'sources', input.filename), input.data, { flag: 'wx' });
  for (const input of media.licenseFiles) await writeFile(join(thirdPartyDir, 'licenses', input.filename), input.data, { flag: 'wx' });
  await writeFile(join(thirdPartyDir, 'media-toolchain.json'), media.lockBytes, { flag: 'wx' });
  await writeFile(join(thirdPartyDir, 'README.md'), media.readme, { flag: 'wx' });
  const noticesFile = join(bundleDir, 'THIRD-PARTY-NOTICES.txt');
  await writeFile(noticesFile, notices, { flag: 'wx' });
  const resourceProvenanceFile = join(bundleDir, 'DESKTOP-RESOURCE-PROVENANCE.json');
  await writeFile(resourceProvenanceFile, JSON.stringify({ applicationVersion, ...(target.startsWith('darwin-') ? { artifactHashScope: 'source-build-before-code-signing' } : {}), applicationLockSha256: digest(applicationLock), mediaTarget: target, ffmpegVersion: media.ffmpegVersion, x264Commit: media.x264Commit, mediaLockSha256: digest(media.lockBytes), artifacts: media.provenance.artifacts, sources: media.lock.sources, productionNoticesSha256: digest(notices), correspondingSource: 'Matching YITOKEN Studio source distribution includes third_party/sources and license/notices generators; these media source archives also accompany this application.' }, null, 2) + '\n', { flag: 'wx' });
  return { bundleDir, mediaDir, thirdPartyDir, noticesFile, resourceProvenanceFile };
}
/** Verify copied bytes, not just builder exit status or the pre-build cache. */
export async function verifyPackagedDesktopResources(staging, target, snapshot, { signedMacMedia = false } = {}) {
  if (signedMacMedia && !target.startsWith('darwin-')) throw new Error('Signed media exceptions are restricted to verified Darwin/Mac bundles');
  if (signedMacMedia) await verifyMacPreSignProof(staging, target, snapshot);
  if (!supportedTargets.has(target)) throw new Error('Unsupported packaged media target');
  const [platform, arch] = target.split('-');
  const platformName = { linux: 'linux', win32: 'win', darwin: 'mac' }[platform];
  const unpacked = join(staging, `${platformName}${arch === 'x64' ? '' : '-' + arch}${platform === 'darwin' ? '' : '-unpacked'}`);
  let resources = join(unpacked, 'resources');
  if (platform === 'darwin') {
    const applications = (await readdir(unpacked, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (applications.length !== 1) throw new Error('Packaged macOS output must contain exactly one application bundle');
    resources = join(unpacked, applications[0].name, 'Contents', 'Resources');
  }
  const directories = [
    { source: snapshot.mediaDir, destination: join(resources, 'ffmpeg') },
    { source: snapshot.thirdPartyDir, destination: join(resources, 'third_party') },
  ];
  const files = [
    { source: snapshot.noticesFile, destination: join(resources, 'THIRD-PARTY-NOTICES.txt') },
    { source: snapshot.resourceProvenanceFile, destination: join(resources, 'DESKTOP-RESOURCE-PROVENANCE.json') },
  ];
  for (const directory of directories) {
    const copied = await lstat(directory.destination).catch(() => null);
    if (!copied?.isDirectory() || copied.isSymbolicLink()) throw new Error(`Missing required packaged resources directory: ${directory.destination}; staging retained, do not distribute`);
    for (const entry of await readdir(directory.source, { withFileTypes: true })) {
      const source = join(directory.source, entry.name), destination = join(directory.destination, entry.name);
      if (entry.isDirectory()) directories.push({ source, destination });
      else if (entry.isFile()) files.push({ source, destination });
      else throw new Error(`Invalid snapshot resource: ${source}`);
    }
  }
  for (const file of files) {
    const original = await regularFile(file.source), copied = await regularFile(file.destination);
    if (signedMacMedia && ['ffmpeg', 'ffprobe'].some(tool => file.source === join(snapshot.mediaDir, tool))) {
      const cpu = target === 'darwin-arm64' ? 0x100000c : 0x1000007;
      if (copied.length < 32 || copied.readUInt32LE(0) !== 0xfeedfacf || copied.readUInt32LE(4) !== cpu || copied.readUInt32LE(12) !== 2) throw new Error(`Signed media must remain a target-architecture Mach-O executable: ${file.destination}`);
      continue; // Native signature verification is required by the caller before this opt-in.
    }
    if (digest(original) !== digest(copied)) throw new Error(`Packaged resource checksum mismatch: ${file.destination}; staging retained, do not distribute`);
  }
  return resources;
}
// This proof records exact pre-sign bytes, outside the application bundle. It is
// intentionally not a substitute for native codesign verification after signing.
async function macPreSignProofIdentity(staging, target, snapshot) {
  if (!['darwin-arm64', 'darwin-x64'].includes(target)) throw new Error('Mac pre-sign proof requires a supported Darwin target');
  const manifest = JSON.parse((await regularFile(snapshot.resourceProvenanceFile)).toString());
  if (manifest.mediaTarget !== target || manifest.artifactHashScope !== 'source-build-before-code-signing') throw new Error('Mac proof snapshot target/hash scope mismatch');
  const stagingPath = await realpath(staging);
  const unpacked = join(stagingPath, target === 'darwin-x64' ? 'mac' : 'mac-arm64');
  const apps = (await readdir(unpacked, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('Mac proof requires one application in the staging output');
  const paths = {};
  const files = [];
  for (const name of ['mediaDir', 'thirdPartyDir', 'noticesFile', 'resourceProvenanceFile']) {
    const input = snapshot[name];
    if (typeof input !== 'string') throw new Error(`Missing snapshot path for Mac proof: ${name}`);
    paths[name] = await realpath(input);
    const queue = [{ path: input, name }];
    for (const entry of queue) {
      const stat = await lstat(entry.path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const child of (await readdir(entry.path)).sort()) queue.push({ path: join(entry.path, child), name: `${entry.name}/${child}` });
      } else {
        const bytes = await regularFile(entry.path);
        files.push({ name: entry.name, sha256: digest(bytes) });
      }
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { version: 1, staging: stagingPath, target, application: await realpath(join(unpacked, apps[0].name)), snapshotPaths: paths, snapshotSha256: digest(JSON.stringify(files)) };
}
export async function writeMacPreSignProof(staging, target, snapshot) {
  await verifyPackagedDesktopResources(staging, target, snapshot);
  const proof = await macPreSignProofIdentity(staging, target, snapshot);
  await writeFile(join(proof.staging, 'MAC-PRE-SIGN-PROOF.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return proof;
}
export async function verifyMacPreSignProof(staging, target, snapshot) {
  const expected = await macPreSignProofIdentity(staging, target, snapshot);
  const bytes = await regularFile(join(expected.staging, 'MAC-PRE-SIGN-PROOF.json'));
  let proof;
  try { proof = JSON.parse(bytes.toString()); } catch { throw new Error('Invalid Mac pre-sign proof JSON'); }
  if (JSON.stringify(proof) !== JSON.stringify(expected)) throw new Error('Mac pre-sign proof does not match staging, target, application or snapshot hashes');
  return proof;
}
export async function finalizeDesktopOutput(staging, destination) {
  const stat = await lstat(staging).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Desktop staging output is missing');
  if (await lstat(destination).catch(() => null)) return staging;
  await mkdir(dirname(destination), { recursive: true });
  try { await rename(staging, destination); return destination; }
  catch { return staging; } // Never delete a previous output or a successful staging build.
}
