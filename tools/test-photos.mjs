#!/usr/bin/env node
// Shows which embedded photo the Apps Script job would pick from each PDF.
//
//   node tools/test-photos.mjs samples/*.pdf
//
// Saves the chosen photo as <file>.photo.jpg so you can check it.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Photos.gs'), 'utf8'), ctx);

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node tools/test-photos.mjs <pdf files...>');
  process.exit(1);
}

for (const file of files) {
  const bytes = fs.readFileSync(file);
  const jpegs = ctx.findPdfJpegs_(bytes.toString('latin1'));
  const pick = ctx.pickDishPhoto_(jpegs);
  const list = jpegs.map((j) => `${j.width}x${j.height}`).join(', ') || 'none';
  console.log(`${path.basename(file)}: embedded JPEGs: ${list}`);
  if (pick) {
    fs.writeFileSync(file + '.photo.jpg', bytes.subarray(pick.start, pick.end));
    console.log(`  -> picked ${pick.width}x${pick.height}, saved ${path.basename(file)}.photo.jpg`);
  } else {
    console.log('  -> no suitable photo; the site would show page 1 instead');
  }
}
