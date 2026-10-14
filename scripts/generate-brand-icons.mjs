// YITOKEN Studio branding assets; upstream copyright remains in source notices.
import fs from 'node:fs/promises';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const svg = new URL('../build/yitoken-logo.svg', import.meta.url);
const source = await fs.readFile(svg);
await sharp(source).resize(512, 512).png().toFile(new URL('../build/icon.png', import.meta.url).pathname);
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()));
await fs.writeFile(new URL('../build/icon.ico', import.meta.url), await pngToIco(pngs));
// PNG-backed modern ICNS chunks are portable; this does not validate a macOS build.
const chunks = await Promise.all([[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(async ([size, type]) => {
  const png = await sharp(source).resize(size, size).png().toBuffer();
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
}));
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await fs.writeFile(new URL('../build/icon.icns', import.meta.url), Buffer.concat([header, ...chunks]));
console.log('Generated YITOKEN SVG-derived PNG, ICO and ICNS assets.');
