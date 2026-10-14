import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyMediaSources, mediaTarget } from './build-media-toolchain.mjs';

test('media toolchain verifies source checksums before executing build tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-source-check-'));
  try {
    await writeFile(join(root, 'source.tar.xz'), 'known-source');
    const lock = { sources: [{filename:'source.tar.xz',sha256:createHash('sha256').update('known-source').digest('hex')}] };
    await expect(verifyMediaSources(root,lock)).resolves.toBeUndefined();
    await writeFile(join(root,'source.tar.xz'),'tampered-source');
    await expect(verifyMediaSources(root,lock)).rejects.toThrow(/checksum/i);
    await expect(verifyMediaSources(root,{sources:[{filename:'../secret',sha256:'no'}]})).rejects.toThrow(/filename/i);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('release tools only target supported explicit platform architectures', () => {
  expect(mediaTarget('linux','x64')).toBe('linux-x64');
  expect(mediaTarget('darwin','arm64')).toBe('darwin-arm64');
  expect(mediaTarget('win32','x64')).toBe('win32-x64');
  expect(() => mediaTarget('win32','arm64')).toThrow(/unsupported/i);
  expect(() => mediaTarget('../evil','x64')).toThrow(/unsupported/i);
});
