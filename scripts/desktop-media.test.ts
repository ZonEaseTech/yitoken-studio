import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, cp } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyDesktopMedia, prepareDesktopResources, finalizeDesktopOutput, desktopMediaTarget } from './desktop-media.mjs';

const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function fixture(target='linux-x64') {
  const root=await mkdtemp(join(tmpdir(),'yitoken-desktop-media-'));roots.push(root);
  const put=async(relative:string,value:string|Buffer)=>{await mkdir(dirname(join(root,relative)),{recursive:true});await writeFile(join(root,relative),value);};
  const source='exact locked source';const sourceName='ffmpeg-9.0.2.tar.xz';
  const lock={ffmpegVersion:'9.0.2',x264Commit:'b'.repeat(40),releaseSigningFingerprint:'C'.repeat(40),sources:[{filename:sourceName,sha256:hash(source),url:'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',bytes:Buffer.byteLength(source)}]};
  for (const filename of ['ffmpeg-9.0.2.tar.xz.asc','ffmpeg-devel.asc',`x264-${lock.x264Commit}.tar.gz`]) lock.sources.push({filename,sha256:hash(source),url:`https://source.test/${filename}`,bytes:Buffer.byteLength(source)});
  await put('third_party/media-toolchain.json',JSON.stringify(lock));
  for (const entry of lock.sources) await put(`third_party/sources/${entry.filename}`,source);
  await put('package.json',JSON.stringify({name:'yitoken-studio',version:'0.1.0-alpha.1',dependencies:{}}));
  await put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'':{name:'yitoken-studio',version:'0.1.0-alpha.1'}}}));
  await put('third_party/licenses/FFMPEG-GPL-3.0.txt','FFmpeg GPL v3 fixture');await put('third_party/licenses/X264-GPL.txt','x264 GPL fixture');await put('third_party/README.md','Matching source archive fixture');
  const suffix=target.startsWith('win32-')?'.exe':'';
  const artifacts=[];
  for(const tool of ['ffmpeg','ffprobe']){const filename=tool+suffix;const data=`source-built ${tool} ${target}`;await put(`.cache/ffmpeg/${target}/${filename}`,data);artifacts.push({filename,sha256:hash(data)});}
  await put(`.cache/ffmpeg/${target}/FFMPEG-LICENSE.txt`,'FFmpeg GPL v3 fixture');await put(`.cache/ffmpeg/${target}/X264-LICENSE.txt`,'x264 GPL fixture');
  const provenance={target,ffmpegVersion:lock.ffmpegVersion,x264Commit:lock.x264Commit,releaseSignatureFingerprint:lock.releaseSigningFingerprint,configuration:'FFMPEG_CONFIGURATION=--enable-gpl --enable-version3 --enable-libx264 --enable-static --disable-shared --disable-network --disable-devices',artifacts,sources:lock.sources,correspondingSource:'Included third_party/sources'};
  await put(`.cache/ffmpeg/${target}/MEDIA-PROVENANCE.json`,JSON.stringify(provenance));
  return {root,put,lock,provenance,target};
}
test('accepts only exact target source-built tools and locked source hashes',async()=>{
  const {root}=await fixture();expect(await verifyDesktopMedia(root,'linux-x64')).toMatchObject({target:'linux-x64',ffmpegVersion:'9.0.2'});
  const windows=await fixture('win32-x64');expect(await verifyDesktopMedia(windows.root,'win32-x64')).toMatchObject({target:'win32-x64'});
  expect(desktopMediaTarget('mac','arm64')).toBe('darwin-arm64');expect(()=>desktopMediaTarget('mac','universal')).toThrow(/supported|universal/i);
});
test('rejects absent provenance, development versions, wrong revisions and wrong architecture',async()=>{
  for(const mutation of [{ffmpegVersion:'6.1.1'},{target:'win32-x64'},{x264Commit:'a'.repeat(40)},{releaseSignatureFingerprint:'D'.repeat(40)},{configuration:'--enable-network'}]){
    const {root,put,provenance}=await fixture();await put('.cache/ffmpeg/linux-x64/MEDIA-PROVENANCE.json',JSON.stringify({...provenance,...mutation}));await expect(verifyDesktopMedia(root,'linux-x64')).rejects.toThrow();
  }
  const {root}=await fixture();await rm(join(root,'.cache/ffmpeg/linux-x64/MEDIA-PROVENANCE.json'));await expect(verifyDesktopMedia(root,'linux-x64')).rejects.toThrow(/provenance|missing/i);
});
test('rejects tampered tools, source archives and missing matching licenses',async()=>{
  for(const changed of ['.cache/ffmpeg/linux-x64/ffmpeg','third_party/sources/ffmpeg-9.0.2.tar.xz','.cache/ffmpeg/linux-x64/FFMPEG-LICENSE.txt']){
    const {root,put}=await fixture();await put(changed,'tampered');await expect(verifyDesktopMedia(root,'linux-x64')).rejects.toThrow(/checksum|license|hash/i);
  }
});
test('does not follow source or binary symlinks into unrelated files',async()=>{
  const {root}=await fixture();const source=join(root,'.cache/ffmpeg/linux-x64/ffmpeg');await rm(source);await symlink('/etc/passwd',source);await expect(verifyDesktopMedia(root,'linux-x64')).rejects.toThrow(/symbolic|regular/i);
});
test('snapshot contains only verified tools, their licenses/provenance and exact corresponding sources',async()=>{
  const {root,put}=await fixture();await put('.cache/ffmpeg/linux-x64/LICENSE.upstream.txt','unrelated development bundle');await put('.cache/ffmpeg/linux-x64/operator.key','not a real key');
  const resources=await prepareDesktopResources(root,'linux-x64','0.1.0-alpha.1','teststamp');
  expect((await readdir(resources.mediaDir)).sort()).toEqual(['FFMPEG-LICENSE.txt','MEDIA-PROVENANCE.json','X264-LICENSE.txt','ffmpeg','ffprobe'].sort());
  expect(await readFile(join(resources.thirdPartyDir,'sources/ffmpeg-9.0.2.tar.xz'),'utf8')).toBe('exact locked source');
  const appProvenance=JSON.parse(await readFile(join(resources.bundleDir,'DESKTOP-RESOURCE-PROVENANCE.json'),'utf8'));expect(appProvenance).toMatchObject({applicationVersion:'0.1.0-alpha.1',mediaTarget:'linux-x64',ffmpegVersion:'9.0.2'});
  expect(appProvenance.applicationLockSha256).toBe(hash(await readFile(join(root,'package-lock.json'))));
  expect(appProvenance.productionNoticesSha256).toBe(hash(await readFile(resources.noticesFile)));
  await put('.cache/ffmpeg/linux-x64/ffmpeg','late cache mutation');expect(await readFile(join(resources.mediaDir,'ffmpeg'),'utf8')).toContain('source-built');
});
test('finalization preserves existing release directories and leaves staging on a collision',async()=>{
  const {root,put}=await fixture();const old=join(root,'release/build/linux-x64');await put('release/build/linux-x64/old-installer.exe','keep existing');
  const staging=join(root,'release/staging');await put('release/staging/new-installer.exe','new artifact');
  expect(await finalizeDesktopOutput(staging,old)).toBe(staging);expect(await readFile(join(old,'old-installer.exe'),'utf8')).toBe('keep existing');
  const destination=join(root,'release/build/0.1.0-alpha.1/linux-x64-unique');expect(await finalizeDesktopOutput(staging,destination)).toBe(destination);expect(await readFile(join(destination,'new-installer.exe'),'utf8')).toBe('new artifact');
});
test('desktop build fails before invoking any builder when a target toolchain is missing',async()=>{
  const {buildDesktop}=await import('./build-desktop.mjs');const {root}=await fixture();const commands:any[]=[];
  await expect(buildDesktop({root,args:['--win','--x64'],run:async(...args:any[])=>{commands.push(args);}})).rejects.toThrow(/missing|provenance/i);
  expect(commands).toEqual([]);
});
test('desktop build injects immutable resource snapshots, retains old outputs and never uses npx or inherited signing credentials',async()=>{
  const {buildDesktop}=await import('./build-desktop.mjs');const {root,put}=await fixture();
  await put('node_modules/electron-builder/package.json',JSON.stringify({bin:{'electron-builder':'cli.js'}}));await put('node_modules/electron-builder/cli.js','fixture');
  await put('node_modules/electron-vite/package.json',JSON.stringify({bin:{'electron-vite':'bin/electron-vite.js'}}));await put('node_modules/electron-vite/bin/electron-vite.js','fixture');
  await put('release/build/linux-x64/previous-installer','preserve');
  const commands:any[]=[];
  const output=await buildDesktop({root,args:['--linux','--x64'],stamp:'teststamp',environment:{CSC_LINK:'synthetic-secret-not-real',CSC_KEY_PASSWORD:'synthetic-password-not-real'},run:async(command:string,args:string[],env:any)=>{
    commands.push({command,args,env});const argument=args.find(value=>value.startsWith('-c.directories.output='));
    if(argument){const staging=argument.split('=')[1];await mkdir(staging,{recursive:true});await writeFile(join(staging,'installer.fixture'),'artifact');
      expect(isAbsolute(env.YITOKEN_VERIFIED_MEDIA_DIR)).toBe(false);
      const resources=join(staging,'linux-unpacked','resources');await mkdir(resources,{recursive:true});
      for(const [variable,name]of [['YITOKEN_VERIFIED_MEDIA_DIR','ffmpeg'],['YITOKEN_VERIFIED_THIRD_PARTY_DIR','third_party'],['YITOKEN_THIRD_PARTY_NOTICES','THIRD-PARTY-NOTICES.txt'],['YITOKEN_DESKTOP_RESOURCE_PROVENANCE','DESKTOP-RESOURCE-PROVENANCE.json']])await cp(join(root,env[variable]),join(resources,name),{recursive:true});}
  }});
  expect(commands).toHaveLength(2);expect(commands.every(command=>command.command!=='npx')).toBe(true);
  const packaging=commands[1];expect(packaging.env.CSC_LINK).toBeUndefined();expect(packaging.env.CSC_KEY_PASSWORD).toBeUndefined();expect(packaging.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  expect(await readFile(join(root,packaging.env.YITOKEN_VERIFIED_MEDIA_DIR,'MEDIA-PROVENANCE.json'),'utf8')).toContain('9.0.2');
  expect(await readFile(join(root,packaging.env.YITOKEN_THIRD_PARTY_NOTICES),'utf8')).toContain('Third-party');
  expect(await readFile(join(root,'release/build/linux-x64/previous-installer'),'utf8')).toBe('preserve');
  expect(output[0]).toContain('0.1.0-alpha.1');expect(await readFile(join(output[0],'installer.fixture'),'utf8')).toBe('artifact');
});

test('builder exit zero with missing resources is refused and successful-looking staging is preserved',async()=>{
 const {buildDesktop}=await import('./build-desktop.mjs');const{root,put}=await fixture();
 for(const dependency of ['electron-builder','electron-vite']){await put(`node_modules/${dependency}/package.json`,JSON.stringify({bin:{[dependency]:'cli.js'}}));await put(`node_modules/${dependency}/cli.js`,'fixture');}
 let staging='';const pending=buildDesktop({root,args:['--linux','--x64'],stamp:'missing',run:async(_command:string,args:string[])=>{const output=args.find(value=>value.startsWith('-c.directories.output='));if(output){staging=output.split('=')[1];await writeFile(join(staging,'installer.fixture'),'incomplete installer');}}});
 await expect(pending).rejects.toThrow(/missing|required|resources/i);expect(await readFile(join(staging,'installer.fixture'),'utf8')).toBe('incomplete installer');expect(await readdir(join(root,'release'))).not.toContain('build');
});
test('post-build verification requires exact copied target tools, source archives, licenses and notices',async()=>{
 const module=await import('./desktop-media.mjs');
 expect(typeof module.verifyPackagedDesktopResources).toBe('function');
 for(const target of ['linux-x64','win32-x64','darwin-arm64']){
  const {root}=await fixture(target);const snapshot=await prepareDesktopResources(root,target,'0.1.0-alpha.1','postbuild');
  const staging=join(root,'release/postbuild-staging');const unpacked=target==='linux-x64'?'linux-unpacked':target==='win32-x64'?'win-unpacked':'mac-arm64/Fixture.app/Contents';const resources=join(staging,unpacked,'resources');const actualResources=target.startsWith('darwin')?join(staging,'mac-arm64/Fixture.app/Contents/Resources'):resources;
  await mkdir(actualResources,{recursive:true});
  await cp(snapshot.mediaDir,join(actualResources,'ffmpeg'),{recursive:true});await cp(snapshot.thirdPartyDir,join(actualResources,'third_party'),{recursive:true});await cp(snapshot.noticesFile,join(actualResources,'THIRD-PARTY-NOTICES.txt'));await cp(snapshot.resourceProvenanceFile,join(actualResources,'DESKTOP-RESOURCE-PROVENANCE.json'));
  expect(await module.verifyPackagedDesktopResources(staging,target,snapshot)).toBe(actualResources);
  for(const relative of ['ffmpeg/'+(target.startsWith('win32')?'ffprobe.exe':'ffprobe'),'ffmpeg/FFMPEG-LICENSE.txt','ffmpeg/MEDIA-PROVENANCE.json','third_party/sources/ffmpeg-9.0.2.tar.xz','third_party/licenses/X264-GPL.txt','THIRD-PARTY-NOTICES.txt','DESKTOP-RESOURCE-PROVENANCE.json']){
   const actual=join(actualResources,relative);const original=await readFile(actual);await writeFile(actual,'tampered packaged output');await expect(module.verifyPackagedDesktopResources(staging,target,snapshot)).rejects.toThrow(/checksum|mismatch|hash/i);await writeFile(actual,original);
  }
 }
});

test('Darwin source hashes explicitly describe pre-sign bytes without changing other platform metadata', async () => {
 for (const target of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
  const {root}=await fixture(target);const snapshot=await prepareDesktopResources(root,target,'0.1.0-alpha.1','scope');
  const provenance=JSON.parse(await readFile(snapshot.resourceProvenanceFile,'utf8'));
  expect(provenance.artifactHashScope).toBe(target.startsWith('darwin-')?'source-build-before-code-signing':undefined);
 }
});

async function macSigningFixture(target='darwin-arm64') {
 const {root}=await fixture(target);const snapshot=await prepareDesktopResources(root,target,'0.1.0-alpha.1','signing');
 const staging=join(root,'release/signing-stage');const appOutDir=join(staging,target==='darwin-x64'?'mac':'mac-arm64');const resources=join(appOutDir,'Fixture.app/Contents/Resources');await mkdir(resources,{recursive:true});
 for(const [source,name] of [[snapshot.mediaDir,'ffmpeg'],[snapshot.thirdPartyDir,'third_party'],[snapshot.noticesFile,'THIRD-PARTY-NOTICES.txt'],[snapshot.resourceProvenanceFile,'DESKTOP-RESOURCE-PROVENANCE.json']]) await cp(source,join(resources,name),{recursive:true});
 const environment={YITOKEN_VERIFIED_MEDIA_DIR:snapshot.mediaDir,YITOKEN_VERIFIED_THIRD_PARTY_DIR:snapshot.thirdPartyDir,YITOKEN_THIRD_PARTY_NOTICES:snapshot.noticesFile,YITOKEN_DESKTOP_RESOURCE_PROVENANCE:snapshot.resourceProvenanceFile,YITOKEN_DESKTOP_STAGING_DIR:staging,YITOKEN_DESKTOP_MEDIA_TARGET:target,YITOKEN_MAC_PRE_SIGN_PROOF:join(staging,'MAC-PRE-SIGN-PROOF.json')};
 const context={appOutDir,electronPlatformName:'darwin',packager:{projectDir:root}};
 return {root,snapshot,staging,resources,environment,context};
}

test('Mac afterPack proof permits only post-sign tool bytes after exact pre-sign resource verification', async () => {
 const module=await import('./desktop-media.mjs');const {default:afterPack}=await import('./verify-mac-resources.mjs');
 const f=await macSigningFixture();await afterPack(f.context,f.environment);
 await expect(module.verifyMacPreSignProof(f.staging,'darwin-arm64',f.snapshot)).resolves.toBeDefined();
 await expect(afterPack(f.context,f.environment)).rejects.toThrow(/exist|proof/i);
 for(const tool of ['ffmpeg','ffprobe']) { const signed=Buffer.alloc(40);signed.writeUInt32LE(0xfeedfacf,0);signed.writeUInt32LE(0x100000c,4);signed.writeUInt32LE(2,12);signed.write(`signed ${tool}`,16);await writeFile(join(f.resources,'ffmpeg',tool),signed); }
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot)).rejects.toThrow(/checksum/i);
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).resolves.toBe(f.resources);
 for(const relative of ['ffmpeg/FFMPEG-LICENSE.txt','ffmpeg/MEDIA-PROVENANCE.json','third_party/sources/ffmpeg-9.0.2.tar.xz','THIRD-PARTY-NOTICES.txt','DESKTOP-RESOURCE-PROVENANCE.json']) {
  const file=join(f.resources,relative);const original=await readFile(file);await writeFile(file,'changed after signing');
  await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).rejects.toThrow(/checksum/i);await writeFile(file,original);
 }
});

