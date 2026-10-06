/**
 * Recipe extraction: prompt, JSON schema and Claude request builder.
 *
 * Kept free of Apps Script services so tools/test-extract.mjs can load this
 * file in Node and send the exact same request against local sample files.
 */

// Sonnet 5.5: about half the cost of Opus for this job. 'claude-haiku-4-5' is
// cheaper still (remove effort/fallbacks below if you switch to it).
var CLAUDE_MODEL = 'claude-sonnet-5-5';
var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

var SYSTEM_PROMPT = [
  'You convert recipes into a uniform structured format for a small private recipe website.',
  'The input may be a PDF, a photo of a cookbook page or handwritten card, or plain text.',
  '',
  'Rules:',
  '- Transcribe faithfully. Do not invent ingredients, quantities or steps that are not in the source.',
  '  If a value is genuinely absent (e.g. no cook time given), use null rather than guessing,',
  '  except prep/cook/total times, where you should give your best estimate and set timesAreEstimated to true.',
  '- Quantities: keep the source units. Put the number in "quantity" as written (e.g. "1 1/2", "200", "a pinch").',
  '- "canonical" is the plain ingredient for searching: lowercase, singular, no brand, no preparation',
  '  (e.g. "2 large red onions, finely sliced" -> canonical "red onion"; "Maldon sea salt" -> "salt").',
  '- Mark "staple": true only for pantry basics almost every kitchen always has: salt, black pepper, water,',
  '  cooking oil, olive oil, butter, plain flour, sugar. Everything else (fresh produce, meat, fish, cheese,',
  '  cream, eggs, specific spices and herbs, sauces) is not a staple.',
  '- Steps: split the method into short single-action steps. For each step list "dependsOn": the ids of the',
  '  earlier steps whose output it needs. Steps that can happen in parallel (e.g. making a sauce while pasta',
  '  boils) should NOT depend on each other, so the method can be drawn as a flowchart.',
  '  Step ids are "s1", "s2", ... in source order. "label" is a 2-5 word summary for the flowchart box.',
  '- "sourceNotes" holds tips, variations, storage or serving notes from the source itself.',
  '- "author" is the chef or writer credited for the recipe, and "book" the cookbook, magazine or website',
  '  it comes from, as printed. Use page headers/footers and printed URLs as clues. null if not shown.',
  '  "sourceUrl" is a web address printed on the page (e.g. in a browser print header), else null.',
  '- "dishPhoto": if the file contains a photograph of the finished dish, give the page it is on (1 = first',
  '  page or the image itself) and its bounding box as fractions of that page\'s width and height',
  '  (left, top, width, height, each 0-1), drawn tightly around the photo only, excluding captions and borders.',
  '  Pick the main photo of the finished dish; ignore logos, adverts, step-by-step photos and photos of other',
  '  recipes. null if there is no such photo.',
  '- If the file contains several recipes, return each one in the recipes array.',
  '  If it contains no recipe at all, return an empty recipes array.'
].join('\n');

function nullable_(type, description) {
  var s = { anyOf: [{ type: type }, { type: 'null' }] };
  if (description) s.description = description;
  return s;
}
var NULLABLE_INT = nullable_('integer');
var NULLABLE_STR = nullable_('string');

var RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recipes'],
  properties: {
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title', 'description', 'servings', 'prepMinutes', 'cookMinutes', 'totalMinutes',
          'timesAreEstimated', 'course', 'cuisine', 'tags', 'ingredientGroups', 'steps',
          'sourceNotes', 'author', 'book', 'sourceUrl', 'dishPhoto'
        ],
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: 'One or two sentence summary of the dish.' },
          servings: NULLABLE_STR,
          prepMinutes: NULLABLE_INT,
          cookMinutes: NULLABLE_INT,
          totalMinutes: NULLABLE_INT,
          timesAreEstimated: { type: 'boolean' },
          course: { type: 'string', description: 'e.g. Breakfast, Starter, Main, Side, Dessert, Baking, Drink, Snack' },
          cuisine: NULLABLE_STR,
          tags: { type: 'array', items: { type: 'string' } },
          ingredientGroups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'items'],
              properties: {
                name: nullable_('string', 'e.g. "For the sauce"; null for a single ungrouped list'),
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['quantity', 'unit', 'name', 'canonical', 'preparation', 'optional', 'staple'],
                    properties: {
                      quantity: NULLABLE_STR,
                      unit: NULLABLE_STR,
                      name: { type: 'string' },
                      canonical: { type: 'string' },
                      preparation: NULLABLE_STR,
                      optional: { type: 'boolean' },
                      staple: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'text', 'minutes', 'dependsOn'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                text: { type: 'string' },
                minutes: NULLABLE_INT,
                dependsOn: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          sourceNotes: { type: 'array', items: { type: 'string' } },
          author: NULLABLE_STR,
          book: NULLABLE_STR,
          sourceUrl: NULLABLE_STR,
          dishPhoto: {
            anyOf: [{ type: 'null' }, {
              type: 'object',
              additionalProperties: false,
              required: ['page', 'left', 'top', 'width', 'height'],
              properties: {
                page: { type: 'integer' },
                left: { type: 'number' },
                top: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' }
              }
            }]
          }
        }
      }
    }
  }
};

/**
 * Builds the Messages API request body.
 * @param {{kind: 'pdf'|'image'|'text', mediaType?: string, base64?: string, text?: string}} input
 * @param {string} fileName shown to Claude as a hint (often contains the dish name)
 */
function buildExtractionRequest_(input, fileName) {
  var content = [];
  if (input.kind === 'pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } });
  } else if (input.kind === 'image') {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.base64 } });
  } else {
    content.push({ type: 'text', text: input.text });
  }
  content.push({ type: 'text', text: 'File name: ' + fileName + '\nExtract the recipe(s) from this file.' });

  return {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    // Extraction is straightforward; low effort keeps each call quick (Apps Script
    // requests time out) and cheap.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RECIPE_SCHEMA } },
    // If a safety check wrongly declines a recipe, Anthropic retries it on another model.
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: content }]
  };
}

var CLAUDE_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'server-side-fallback-2026-07-01'
};

/** Parses a Messages API response body into {recipes: [...]}, or throws. */
function parseExtractionResponse_(body) {
  if (body.type === 'error') throw new Error('Claude API error: ' + body.error.type + ': ' + body.error.message);
  if (body.stop_reason === 'refusal') throw new Error('Claude declined to process this file');
  if (body.stop_reason === 'max_tokens') throw new Error('Response was cut off (recipe too long)');
  var text = body.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return JSON.parse(text);
}

// ---------- checking an extracted recipe ----------
//
// A second, text-only pass over each recipe once it has been extracted. It lists
// the equipment, traces every step that uses something made earlier, and flags
// anything a cook could get wrong: mostly a later step referring back to a pot or
// mixture ("add the raisins to the cream") where the flowchart links may be wrong.

// The kinds the website has icons for. Anything else is "other", with a name;
// if the same "other" keeps coming up, add it here and to the site's icons.
var EQUIPMENT_KINDS = [
  'saucepan', 'frying pan', 'wok', 'casserole', 'roasting tin', 'baking tray', 'baking dish',
  'cake tin', 'mixing bowl', 'food processor', 'blender', 'mixer', 'other'
];

