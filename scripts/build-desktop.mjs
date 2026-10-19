// YITOKEN changes: verify source-built media and notices before any desktop build.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopMediaTarget, prepareDesktopResources, verifyPackagedDesktopResources, verifyMacPreSignProof, finalizeDesktopOutput } from './desktop-media.mjs';

import { prepareMacSigning, verifyMacSigningOutput } from './mac-signing.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function localCli(root, dependency, command) {
  const directory = join(root, 'node_modules', dependency);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8').catch(() => { throw new Error(`Locked build dependency ${dependency} is missing; run npm ci, not an unpinned npx download`); }));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command];
  if (typeof bin !== 'string') throw new Error(`Local CLI missing: ${command}`);
  const entry = resolve(directory, bin), boundary = relative(directory, entry);
  if (boundary.startsWith('..') || isAbsolute(boundary) || !(await lstat(entry).catch(() => null))?.isFile()) throw new Error(`Invalid locked local CLI: ${command}`);
  return entry;
}
function run(command, args, environment, root) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Desktop build command failed (${result.status ?? result.error?.message}); any staging output has been retained`);
}
export async function buildDesktop({ root = projectRoot, args = process.argv.slice(2), platform = process.platform, arch = process.arch, stamp = new Date().toISOString().replace(/[-:.TZ]/g, ''), environment = process.env, run: runner = run } = {}) {
  const platforms = new Set(['linux', 'win', 'mac']);
  const arches = new Set(['x64', 'arm64', 'universal', 'ia32', 'armv7l']);
  const parsed = args.map(value => value.replace(/^--/, ''));
  if (parsed.some(value => !platforms.has(value) && !arches.has(value))) throw new Error('Unsupported desktop arguments; choose a platform and a verified architecture');
  const requestedTargets = [...new Set(parsed.filter(value => platforms.has(value)))];
  if (requestedTargets.length > 1) throw new Error('Build one explicit desktop platform per invocation');
  const target = requestedTargets[0] || { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
  if (target === 'mac' && platform !== 'darwin') throw new Error('Mac signing and package verification require a native macOS build host');
  const macSigning = target === 'mac' ? await prepareMacSigning({ root, environment }) : null;
  const requestedArchs = [...new Set(parsed.filter(value => arches.has(value)))];
  const buildArchs = requestedArchs.length ? requestedArchs : [arch];
  const mediaTargets = buildArchs.map(value => desktopMediaTarget(target, value));
  const application = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const resources = [];
  // Every requested target must pass preflight before the first build command runs.
  for (const mediaTarget of mediaTargets) resources.push(await prepareDesktopResources(root, mediaTarget, application.version, stamp));
  const viteCli = await localCli(root, 'electron-vite', 'electron-vite');
  const builderCli = await localCli(root, 'electron-builder', 'electron-builder');
  const cache = join(root, '.cache'), release = join(root, 'release');
  const env = { ...(macSigning?.environment || environment), TEMP: join(cache, 'tmp'), TMP: join(cache, 'tmp'), ELECTRON_CACHE: join(cache, 'electron'), ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'), CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  if (!macSigning) for (const name of Object.keys(env)) if (/^(CSC_|WIN_CSC_|APPLE_|MAC_CERTIFICATE_)/.test(name)) delete env[name];
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const directory of [env.TEMP, env.ELECTRON_CACHE, env.ELECTRON_BUILDER_CACHE]) await mkdir(directory, { recursive: true });
  const logo = await lstat(join(root, 'build', 'yitoken-logo.svg')).catch(() => null);
  const requiredIcons = ['icon.png', 'icon.ico', ...(target === 'mac' ? ['icon.icns'] : [])];
  if (logo && (await Promise.all(requiredIcons.map(name => lstat(join(root, 'build', name)).catch(() => null)))).some(value => !value)) await runner(process.execPath, [join(root, 'scripts', 'generate-brand-icons.mjs')], env, root);
  await runner(process.execPath, [viteCli, 'build'], env, root);
  const outputs = [];
  for (let index = 0; index < buildArchs.length; index++) {
    const buildArch = buildArchs[index], snapshot = resources[index];
    const staging = await mkdtemp(join(release, `build-staging-${target}-${buildArch}-${stamp}-`));
    const suffix = staging.slice(staging.lastIndexOf('-') + 1);
    const destination = join(release, 'build', application.version, `${target}-${buildArch}-${stamp}-${suffix}`);
    const resourceEnvironment = { ...env, YITOKEN_VERIFIED_MEDIA_DIR: relative(root, snapshot.mediaDir), YITOKEN_VERIFIED_THIRD_PARTY_DIR: relative(root, snapshot.thirdPartyDir), YITOKEN_THIRD_PARTY_NOTICES: relative(root, snapshot.noticesFile), YITOKEN_DESKTOP_RESOURCE_PROVENANCE: relative(root, snapshot.resourceProvenanceFile) };
    if (macSigning) Object.assign(resourceEnvironment, {
      YITOKEN_DESKTOP_STAGING_DIR: staging,
      YITOKEN_DESKTOP_MEDIA_TARGET: mediaTargets[index],
      YITOKEN_MAC_PRE_SIGN_PROOF: join(staging, 'MAC-PRE-SIGN-PROOF.json'),
    });
    await runner(process.execPath, [builderCli, `--${target}`, `--${buildArch}`, `-c.directories.output=${staging}`, '--publish', 'never', ...(macSigning?.builderArgs || [])], resourceEnvironment, root);
    if (macSigning) {
      await verifyMacPreSignProof(staging, mediaTargets[index], snapshot);
      // Native signature and final-distribution checks precede the narrow signed-media exception.
      const signingProof = await verifyMacSigningOutput({ staging, target: mediaTargets[index], profile: macSigning });
      await verifyPackagedDesktopResources(staging, mediaTargets[index], snapshot, { signedMacMedia: true });
      await writeFile(join(staging, 'MAC-SIGNING-PROVENANCE.json'), JSON.stringify(signingProof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } else {
      // Builder exit zero is not evidence that required resources were copied.
      await verifyPackagedDesktopResources(staging, mediaTargets[index], snapshot);
    }
    const output = await finalizeDesktopOutput(staging, destination);
    outputs.push(output);
    console.log(`${macSigning ? macSigning.mode + " verified Mac" : "Unsigned desktop"} artifacts retained at ${output}`);
  }
  return outputs;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildDesktop(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