test('Mac proof cannot be missing, reused across staging, or survive changed snapshot bytes',async()=>{
 const module=await import('./desktop-media.mjs');const {default:afterPack}=await import('./verify-mac-resources.mjs');const f=await macSigningFixture();
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).rejects.toThrow(/proof|missing/i);
 await afterPack(f.context,f.environment);
 const other=join(f.root,'release/other-stage');await cp(f.staging,other,{recursive:true});
 await expect(module.verifyMacPreSignProof(other,'darwin-arm64',f.snapshot)).rejects.toThrow(/proof|staging/i);
 await expect(module.verifyMacPreSignProof(f.staging,'darwin-x64',f.snapshot)).rejects.toThrow(/proof|target/i);
 await writeFile(join(f.snapshot.mediaDir,'ffmpeg'),'changed snapshot');
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).rejects.toThrow(/proof|snapshot/i);
});

test('afterPack refuses altered pre-sign resources and wrong hook paths without issuing a proof',async()=>{
 const {default:afterPack}=await import('./verify-mac-resources.mjs');const f=await macSigningFixture();
 await writeFile(join(f.resources,'ffmpeg/ffmpeg'),'tampered before signing');
 await expect(afterPack(f.context,f.environment)).rejects.toThrow(/checksum/i);
 await expect(readFile(f.environment.YITOKEN_MAC_PRE_SIGN_PROOF)).rejects.toThrow();
 await cp(join(f.snapshot.mediaDir,'ffmpeg'),join(f.resources,'ffmpeg/ffmpeg'));
 await expect(afterPack(f.context,{...f.environment,YITOKEN_MAC_PRE_SIGN_PROOF:join(f.root,'wrong-proof')})).rejects.toThrow(/proof/i);
 await expect(afterPack({...f.context,appOutDir:f.root},f.environment)).rejects.toThrow(/staging|output/i);
});

