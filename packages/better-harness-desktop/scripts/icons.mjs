/**
 * Rasterise `build/icon.svg` into the platform icon files electron-builder and
 * the main process consume: `icon.icns` (macOS), `icon.ico` (Windows) and
 * `icon.png` (Linux, and the Dock/window icon in an unpackaged run).
 *
 * The outputs are committed, so this only runs when the artwork changes. It is
 * deliberately plain Node plus `sharp` rather than `iconutil`, `sips` or
 * ImageMagick: the ICNS and ICO containers are assembled here so a contributor
 * on any platform can regenerate the same bytes.
 *
 *   node scripts/icons.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');

/** The Linux/renderer PNG, and the largest square every container is cut from. */
const BASE = 1024;

/**
 * Above this size the full composition is used; at or below it the optically
 * sized `icon-small.svg`, because the mark's thin ring stops resolving there.
 */
const SMALL_UP_TO = 48;

/**
 * ICNS element types keyed by pixel size. macOS picks by type, not by the PNG
 * header, so a size appears under every type that declares it: `icp4`/`icp5`
 * carry the 1x menu-bar and Finder sizes, `ic11`..`ic14` the Retina variants.
 */
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024],
];

/** Windows shows 16px in the title bar and 256px in the shell's large views. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('icons.mjs needs sharp to rasterise the SVG: npm install --no-save sharp');
  }
}

/**
 * Render at the target size directly rather than downscaling one bitmap: the
 * mark is an outlined ring, and re-sampling a 1024px render thins its stroke to
 * a grey smear at 16px.
 */
function render(sharp, artwork, size) {
  const svg = size <= SMALL_UP_TO ? artwork.small : artwork.full;
  return sharp(svg, { density: (72 * size) / BASE }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

function icns(entries) {
  const elements = entries.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(elements);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // 1 = icon, as opposed to a cursor.
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;
  entries.forEach(([size, png], index) => {
    const at = index * 16;
    // 256 does not fit the byte, and 0 is its agreed spelling in the directory.
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4); // Colour planes.
    directory.writeUInt16LE(32, at + 6); // Bits per pixel.
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map(([, png]) => png)]);
}

const sharp = await loadSharp();
const artwork = {
  full: await readFile(join(build, 'icon.svg')),
  small: await readFile(join(build, 'icon-small.svg')),
};
const sizes = [...new Set([BASE, ...ICNS_TYPES.map(([, size]) => size), ...ICO_SIZES])];
const png = new Map(await Promise.all(sizes.map(async (size) => [size, await render(sharp, artwork, size)])));

await writeFile(join(build, 'icon.png'), png.get(BASE));
await writeFile(join(build, 'icon.icns'), icns(ICNS_TYPES.map(([type, size]) => [type, png.get(size)])));
await writeFile(join(build, 'icon.ico'), ico(ICO_SIZES.map((size) => [size, png.get(size)])));
console.log(`icon.png, icon.icns and icon.ico written to ${build}`);
