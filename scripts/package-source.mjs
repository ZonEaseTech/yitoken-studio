// YITOKEN changes: corresponding-source packaging for the AGPL desktop derivative.
import { readdir, readFile, writeFile, mkdir, mkdtemp, copyFile, rm, link, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const excludedPrivateFiles = new Set(['.npmrc','.netrc','.git-credentials','credentials.json','secrets.json','api-config.enc','api-config.json','storage-config.json']);
const excludedDirectories = new Set(['.ssh','.aws','.gnupg','.git', 'node_modules', '.cache', 'release', 'out', 'dist', 'dist-electron', '.happy-ai', '.worktrees']);

export function validateSourceVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid source version');
  return version;
}

export async function collectSourceFiles(root) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = entry.name;
      const path = relative ? `${relative}/${name}` : name;
      if (excludedPrivateFiles.has(name.toLowerCase()) || excludedDirectories.has(name) || (name.startsWith('.env') && name !== '.env.example') || /\.(pem|key|p12|pfx|log)$/i.test(name) || name === '.DS_Store' || name === 'SOURCE_PROVENANCE.json') continue;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in corresponding-source archive: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit('');
  return files.sort();
}

export async function packageSource(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = validateSourceVersion(manifest.version);
  const files = await collectSourceFiles(root);
  for (const required of ['LICENSE', 'package.json', 'package-lock.json', 'README.md', 'scripts/build-desktop.mjs']) {
    if (!files.includes(required)) throw new Error(`Missing corresponding-source build input: ${required}`);
  }
  const prefix = `yitoken-studio-${version}-source`;
  const releaseDir = join(root, 'release', 'source');
  const staging = await mkdtemp(join(tmpdir(), 'yitoken-corresponding-source-'));
  let archiveStaging;
  try {
    const hashes = {};
    for (const path of files) {
      const target = join(staging, prefix, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, path), target);
      hashes[path] = createHash('sha256').update(await readFile(target)).digest('hex');
    }
    const provenance = { product: 'YITOKEN Studio', version, license: manifest.license, upstream: manifest.upstream, files: hashes };
    await writeFile(join(staging, prefix, 'SOURCE_PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
    await mkdir(releaseDir, { recursive: true });
    const archive = join(releaseDir, `${prefix}.tar.gz`);
    archiveStaging = await mkdtemp(join(releaseDir, '.source-archive-'));
    const candidate = join(archiveStaging, `${prefix}.tar.gz`);
    const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--use-compress-program=gzip -n', '-cf', candidate, '-C', staging, prefix], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Corresponding-source tar creation failed');
    const bytes = await readFile(candidate);
    const hash = createHash('sha256').update(bytes).digest('hex');
    try { await link(candidate, archive); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await lstat(archive);
      if (!old.isFile() || old.isSymbolicLink() || !bytes.equals(await readFile(archive))) throw new Error('An existing source archive has different bytes; bump the application version rather than overwrite it');
    }
    const checksum = `${hash}  ${basename(archive)}\n`;
    try { await writeFile(`${archive}.sha256`, checksum, {flag:'wx'}); } catch(error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await lstat(`${archive}.sha256`);
      if (!old.isFile() || old.isSymbolicLink() || await readFile(`${archive}.sha256`,'utf8') !== checksum) throw new Error('Existing source checksum differs; it has been preserved');
    }
    console.log(`Corresponding source: ${archive}\nSHA256: ${hash}\nIncluded source files: ${files.length}`);
    return archive;
  } finally {
    if (archiveStaging) await rm(archiveStaging, {recursive:true,force:true});
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageSource(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