test('signed-media option never relaxes Windows/Linux checks or follows signed tool symlinks',async()=>{
 const module=await import('./desktop-media.mjs');const {default:afterPack}=await import('./verify-mac-resources.mjs');const f=await macSigningFixture();await afterPack(f.context,f.environment);
 for(const target of ['linux-x64','win32-x64'])await expect(module.verifyPackagedDesktopResources(f.staging,target,f.snapshot,{signedMacMedia:true})).rejects.toThrow(/Mac|darwin|signed/i);
 const tool=join(f.resources,'ffmpeg/ffmpeg');await rm(tool);await symlink(join(f.snapshot.mediaDir,'ffmpeg'),tool);
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).rejects.toThrow(/regular|symbolic/i);
});

 test('post-sign media must remain target-architecture Mach-O executables and the proof cannot be a symlink',async()=>{
 const module=await import('./desktop-media.mjs');const {default:afterPack}=await import('./verify-mac-resources.mjs');const f=await macSigningFixture();await afterPack(f.context,f.environment);
 for(const bytes of [Buffer.from('not Mach-O'),(()=>{const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(0x1000007,4);return b;})()]){
  await writeFile(join(f.resources,'ffmpeg/ffmpeg'),bytes);await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-arm64',f.snapshot,{signedMacMedia:true})).rejects.toThrow(/Mach-O|architecture/i);
 }
 const proof=await readFile(f.environment.YITOKEN_MAC_PRE_SIGN_PROOF);const outside=join(f.root,'outside-proof.json');await writeFile(outside,proof);await rm(f.environment.YITOKEN_MAC_PRE_SIGN_PROOF);await symlink(outside,f.environment.YITOKEN_MAC_PRE_SIGN_PROOF);
 await expect(module.verifyMacPreSignProof(f.staging,'darwin-arm64',f.snapshot)).rejects.toThrow(/regular|symbolic/i);
});

test('Intel Mac proof binds x64 staging and post-sign tools retain the Intel architecture',async()=>{
 const module=await import('./desktop-media.mjs');const {default:afterPack}=await import('./verify-mac-resources.mjs');const f=await macSigningFixture('darwin-x64');await afterPack(f.context,f.environment);
 for(const tool of ['ffmpeg','ffprobe']){const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(0x1000007,4);b.writeUInt32LE(2,12);await writeFile(join(f.resources,'ffmpeg',tool),b);}
 await expect(module.verifyPackagedDesktopResources(f.staging,'darwin-x64',f.snapshot,{signedMacMedia:true})).resolves.toBe(f.resources);
});
