/**
 * Recipe Box background job.
 *
 * Watches a shared Drive folder ("inbox"), sends new or changed recipe files
 * to Claude for extraction, and writes the results to recipes.json in a data
 * subfolder, which the website reads with each user's own Google sign-in.
 *
 * Script properties (Project Settings > Script properties):
 *   ANTHROPIC_API_KEY  required
 *   INBOX_FOLDER_ID    required: the shared "Recipe Box" folder
 *   DATA_FOLDER_ID     set by setup()
 *   RECIPES_FILE_ID    set by setup()
 *   SHEET_ID           set by setup()
 */

var DATA_FOLDER_NAME = '_website data (do not edit)';
var SHEET_NAME = 'Recipe Box notes';
var TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script kills runs at 6 minutes
var MAX_ATTEMPTS = 3;
var PHOTO_SIZE = 1200;
// Bump when the extraction format changes so existing recipes are processed again.
var EXTRACT_VERSION = 2;
// Bump when photo selection changes: photos are redone from the saved
// extraction, without sending anything to Claude again.
var PHOTO_VERSION = 3;
// Bump when the recipe check (equipment, unclear steps, certainty) changes, so
// every recipe is checked again. The check reads the extracted text only.
var CHECK_VERSION = 1;
var CONTINUE_HANDLER = 'continueProcessing';

// Failures that say nothing about the file: Claude busy, rate-limited, out of
// credit or refusing the key, or the network failing (an unreadable reply is
// usually an outage page). These never count towards giving up on a file; it is
// simply tried again on the next run.
var SERVICE_ERROR = /credit balance|billing|rate_limit|overloaded|api_error|authentication_error|permission_error|HTTP 5\d\d|HTTP 429|timed? ?out|Address unavailable|too many times|unavailable|Unexpected token|not valid JSON|JSON\.parse/i;
var CREDIT_ERROR = /credit balance|billing/i;
var KEY_ERROR = /authentication_error|permission_error/i;

function isServiceError_(message) {
  return SERVICE_ERROR.test(String(message || ''));
}

var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
var CLAUDE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function props_() {
  return PropertiesService.getScriptProperties();
}

function requireProp_(name) {
  var value = props_().getProperty(name);
  if (!value) throw new Error('Missing script property ' + name + '. See README.');
  return value;
}

/**
 * Run once from the editor. Creates the data folder, recipes.json and the notes
 * spreadsheet inside the inbox folder, installs the hourly trigger, and logs the
 * IDs to paste into docs/config.js.
 */
