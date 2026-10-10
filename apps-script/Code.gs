/**
 * Recipe Box background job.
 *
 * Watches a shared Drive folder ("inbox"), sends new or changed recipe files
 * to Claude for extraction, and writes the results to recipes.json in a data
 * subfolder. The website reads it through the password-checking web app in Site.gs.
 *
 * Script properties (Project Settings > Script properties):
 *   ANTHROPIC_API_KEY  required
 *   INBOX_FOLDER_ID    required: the shared "Recipe Box" folder
 *   SITE_PASSWORD      required for the website: the password everyone types
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

  Logger.log('Setup complete. Paste this into docs/config.js:');
  Logger.log("  inboxFolderId: '" + inbox.getId() + "',");
  Logger.log('Then deploy the web app (see Site.gs) and paste its address in as serviceUrl.');
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
  CacheService.getScriptCache().remove(PHOTO_IDS_KEY); // the site's list of photos it may hand out
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

  // Web addresses added on the site become files first, so they're extracted in this same run.
  try {
    processLinks_(inbox, function () { return Date.now() - started > TIME_BUDGET_MS / 3; });
  } catch (e) {
    Logger.log('Could not add recipes from web addresses: ' + (e.message || e));
  }

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

  // Problems reported on the website: Claude fixes the recipe, and keep or undo is carried out.
  var reports = { changed: false, left: 0 };
  try {
    reports = processReports_(index, claudeDown, function () { return Date.now() - started > TIME_BUDGET_MS - 90 * 1000; });
    if (reports.changed) changed = true;
  } catch (e) {
    Logger.log('Could not deal with reported problems: ' + (e.message || e));
  }

  try {
    if (markSiteAdded_(index, inbox)) changed = true;
  } catch (e) {
    Logger.log('Could not mark recipes added on the website: ' + (e.message || e));
  }
  var unchecked = checkRecipes_(index);
  if (changed) saveIndex_(index);
  writeStatus_(index, plan.skipped, pending, held, unchecked);
  scheduleContinuation_(outOfTime() || reports.left > 0);
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
  return parseExtractionResponse_(callClaude_(buildExtractionRequest_(claudeInputFor_(file, pdf), file.getName()))).recipes;
}

/** Sends one request to Claude and returns its reply; throws if the reply isn't JSON. */
function callClaude_(request) {
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
  return body;
}

function decorateRecipe_(r, i, file) {
  var owner = null;
  try { owner = file.getOwner(); } catch (e) { /* shared drives have no owner */ }
  r.id = file.getId() + '-' + i;
  r.sourceFileId = file.getId();
  r.sourceName = file.getName();
  // Files added on the website are saved by this script, so the file says who added it.
  var origin = siteOrigin_(file.getDescription());
  r.addedBy = origin ? origin.by : owner ? (owner.getName() || owner.getEmail()) : null;
  if (origin) setSiteOrigin_(r, origin);
  r.addedAt = file.getDateCreated().toISOString();
  return r;
}

/**
 * Who added a file on the website, and how: "Added by Sam from https://..." for a
 * web address, "Added by Sam on the website" for an upload. Null for anything else.
 */
function siteOrigin_(description) {
  var m = /^Added by (.+?) (?:from (\S+)|on the website)/.exec(description || '');
  return m ? { by: m[1], via: m[2] ? 'link' : 'upload', from: m[2] || null } : null;
}

function setSiteOrigin_(r, origin) {
  r.addedBy = origin.by;
  r.addedVia = origin.via; // the review page lists these, so they can be checked or deleted
  if (origin.from) r.addedFrom = origin.from; else delete r.addedFrom;
}

/**
 * Marks recipes from the two website folders as added on the website, including
 * ones read before this was recorded. True if anything changed.
 */
