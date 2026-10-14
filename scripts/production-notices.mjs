// YITOKEN changes: retain original notices for the installed production dependency tree.
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const approvedException = {
  key: 'react-remove-scroll-bar@2.3.8',
  packageManifestSha256: 'e372f857ce05f266137c65293436b5380fec42ac311e6acb9378ed78b98d75d0',
  readmeSha256: '486442209236ffa3893312e508694699a6b8834d30a2f9c083c1f3379983e4f9',
  npmIntegrity: 'sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==',
};

async function regularBytes(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`License evidence must be a regular file: ${file}`);
  return readFile(file);
}

async function originalNotices(directory, prefix = '', licenseDirectory = false) {
  const texts = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const notice = /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name);
    const noticesDirectory = /^(?:licenses|licences|notices)$/i.test(entry.name);
    if (entry.isSymbolicLink()) {
      if (notice || noticesDirectory || licenseDirectory) throw new Error(`Symbolic dependency license/notice is not allowed: ${path}`);
      continue;
    }
    if (entry.isDirectory()) texts.push(...await originalNotices(directory, path, licenseDirectory || noticesDirectory));
    else if (entry.isFile() && (notice || licenseDirectory)) texts.push({ path, content: (await regularBytes(join(directory, path))).toString('utf8') });
  }
  return texts;
}


