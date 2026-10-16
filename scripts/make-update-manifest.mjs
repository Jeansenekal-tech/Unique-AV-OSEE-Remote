// Builds update-mac.json for the auto-updater from the files in a folder of
// release assets (the per-arch .zip and .dmg files made by electron-builder).
//   node scripts/make-update-manifest.mjs <dir> [version] [notesFile]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2] || 'dist';
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const version = (process.argv[3] || pkg.version).replace(/^v/, '');
const notes = process.argv[4] && fs.existsSync(process.argv[4]) ? fs.readFileSync(process.argv[4], 'utf8') : '';

const files = fs.readdirSync(dir)
  .filter((n) => /\.(zip|dmg)$/i.test(n) && n.includes(version))
  .map((name) => {
    const buf = fs.readFileSync(path.join(dir, name));
    const arch = /arm64/i.test(name) ? 'arm64' : /universal/i.test(name) ? 'universal' : 'x64';
    return { name, arch, size: buf.length, sha512: crypto.createHash('sha512').update(buf).digest('base64') };
  });

if (!files.some((f) => f.name.endsWith('.zip'))) {
  console.error(`No .zip files for version ${version} in ${dir}`);
  process.exit(1);
}

const manifest = { version, releaseDate: new Date().toISOString(), notes, files };
fs.writeFileSync(path.join(dir, 'update-mac.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`update-mac.json → ${version}: ${files.map((f) => `${f.name} (${f.arch})`).join(', ')}`);
