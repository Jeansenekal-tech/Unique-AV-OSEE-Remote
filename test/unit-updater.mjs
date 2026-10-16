// Unit tests: version comparison + update manifest generation.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isNewer } = require('../main/updater-mac.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

check(isNewer('1.0.1', '1.0.0'), '1.0.1 > 1.0.0');
check(isNewer('1.10.0', '1.9.9'), '1.10.0 > 1.9.9 (numeric, not string)');
check(isNewer('v2.0.0', '1.99.99'), 'v-prefixed tags');
check(!isNewer('1.0.0', '1.0.0'), 'same version is not newer');
check(!isNewer('1.0.0', '1.0.1'), 'older is not newer');
check(isNewer('1.2.0', '1.2.0-beta.1'), 'release > its prerelease');
check(!isNewer('1.2.0-beta.1', '1.2.0'), 'prerelease < release');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
const names = ['Unique-AV-OSEE-Remote-1.2.3-arm64.zip', 'Unique-AV-OSEE-Remote-1.2.3-x64.zip', 'Unique-AV-OSEE-Remote-1.2.3-arm64.dmg', 'Unique-AV-OSEE-Remote-1.0.0-x64.zip', 'Unique-AV-OSEE-Remote-Setup-1.2.3.exe'];
for (const n of names) fs.writeFileSync(path.join(dir, n), `content of ${n}`);
fs.writeFileSync(path.join(dir, 'notes.txt'), 'Bug fixes');
execFileSync('node', [path.join(root, 'scripts/make-update-manifest.mjs'), dir, 'v1.2.3', path.join(dir, 'notes.txt')]);
const m = JSON.parse(fs.readFileSync(path.join(dir, 'update-mac.json'), 'utf8'));
check(m.version === '1.2.3', 'manifest version from tag');
check(m.files.length === 3, 'manifest only includes this version’s files');
const arm = m.files.find((f) => f.arch === 'arm64' && f.name.endsWith('.zip'));
check(arm && arm.sha512 === crypto.createHash('sha512').update(`content of ${arm.name}`).digest('base64'), 'sha512 matches file');
check(m.files.some((f) => f.arch === 'x64' && f.name.endsWith('.zip')), 'x64 zip present');
check(m.notes === 'Bug fixes', 'release notes included');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
