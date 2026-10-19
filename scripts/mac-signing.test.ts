import { afterEach, expect, test } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function credentials(){
 const root=await mkdtemp(join(tmpdir(),'yitoken-signing-'));roots.push(root);
 const cert=join(root,'certificate.p12'),key=join(root,'AuthKey_AB12345678.p8');
 await writeFile(cert,'synthetic certificate',{mode:0o600});await writeFile(key,'synthetic private key',{mode:0o600});
 return {root,environment:{YITOKEN_MAC_SIGNING_MODE:'developer-id',CSC_LINK:cert,CSC_KEY_PASSWORD:'synthetic-password',CSC_NAME:'Developer ID Application: Fixture Company (TEAM123456)',APPLE_TEAM_ID:'TEAM123456',APPLE_API_KEY:key,APPLE_API_KEY_ID:'AB12345678',APPLE_API_ISSUER:'12345678-1234-1234-1234-123456789abc'}};
}
test('local Mac defaults to complete ad-hoc bundle signing, never silently inherits release credentials',async()=>{
 const {prepareMacSigning}=await import('./mac-signing.mjs');
 const {root,environment}=await credentials();
 const p=await prepareMacSigning({root,environment:{...environment,YITOKEN_MAC_SIGNING_MODE:undefined,CSC_IDENTITY_AUTO_DISCOVERY:'true',APPLE_ID:'must-not-inherit',MAC_CERTIFICATE_P12_BASE64:'must-not-inherit'}});
 expect(p.mode).toBe('adhoc');expect(p.builderArgs).toContain('-c.mac.identity=-');expect(p.builderArgs).toContain('-c.mac.hardenedRuntime=false');expect(p.builderArgs).toContain('-c.mac.notarize=false');expect(p.environment.CSC_LINK).toBeUndefined();expect(p.environment.APPLE_API_KEY).toBeUndefined();expect(p.environment.APPLE_ID).toBeUndefined();expect(p.environment.MAC_CERTIFICATE_P12_BASE64).toBeUndefined();
});
test('Developer ID signing requires all explicit credentials and never falls back to ad-hoc',async()=>{
 const {prepareMacSigning}=await import('./mac-signing.mjs');const {root,environment}=await credentials();
 for(const name of ['CSC_LINK','CSC_KEY_PASSWORD','CSC_NAME','APPLE_TEAM_ID','APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER']){
  await expect(prepareMacSigning({root,environment:{...environment,[name]:''}})).rejects.toThrow(name);
 }
 await expect(prepareMacSigning({root,environment:{...environment,YITOKEN_MAC_SIGNING_MODE:'unsigned'}})).rejects.toThrow(/mode/i);
 await expect(prepareMacSigning({root,environment:{...environment,CSC_NAME:'Other (OTHER12345)'}})).rejects.toThrow(/team|identity/i);
 await expect(prepareMacSigning({root,environment:{...environment,CSC_LINK:'https://example.invalid/cert.p12'}})).rejects.toThrow(/local|absolute/i);
});
test('Developer ID profile enables hardened runtime, notarization and explicit local identity',async()=>{
 const {prepareMacSigning}=await import('./mac-signing.mjs');const {root,environment}=await credentials();
 const p=await prepareMacSigning({root,environment:{...environment,APPLE_ID:'must-not-inherit',CSC_KEYCHAIN:'must-not-inherit'}});
 expect(p.mode).toBe('developer-id');expect(p.teamId).toBe('TEAM123456');
 expect(p.builderArgs).toContain('-c.mac.identity=Fixture Company (TEAM123456)');expect(p.builderArgs).toContain('-c.mac.hardenedRuntime=true');expect(p.builderArgs).toContain('-c.mac.notarize=true');expect(p.builderArgs).toContain('-c.dmg.sign=true');expect(p.builderArgs).toContain('-c.mac.entitlementsInherit='+join(root,'build/entitlements.mac.plist'));
 expect(p.environment.CSC_LINK).toBe(environment.CSC_LINK);expect(p.environment.APPLE_API_KEY).toBe(environment.APPLE_API_KEY);expect(p.environment.APPLE_ID).toBeUndefined();expect(p.environment.CSC_KEYCHAIN).toBeUndefined();
});
test('broken bundle resources or wrong Team cannot become a verified Mac release',async()=>{
 const {verifyMacSigningOutput}=await import('./mac-signing.mjs');const {root}=await credentials();
 const staging=join(root,'staging'),app=join(staging,'mac-arm64','YITOKEN Studio.app');
 await mkdir(join(app,'Contents','_CodeSignature'),{recursive:true});await writeFile(join(app,'Contents','_CodeSignature','CodeResources'),'sealed');
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'adhoc',teamId:null},execute:async()=>({status:1,stdout:'',stderr:'code has no resources but signature indicates they must be present'})})).rejects.toThrow(/verification|signature/i);
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'developer-id',teamId:'TEAM123456'},execute:async(_command:string,args:string[])=>({status:0,stdout:'',stderr:args.includes('-d')?'Identifier=cn.com.yitoken.studio\nAuthority=Developer ID Application: Other\nTeamIdentifier=OTHER12345\nflags=0x10000(runtime)\nSealed Resources version=2':'valid'})})).rejects.toThrow(/team/i);
});
test('final DMG and ZIP must contain the exact verified app, and signed release requires Apple acceptance',async()=>{
 const {verifyMacSigningOutput}=await import('./mac-signing.mjs');const {root}=await credentials();
 const staging=join(root,'staging'),app=join(staging,'mac-arm64','YITOKEN Studio.app');
 for(const f of ['_CodeSignature/CodeResources','MacOS/YITOKEN Studio','Resources/ffmpeg/ffmpeg','Resources/ffmpeg/ffprobe']){const p=join(app,'Contents',f);await mkdir(join(p,'..'),{recursive:true});await writeFile(p,'verified fixture');}
 await writeFile(join(staging,'fixture.dmg'),'fixture DMG');await writeFile(join(staging,'fixture.zip'),'fixture ZIP');
 let extraPayload = false;
 const execute=async(command:string,args:string[])=>{
  if(command==='/usr/bin/hdiutil'&&args[0]==='attach'){const mount=args[args.indexOf('-mountpoint')+1];await cp(app,join(mount,'YITOKEN Studio.app'),{recursive:true});}
  if(command==='/usr/bin/ditto'){await cp(app,join(args.at(-1)!,'YITOKEN Studio.app'),{recursive:true});if(extraPayload)await writeFile(join(args.at(-1)!,'payload.sh'),'unexpected installer payload');}
  return {status:0,stdout:'',stderr:args.includes('-d')?'Identifier=cn.com.yitoken.studio\nSignature=adhoc\nInfo.plist entries=42\nSealed Resources version=2':''};
 };
 const p=await verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'adhoc',teamId:null},execute});
 expect(p).toMatchObject({schemaVersion:1,mode:'adhoc',signatureVerified:true,gatekeeperAccepted:false,notarized:false,verificationScope:'unpacked-app-and-final-dmg-zip'});
 expect(p.mediaArtifacts).toHaveLength(2);
 extraPayload=true;
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'adhoc',teamId:null},execute})).rejects.toThrow(/ZIP/);
 extraPayload=false;
 const {environment}=await credentials();
 const signedExecute=async(command:string,args:string[])=>{
  if(args.includes('-d'))return {status:0,stdout:'',stderr:'Identifier=cn.com.yitoken.studio\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=TEAM123456\nflags=0x10000(runtime)\nSealed Resources version=2'};
  if(command==='/usr/bin/xcrun'&&args[0]==='notarytool')return {status:0,stdout:JSON.stringify({status:'Accepted'}),stderr:''};
  return execute(command,args);
 };
 const signed=await verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'developer-id',teamId:'TEAM123456',environment},execute:signedExecute});
 expect(signed).toMatchObject({notarized:true,gatekeeperAccepted:true,teamId:'TEAM123456'});
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'developer-id',teamId:'TEAM123456',environment},execute:async(c:string,a:string[])=>c==='/usr/bin/xcrun'&&a[0]==='notarytool'?{status:0,stdout:JSON.stringify({status:'Invalid'}),stderr:''}:signedExecute(c,a)})).rejects.toThrow(/not accept/);
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'adhoc',teamId:null},execute:async(c:string,a:string[])=>{const r=await execute(c,a);if(c==='/usr/bin/ditto')await writeFile(join(a.at(-1)!,'YITOKEN Studio.app/Contents/MacOS/YITOKEN Studio'),'tampered');return r;}})).rejects.toThrow(/differs/);
 const rejected=async(command:string,args:string[])=>command==='/usr/sbin/spctl'?{status:1,stdout:'',stderr:'rejected'}:execute(command,args);
 await expect(verifyMacSigningOutput({staging,target:'darwin-arm64',profile:{mode:'developer-id',teamId:'TEAM123456'},execute:async(c:string,a:string[])=>a.includes('-d')?{status:0,stdout:'',stderr:'Identifier=cn.com.yitoken.studio\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=TEAM123456\nflags=0x10000(runtime)\nSealed Resources version=2'}:rejected(c,a)})).rejects.toThrow(/Gatekeeper|accept/i);
});
