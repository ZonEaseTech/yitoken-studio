// YITOKEN changes: local website handoff, not a production deployment.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export async function stageDownloads(root, {source,windows,linux}) {
 const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw Error('Invalid release version');
 if(!source||basename(source)!==`yitoken-studio-${version}-source.tar.gz`)throw Error('Matching application source archive is required');
 const destination=join(root,'release','website','downloads');
 if(await lstat(destination).catch(()=>null))throw Error('Website handoff already exists; retain it rather than overwrite');
 const artifacts=[];
 for(const [platform,file] of [['source',source],['windows',windows],['linux',linux]]) {
  if(!file)continue;
  const absolute=resolve(file),boundary=relative(join(root,'release'),absolute);
  if(boundary==='..'||boundary.startsWith('../')||isAbsolute(boundary))throw Error('Download must be a generated release artifact');
  const stat=await lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||!stat.size)throw Error('Download must be a nonempty regular release file');
  if(platform==='windows'&&!file.endsWith('.exe')||platform==='linux'&&!file.endsWith('.AppImage'))throw Error('Download platform extension mismatch');
  if(platform!=='source') {
   if(!basename(file).includes(version)) throw Error('Download filename must identify the matching application version');
   const proof=JSON.parse(await readFile(join(dirname(absolute),platform==='windows'?'win-unpacked':'linux-unpacked','resources','DESKTOP-RESOURCE-PROVENANCE.json'),'utf8'));
   if(proof.applicationVersion!==version||proof.mediaTarget!==(platform==='windows'?'win32-x64':'linux-x64'))throw Error('Download resource provenance must match the application version and x64 platform');
  }
  const bytes=await readFile(absolute);artifacts.push({platform,filename:basename(file),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes});
 }
 const cards=artifacts.map(item=>`<article class="card"><h3>${item.platform==='source'?'同版本完整源码':item.platform==='windows'?'Windows x64 · 测试包':'Linux x64 · 测试包'}</h3><p>${item.platform==='source'?'AGPL 客户端源码 + 锁文件、构建脚本、FFmpeg/x264 对应源码与许可。':item.platform==='windows'?'未签名；尚未完成真实 Windows 安装、系统加密和生成验收。不属于稳定版。':'当前 Linux 环境构建，面向 Ubuntu 24.04；不承诺较老发行版兼容。不属于稳定版。'}</p><a class="button" href="assets/${encodeURIComponent(item.filename)}" download>下载${item.platform==='source'?'源码':'预发布测试包'}</a><small>${(item.bytes/1048576).toFixed(1)} MiB · ${escape(item.filename)}</small><details><summary>SHA256 校验</summary><code>${item.sha256}</code></details></article>`).join('')+'<article class="card unavailable"><h3>macOS · 尚未提供</h3><p>未构建、未签名公证、未安装验证；当前没有下载按钮。</p></article>';
 const html=(await readFile(join(root,'website/downloads/template.html'),'utf8')).replaceAll('@@VERSION@@',escape(version)).replace('@@ARTIFACT_CARDS@@',cards);
 await mkdir(join(destination,'assets'),{recursive:true});
 for(const item of artifacts)await writeFile(join(destination,'assets',item.filename),item.content,{flag:'wx'});
 await writeFile(join(destination,'index.html'),html,{flag:'wx'});
 await writeFile(join(destination,'SHA256SUMS'),artifacts.map(item=>`${item.sha256}  assets/${item.filename}`).join('\n')+'\n',{flag:'wx'});
 await writeFile(join(destination,'manifest.json'),JSON.stringify({product:'YITOKEN Studio',version,readyForGeneralRelease:false,artifacts:artifacts.map(({content,...item})=>item)},null,2)+'\n',{flag:'wx'});
 await writeFile(join(destination,'version.json'),JSON.stringify({version,releaseNotes:'预发布：整片本地合成；使用本人API Key。付费生成和跨平台安装尚未完成验收。',githubUrl:'https://yitoken.com.cn/downloads/'},null,2)+'\n',{flag:'wx'});
 return destination;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');if(i<1)throw Error('Use --source=/path --windows=/path --linux=/path');return [arg.slice(0,i).replace(/^--/,''),arg.slice(i+1)]}));
 console.log(await stageDownloads(root,options));
}