function setup() {
  var me = Session.getEffectiveUser().getEmail();
  Logger.log('Running as ' + me);
  var inboxId = requireProp_('INBOX_FOLDER_ID').trim();
  if (!/^[\w-]{20,}$/.test(inboxId)) {
    throw new Error('INBOX_FOLDER_ID "' + inboxId + '" does not look like a folder ID. Use only the part of ' +
      'the folder URL after /folders/, without any "?usp=..." on the end.');
  }
  var inbox;
  try {
    inbox = DriveApp.getFolderById(inboxId);
    Logger.log('Found folder "' + inbox.getName() + '"');
  } catch (e) {
    throw new Error(me + ' cannot open folder ' + inboxId + '. Check the ID, and that this account can see the folder. (' + e.message + ')');
  }
  var p = props_();

  var dataFolder;
  try {
    dataFolder = p.getProperty('DATA_FOLDER_ID')
      ? DriveApp.getFolderById(p.getProperty('DATA_FOLDER_ID'))
      : inbox.createFolder(DATA_FOLDER_NAME);
  } catch (e) {
    throw new Error(me + ' can see "' + inbox.getName() + '" but cannot add to it. Run this script from the ' +
      'account that owns the folder, or share the folder with ' + me + ' as Editor. If DATA_FOLDER_ID is set ' +
      'in Script properties from an earlier attempt, delete it. (' + e.message + ')');
  }
  p.setProperty('DATA_FOLDER_ID', dataFolder.getId());

  if (!p.getProperty('RECIPES_FILE_ID')) {
    var file = dataFolder.createFile('recipes.json', JSON.stringify(emptyIndex_()), 'application/json');
    p.setProperty('RECIPES_FILE_ID', file.getId());
  }

  if (!p.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create(SHEET_NAME);
    var notes = ss.getSheets()[0].setName('Notes');
    notes.appendRow(['id', 'recipeId', 'timestamp', 'email', 'name', 'text']);
    notes.setFrozenRows(1);
    var status = ss.insertSheet('Status');
    status.appendRow(['file', 'status', 'recipes', 'detail', 'checked']);
    status.setFrozenRows(1);
    DriveApp.getFileById(ss.getId()).moveTo(inbox);
    p.setProperty('SHEET_ID', ss.getId());
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyHours(1).create();

  Logger.log('Setup complete. Paste these into docs/config.js:');
  Logger.log("  recipesFileId: '" + p.getProperty('RECIPES_FILE_ID') + "',");
  Logger.log("  sheetId: '" + p.getProperty('SHEET_ID') + "',");
  Logger.log("  inboxFolderId: '" + inbox.getId() + "',");
}

function emptyIndex_() {
  return { version: 1, updated: null, sources: {}, recipes: [] };
}

function loadIndex_() {
  var text = DriveApp.getFileById(requireProp_('RECIPES_FILE_ID')).getBlob().getDataAsString();
  return text ? JSON.parse(text) : emptyIndex_();
}

function saveIndex_(index) {
  index.updated = new Date().toISOString();
  DriveApp.getFileById(requireProp_('RECIPES_FILE_ID')).setContent(JSON.stringify(index));
}

/** Hourly trigger entry point. Safe to run by hand from the editor too. */
async function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous run is still going
  try {
    await processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

async function processInboxLocked_() {
  var started = Date.now();
  var inbox = DriveApp.getFolderById(requireProp_('INBOX_FOLDER_ID'));
  var dataFolderId = requireProp_('DATA_FOLDER_ID');
  var sheetId = requireProp_('SHEET_ID');
  var index = loadIndex_();

  var files = [];
  collectFiles_(inbox, dataFolderId, files);
  files = files.filter(function (f) { return f.getId() !== sheetId; });

  var plan = planSources_(files);
  var seen = {};
  var changed = false;

  var pending = [];
  var held = []; // new files left for the next run because Claude is unavailable
  var claudeDown = false;
  var outOfTime = function () { return Date.now() - started > TIME_BUDGET_MS; };

  for (const item of plan.sources) {
    const file = item.file;
    const id = file.getId();
    seen[id] = true;
    const modified = file.getLastUpdated().toISOString();
    const photo = item.photo;
    const photoKey = photo ? photo.getId() + '@' + photo.getLastUpdated().toISOString() : null;
    const entry = index.sources[id];

    const needsWork = !entry || entry.modified !== modified || entry.photoKey !== photoKey ||
      (entry.extractVersion !== EXTRACT_VERSION && entry.status !== 'error') ||
      (entry.status === 'error' && (entry.attempts < MAX_ATTEMPTS || isServiceError_(entry.error)));
    const needsPhoto = !needsWork && entry.status === 'ok' && (entry.photoVersion !== PHOTO_VERSION ||
      (entry.photoRetry && (entry.photoAttempts || 0) < MAX_ATTEMPTS));
    if (entry) entry.name = file.getName();
    if (!needsWork && !needsPhoto) continue;
    if (needsWork && claudeDown) { // no point trying more files this run
      if (!entry) held.push(file.getName());
      continue;
    }
    if (outOfTime()) { // pick it up on the follow-up run
      if (needsWork) pending.push(file.getName());
      continue;
    }

    if (needsPhoto) {
      const pdf = inputKind_(file) === 'pdf' ? pdfBlobFor_(file) : null;
      const recipes = index.recipes.filter(function (r) { return r.sourceFileId === id; });
      const result = await attachPhotos_(file, photo, id, recipes, pdf);
      entry.photoVersion = PHOTO_VERSION;
      entry.photoRetry = result.incomplete;
      entry.photoAttempts = result.incomplete ? (entry.photoAttempts || 0) + 1 : 0;
      changed = true;
      saveIndex_(index);
      continue;
    }

    const attempts = entry && entry.modified === modified && entry.status === 'error' ? entry.attempts : 0;
    try {
      const pdf = inputKind_(file) === 'pdf' ? pdfBlobFor_(file) : null;
      const recipes = extractRecipes_(file, pdf);
      removeRecipesForSource_(index, id);
      const photos = await attachPhotos_(file, photo, id, recipes, pdf);
      recipes.forEach(function (r, i) {
        index.recipes.push(decorateRecipe_(r, i, file));
      });
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey,
        extractVersion: EXTRACT_VERSION, photoVersion: PHOTO_VERSION,
        photoRetry: photos.incomplete, photoAttempts: photos.incomplete ? 1 : 0,
        status: recipes.length ? 'ok' : 'no recipe found',
        recipes: recipes.length, attempts: 0, error: null
      };
    } catch (e) {
      const message = String(e.message || e);
      const service = isServiceError_(message);
      if (service) claudeDown = true;
      if (service && entry && entry.status === 'ok') {
        // An edited file that worked before: keep its recipes and try again next run.
        entry.modified = null;
        Logger.log('Claude unavailable for ' + file.getName() + ': ' + message);
        changed = true;
        continue;
      }
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey, extractVersion: EXTRACT_VERSION,
        status: 'error', recipes: entry ? entry.recipes : 0,
        attempts: service ? attempts : attempts + 1, error: message
      };
      Logger.log('Failed on ' + file.getName() + ': ' + message);
    }
    changed = true;
    saveIndex_(index); // save after each file so a timeout loses nothing
  }

  // Files removed from the inbox: drop their recipes and generated photos.
  Object.keys(index.sources).forEach(function (id) {
    if (seen[id]) return;
    removeRecipesForSource_(index, id);
    trashPhotosFor_(id);
    delete index.sources[id];
    changed = true;
  });

  var unchecked = checkRecipes_(index);
  if (changed) saveIndex_(index);
  writeStatus_(index, plan.skipped, pending, held, unchecked);
  scheduleContinuation_(outOfTime());
}

