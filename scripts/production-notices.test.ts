import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { collectProductionNotices } from './production-notices.mjs';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'production-notices-'));roots.push(root);
 const put=async(relative:string,value:string)=>{await mkdir(dirname(join(root,relative)),{recursive:true});await writeFile(join(root,relative),value);};
 const manifests:any={
  'node_modules/component-a':{name:'component-a',version:'1.0.0',license:'MIT',dependencies:{react:'17'},peerDependencies:{peer:'1'},optionalDependencies:{missingOptional:'1'}},
  'node_modules/component-a/node_modules/react':{name:'react',version:'17.0.0',license:'MIT'},
  'node_modules/react':{name:'react',version:'18.2.0',license:'MIT'},
  'node_modules/peer':{name:'peer',version:'1.0.0',license:'ISC'},
  'node_modules/dev-only':{name:'dev-only',version:'1.0.0',license:'MIT'},
 };
 await put('package.json',JSON.stringify({name:'yitoken-studio',version:'0.1.0-alpha.1',dependencies:{'component-a':'1',react:'18'},devDependencies:{'dev-only':'1'}}));
 await put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:Object.fromEntries(Object.entries(manifests).map(([path,manifest]:any)=>[path,{version:manifest.version}]))}));
 for(const [path,manifest]of Object.entries(manifests)){await put(`${path}/package.json`,JSON.stringify(manifest));await put(`${path}/LICENSE`,`Original license text ${path}\nCopyright holder ${path}`);}
 await put('node_modules/component-a/NOTICE.txt','Original dependency NOTICE, not a patent-clearance certification.');
 return {root,put};
}
test('retains exact LICENSE/NOTICE of production transitive, nested versions and installed peers without dev-only packages',async()=>{
 const {root}=await fixture();const text=await collectProductionNotices(root);
 for(const marker of ['component-a@1.0.0','react@17.0.0','react@18.2.0','peer@1.0.0','Original dependency NOTICE','Copyright holder'])expect(text).toContain(marker);
 expect(text).not.toContain('dev-only');expect(text).not.toContain('missingOptional');
});
test('fails closed when a shipped production dependency is missing or disagrees with lock',async()=>{
 for(const broken of ['missing','version']){const{root,put}=await fixture();if(broken==='missing')await rm(join(root,'node_modules/react'),{recursive:true});else await put('node_modules/react/package.json',JSON.stringify({name:'react',version:'99.0.0',license:'MIT'}));await expect(collectProductionNotices(root)).rejects.toThrow(/missing|version|lock/i);}
});
test('does not invent a generic license when a production dependency has no license text',async()=>{
 const{root}=await fixture();await rm(join(root,'node_modules/peer/LICENSE'));await expect(collectProductionNotices(root)).rejects.toThrow(/license.*peer|peer.*license/i);
});
test('cannot copy unrelated data through a symbolic dependency notice',async()=>{
 const{root}=await fixture();await rm(join(root,'node_modules/peer/LICENSE'));await symlink('/etc/passwd',join(root,'node_modules/peer/LICENSE'));await expect(collectProductionNotices(root)).rejects.toThrow(/symbolic|regular/i);
});
test('retains nested bundled vendor notices, not just the wrapper license',async()=>{
 const{root,put}=await fixture();await put('node_modules/component-a/lib-vendor/d3-array/LICENSE','Bundled D3 original copyright');await put('node_modules/component-a/lib-vendor/d3-array/NOTICE','Bundled D3 attribution');
 const text=await collectProductionNotices(root);expect(text).toContain('lib-vendor/d3-array/LICENSE');expect(text).toContain('Bundled D3 original copyright');expect(text).toContain('Bundled D3 attribution');
});
test('uses exact offline upstream supplements and refuses modified cached license text',async()=>{
 const{root,put}=await fixture();await rm(join(root,'node_modules/peer/LICENSE'));
 const content='Original peer copyright and upstream license';
 const {createHash}=await import('node:crypto');const sha256=createHash('sha256').update(content).digest('hex');
 await put('third_party/dependency-licenses/peer-LICENSE.txt',content);
 await put('third_party/dependency-licenses/lock.json',JSON.stringify({packages:{'peer@1.0.0':{texts:[{filename:'peer-LICENSE.txt',sha256,sourceUrl:'https://example.org/peer/LICENSE',sourceRevision:'exact-commit'}]}}}));
 const text=await collectProductionNotices(root);expect(text).toContain(content);expect(text).toContain('https://example.org/peer/LICENSE');
 await put('third_party/dependency-licenses/peer-LICENSE.txt','Modified');await expect(collectProductionNotices(root)).rejects.toThrow(/hash|sha256/i);
});
test('only accepts the approved missing-license prerelease exception with exact metadata and README evidence',async()=>{
 const{root,put}=await fixture();const {readFile}=await import('node:fs/promises');
 const repo=new URL('../',import.meta.url);
 const manifest=await readFile(new URL('node_modules/react-remove-scroll-bar/package.json',repo),'utf8');
 const readme=await readFile(new URL('node_modules/react-remove-scroll-bar/README.md',repo),'utf8');
 const cache=JSON.parse(await readFile(new URL('third_party/dependency-licenses/lock.json',repo),'utf8'));
 const record=cache.packages['react-remove-scroll-bar@2.3.8'];
 // Preserve the original metadata bytes for the accepted exception; supply its actual peers/dependencies.
 const app=JSON.parse(await readFile(join(root,'package.json'),'utf8'));app.dependencies['react-remove-scroll-bar']='2.3.8';await put('package.json',JSON.stringify(app));
 const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));lock.packages['node_modules/react-remove-scroll-bar']={version:'2.3.8',integrity:record.npmIntegrity};
 for(const name of Object.keys({...JSON.parse(manifest).dependencies,...JSON.parse(manifest).peerDependencies})){
   if(name==='react')continue;
   lock.packages[`node_modules/${name}`]={version:'1.0.0'};await put(`node_modules/${name}/package.json`,JSON.stringify({name,version:'1.0.0',license:'MIT'}));await put(`node_modules/${name}/LICENSE`,'Original dependency license');
 }
 await put('package-lock.json',JSON.stringify(lock));await put('node_modules/react-remove-scroll-bar/package.json',manifest);await put('node_modules/react-remove-scroll-bar/README.md',readme);
 await put('third_party/dependency-licenses/lock.json',JSON.stringify({packages:{'react-remove-scroll-bar@2.3.8':record}}));
 for(const item of record.texts)await put(`third_party/dependency-licenses/${item.filename}`,await readFile(new URL(`third_party/dependency-licenses/${item.filename}`,repo),'utf8'));
 const text=await collectProductionNotices(root);expect(text).toContain('pending legal/author review');expect(text).toContain('NOT an upstream copyright notice');expect(text).toContain('Original package author:');expect(text).toContain('Original repository:');
 await put('node_modules/react-remove-scroll-bar/README.md',readme+'tamper');await expect(collectProductionNotices(root)).rejects.toThrow(/exception|README|evidence/i);
 await put('node_modules/react-remove-scroll-bar/README.md',readme);record.readmeSha256='0'.repeat(64);await put('third_party/dependency-licenses/lock.json',JSON.stringify({packages:{'react-remove-scroll-bar@2.3.8':record}}));await expect(collectProductionNotices(root)).rejects.toThrow(/exception|README|evidence/i);
});
test('a bundled vendor license cannot replace the enclosing package own missing license',async()=>{
 const{root,put}=await fixture();await rm(join(root,'node_modules/peer/LICENSE'));await put('node_modules/peer/lib-vendor/d3/LICENSE','Different vendor license');
 await expect(collectProductionNotices(root)).rejects.toThrow(/peer|license/i);
});
