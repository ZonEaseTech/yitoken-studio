// YITOKEN changes: build the bundled media tools from checksum-locked GPL sources.
import { readFile, writeFile, mkdir, copyFile, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function mediaTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64'].includes(target)) throw new Error('Unsupported media toolchain target');
  return target;
}
export async function verifyMediaSources(directory, lock) {
  if (!Array.isArray(lock.sources) || lock.sources.length === 0) throw new Error('Media sources missing');
  for (const source of lock.sources) {
    if (typeof source.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.filename)) throw new Error('Invalid source filename');
    const actual = createHash('sha256').update(await readFile(join(directory,source.filename))).digest('hex');
    if (actual !== source.sha256) throw new Error(`Media source checksum mismatch: ${source.filename}`);
  }
}
function run(command, args, cwd, env) {
  const result = spawnSync(command,args,{cwd,env,stdio:'inherit',shell:false});
  if (result.error || result.status !== 0) throw new Error(`Media build command failed: ${command} (${result.status ?? result.error?.message})`);
}
export async function buildMediaTools(root, platform = process.platform, arch = process.arch) {
  const target = mediaTarget(platform,arch);
  if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('macOS media tools must be built on macOS with its SDK');
  if (arch !== process.arch && !(platform === 'win32' && arch === 'x64')) throw new Error('Cross architecture needs a separately verified build host');
  const sourceDir = join(root,'third_party','sources');
  const lock = JSON.parse(await readFile(join(root,'third_party','media-toolchain.json'),'utf8'));
  await verifyMediaSources(sourceDir,lock);
  if (!/^\d+\.\d+\.\d+$/.test(lock.ffmpegVersion) || !/^[0-9a-f]{40}$/.test(lock.x264Commit)) throw new Error('Invalid locked media source revision');
  const build = join(root,'.cache','media-build',target);
  const prefix = join(build,'install');
  const output = join(root,'.cache','ffmpeg',target);
  await mkdir(build,{recursive:true});
  const gnupg = join(build,'gnupg'); await mkdir(gnupg,{recursive:true,mode:0o700});
  run('gpg',['--homedir',gnupg,'--batch','--import',join(sourceDir,'ffmpeg-devel.asc')],build,process.env);
  const verify = spawnSync('gpg',['--homedir',gnupg,'--batch','--status-fd','1','--verify',join(sourceDir,`ffmpeg-${lock.ffmpegVersion}.tar.xz.asc`),join(sourceDir,`ffmpeg-${lock.ffmpegVersion}.tar.xz`)],{encoding:'utf8'});
  if (verify.status !== 0 || !verify.stdout.includes(`VALIDSIG ${lock.releaseSigningFingerprint} `)) throw new Error('FFmpeg release signature is invalid');
  const ffmpegSource = join(build,`ffmpeg-${lock.ffmpegVersion}`);
  const x264Source = join(build,`x264-${lock.x264Commit}`);
  // Remove only the build directories associated with this locked target, not app media.
  await rm(ffmpegSource,{recursive:true,force:true}); await rm(x264Source,{recursive:true,force:true});
  for (const archive of [`ffmpeg-${lock.ffmpegVersion}.tar.xz`,`x264-${lock.x264Commit}.tar.gz`]) run('tar',['-xf',join(sourceDir,archive),'-C',build],build,process.env);
  const crossWindows = platform === 'win32' && process.platform !== 'win32';
  const cc = crossWindows ? 'x86_64-w64-mingw32-gcc-posix' : (process.env.CC || 'cc');
  const env = {...process.env,CC:cc,PKG_CONFIG_PATH:join(prefix,'lib','pkgconfig')};
  const x264Args = ['./configure',`--prefix=${prefix}`,'--enable-static','--disable-cli','--enable-pic'];
  if (crossWindows) x264Args.push('--host=x86_64-w64-mingw32','--cross-prefix=x86_64-w64-mingw32-');
  run('bash',x264Args,x264Source,env); run('make',['-j8'],x264Source,env); run('make',['install'],x264Source,env);
  const ffArgs = ['./configure',`--prefix=${prefix}`,'--enable-gpl','--enable-version3','--enable-libx264','--enable-static','--disable-shared','--disable-autodetect','--disable-network','--disable-devices','--enable-indev=lavfi','--disable-ffplay','--disable-doc','--disable-debug',`--cc=${cc}`,`--extra-cflags=-I${join(prefix,'include')}`,`--extra-ldflags=-L${join(prefix,'lib')}${crossWindows ? ' -static' : ''}`];
  if (crossWindows) ffArgs.push('--enable-cross-compile','--pkg-config=pkg-config','--target-os=mingw32','--arch=x86_64','--cross-prefix=x86_64-w64-mingw32-');
  run('bash',ffArgs,ffmpegSource,env); run('make',['-j8'],ffmpegSource,env);
  await mkdir(output,{recursive:true});
  const artifacts=[];
  for (const tool of ['ffmpeg','ffprobe']) {
    const name=tool+(platform==='win32'?'.exe':'');
    await copyFile(join(ffmpegSource,name),join(output,name)); await chmod(join(output,name),0o755);
    artifacts.push({filename:name,sha256:createHash('sha256').update(await readFile(join(output,name))).digest('hex')});
  }
  await copyFile(join(ffmpegSource,'COPYING.GPLv3'),join(output,'FFMPEG-LICENSE.txt'));
  await copyFile(join(x264Source,'COPYING'),join(output,'X264-LICENSE.txt'));
  const config = await readFile(join(ffmpegSource,'ffbuild','config.mak'),'utf8');
  const provenance={target,ffmpegVersion:lock.ffmpegVersion,x264Commit:lock.x264Commit,releaseSignatureFingerprint:lock.releaseSigningFingerprint,configuration:config.split('\n').filter(line=>line.startsWith('FFMPEG_CONFIGURATION=')||line.startsWith('CC=')).join('\n'),artifacts,sources:lock.sources,correspondingSource:'Included under third_party/sources in the matching YITOKEN Studio application source download'};
  await writeFile(join(output,'MEDIA-PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');
  console.log(`Media tools built from locked sources: ${output}`); return output;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const platform=process.argv.includes('--win')?'win32':process.platform;
  await buildMediaTools(root,platform,process.arch);
}