function recipesToCheck_(index) {
  return index.recipes.filter(function (r) {
    return r.checkVersion !== CHECK_VERSION &&
      ((r.checkAttempts || 0) < MAX_ATTEMPTS || isServiceError_(r.checkError));
  });
}

/**
 * Checks recipes that haven't been checked yet, through Anthropic's batch
 * service. Each run first collects the batch sent by an earlier run, if Claude
 * has finished it, then sends every recipe still to check as one new batch.
 * Sets on each recipe:
 *   equipment   [{kind, count, other}]
 *   unclear     [{step, serious, note}] places the steps or flowchart may be wrong
 *   certainty   0-100
 * index.checkBatch holds the batch Claude is working on: {id, sent, recipes},
 * where recipes maps each recipe id to a fingerprint of what was sent, so a
 * recipe edited in the meantime isn't given an out-of-date result.
 * Saves as it goes. Returns how many are still to check.
 */
function checkRecipes_(index) {
  try {
    var key = requireProp_('ANTHROPIC_API_KEY');
    var batch = index.checkBatch;
    if (batch) {
      var info;
      try {
        info = batchRequest_(key, 'get', CLAUDE_BATCH_URL + '/' + batch.id);
      } catch (e) {
        if (!/not_found/.test(e.message)) throw e;
        info = null; // gone (or a different API key): send again below
      }
      if (info && info.processing_status !== 'ended') return recipesToCheck_(index).length;
      if (info) collectCheckResults_(index, key, info, batch);
      delete index.checkBatch;
      saveIndex_(index);
    }

    var todo = recipesToCheck_(index).filter(function (r) { return /^[\w-]{1,64}$/.test(r.id); });
    if (todo.length) {
      var sent = {};
      var created = batchRequest_(key, 'post', CLAUDE_BATCH_URL, {
        requests: todo.map(function (r) {
          sent[r.id] = checkDigest_(r);
          return { custom_id: r.id, params: buildCheckRequest_(r) };
        })
      });
      index.checkBatch = { id: created.id, sent: new Date().toISOString(), recipes: sent };
      saveIndex_(index);
      Logger.log('Sent ' + recipesCount_(todo.length) + ' to Claude to check (batch ' + created.id + ').');
    }
  } catch (e) {
    Logger.log('Could not check recipes: ' + (e.message || e)); // tried again next run
  }
  return recipesToCheck_(index).length;
}

