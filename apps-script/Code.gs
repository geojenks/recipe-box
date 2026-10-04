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
var CONTINUE_HANDLER = 'continueProcessing';

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
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous run is still going
  try {
    processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processInboxLocked_() {
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
  var outOfTime = function () { return Date.now() - started > TIME_BUDGET_MS; };

  plan.sources.forEach(function (item) {
    var file = item.file;
    var id = file.getId();
    seen[id] = true;
    var modified = file.getLastUpdated().toISOString();
    var photo = item.photo;
    var photoKey = photo ? photo.getId() + '@' + photo.getLastUpdated().toISOString() : null;
    var entry = index.sources[id];

    var needsWork = !entry || entry.modified !== modified || entry.photoKey !== photoKey ||
      (entry.extractVersion !== EXTRACT_VERSION && entry.status !== 'error') ||
      (entry.status === 'error' && entry.attempts < MAX_ATTEMPTS);
    if (entry) entry.name = file.getName();
    if (!needsWork) return;
    if (outOfTime()) { // pick it up on the follow-up run
      pending.push(file.getName());
      return;
    }

    var attempts = entry && entry.modified === modified && entry.status === 'error' ? entry.attempts : 0;
    try {
      var pdf = inputKind_(file) === 'pdf' ? pdfBlobFor_(file) : null;
      var recipes = extractRecipes_(file, pdf);
      removeRecipesForSource_(index, id);
      if (entry) trashQuietly_(entry.photoFileId);
      var photoFileId = attachPhotos_(file, photo, id, recipes, pdf);
      recipes.forEach(function (r, i) {
        index.recipes.push(decorateRecipe_(r, i, file));
      });
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey, extractVersion: EXTRACT_VERSION,
        status: recipes.length ? 'ok' : 'no recipe found',
        recipes: recipes.length, attempts: 0, error: null, photoFileId: photoFileId
      };
    } catch (e) {
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey, extractVersion: EXTRACT_VERSION,
        status: 'error', recipes: entry ? entry.recipes : 0,
        attempts: attempts + 1, error: String(e.message || e),
        photoFileId: entry ? entry.photoFileId : null
      };
      Logger.log('Failed on ' + file.getName() + ': ' + e);
    }
    changed = true;
    saveIndex_(index); // save after each file so a timeout loses nothing
  });

  // Files removed from the inbox: drop their recipes and generated photos.
  Object.keys(index.sources).forEach(function (id) {
    if (seen[id]) return;
    removeRecipesForSource_(index, id);
    trashQuietly_(index.sources[id].photoFileId);
    delete index.sources[id];
    changed = true;
  });

  if (changed) saveIndex_(index);
  writeStatus_(index, plan.skipped, pending);
  scheduleContinuation_(outOfTime());
}

/** One-off trigger that carries on a minute later when a run ran out of time. */
function scheduleContinuation_(needed) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === CONTINUE_HANDLER) ScriptApp.deleteTrigger(t);
  });
  if (needed) ScriptApp.newTrigger(CONTINUE_HANDLER).timeBased().after(60 * 1000).create();
}

function continueProcessing() {
  processInbox();
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
  var body = JSON.parse(resp.getContentText());
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
 * Saves one picture per source file into the data folder and sets on each recipe:
 *   photoFileId
 *   photoKind  'dish' (a photo of the food) or 'page' (a picture of the recipe itself)
 *   photoCrop  {left, top, width, height} as page fractions when the dish photo has to be
 *              cut out of the page picture (the website does the cutting), else null
 * Preference: uploaded photo with the same name > JPEG embedded in the PDF > crop of page 1.
 * Returns the saved file's id.
 */
function attachPhotos_(file, uploaded, sourceId, recipes, pdf) {
  var dataFolder = DriveApp.getFolderById(requireProp_('DATA_FOLDER_ID'));
  var name = 'photo-' + sourceId + '.jpg';
  var existing = dataFolder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  var save = function (blob) { return dataFolder.createFile(blob.setName(name)).getId(); };
  var setAll = function (id, kind) {
    recipes.forEach(function (r) { r.photoFileId = id; r.photoKind = kind; r.photoCrop = null; });
    return id;
  };

  try {
    if (uploaded) return setAll(save(driveThumbnail_(uploaded, PHOTO_SIZE)), 'dish');

    var wantsPhoto = recipes.some(function (r) { return r.dishPhoto; });
    if (pdf && wantsPhoto && recipes.length === 1) {
      var embedded = embeddedDishPhoto_(pdf);
      if (embedded) return setAll(save(embedded), 'dish');
    }

    var crops = recipes.map(function (r) { return cleanCrop_(r.dishPhoto); });
    var anyCrop = crops.some(function (c) { return c; });
    var id = save(driveThumbnail_(file, anyCrop ? 2400 : PHOTO_SIZE));
    recipes.forEach(function (r, i) {
      r.photoFileId = id;
      r.photoKind = crops[i] ? 'dish' : 'page';
      r.photoCrop = crops[i];
    });
    return id;
  } catch (e) {
    Logger.log('No photo for ' + file.getName() + ': ' + e);
    setAll(null, null);
    return null;
  }
}

/** Only page 1 can be rendered, so only boxes on page 1 that look like a real photo are usable. */
function cleanCrop_(box) {
  if (!box || box.page !== 1) return null;
  var clamp = function (v) { return Math.min(1, Math.max(0, v)); };
  var left = clamp(box.left), top = clamp(box.top);
  var width = clamp(box.width), height = clamp(box.height);
  width = Math.min(width, 1 - left);
  height = Math.min(height, 1 - top);
  if (width < 0.1 || height < 0.05) return null;
  return { left: left, top: top, width: width, height: height };
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

function driveThumbnail_(file, size) {
  // Drive's thumbnailLink can be requested at any size; getThumbnail() is a small fallback.
  try {
    var token = ScriptApp.getOAuthToken();
    var meta = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=thumbnailLink',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    var link = JSON.parse(meta.getContentText()).thumbnailLink;
    if (link) {
      var sized = link.replace(/=s\d+$/, '=s' + size);
      return UrlFetchApp.fetch(sized, { headers: { Authorization: 'Bearer ' + token } }).getBlob().getAs('image/jpeg');
    }
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
function writeStatus_(index, skipped, pending) {
  var sheet = SpreadsheetApp.openById(requireProp_('SHEET_ID')).getSheetByName('Status');
  var now = new Date();
  var rows = Object.keys(index.sources).map(function (id) {
    var s = index.sources[id];
    var detail = s.error ? s.error + (s.attempts >= MAX_ATTEMPTS ? ' (gave up; re-upload or edit the file to retry)' : '') : '';
    return [s.name, s.status, s.recipes, detail, now];
  });
  pending.forEach(function (name) { rows.push([name, 'waiting', '', 'Will be processed in the next few minutes', now]); });
  skipped.forEach(function (name) { rows.push([name, 'unsupported file type', 0, 'Use PDF, Google Doc, Word, image or text', now]); });
  rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });

  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}
