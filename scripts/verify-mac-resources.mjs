// electron-builder afterPack: verify original media before codesign mutates it.
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeMacPreSignProof } from './desktop-media.mjs';

export default async function verifyMacResources(context, environment = process.env) {
  if (context.electronPlatformName !== 'darwin') return;
  const root = context.packager.projectDir;
  const values = {};
  for (const name of ['YITOKEN_VERIFIED_MEDIA_DIR', 'YITOKEN_VERIFIED_THIRD_PARTY_DIR', 'YITOKEN_THIRD_PARTY_NOTICES', 'YITOKEN_DESKTOP_RESOURCE_PROVENANCE', 'YITOKEN_DESKTOP_STAGING_DIR', 'YITOKEN_MAC_PRE_SIGN_PROOF']) {
    if (!environment[name]) throw new Error(`Missing Mac pre-sign proof hook environment: ${name}`);
    values[name] = resolve(root, environment[name]);
  }
  const target = environment.YITOKEN_DESKTOP_MEDIA_TARGET;
  if (!['darwin-arm64', 'darwin-x64'].includes(target)) throw new Error('Mac pre-sign proof hook requires the explicit Darwin media target');
  const staging = await realpath(values.YITOKEN_DESKTOP_STAGING_DIR);
  const proof = join(staging, 'MAC-PRE-SIGN-PROOF.json');
  // Normalize the parent, not the proof itself: it must not already exist.
  if (values.YITOKEN_MAC_PRE_SIGN_PROOF !== join(values.YITOKEN_DESKTOP_STAGING_DIR, 'MAC-PRE-SIGN-PROOF.json')) throw new Error('Mac pre-sign proof must use the unique staging proof path');
  const expectedOutput = join(staging, target === 'darwin-x64' ? 'mac' : 'mac-arm64');
  if (await realpath(context.appOutDir) !== expectedOutput) throw new Error('Mac afterPack output does not match its staging and target');
  const snapshot = { mediaDir: values.YITOKEN_VERIFIED_MEDIA_DIR, thirdPartyDir: values.YITOKEN_VERIFIED_THIRD_PARTY_DIR, noticesFile: values.YITOKEN_THIRD_PARTY_NOTICES, resourceProvenanceFile: values.YITOKEN_DESKTOP_RESOURCE_PROVENANCE };
  await writeMacPreSignProof(staging, target, snapshot);
  return proof;
}