/** Stores the results of a finished batch on the recipes it covered. */
function collectCheckResults_(index, key, info, batch) {
  var resp = UrlFetchApp.fetch(info.results_url, {
    headers: Object.assign({ 'x-api-key': key }, BATCH_HEADERS), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('HTTP ' + resp.getResponseCode() + ' fetching the results of batch ' + batch.id);
  }
  var byId = {};
  index.recipes.forEach(function (r) { byId[r.id] = r; });
  var done = 0;
  resp.getContentText().split('\n').forEach(function (line) {
    if (!line.trim()) return;
    var item = JSON.parse(line);
    var r = byId[item.custom_id];
    // Removed or changed since it was sent: it goes in the next batch instead.
    if (!r || r.checkVersion === CHECK_VERSION || checkDigest_(r) !== batch.recipes[item.custom_id]) return;
    var res = item.result;
    if (res.type === 'expired' || res.type === 'canceled') return; // sent again in the next batch
    try {
      if (res.type !== 'succeeded') {
        var err = (res.error && res.error.error) || res.error || {};
        throw new Error('Claude API error: ' + err.type + ': ' + err.message);
      }
      var result = parseCheckResponse_(res.message, r);
      r.equipment = result.equipment;
      r.unclear = result.unclear;
      r.certainty = result.certainty;
      r.checkVersion = CHECK_VERSION;
      delete r.checkError;
      delete r.checkAttempts;
      done++;
    } catch (e) {
      var message = String(e.message || e);
      if (!isServiceError_(message)) r.checkAttempts = (r.checkAttempts || 0) + 1;
      r.checkError = message;
      Logger.log('Could not check ' + r.title + ': ' + message);
    }
  });
  Logger.log('Claude checked ' + recipesCount_(done) + ' (batch ' + batch.id + ').');
}

/** A call to the batch service; returns the parsed reply or throws. */
function batchRequest_(key, method, url, payload) {
  var options = { method: method, headers: Object.assign({ 'x-api-key': key }, BATCH_HEADERS), muteHttpExceptions: true };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var resp = UrlFetchApp.fetch(url, options);
  var body;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    throw new Error('HTTP ' + resp.getResponseCode() + ' from the Claude batch service');
  }
  if (body.type === 'error') throw new Error('Claude API error: ' + body.error.type + ': ' + body.error.message);
  return body;
}

function recipesCount_(n) {
  return n + (n === 1 ? ' recipe' : ' recipes');
}

/** A short fingerprint of the text a recipe's check is based on. */
function checkDigest_(r) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, recipeForCheck_(r), Utilities.Charset.UTF_8));
}

/** One-off trigger that carries on a minute later when a run ran out of time. */
function scheduleContinuation_(needed) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === CONTINUE_HANDLER) ScriptApp.deleteTrigger(t);
  });
  if (needed) ScriptApp.newTrigger(CONTINUE_HANDLER).timeBased().after(60 * 1000).create();
}

async function continueProcessing() {
  await processInbox();
}

/**
 * Run by hand from the editor to try every failed file again now, including
 * ones the job gave up on (for example after fixing a broken file in place).
 */
async function retryFailed() {
  var index = loadIndex_();
  var count = 0;
  Object.keys(index.sources).forEach(function (id) {
    var s = index.sources[id];
    if (s.status === 'error') { s.attempts = 0; count++; }
  });
  index.recipes.forEach(function (r) { delete r.checkAttempts; });
  saveIndex_(index);
  Logger.log('Trying ' + count + ' failed files again.');
  await processInbox();
}

function collectFiles_(folder, dataFolderId, out) {
  var it = folder.getFiles();
  while (it.hasNext()) out.push(it.next());
  var sub = folder.getFolders();
  while (sub.hasNext()) {
    var f = sub.next();
    if (f.getId() !== dataFolderId) collectFiles_(f, dataFolderId, out);
  }
}

