#!/usr/bin/env node
// Runs the same Claude extraction the Apps Script job uses, on local files.
//
//   ANTHROPIC_API_KEY=sk-ant-... node tools/test-extract.mjs samples/*.pdf
//
// Writes <file>.recipe.json next to each input and, if every file succeeds,
// docs/demo/recipes.json so you can preview the results in the site's demo mode.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Extract.gs'), 'utf8'), ctx);

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function inputFor(file) {
  const ext = path.extname(file).toLowerCase();
  const bytes = fs.readFileSync(file);
  if (ext === '.pdf') return { kind: 'pdf', base64: bytes.toString('base64') };
  if (IMAGE_TYPES[ext]) return { kind: 'image', mediaType: IMAGE_TYPES[ext], base64: bytes.toString('base64') };
  return { kind: 'text', text: bytes.toString('utf8') };
}

const key = process.env.ANTHROPIC_API_KEY;
const files = process.argv.slice(2);
if (!key || !files.length) {
  console.error('Usage: ANTHROPIC_API_KEY=... node tools/test-extract.mjs <files...>');
  process.exit(1);
}

const all = [];
let failed = false;
for (const file of files) {
  const started = Date.now();
  process.stdout.write(`${path.basename(file)} ... `);
  try {
    const res = await fetch(ctx.CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, ...ctx.CLAUDE_HEADERS },
      body: JSON.stringify(ctx.buildExtractionRequest_(inputFor(file), path.basename(file))),
    });
    const body = await res.json();
    const { recipes } = ctx.parseExtractionResponse_(body);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${recipes.length} recipe(s) in ${secs}s, ${body.usage.input_tokens} in / ${body.usage.output_tokens} out tokens`);
    fs.writeFileSync(file + '.recipe.json', JSON.stringify(recipes, null, 2));
    recipes.forEach((r, i) => {
      console.log(`  - ${r.title}: ${r.ingredientGroups.flatMap(g => g.items).length} ingredients, ${r.steps.length} steps`);
      all.push({ ...r, id: `${path.basename(file)}-${i}`, sourceName: path.basename(file), addedBy: 'test', addedAt: new Date().toISOString(), photoFileId: null });
    });
  } catch (e) {
    failed = true;
    console.log(`FAILED: ${e.message}`);
  }
}

if (!failed && all.length) {
  const out = path.join(root, 'docs/demo/recipes.json');
  fs.writeFileSync(out, JSON.stringify({ version: 1, updated: new Date().toISOString(), sources: {}, recipes: all }, null, 2));
  console.log(`\nWrote ${all.length} recipes to ${path.relative(root, out)}; open the site with ?demo to preview.`);
}
