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
  var inbox = DriveApp.getFolderById(requireProp_('INBOX_FOLDER_ID'));
  var p = props_();

  var dataFolder = p.getProperty('DATA_FOLDER_ID')
    ? DriveApp.getFolderById(p.getProperty('DATA_FOLDER_ID'))
    : inbox.createFolder(DATA_FOLDER_NAME);
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

  plan.sources.forEach(function (item) {
    var file = item.file;
    var id = file.getId();
    seen[id] = true;
    var modified = file.getLastUpdated().toISOString();
    var photo = item.photo;
    var photoKey = photo ? photo.getId() + '@' + photo.getLastUpdated().toISOString() : null;
    var entry = index.sources[id];

    var needsWork = !entry || entry.modified !== modified || entry.photoKey !== photoKey ||
      (entry.status === 'error' && entry.attempts < MAX_ATTEMPTS);
    if (!needsWork) {
      entry.name = file.getName();
      return;
    }
    if (Date.now() - started > TIME_BUDGET_MS) return; // pick it up next run

    var attempts = entry && entry.modified === modified && entry.status === 'error' ? entry.attempts : 0;
    try {
      var recipes = extractRecipes_(file);
      removeRecipesForSource_(index, id);
      var photoFileId = makePhoto_(photo || file, id);
      recipes.forEach(function (r, i) {
        index.recipes.push(decorateRecipe_(r, i, file, photoFileId));
      });
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey,
        status: recipes.length ? 'ok' : 'no recipe found',
        recipes: recipes.length, attempts: 0, error: null, photoFileId: photoFileId
      };
    } catch (e) {
      index.sources[id] = {
        name: file.getName(), modified: modified, photoKey: photoKey,
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
  writeStatus_(index, plan.skipped);
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

function claudeInputFor_(file) {
  var kind = inputKind_(file);
  var type = file.getMimeType();
  if (kind === 'pdf') {
    var blob = type === 'application/pdf' ? file.getBlob() : exportAsPdf_(file);
    return { kind: 'pdf', base64: Utilities.base64Encode(blob.getBytes()) };
  }
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

function extractRecipes_(file) {
  var request = buildExtractionRequest_(claudeInputFor_(file), file.getName());
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

function decorateRecipe_(r, i, file, photoFileId) {
  var owner = null;
  try { owner = file.getOwner(); } catch (e) { /* shared drives have no owner */ }
  r.id = file.getId() + '-' + i;
  r.sourceFileId = file.getId();
  r.sourceName = file.getName();
  r.addedBy = owner ? (owner.getName() || owner.getEmail()) : null;
  r.addedAt = file.getDateCreated().toISOString();
  r.photoFileId = photoFileId;
  return r;
}

function removeRecipesForSource_(index, sourceId) {
  index.recipes = index.recipes.filter(function (r) { return r.sourceFileId !== sourceId; });
}

/** Renders a JPEG preview (photo, or page 1 of a PDF) into the data folder. */
function makePhoto_(file, sourceId) {
  var dataFolder = DriveApp.getFolderById(requireProp_('DATA_FOLDER_ID'));
  var name = 'photo-' + sourceId + '.jpg';
  var existing = dataFolder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  try {
    var blob = driveThumbnail_(file, PHOTO_SIZE).setName(name);
    return dataFolder.createFile(blob).getId();
  } catch (e) {
    Logger.log('No photo for ' + file.getName() + ': ' + e);
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
function writeStatus_(index, skipped) {
  var sheet = SpreadsheetApp.openById(requireProp_('SHEET_ID')).getSheetByName('Status');
  var now = new Date();
  var rows = Object.keys(index.sources).map(function (id) {
    var s = index.sources[id];
    var detail = s.error ? s.error + (s.attempts >= MAX_ATTEMPTS ? ' (gave up; re-upload or edit the file to retry)' : '') : '';
    return [s.name, s.status, s.recipes, detail, now];
  });
  skipped.forEach(function (name) { rows.push([name, 'unsupported file type', 0, 'Use PDF, Google Doc, Word, image or text', now]); });
  rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });

  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}