/**
 * Decides which files are recipes and which are photos. An image that shares
 * its name with another file (Lasagne.pdf + Lasagne.jpg) is that recipe's photo;
 * any other image is treated as a photographed recipe.
 */
function planSources_(files) {
  var byBase = {};
  files.forEach(function (f) {
    var base = f.getName().replace(/\.[^.]+$/, '').trim().toLowerCase();
    (byBase[base] = byBase[base] || []).push(f);
  });

  var sources = [];
  var skipped = [];
  Object.keys(byBase).forEach(function (base) {
    var group = byBase[base];
    var images = group.filter(function (f) { return IMAGE_TYPES.indexOf(f.getMimeType()) >= 0; });
    var docs = group.filter(function (f) { return IMAGE_TYPES.indexOf(f.getMimeType()) < 0; });
    if (docs.length) {
      docs.forEach(function (d) {
        if (inputKind_(d)) sources.push({ file: d, photo: images[0] || null });
        else skipped.push(d.getName());
      });
    } else {
      images.forEach(function (img) { sources.push({ file: img, photo: null }); });
    }
  });
  return { sources: sources, skipped: skipped };
}

function inputKind_(file) {
  var type = file.getMimeType();
  if (type === 'application/pdf') return 'pdf';
  if (type === MimeType.GOOGLE_DOCS || type === MimeType.MICROSOFT_WORD) return 'pdf';
  if (IMAGE_TYPES.indexOf(type) >= 0) return 'image';
  if (type === 'text/plain' || type === 'text/markdown' || type === 'text/html') return 'text';
  return null;
}

function pdfBlobFor_(file) {
  return file.getMimeType() === 'application/pdf' ? file.getBlob() : exportAsPdf_(file);
}

function claudeInputFor_(file, pdf) {
  var kind = inputKind_(file);
  var type = file.getMimeType();
  if (kind === 'pdf') return { kind: 'pdf', base64: Utilities.base64Encode(pdf.getBytes()) };
  if (kind === 'image') {
    if (CLAUDE_IMAGE_TYPES.indexOf(type) >= 0 && file.getSize() < 4.5 * 1024 * 1024) {
      return { kind: 'image', mediaType: type, base64: Utilities.base64Encode(file.getBlob().getBytes()) };
    }
    // HEIC from iPhones, or very large photos: use Drive's JPEG rendering instead.
    return { kind: 'image', mediaType: 'image/jpeg', base64: Utilities.base64Encode(driveThumbnail_(file, 2000).getBytes()) };
  }
  return { kind: 'text', text: file.getBlob().getDataAsString() };
}

function exportAsPdf_(file) {
  if (file.getMimeType() === MimeType.GOOGLE_DOCS) return file.getAs('application/pdf');
  // Word files: convert via a temporary Google Doc copy.
  var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '/copy', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ mimeType: MimeType.GOOGLE_DOCS, name: 'tmp-' + file.getName() }),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  var copyId = JSON.parse(resp.getContentText()).id;
  try {
    return DriveApp.getFileById(copyId).getAs('application/pdf');
  } finally {
    trashQuietly_(copyId);
  }
}

function extractRecipes_(file, pdf) {
  var request = buildExtractionRequest_(claudeInputFor_(file, pdf), file.getName());
  var resp = UrlFetchApp.fetch(CLAUDE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: Object.assign({ 'x-api-key': requireProp_('ANTHROPIC_API_KEY') }, CLAUDE_HEADERS),
    payload: JSON.stringify(request),
    muteHttpExceptions: true
  });
  var body;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    throw new Error('HTTP ' + resp.getResponseCode() + ' from the Claude API');
  }
  return parseExtractionResponse_(body).recipes;
}

function decorateRecipe_(r, i, file) {
  var owner = null;
  try { owner = file.getOwner(); } catch (e) { /* shared drives have no owner */ }
  r.id = file.getId() + '-' + i;
  r.sourceFileId = file.getId();
  r.sourceName = file.getName();
  r.addedBy = owner ? (owner.getName() || owner.getEmail()) : null;
  r.addedAt = file.getDateCreated().toISOString();
  return r;
}

function removeRecipesForSource_(index, sourceId) {
  index.recipes = index.recipes.filter(function (r) { return r.sourceFileId !== sourceId; });
}