function markSiteAdded_(index, inbox) {
  var changed = false;
  [WEB_FOLDER_NAME, UPLOAD_FOLDER_NAME].forEach(function (name) {
    var folders = inbox.getFoldersByName(name);
    if (!folders.hasNext()) return;
    var files = folders.next().getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var origin = siteOrigin_(f.getDescription());
      if (!origin) continue;
      index.recipes.forEach(function (r) {
        if (r.sourceFileId !== f.getId() || (r.addedVia === origin.via && r.addedBy === origin.by)) return;
        setSiteOrigin_(r, origin);
        changed = true;
      });
    }
  });
  return changed;
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

    if (inputKind_(file) === 'text') { // a picture of plain text is no use as a photo
      setAll(null, null);
      return { incomplete: false };
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

// ---------- recipes added from a web address ----------

var LINKS_SHEET = 'Links';
var LINKS_HEADERS = ['id', 'timestamp', 'email', 'name', 'url', 'status', 'detail', 'file', 'attempts'];
var WEB_FOLDER_NAME = 'Added from the web';
var LINKS_PER_RUN = 10;
var LINK_NOTICE_DAYS = 14; // how long a failed link stays on the Status tab
var LINK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** The Links tab the website adds web addresses to; created on first use. */
function linksSheet_() {
  var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
  var sheet = ss.getSheetByName(LINKS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LINKS_SHEET);
    sheet.appendRow(LINKS_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function linkRows_(sheet) {
  var last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, LINKS_HEADERS.length).getValues();
}

/**
 * Fetches the web addresses people added on the website and saves each recipe
 * into the shared folder as a text file, with the page's photo under the same
 * name. The rest of the run then extracts it like any other upload, and it can be
 * edited or deleted in Drive like one too.
 */
function processLinks_(inbox, outOfTime) {
  var sheet = linksSheet_();
  var rows = linkRows_(sheet);
  var folder = null;
  var names = null; // lower-case base names already in the folder, so photos pair with the right file
  var done = 0;
  for (var i = 0; i < rows.length && done < LINKS_PER_RUN && !outOfTime(); i++) {
    var row = rows[i];
    var url = String(row[4] || '').trim();
    if (!url || (row[5] && row[5] !== 'waiting')) continue;
    var attempts = Number(row[8]) || 0;
    var result;
    var earlier = rows.filter(function (r) { return r[5] === 'added' && String(r[4]).trim() === url; })[0];
    if (earlier) {
      result = { status: 'already added', detail: 'Already added as ' + earlier[7] + '.' };
    } else {
      try {
        if (!folder) {
          folder = webFolder_(inbox);
          names = {};
          var files = [];
          collectFiles_(inbox, requireProp_('DATA_FOLDER_ID'), files);
          files.forEach(function (f) { names[f.getName().replace(/\.[^.]+$/, '').trim().toLowerCase()] = true; });
        }
        result = saveLink_(url, row, folder, names);
      } catch (e) {
        var message = String(e.message || e);
        Logger.log('Could not fetch ' + url + ': ' + message);
        attempts++;
        result = attempts < MAX_ATTEMPTS
          ? { status: 'waiting', detail: message }
          : { status: 'error', detail: 'Could not reach the website (' + message + '). Save the page as a PDF and upload that instead.' };
      }
    }
    row[5] = result.status;
    row[7] = result.file || '';
    sheet.getRange(i + 2, 6, 1, 4).setValues([[result.status, result.detail || '', result.file || '', attempts]]);
    done++;
  }
}

function webFolder_(inbox) {
  var it = inbox.getFoldersByName(WEB_FOLDER_NAME);
  return it.hasNext() ? it.next() : inbox.createFolder(WEB_FOLDER_NAME);
}

/** Fetches one web address and saves its recipe. Returns the row's {status, detail, file}. */
function saveLink_(url, row, folder, names) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { status: 'error', detail: 'That is not a web address.' };
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': LINK_USER_AGENT, 'Accept-Language': 'en-GB,en;q=0.9' }
  });
  var code = resp.getResponseCode();
  if (code >= 500) throw new Error('HTTP ' + code); // the website is having trouble: try again next run
  if (code !== 200) {
    return {
      status: 'error',
      detail: 'The website would not let the job read the page (HTTP ' + code + '). Save the page as a PDF and upload that to the recipe folder instead.'
    };
  }
  var page = webRecipe_(resp.getContentText(), url);
  if (!page) {
    return {
      status: 'error',
      detail: 'No recipe found on that page. If it needs a sign-in, save the page as a PDF and upload that instead.'
    };
  }

  var base = page.title;
  for (var n = 2; names[base.toLowerCase()]; n++) base = page.title + ' (' + n + ')';
  names[base.toLowerCase()] = true;
  var file = folder.createFile(base + '.txt', page.text, MimeType.PLAIN_TEXT);
  file.setDescription('Added by ' + (row[3] || row[2] || 'someone') + ' from ' + url);

  if (page.image) {
    try {
      var img = UrlFetchApp.fetch(page.image, { muteHttpExceptions: true, headers: { 'User-Agent': LINK_USER_AGENT } });
      var type = String(img.getHeaders()['Content-Type'] || img.getHeaders()['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (img.getResponseCode() === 200 && IMAGE_TYPES.indexOf(type) >= 0) {
        folder.createFile(img.getBlob().setContentType(type).setName(base + '.' + type.split('/')[1].replace('jpeg', 'jpg')));
      }
    } catch (e) {
      Logger.log('No photo for ' + url + ': ' + e);
    }
  }
  return { status: 'added', file: base + '.txt' };
}

