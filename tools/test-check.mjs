#!/usr/bin/env node
// Runs the same recipe check the Apps Script job uses (equipment, unclear steps,
// certainty) on recipes already extracted, from JSON files.
//
//   ANTHROPIC_API_KEY=sk-ant-... node tools/test-check.mjs docs/demo/recipes.json
//   ANTHROPIC_API_KEY=sk-ant-... node tools/test-check.mjs --write docs/demo/recipes.json
//
// A file can hold a recipes.json index, an array of recipes, or one recipe.
// --write saves the results back into the file (for the demo data).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Extract.gs'), 'utf8'), ctx);

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a !== '--write');
const key = process.env.ANTHROPIC_API_KEY;
if (!key || !files.length) {
  console.error('Usage: ANTHROPIC_API_KEY=... node tools/test-check.mjs [--write] <files...>');
  process.exit(1);
}

// The early test extractions used snake_case and numeric step ids.
function normalise(r) {
  if (r.ingredientGroups) return r;
  return {
    ...r,
    ingredientGroups: r.ingredient_groups.map((g) => ({ name: g.name ?? null, items: g.items })),
    steps: r.steps.map((s) => ({ id: `s${s.id}`, label: s.label, text: s.text, dependsOn: (s.depends_on || []).map((d) => `s${d}`) })),
    sourceNotes: r.book_notes || [],
  };
}

async function check(r) {
  const started = Date.now();
  const res = await fetch(ctx.CLAUDE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, ...ctx.CLAUDE_HEADERS },
    body: JSON.stringify(ctx.buildCheckRequest_(r)),
  });
  const body = await res.json();
  const result = ctx.parseCheckResponse_(body, r);
  return { result, secs: ((Date.now() - started) / 1000).toFixed(1), usage: body.usage };
}

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = data.recipes || (Array.isArray(data) ? data : [data]);
  await Promise.all(list.map(async (raw, i) => {
    const r = normalise(raw);
    try {
      const { result, secs, usage } = await check(r);
      const kit = result.equipment.map((e) => `${e.kind === 'other' ? e.other : e.kind}${e.count > 1 ? ` x${e.count}` : ''}`).join(', ');
      console.log(`\n${r.title} (${path.basename(file)}): certainty ${result.certainty}, ${secs}s, ${usage.input_tokens} in / ${usage.output_tokens} out`);
      console.log(`  equipment: ${kit}`);
      for (const u of result.unclear) console.log(`  ${u.serious ? "SERIOUS" : "minor"} ${u.step ?? "-"}: ${u.note}`);
      const unsure = result.references.filter((x) => !x.sure);
      if (unsure.length) console.log(`  unsure references: ${unsure.map((x) => `${x.step} "${x.words}" -> ${x.madeIn}`).join('; ')}`);
      if (write) Object.assign(list[i], { equipment: result.equipment, unclear: result.unclear, certainty: result.certainty, checkVersion: 1 });
    } catch (e) {
      console.log(`\n${r.title}: FAILED ${e.message}`);
    }
  }));
  if (write) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