/**
 * Saves the pictures for one source file into the data folder and sets on each recipe:
 *   photoFileId
 *   photoKind  'dish' (a photo of the food) or 'page' (a picture of the recipe itself)
 *   photoCrop  {left, top, width, height} as page fractions when the dish photo has to be
 *              cut out of a page picture (the website does the cutting), else null
 * Preference: uploaded photo with the same name > JPEG embedded in the PDF > crop of the
 * page Claude found the photo on. Returns {incomplete: true} if a page picture wasn't
 * ready yet, so the next run tries again.
 */
async function attachPhotos_(file, uploaded, sourceId, recipes, pdf) {
  var dataFolder = DriveApp.getFolderById(requireProp_('DATA_FOLDER_ID'));
  trashPhotosFor_(sourceId);
  var save = function (blob, suffix) {
    return dataFolder.createFile(blob.setName('photo-' + sourceId + suffix + '.jpg')).getId();
  };
  var setAll = function (id, kind) {
    recipes.forEach(function (r) { r.photoFileId = id; r.photoKind = kind; r.photoCrop = null; });
  };

  try {
    if (uploaded) {
      setAll(save(driveThumbnail_(uploaded, PHOTO_SIZE), ''), 'dish');
      return { incomplete: false };
    }
    if (pdf && recipes.length === 1 && recipes[0].dishPhoto) {
      var embedded = embeddedDishPhoto_(pdf);
      if (embedded) {
        setAll(save(embedded, ''), 'dish');
        return { incomplete: false };
      }
    }

    var crops = recipes.map(function (r) { return cleanCrop_(r.dishPhoto); });
    var page1Crop = crops.some(function (c) { return c && c.page === 1; });
    var pictures = {};
    var incomplete = false;
    var pictureOf = async function (page) {
      if (!(page in pictures)) {
        var id = null;
        if (page === 1) {
          id = save(driveThumbnail_(file, page1Crop ? 2400 : PHOTO_SIZE), '-p1');
        } else if (pdf) {
          var rendered = await renderPdfPage_(pdf, page, dataFolder);
          if (rendered.blob) id = save(rendered.blob, '-p' + page);
          else if (!rendered.missing) incomplete = true;
        }
        pictures[page] = id;
      }
      return pictures[page];
    };

    for (let i = 0; i < recipes.length; i++) {
      const r = recipes[i];
      const crop = crops[i];
      const id = crop ? await pictureOf(crop.page) : null;
      if (id) {
        r.photoFileId = id;
        r.photoKind = 'dish';
        r.photoCrop = crop.box;
      } else {
        r.photoFileId = await pictureOf(1);
        r.photoKind = 'page';
        r.photoCrop = null;
      }
    }
    return { incomplete: incomplete };
  } catch (e) {
    Logger.log('No photo for ' + file.getName() + ': ' + e);
    setAll(null, null);
    return { incomplete: true };
  }
}

/** Claude's photo box, clamped to the page; null if it's too small to be a real photo. */
function cleanCrop_(box) {
  if (!box || !(box.page >= 1)) return null;
  var clamp = function (v) { return Math.min(1, Math.max(0, v)); };
  var left = clamp(box.left), top = clamp(box.top);
  var width = Math.min(clamp(box.width), 1 - left);
  var height = Math.min(clamp(box.height), 1 - top);
  if (width < 0.1 || height < 0.05) return null;
  return { page: box.page, box: { left: left, top: top, width: width, height: height } };
}

/**
 * Pictures page N of a PDF: copies that page into a temporary one-page PDF and
 * waits for Drive to render it. Returns {blob}, {missing: true} if the PDF has no
 * such page, or {} if Drive hasn't rendered it yet.
 */
