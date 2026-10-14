import { expect, test, vi } from 'vitest';
const mutation = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs/promises', async () => {
 const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
 return {...actual,readFile:async (...args:Parameters<typeof actual.readFile>)=>{ const bytes=await actual.readFile(...args); if(args[0]===mutation.path) await actual.writeFile(mutation.path,'changed-after-read'); return bytes; }};
});
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageDownloads } from './stage-downloads.mjs';
test('stages matching source and alpha downloads with truthful platform states and checksums', async () => {
 const root=await mkdtemp(join(tmpdir(),'yitoken-download-stage-'));
 try {
  await mkdir(join(root,'release/source'),{recursive:true});await mkdir(join(root,'website/downloads'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.0-alpha.1'}));
  await writeFile(join(root,'website/downloads/template.html'),'@@VERSION@@ @@ARTIFACT_CARDS@@');
  const source=join(root,'release/source/yitoken-studio-0.1.0-alpha.1-source.tar.gz');await writeFile(source,'fixture-source');
  const linux=join(root,'release/YITOKEN Studio-0.1.0-alpha.1.AppImage');await writeFile(linux,'fixture-linux');
  const proof=join(root,'release/linux-unpacked/resources/DESKTOP-RESOURCE-PROVENANCE.json');
  await mkdir(join(root,'release/linux-unpacked/resources'),{recursive:true});
  await writeFile(proof,JSON.stringify({applicationVersion:'wrong-version',mediaTarget:'linux-arm64'}));
  await expect(stageDownloads(root,{source,linux})).rejects.toThrow(/version|platform/i);
  await writeFile(proof,JSON.stringify({applicationVersion:'0.1.0-alpha.1',mediaTarget:'linux-x64'}));
  mutation.path=linux;
  const result=await stageDownloads(root,{source,linux});
  const html=await readFile(join(result,'index.html'),'utf8');expect(html).toContain('0.1.0-alpha.1');expect(html).toContain('macOS');expect(html).toContain('未构建');
  const manifest=JSON.parse(await readFile(join(result,'manifest.json'),'utf8'));expect(manifest.readyForGeneralRelease).toBe(false);expect(manifest.artifacts).toHaveLength(2);
  expect(manifest.artifacts.every((item: {sha256:string})=>/^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  expect(await readFile(join(result,'assets/YITOKEN Studio-0.1.0-alpha.1.AppImage'),'utf8')).toBe('fixture-linux');
  await expect(stageDownloads(root,{source,linux})).rejects.toThrow(/exists|已有/i);
  await expect(stageDownloads(root,{source:join(root,'package.json')})).rejects.toThrow(/source|源码/i);
 }finally{mutation.path='';await rm(root,{recursive:true,force:true});}
});
