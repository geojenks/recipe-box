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
  '  except estimatedTimes, where you should give your best estimate and set timesAreEstimated to true.',
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
          'sourceNotes', 'sourceCredit'
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
          sourceCredit: nullable_('string', 'Author, book or website if stated')
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