var CHECK_PROMPT = [
  'You check recipes that were converted from cookbook pages into numbered steps with a flowchart, for a',
  'small private recipe website. Each step has an id, its text, and "dependsOn": the earlier steps whose',
  'output it uses. The flowchart is drawn from dependsOn, so a wrong or missing link sends the cook wrong.',
  'Cookbooks are often written out of order: a later paragraph says "now add the raisins to the cream" about',
  'a pot last touched much earlier. That is where conversions go wrong, so look hardest there.',
  '',
  'Give, in this order:',
  '1. "equipment": the pots, pans, tins, bowls and machines the cook needs. Use one of the listed kinds;',
  '   for anything else use "other" and name it in "other" (e.g. "slow cooker", "griddle pan").',
  '   Kinds: saucepan (includes stockpots and milk pans); frying pan (includes sauté pans and skillets);',
  '   wok; casserole (heavy lidded pot that can go in the oven); roasting tin; baking tray (flat sheet);',
  '   baking dish (ovenproof, gratin or pie dish); cake tin (includes loaf, tart and muffin tins);',
  '   mixing bowl; food processor (includes mini choppers); blender (jug or stick blender);',
  '   mixer (stand mixer or electric whisk).',
  '   "count" is how many of that kind you need, i.e. the most in use at once, counting one that is holding',
  '   something set aside for later. Leave out knives, boards, spoons, whisks, sieves, graters, jugs,',
  '   scales, serving plates and the hob or oven itself. Only include a mixing bowl if something is mixed,',
  '   soaked or marinated in it; a bowl of any size used that way is a mixing bowl, not "other".',
  '   Count what the steps actually need, even if the recipe does not name it.',
  '2. "references": for every step that uses something prepared in an earlier step (a mixture, a pot,',
  '   a sauce, "the onions", "it"), the words that refer to it, the id of the step where that thing was made',
  '   or last changed ("madeIn", null if it was never made), and whether you are sure.',
  '3. "unclear": places where the conversion into steps and flowchart may send a cook wrong. Include:',
  '   - a reference you are not sure about, or that could mean more than one earlier thing;',
  '   - a step whose dependsOn does not lead back to the step its reference was made in, directly or',
  '     through earlier steps (a link through earlier steps is fine: do not report it);',
  '   - a step that uses something before it has been made, an instruction that belongs earlier',
  '     (e.g. "five minutes before the end, add..." written after that stage), or steps out of order;',
  '   - an ingredient in the list that no step uses.',
  '   Do not report things the original probably left out too (how to prepare an ingredient, a choice of',
  '   alternatives, slightly different wording), style, or missing times. If you look at something and',
  '   conclude it is fine, leave it out. Most recipes have nothing unclear: return an empty list then.',
  '   For each: the step id; "serious": true if a cook following the steps or flowchart would likely get',
  '   the dish wrong (wrong order, a missing link, something used before it exists), false for a minor',
  '   point; and a "note" of one or two plain sentences telling the cook what to check, e.g. "Step 9 adds',
  '   the raisins to \'the cream\', which was heated in step 2, but the flowchart does not link step 9 to',
  '   step 2." Write "step 9", never the id ("s9"), and "the flowchart", never "dependsOn".',
  '4. "certainty": 0-100, how sure you are that a cook following the steps and the flowchart would make',
  '   the dish correctly. Work it out from your unclear list: 95-100 when it is empty; take off about 5',
  '   for each minor point and 20-30 for each serious one. Below 60 means the recipe should be checked',
  '   against the original before anyone cooks it.'
].join('\n');

var CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['equipment', 'references', 'unclear', 'certainty'],
  properties: {
    equipment: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'count', 'other'],
        properties: {
          kind: { type: 'string', enum: EQUIPMENT_KINDS },
          count: { type: 'integer' },
          other: nullable_('string', 'Name of the equipment when kind is "other", else null')
        }
      }
    },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'words', 'madeIn', 'sure'],
        properties: {
          step: { type: 'string' },
          words: { type: 'string' },
          madeIn: NULLABLE_STR,
          sure: { type: 'boolean' }
        }
      }
    },
    unclear: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'serious', 'note'],
        properties: {
          step: NULLABLE_STR,
          serious: { type: 'boolean' },
          note: { type: 'string' }
        }
      }
    },
    certainty: { type: 'integer' }
  }
};

/** The parts of an extracted recipe the check needs, as compact text for Claude. */
function recipeForCheck_(r) {
  var lines = ['Title: ' + r.title, '', 'Ingredients:'];
  r.ingredientGroups.forEach(function (g) {
    if (g.name) lines.push(g.name + ':');
    g.items.forEach(function (i) {
      lines.push('- ' + [i.quantity, i.unit, i.name].filter(Boolean).join(' ') +
        (i.preparation ? ', ' + i.preparation : '') + (i.optional ? ' (optional)' : ''));
    });
  });
  lines.push('', 'Steps:');
  r.steps.forEach(function (s) {
    lines.push(s.id + ' [dependsOn: ' + (s.dependsOn.length ? s.dependsOn.join(', ') : 'none') + '] ' + s.text);
  });
  if (r.sourceNotes && r.sourceNotes.length) lines.push('', 'Notes from the original:', r.sourceNotes.join('\n'));
  return lines.join('\n');
}