async function renderPdfPage_(pdf, page, dataFolder) {
  var single = await extractPdfPage_(pdf.getBytes(), page, function () {
    return UrlFetchApp.fetch(PDF_LIB_URL).getContentText();
  });
  if (!single) return { missing: true };
  var bytes = Array.from(new Int8Array(single.buffer, single.byteOffset, single.length));
  var tmp = dataFolder.createFile(Utilities.newBlob(bytes, 'application/pdf', 'tmp-page.pdf'));
  try {
    for (var i = 0; i < 8; i++) {
      var link = thumbnailLink_(tmp.getId());
      if (link) return { blob: fetchThumbnail_(link, 2400) };
      Utilities.sleep(4000);
    }
    Logger.log('Drive had not rendered page ' + page + ' yet; will retry next run');
    return {};
  } finally {
    trashQuietly_(tmp.getId());
  }
}

function trashPhotosFor_(sourceId) {
  var dataFolder = DriveApp.getFolderById(requireProp_('DATA_FOLDER_ID'));
  var it = dataFolder.searchFiles("title contains 'photo-" + sourceId + "' and trashed = false");
  while (it.hasNext()) it.next().setTrashed(true);
}

function embeddedDishPhoto_(pdf) {
  try {
    var bytes = pdf.getBytes();
    var text = Utilities.newBlob(bytes).getDataAsString('ISO-8859-1');
    // A PDF with no fonts is a scan: its biggest image is the whole page, not the dish.
    if (text.indexOf('/Font') === -1) return null;
    var pick = pickDishPhoto_(findPdfJpegs_(text));
    return pick ? Utilities.newBlob(bytes.slice(pick.start, pick.end), 'image/jpeg') : null;
  } catch (e) {
    Logger.log('Could not look for an embedded photo: ' + e);
    return null;
  }
}

function thumbnailLink_(fileId) {
  var meta = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }
  );
  return JSON.parse(meta.getContentText()).thumbnailLink || null;
}

function fetchThumbnail_(link, size) {
  var sized = link.replace(/=s\d+$/, '=s' + size);
  return UrlFetchApp.fetch(sized, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } })
    .getBlob().getAs('image/jpeg');
}

function driveThumbnail_(file, size) {
  // Drive's thumbnailLink can be requested at any size; getThumbnail() is a small fallback.
  try {
    var link = thumbnailLink_(file.getId());
    if (link) return fetchThumbnail_(link, size);
  } catch (e) {
    Logger.log('thumbnailLink failed for ' + file.getName() + ': ' + e);
  }
  return file.getThumbnail().getAs('image/jpeg');
}

function trashQuietly_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* already gone */ }
}

/** Mirrors processing state into the Status tab so people can see what happened to their upload. */
function writeStatus_(index, skipped, pending, held, unchecked) {
  var sheet = SpreadsheetApp.openById(requireProp_('SHEET_ID')).getSheetByName('Status');
  var now = new Date();
  var rows = Object.keys(index.sources).map(function (id) {
    var s = index.sources[id];
    var detail = '';
    if (s.error && CREDIT_ERROR.test(s.error)) detail = 'Out of Claude credit when last tried. Tries again every hour.';
    else if (s.error && KEY_ERROR.test(s.error)) detail = 'Claude refused the API key. Check ANTHROPIC_API_KEY in Script properties. Tries again every hour.';
    else if (s.error && isServiceError_(s.error)) detail = s.error + ' (not a problem with the file; tries again every hour)';
    else if (s.error) detail = s.error + (s.attempts >= MAX_ATTEMPTS ? ' (gave up; re-upload or edit the file to retry)' : ' (tries again next hour)');
    return [s.name, s.status, s.recipes, detail, now];
  });
  held.forEach(function (name) { rows.push([name, 'waiting', '', 'Claude was unavailable; tries again next hour', now]); });
  pending.forEach(function (name) { rows.push([name, 'waiting', '', 'Will be processed in the next few minutes', now]); });
  if (unchecked) {
    rows.push(['(checking recipes for unclear steps)', 'waiting', unchecked, recipesCount_(unchecked) + (index.checkBatch
      ? ' with Claude to check since ' + Utilities.formatDate(new Date(index.checkBatch.sent), Session.getScriptTimeZone(), 'd MMM HH:mm') +
        '; results come in on an hourly run, usually the next one'
      : ' still to check; sent to Claude on the next hourly run'), now]);
  }
  skipped.forEach(function (name) { rows.push([name, 'unsupported file type', 0, 'Use PDF, Google Doc, Word, image or text', now]); });
  rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });

  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}
