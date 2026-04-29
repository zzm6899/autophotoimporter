import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'docs', 'support-matrix.json');
const readmePath = path.join(root, 'README.md');

const startMarker = '<!-- SUPPORT_MATRIX:START -->';
const endMarker = '<!-- SUPPORT_MATRIX:END -->';

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

const header = '| OS | FTP | GPU provider | Auto-updates |';
const divider = '| --- | --- | --- | --- |';
const rows = source.platforms.map((p) => `| ${p.os} | ${p.ftpSource} | ${p.gpuProvider} | ${p.autoUpdates} |`);

const block = [
  startMarker,
  header,
  divider,
  ...rows,
  '',
  `_Generated from \`docs/support-matrix.json\` on ${source.generatedAt}._`,
  endMarker,
].join('\n');

const readme = fs.readFileSync(readmePath, 'utf8');
if (!readme.includes(startMarker) || !readme.includes(endMarker)) {
  throw new Error('README support-matrix markers not found.');
}

const updated = readme.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm'), block);
fs.writeFileSync(readmePath, updated);
console.log('README support matrix updated.');
