const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const svg = path.join(root, 'assets', 'app-icon.svg');
const png = path.join(root, 'assets', 'app-icon.png');
const ico = path.join(root, 'assets', 'app-icon.ico');

function pngToIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

(async () => {
  const image = sharp(svg).resize(512, 512);
  const pngBuffer = await image.png().toBuffer();
  await fs.promises.writeFile(png, pngBuffer);
  await fs.promises.writeFile(ico, pngToIco(pngBuffer));
  console.log(`Generated ${path.relative(root, png)} and ${path.relative(root, ico)}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
