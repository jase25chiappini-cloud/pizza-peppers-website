/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

function addNoCheckHeader(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return;
    const orig = fs.readFileSync(targetPath, 'utf8');
    if (orig.startsWith('// @ts-nocheck') || orig.startsWith('//@ts-nocheck')) {
      return;
    }
    const updated = `// @ts-nocheck\n${orig}`;
    fs.writeFileSync(targetPath, updated, 'utf8');
    console.log(`[postinstall] added // @ts-nocheck to ${targetPath}`);
  } catch (e) {
    console.warn(`[postinstall] skipped ${targetPath}:`, e?.message || e);
  }
}

function main() {
  const root = process.cwd();
  const target = path.join(root, 'node_modules', '@babel', 'parser', 'lib', 'index.js');
  addNoCheckHeader(target);
}

main();