// Checks go through the batch service: half price, results within 24 hours
// (usually under one). It doesn't accept `fallbacks` or need its beta header.
var CLAUDE_BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';
var BATCH_HEADERS = { 'anthropic-version': '2023-06-01' };

function buildCheckRequest_(r) {
  return {
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CHECK_SCHEMA } },
    // The instructions are the same for every recipe, so Claude keeps them cached
    // (a tenth of the price on reuse). One hour, as a batch runs in any order.
    system: [{ type: 'text', text: CHECK_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: recipeForCheck_(r) }]
  };
}

/**
 * Parses a check response into the fields stored on the recipe:
 * {equipment, unclear, certainty, references}, or throws.
 *
 * Claude traces the references reliably but doesn't always notice when the
 * flowchart fails to follow one, so that comparison is done here.
 */
function parseCheckResponse_(body, r) {
  var out = parseExtractionResponse_(body);
  var pos = {};
  r.steps.forEach(function (s, i) { pos[s.id] = i; });
  var num = function (id) { return pos[id] + 1; };

  // Every step each step leads back to through dependsOn.
  var before = {};
  r.steps.forEach(function (s) {
    var set = {};
    s.dependsOn.forEach(function (d) {
      if (!(d in before)) return; // unknown or later step
      set[d] = true;
      Object.keys(before[d]).forEach(function (a) { set[a] = true; });
    });
    before[s.id] = set;
  });

  // Notes are read by cooks: "step 5", not the id "s5".
  var plain = function (note) {
    return note.replace(/\b(step )?(s\d+)\b/gi, function (all, word, id) {
      id = id.toLowerCase();
      return id in pos ? (word && word[0] === 'S' ? 'Step ' : 'step ') + num(id) : all;
    });
  };
  var unclear = out.unclear.map(function (u) {
    return { step: u.step in pos ? u.step : null, serious: u.serious, note: plain(u.note) };
  });
  var flagged = {};
  unclear.forEach(function (u) { if (u.step) flagged[u.step] = flagged[u.step] || u.serious; });
  out.references.forEach(function (ref) {
    var step = ref.step, from = ref.madeIn;
    if (!(step in pos) || flagged[step]) return;
    var item = null;
    if (from in pos && pos[from] > pos[step]) {
      item = { serious: true, note: 'Step ' + num(step) + ' uses "' + ref.words + '", which isn\'t made until step ' +
        num(from) + '. Check the order against the original.' };
    } else if (from in pos && from !== step && !before[step][from]) {
      item = { serious: true, note: 'Step ' + num(step) + ' uses "' + ref.words + '" from step ' + num(from) +
        ', but the flowchart doesn\'t link step ' + num(step) + ' back to step ' + num(from) + '. Check against the original.' };
    } else if (!ref.sure && flagged[step] === undefined) {
      item = { serious: false, note: 'Step ' + num(step) + ' says "' + ref.words + '"' +
        (from in pos ? ', taken to mean what was made in step ' + num(from) : '') + '. Check that is right.' };
    }
    if (item) {
      item.step = step;
      unclear.push(item);
      flagged[step] = flagged[step] || item.serious;
    }
  });

  var serious = unclear.filter(function (u) { return u.serious; }).length;
  var fromList = 100 - 25 * serious - 5 * (unclear.length - serious);
  return {
    equipment: out.equipment.filter(function (e) { return e.count > 0; }).map(function (e) {
      return { kind: e.kind, count: e.count, other: e.kind === 'other' ? (e.other || 'other') : null };
    }),
    unclear: unclear,
    certainty: Math.max(0, Math.min(100, out.certainty, fromList)),
    references: out.references
  };
}