/**
 * The recipe on a web page as plain text for Claude, from the page's recipe data
 * (schema.org JSON-LD, which most recipe sites include) or else from its visible
 * text. Returns {title, text, image} or null if there's no recipe to be had.
 */
function webRecipe_(html, url) {
  var host = (url.match(/^https?:\/\/(?:www\.)?([^\/?#:]+)/i) || [])[1] || url;
  var site = metaContent_(html, 'og:site_name') || host;
  var recipe = jsonLdRecipe_(html);
  var title = (recipe && cleanText_(String(recipe.name || ''))) || pageTitle_(metaContent_(html, 'og:title') ||
    cleanText_(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || ''), site, host);
  var lines = [title, 'From ' + site + ': ' + url];

  if (recipe) {
    var author = [].concat(recipe.author || []).map(function (a) { return typeof a === 'string' ? a : a && a.name; })
      .filter(Boolean).join(', ');
    if (author) lines.push('By ' + cleanText_(author));
    var serves = [].concat(recipe.recipeYield || []).map(String).sort(function (a, b) { return b.length - a.length; })[0];
    if (serves) lines.push('Serves / makes: ' + cleanText_(serves));
    var times = [['Prep', recipe.prepTime], ['Cook', recipe.cookTime], ['Total', recipe.totalTime]]
      .map(function (t) { var d = duration_(t[1]); return d ? t[0] + ': ' + d : null; }).filter(Boolean);
    if (times.length) lines.push(times.join('. '));
    if (recipe.description) lines.push('', cleanText_(String(recipe.description)));
    lines.push('', 'Ingredients');
    [].concat(recipe.recipeIngredient || recipe.ingredients || []).forEach(function (i) { lines.push('- ' + cleanText_(String(i))); });
    lines.push('', 'Method');
    var step = 0;
    instructionLines_(recipe.recipeInstructions).forEach(function (l) {
      lines.push(l.section ? '\n' + l.section : (++step) + '. ' + l.text);
    });
    if (recipe.recipeNotes || recipe.notes) lines.push('', 'Notes', cleanText_(String(recipe.recipeNotes || recipe.notes)));
  } else {
    var text = pageText_(html);
    if (text.length < 200) return null;
    lines.push('', text);
  }

  var name = cleanText_(title).replace(/[\\\/:*?"<>|#\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return { title: name || 'Recipe from ' + host, text: lines.join('\n'), image: absoluteUrl_(imageOf_(recipe) || metaContent_(html, 'og:image'), url) };
}

/** The first schema.org Recipe in the page's JSON-LD that has ingredients and a method, else null. */
function jsonLdRecipe_(html) {
  var re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  var found = null;
  var visit = function (node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    var types = [].concat(node['@type'] || []).map(String);
    if (types.indexOf('Recipe') >= 0 && (node.recipeIngredient || node.ingredients) && node.recipeInstructions) {
      found = node;
      return;
    }
    visit(node['@graph']);
    visit(node.mainEntity);
    visit(node.mainEntityOfPage);
  };
  var m;
  while (!found && (m = re.exec(html))) {
    var raw = m[1].replace(/^\s*(?:<!--|\/\/\s*<!\[CDATA\[)/, '').replace(/(?:-->|\/\/\s*\]\]>)\s*$/, '').trim();
    try { visit(JSON.parse(raw)); } catch (e) { /* malformed JSON-LD: try the next block */ }
  }
  return found;
}

/** Method steps as [{text}] and section headings as [{section}], from any of the shapes sites use. */
function instructionLines_(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') {
    return cleanText_(ins).split(/\n+/).map(function (t) { return t.replace(/^\d+[.)]\s*/, '').trim(); })
      .filter(Boolean).map(function (t) { return { text: t }; });
  }
  if (Array.isArray(ins)) return ins.reduce(function (out, i) { return out.concat(instructionLines_(i)); }, []);
  if (ins.itemListElement) { // a HowToSection
    var heading = ins.name ? [{ section: cleanText_(String(ins.name)) }] : [];
    return heading.concat(instructionLines_(ins.itemListElement));
  }
  var text = cleanText_(String(ins.text || ins.name || ''));
  return text ? [{ text: text }] : [];
}

function imageOf_(recipe) {
  if (!recipe) return null;
  var img = [].concat(recipe.image || [])[0];
  return typeof img === 'string' ? img : img && (img.url || img.contentUrl) || null;
}

function absoluteUrl_(link, page) {
  if (!link) return null;
  link = String(link).trim();
  if (/^https?:\/\//i.test(link)) return link;
  if (/^\/\//.test(link)) return 'https:' + link;
  var origin = (page.match(/^https?:\/\/[^\/?#]+/i) || [])[0];
  return origin && /^\//.test(link) ? origin + link : null;
}

/** The content of a <meta property|name="..."> tag. */
function metaContent_(html, prop) {
  var tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (var i = 0; i < tags.length; i++) {
    var key = attr_(tags[i], 'property') || attr_(tags[i], 'name');
    if (key && key.toLowerCase() === prop) return cleanText_(attr_(tags[i], 'content') || '') || null;
  }
  return null;
}

function attr_(tag, name) {
  var m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[1] || m[2] || m[3] || '') : null;
}

/** The readable text of a page without its scripts, menus and footers, preferring <main> or <article>. */
function pageText_(html) {
  var s = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  var main = s.match(/<main\b[\s\S]*<\/main\s*>/i) || s.match(/<article\b[\s\S]*<\/article\s*>/i);
  if (main && cleanText_(main[0]).length > 500) s = main[0];
  return cleanText_(s).slice(0, 60000);
}

var ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d',
  ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', deg: '\u00b0', frac12: '\u00bd', frac14: '\u00bc',
  frac34: '\u00be', frac13: '\u2153', frac23: '\u2154', times: '\u00d7', pound: '\u00a3', eacute: '\u00e9', egrave: '\u00e8',
  ecirc: '\u00ea', agrave: '\u00e0', aacute: '\u00e1', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', ccedil: '\u00e7',
  ntilde: '\u00f1', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', szlig: '\u00df', bull: '\u2022', middot: '\u00b7'
};

function decodeEntities_(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, function (m, e) {
    if (e.charAt(0) !== '#') return ENTITIES[e] || ENTITIES[e.toLowerCase()] || m;
    var code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML to plain text: block tags become line breaks, list items "- ", entities decoded. */
function cleanText_(s) {
  s = String(s || '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:br|hr)\b[^>]*>|<\/?(?:p|div|section|ul|ol|h[1-6]|tr|table|blockquote|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities_(decodeEntities_(s)); // some sites encode twice ("&amp;#8217;")
  return s.split('\n').map(function (l) { return l.replace(/[ \t\u00a0]+/g, ' ').trim(); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "PT1H30M" -> "1 hr 30 min"; null if there's no time in it. */
function duration_(iso) {
  var m = String(iso || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
  if (!m) return null;
  var mins = ((Number(m[1]) || 0) * 24 + (Number(m[2]) || 0)) * 60 + (Number(m[3]) || 0);
  if (!mins) return null;
  var h = Math.floor(mins / 60), rest = mins % 60;
  return [h ? h + ' hr' : '', rest ? rest + ' min' : ''].join(' ').trim();
}

/** "Chickpeas cacio e pepe recipe | Ottolenghi Recipes" -> "Chickpeas cacio e pepe". */
function pageTitle_(title, site, host) {
  var squash = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var names = [squash(site), squash(host.replace(/\.[a-z.]+$/i, ''))].filter(Boolean);
  for (var m; (m = /^(.*\S)\s+[|\u2013\u2014-]\s+([^|\u2013\u2014]+)$/.exec(title));) {
    var last = squash(m[2]);
    if (!names.some(function (n) { return last.indexOf(n) >= 0 || n.indexOf(last) >= 0; })) break;
    title = m[1];
  }
  return title.replace(/\s+recipe$/i, '').trim();
}

// ---------- problems reported on the website, and added photos ----------

var REPORTS_SHEET = 'Reports';
var REPORTS_HEADERS = ['id', 'recipeId', 'timestamp', 'device', 'name', 'text', 'status', 'detail', 'decision', 'decidedBy', 'decidedAt', 'attempts'];
var REPORTS_PER_RUN = 3;
var PHOTOS_SHEET = 'Photos';
var PHOTOS_HEADERS = ['id', 'recipeId', 'timestamp', 'device', 'name', 'fileId', 'removedBy', 'removedAt'];

/** A tab of the notes spreadsheet that the website writes to; made on first use. */
function siteSheet_(name, headers, ss) {
  ss = ss || SpreadsheetApp.openById(requireProp_('SHEET_ID'));
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** The rows of such a tab as objects named by its headers, each with .row, its row number. */
function sheetRecords_(sheet, headers) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, headers.length).getDisplayValues().map(function (v, i) {
    var o = { row: i + 2 };
    headers.forEach(function (h, j) { o[h] = v[j]; });
    return o;
  }).filter(function (o) { return o.id; });
}

/**
 * Fixes recipes after problems reported on the website, and carries out the keep
 * or undo people chose. A fixed recipe has an entry in index.fixes under its id:
 *   fields   the new values of the fields that changed
 *   before   their values as first read from the original, for undo
 *   reports  [{id, by, at, text, summary}] the reports that led to it, oldest first
 *   at       when it last changed
 *   kept     {by, at} once someone has kept it, else null
 *   sourceModified  the original file's date when it was fixed
 * A fix outlasts the recipe being read again from the same file; if the file
 * itself is edited, the fix gives way to the edit.
 * Returns {changed, left}: left counts reports put off because time ran short.
 */
function processReports_(index, claudeDown, outOfTime) {
  var sheet = siteSheet_(REPORTS_SHEET, REPORTS_HEADERS);
  var rows = sheetRecords_(sheet, REPORTS_HEADERS);
  index.fixes = index.fixes || {};
  var byId = {};
  index.recipes.forEach(function (r) { byId[r.id] = r; });
  var changed = syncFixes_(index, byId, rows, sheet);
  var done = 0, left = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.status !== 'waiting' || row.decision === 'dismiss' || claudeDown) continue;
    if (done >= REPORTS_PER_RUN || outOfTime()) { left++; continue; }
    var attempts = Number(row.attempts) || 0;
    var result;
    try {
      var r = byId[row.recipeId];
      result = r ? fixRecipe_(index, r, row) : { status: 'error', detail: 'That recipe is no longer in the book.' };
    } catch (e) {
      var message = String(e.message || e);
      Logger.log('Could not fix ' + row.recipeId + ': ' + message);
      if (isServiceError_(message)) { // try again next run
        claudeDown = true;
        continue;
      }
      attempts++;
      result = attempts < MAX_ATTEMPTS ? { status: 'waiting', detail: message }
        : { status: 'error', detail: 'Claude could not fix it (' + message + ').' };
    }
    row.status = result.status;
    sheet.getRange(row.row, 7, 1, 2).setValues([asText_([result.status, result.detail])]);
    sheet.getRange(row.row, 12).setValue(attempts);
    if (result.status === 'changed') {
      changed = true;
      saveIndex_(index); // after each fix, so a timeout loses nothing
    }
    done++;
  }
  return { changed: changed, left: left };
}

/** Asks Claude to fix one recipe from its original file and the report. Returns the report's {status, detail}. */
function fixRecipe_(index, r, row) {
  var file = DriveApp.getFileById(r.sourceFileId);
  var pdf = inputKind_(file) === 'pdf' ? pdfBlobFor_(file) : null;
  var result = parseFixResponse_(callClaude_(buildFixRequest_(claudeInputFor_(file, pdf), file.getName(), r, row.text)), r);
  if (!result.fields) return { status: 'no change', detail: result.summary || 'Claude found nothing to change.' };

  // A recipe fixed before: this fix goes on top, and undo still goes back to the first reading.
  var earlier = index.fixes[r.id];
  var before = earlier ? earlier.before : {};
  Object.keys(result.before).forEach(function (k) { if (!(k in before)) before[k] = result.before[k]; });
  Object.keys(result.fields).forEach(function (k) { r[k] = result.fields[k]; });
  var fields = {};
  Object.keys(before).forEach(function (k) { fields[k] = r[k] === undefined ? null : r[k]; });
  var entry = index.sources[r.sourceFileId];
  index.fixes[r.id] = {
    fields: fields, before: before,
    reports: (earlier ? earlier.reports : []).concat([{ id: row.id, by: row.name, at: row.timestamp, text: row.text, summary: result.summary }]),
    at: new Date().toISOString(), kept: null, sourceModified: entry ? entry.modified : null
  };
  recheck_(r);
  return { status: 'changed', detail: result.summary };
}

/**
 * Keeps index.fixes and the recipes in step: puts a fix back on a recipe read
 * again from the same file, drops it if the file was edited or the recipe has
 * gone, and carries out keep or undo. True if anything changed.
 */
function syncFixes_(index, byId, rows, sheet) {
  var rowsById = {};
  rows.forEach(function (x) { rowsById[x.id] = x; });
  var changed = false;
  Object.keys(index.fixes).forEach(function (recipeId) {
    var fix = index.fixes[recipeId];
    var r = byId[recipeId];
    var mine = fix.reports.map(function (x) { return rowsById[x.id]; }).filter(Boolean);
    var close = function (status, detail) {
      mine.forEach(function (x) {
        x.status = status;
        sheet.getRange(x.row, 7, 1, 2).setValues([asText_([status, detail])]);
      });
      delete index.fixes[recipeId];
      changed = true;
    };
    if (!r) return close('gone', 'The recipe is no longer in the book.');
    var value = function (k) { return r[k] === undefined ? null : r[k]; };
    var applied = Object.keys(fix.fields).every(function (k) { return JSON.stringify(value(k)) === JSON.stringify(fix.fields[k]); });
    if (!applied) { // the recipe was read from its file again
      var entry = index.sources[r.sourceFileId];
      if (!entry || entry.modified !== fix.sourceModified) {
        return close('replaced', 'The original file was changed after this fix, so the recipe was read from it again.');
      }
      Object.keys(fix.fields).forEach(function (k) {
        fix.before[k] = value(k);
        r[k] = fix.fields[k];
      });
      recheck_(r);
      changed = true;
    }
    var decision = latestDecision_(mine, fix.at);
    if (decision && decision.decision === 'undo') {
      Object.keys(fix.before).forEach(function (k) { r[k] = fix.before[k]; });
      recheck_(r);
      close('undone', 'Undone by ' + (decision.decidedBy || 'someone') + '.');
    } else if (decision && decision.decision === 'keep' && !fix.kept) {
      fix.kept = { by: decision.decidedBy, at: decision.decidedAt };
      changed = true;
    }
  });
  return changed;
}

/** The latest keep or undo on these reports made since the fix; older ones were about an earlier fix. */
function latestDecision_(rows, since) {
  return rows.filter(function (x) { return (x.decision === 'keep' || x.decision === 'undo') && x.decidedAt >= since; })
    .sort(function (a, b) { return a.decidedAt < b.decidedAt ? 1 : -1; })[0] || null;
}

/** A changed recipe is checked again for unclear steps, since the old notes may point at the wrong steps. */
function recheck_(r) {
  ['checkVersion', 'unclear', 'certainty', 'checkAttempts', 'checkError'].forEach(function (k) { delete r[k]; });
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

  // Web addresses at the top: those not fetched yet, and those added in the last fortnight.
  var links = [];
  try {
    var recent = Date.now() - LINK_NOTICE_DAYS * 24 * 3600 * 1000;
    var byName = {};
    Object.keys(index.sources).forEach(function (id) { byName[index.sources[id].name] = index.sources[id]; });
    linkRows_(linksSheet_()).forEach(function (r) {
      var url = String(r[4] || '').trim();
      var who = 'Added by ' + (r[3] || r[2] || 'someone') + '. ';
      if (!url) return;
      if (!r[5] || r[5] === 'waiting') {
        links.push([url, 'waiting', '', who + 'Fetched on the next run, within the hour.' + (r[6] ? ' Last try: ' + r[6] : ''), now]);
      } else if (new Date(r[1]).getTime() < recent) {
        return;
      } else if (r[5] === 'added') {
        var src = byName[r[7]];
        links.push([url, src ? src.status : 'waiting', src ? src.recipes : '',
          who + 'Saved as "' + r[7] + '" in the folder "' + WEB_FOLDER_NAME + '".' + (src ? '' : ' Read by Claude on the next run.'), now]);
      } else {
        links.push([url, r[5], 0, who + r[6], now]);
      }
    });
  } catch (e) {
    Logger.log('Could not list web addresses: ' + (e.message || e));
  }
  rows = links.reverse().concat(rows); // newest first

  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}