const packageName = value => typeof value === 'string' && /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(value);
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function collectProductionNotices(root) {
  const application = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  if (!lock.packages || lock.lockfileVersion < 2) throw new Error('Production license collection requires the locked installed dependency tree');
  const supplementsDirectory = join(root, 'third_party', 'dependency-licenses');
  const supplementsFile = join(supplementsDirectory, 'lock.json');
  const supplements = await lstat(supplementsFile).catch(() => null) ? JSON.parse((await regularBytes(supplementsFile)).toString('utf8')) : { packages: {} };
  const rootReal = await realpath(root), visited = new Set(), packages = [], missingLicenses = [];
  const pending = [];
  for (const name of Object.keys(application.dependencies || {})) pending.push({ name, parent: root, optional: false });
  for (const name of Object.keys(application.optionalDependencies || {})) pending.push({ name, parent: root, optional: true });
  while (pending.length) {
    const { name, parent, optional } = pending.shift();
    if (!packageName(name)) throw new Error('Invalid production dependency name');
    let current = parent, directory;
    while (true) {
      const candidate = join(current, 'node_modules', name);
      if (await lstat(join(candidate, 'package.json')).catch(() => null)) { directory = candidate; break; }
      if (current === root) break;
      const next = dirname(current);
      if (next === current || relative(root, next).startsWith('..')) break;
      current = next;
    }
    if (!directory) { if (optional) continue; throw new Error(`Missing installed production dependency: ${name}`); }
    const actualDirectory = await realpath(directory);
    const boundary = relative(rootReal, actualDirectory);
    if (boundary === '..' || boundary.startsWith('../') || boundary.startsWith('..\\') || isAbsolute(boundary)) throw new Error(`Symbolic dependency directory escapes the source tree: ${name}`);
    if (visited.has(actualDirectory)) continue;
    visited.add(actualDirectory);
    const manifest = await json(join(directory, 'package.json'));
    const lockKey = relative(root, directory).split('\\').join('/');
    if (!packageName(manifest.name) || typeof manifest.version !== 'string' || lock.packages[lockKey]?.version !== manifest.version) throw new Error(`Installed production dependency version does not match lock: ${name}`);
    const key = `${manifest.name}@${manifest.version}`;
    const texts = await originalNotices(directory);
    const supplement = supplements.packages?.[key];
    let exception;
    if (supplement?.exception) {
      if (key !== approvedException.key || Object.entries(approvedException).some(([field, expected]) => field !== 'key' && supplement[field] !== expected)) throw new Error(`Unapproved missing-license exception evidence: ${key}`);
      const manifestBytes = await regularBytes(join(directory, 'package.json'));
      const readmeBytes = await regularBytes(join(directory, 'README.md'));
      if (sha256(manifestBytes) !== approvedException.packageManifestSha256 || sha256(readmeBytes) !== approvedException.readmeSha256 || lock.packages[lockKey].integrity !== approvedException.npmIntegrity || manifest.license !== 'MIT' || supplement.originalLicenseChapter !== '# License\nMIT\n' || !readmeBytes.toString('utf8').endsWith(supplement.originalLicenseChapter)) throw new Error(`Missing-license exception metadata/README evidence mismatch: ${key}`);
      exception = supplement.exception;
    }
    for (const source of supplement?.texts || []) {
      if (!/^[a-zA-Z0-9._-]+$/.test(source.filename) || !/^[a-f0-9]{64}$/.test(source.sha256) || !/^https:\/\//.test(source.sourceUrl || '')) throw new Error(`Invalid cached license metadata: ${key}`);
      const bytes = await regularBytes(join(supplementsDirectory, source.filename));
      if (sha256(bytes) !== source.sha256) throw new Error(`Cached upstream license SHA256 mismatch: ${key}/${source.filename}`);
      texts.push({ path: `cached-upstream/${source.filename}`, content: bytes.toString('utf8'), source });
    }
    if (!texts.some(text => text.content.trim() && (/^(?:licen[sc]e|copying)(?:[._-][^/]*)?$/i.test(text.path) || /^(?:licenses|licences)\//i.test(text.path) || text.source && !text.source.kind)) && !exception) missingLicenses.push(key);
    packages.push({ name: manifest.name, version: manifest.version, lockKey, license: manifest.license, author: manifest.author, repository: manifest.repository, exception, evidence: exception ? approvedException : undefined, texts });
    for (const dependency of Object.keys(manifest.dependencies || {})) pending.push({ name: dependency, parent: directory, optional: Object.hasOwn(manifest.optionalDependencies || {}, dependency) });
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) pending.push({ name: dependency, parent: directory, optional: true });
    for (const dependency of Object.keys(manifest.peerDependencies || {})) pending.push({ name: dependency, parent: directory, optional: manifest.peerDependenciesMeta?.[dependency]?.optional === true });
  }
  if (missingLicenses.length) throw new Error(`Original license text missing for production dependencies: ${missingLicenses.sort().join(', ')}; do not invent replacement licenses`);
  packages.sort((a,b) => a.lockKey.localeCompare(b.lockKey));
  let output = 'YITOKEN Studio — Third-party production dependency licenses and notices\n';
  output += 'Original upstream texts are labelled below; any SPDX reference text is explicitly marked as a reference rather than an upstream copyright notice. This collection does not certify patent clearance or provide a separate commercial license. Electron LICENSE / LICENSES.chromium.html are retained in the Electron distribution.\n';
  for (const item of packages) {
    output += `\n${'='.repeat(72)}\n${item.name}@${item.version}\nInstalled package: ${item.lockKey}\nDeclared license: ${typeof item.license === 'string' ? item.license : JSON.stringify(item.license || 'unspecified')}\n`;
    if (item.exception) output += `Prerelease-only exception: ${item.exception}\nOriginal package author: ${JSON.stringify(item.author)}\nOriginal repository: ${JSON.stringify(item.repository)}\nExact npm/evidence hashes: ${JSON.stringify(item.evidence)}\n`;
    for (const text of item.texts.sort((a,b) => a.path.localeCompare(b.path))) {
      output += `\n--- ${text.path} ---\n`;
      if (text.source) output += `Source: ${text.source.sourceUrl}\nRevision: ${text.source.sourceRevision || 'exact npm version above'}\nSHA256: ${text.source.sha256}\nText kind: ${text.source.kind || 'original upstream license text'}\n`;
      output += `${text.content.trimEnd()}\n`;
    }
  }
  return output;
}
