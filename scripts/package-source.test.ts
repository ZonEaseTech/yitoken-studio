import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSourceFiles, validateSourceVersion, packageSource } from './package-source.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('source download includes build inputs and licence but excludes generated files and local secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-package-test-')); roots.push(root);
  const files = ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'electron/main.ts', 'src/App.tsx', 'scripts/build-desktop.mjs', '.env.example', '.env', '.env.local', '.git/config', 'node_modules/secret.js', '.cache/electron.bin', 'release/installer.exe', 'out/main.js', 'dist/index.html', 'dist-electron/main.js', 'credentials.pem', '.happy-ai/session.json', '.npmrc', '.netrc', '.git-credentials', 'credentials.json', 'api-config.enc', 'storage-config.json'];
  for (const file of files) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'fixture'); }
  await expect(collectSourceFiles(root)).resolves.toEqual(['.env.example', 'LICENSE', 'README.md', 'electron/main.ts', 'package-lock.json', 'package.json', 'scripts/build-desktop.mjs', 'src/App.tsx']);
});

test('source packager cannot follow a symlink outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-package-test-')); roots.push(root);
  await writeFile(join(root, 'LICENSE'), 'fixture');
  await symlink('/etc', join(root, 'external'));
  await expect(collectSourceFiles(root)).rejects.toThrow(/symbolic link/i);
});

test('version used in the archive filename cannot escape the release directory', () => {
  expect(validateSourceVersion('0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
  for (const version of ['../secret', '0.1.0/other', '', 'latest', '1;echo unsafe']) expect(() => validateSourceVersion(version)).toThrow(/version/i);
});


test('same-version corresponding source never overwrites a different earlier archive', async () => {
  const root = await mkdtemp(join(tmpdir(),'source-release-test-')); roots.push(root);
  await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.0-alpha.1',license:'AGPL-3.0-or-later'}));
  for(const file of ['package-lock.json','LICENSE','README.md','scripts/build-desktop.mjs']) await writeFile(join(root,file),'fixture');
  const archive = await packageSource(root); const original = await readFile(archive);
  expect(await packageSource(root)).toBe(archive);
  expect(await readFile(archive)).toEqual(original);
  await writeFile(join(root,'README.md'),'different-source');
  await expect(packageSource(root)).rejects.toThrow(/existing|version|已有/i);
  expect(await readFile(archive)).toEqual(original);
},30_000);
