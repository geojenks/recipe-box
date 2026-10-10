/**
 * The website's only way in: a web app that checks the shared password, then
 * reads and writes on the site's behalf, as the account that deployed it.
 *
 * Deploy > New deployment > Web app, "Execute as: Me", "Who has access: Anyone",
 * and paste the /exec address into docs/config.js as serviceUrl. After changing
 * any script file, Deploy > Manage deployments > edit > Version: New version, so
 * the site gets the change at the same address.
 *
 * Script property SITE_PASSWORD holds the password. Capitals and extra spaces
 * don't matter. Changing it signs every device out.
 *
 * The site sends POST requests with a text/plain JSON body {password, action, ...},
 * so the browser sends them without asking permission first (Apps Script can't
 * answer that). Every reply is JSON; a failure is {error, status}.
 */

var UPLOAD_FOLDER_NAME = 'Uploaded on the website';
var UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
var PHOTOS_PER_REQUEST = 8;
var ADDED_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
var ADDED_PHOTO_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
var DECISIONS = { keep: 1, undo: 1, dismiss: 1 };
var PHOTO_IDS_KEY = 'site-photo-ids';
var SOON_HANDLER = 'processSoon';
var RECIPE_TYPES = {
  pdf: 'application/pdf', docx: MimeType.MICROSOFT_WORD,
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html'
};
var PHOTO_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif'
};

function doGet() {
  return ContentService.createTextOutput('Recipe book service');
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return reply_({ error: 'Bad request', status: 400 });
  }
  try {
    var expected = props_().getProperty('SITE_PASSWORD');
    if (!expected) return reply_({ error: 'The site password has not been set up yet.', status: 503 });
    if (normPassword_(req.password) !== normPassword_(expected)) {
      Utilities.sleep(2000); // slows down anyone guessing
      return reply_({ error: 'Wrong password', status: 401 });
    }
    var action = SITE_ACTIONS[req.action];
    if (!action) return reply_({ error: 'Unknown action', status: 400 });
    var result = action(req);
    return typeof result === 'string' ? replyText_(result) : reply_(result);
  } catch (err) {
    if (err.status) return reply_({ error: err.message, status: err.status });
    Logger.log('Site request ' + req.action + ' failed: ' + (err.stack || err));
    return reply_({ error: String(err.message || err), status: 500 });
  }
}

var SITE_ACTIONS = {
  /** The book: recipes.json unless the site already has this version, the notes, added photos and reported problems. */
  open: function (req) {
    var file = DriveApp.getFileById(requireProp_('RECIPES_FILE_ID'));
    var version = file.getLastUpdated().toISOString();
    var text = req.since === version ? 'null' : (file.getBlob().getDataAsString() || 'null');
    var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
    // recipes.json is already JSON, so it goes in as it is rather than being parsed and written out again.
    return '{"version":' + JSON.stringify(version) + ',"notes":' + JSON.stringify(readNotes_(ss)) +
      ',"photos":' + JSON.stringify(readPhotos_(ss)) + ',"reports":' + JSON.stringify(readReports_(ss)) +
      ',"index":' + text + '}';
  },

  notes: function () {
    return { notes: readNotes_() };
  },

  status: function () {
    var sheet = SpreadsheetApp.openById(requireProp_('SHEET_ID')).getSheetByName('Status');
    var last = sheet ? sheet.getLastRow() : 0;
    return { rows: last < 2 ? [] : sheet.getRange(2, 1, last - 1, 5).getDisplayValues() };
  },

  /** Recipe photos, as base64. Only files that are a recipe's photo, so the password doesn't open the rest of Drive. */
  photos: function (req) {
    var ids = Array.isArray(req.ids) ? req.ids.map(String) : [];
    if (ids.length > PHOTOS_PER_REQUEST) throw siteError_('Too many photos at once', 400);
    var allowed = photoIds_();
    var out = {};
    ids.forEach(function (id) {
      out[id] = null;
      if (!allowed[id]) return;
      try {
        var blob = DriveApp.getFileById(id).getBlob();
        out[id] = { type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
      } catch (err) {
        Logger.log('No photo ' + id + ': ' + err);
      }
    });
    return { photos: out };
  },

  addNote: function (req) {
    var who = visitor_(req);
    var text = String(req.text || '').trim();
    var recipeId = String(req.recipeId || '');
    if (!text || !recipeId) throw siteError_('A note needs some text.', 400);
    if (text.length > 5000) throw siteError_('That note is too long.', 400);
    notesSheet_().appendRow(asText_([Utilities.getUuid(), recipeId, new Date().toISOString(), who.device, who.name, text]));
    return { notes: readNotes_() };
  },

  /** Notes can only be deleted from the device that wrote them. */
  deleteNote: function (req) {
    var who = visitor_(req);
    var note = readNotes_().filter(function (n) { return n.id === req.id; })[0];
    if (note) {
      if (note.email !== who.device) throw siteError_('You can only delete your own notes.', 403);
      // Rows are only ever appended or blanked, never removed, so row numbers stay put.
      notesSheet_().getRange(note.row, 1, 1, 6).clearContent();
    }
    return { notes: readNotes_() };
  },

  link: function (req) {
    var who = visitor_(req);
    var url = String(req.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) throw siteError_('That is not a web address.', 400);
    linksSheet_().appendRow(asText_([Utilities.getUuid(), new Date().toISOString(), who.device, who.name, url]));
    scheduleSoon_();
    return { ok: true };
  },

  /**
   * A recipe file, and optionally a photo of the dish, saved to the "Uploaded on
   * the website" folder under the same new name, so the job pairs them. The
   * description records who added it, which marks it as added on the site.
   */
  upload: function (req) {
    var who = visitor_(req);
    var recipe = uploadPart_(req.recipe, false);
    var photo = req.photo ? uploadPart_(req.photo, true) : null;
    if (!recipe) throw siteError_('Choose a recipe file.', 400);
    if (photo && PHOTO_TYPES[recipe.ext]) {
      throw siteError_('A photo of the dish can go with a PDF, Word or text file. For a photo of a recipe page, the dish photo is found on the page.', 400);
    }
    if (recipe.bytes.length + (photo ? photo.bytes.length : 0) > UPLOAD_MAX_BYTES) {
      throw siteError_('That is too big. Files can be up to 20 MB in all.', 413);
    }

    var lock = LockService.getUserLock();
    var locked = lock.tryLock(20000); // two uploads with the same name at once would otherwise share one
    try {
      var inbox = DriveApp.getFolderById(requireProp_('INBOX_FOLDER_ID'));
      var it = inbox.getFoldersByName(UPLOAD_FOLDER_NAME);
      var folder = it.hasNext() ? it.next() : inbox.createFolder(UPLOAD_FOLDER_NAME);
      var files = [];
      collectFiles_(inbox, requireProp_('DATA_FOLDER_ID'), files);
      var names = {};
      files.forEach(function (f) { names[f.getName().replace(/\.[^.]+$/, '').trim().toLowerCase()] = true; });
      var base = recipe.base;
      for (var n = 2; names[base.toLowerCase()]; n++) base = recipe.base + ' (' + n + ')';

      var note = 'Added by ' + who.name + ' on the website';
      [recipe, photo].forEach(function (part) {
        if (!part) return;
        folder.createFile(Utilities.newBlob(part.bytes, part.type, base + '.' + part.ext)).setDescription(note);
      });
    } finally {
      if (locked) lock.releaseLock();
    }
    scheduleSoon_();
    return { file: base + '.' + recipe.ext };
  },

  /** A photo of a recipe as made, kept beside the job's own photos and listed in the Photos tab. */
  addPhoto: function (req) {
    var who = visitor_(req);
    var recipeId = String(req.recipeId || '');
    if (!/^[\w-]{10,}-\d+$/.test(recipeId)) throw siteError_('That recipe is not in the book.', 400);
    var part = req.photo || {};
    var ext = (/\.([a-z0-9]+)$/i.exec(String(part.name || '')) || [])[1];
    var type = ADDED_PHOTO_TYPES[String(ext).toLowerCase()];
    if (!type || !part.data) throw siteError_('The photo should be a JPEG, PNG or WebP picture.', 400);
    var bytes = Utilities.base64Decode(String(part.data));
    if (bytes.length > ADDED_PHOTO_MAX_BYTES) throw siteError_('That photo is too big. It can be up to 5 MB.', 413);

    var id = Utilities.getUuid();
    var name = 'added-' + id + '.' + (type === 'image/jpeg' ? 'jpg' : type.slice(6));
    var file = DriveApp.getFolderById(requireProp_('DATA_FOLDER_ID')).createFile(Utilities.newBlob(bytes, type, name));
    file.setDescription('Added by ' + who.name + ' on the website, for ' + recipeId);
    var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
    siteSheet_(PHOTOS_SHEET, PHOTOS_HEADERS, ss).appendRow(asText_([id, recipeId, new Date().toISOString(), who.device, who.name, file.getId(), '', '']));
    CacheService.getScriptCache().remove(PHOTO_IDS_KEY);
    return { id: id, photos: readPhotos_(ss) };
  },

  /** Anyone with the password can take an added photo off; the file goes to the bin. */
  removePhoto: function (req) {
    var who = visitor_(req);
    var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
    var sheet = siteSheet_(PHOTOS_SHEET, PHOTOS_HEADERS, ss);
    var photo = sheetRecords_(sheet, PHOTOS_HEADERS).filter(function (p) { return p.id === req.id && !p.removedAt; })[0];
    if (photo) {
      sheet.getRange(photo.row, 7, 1, 2).setValues([asText_([who.name, new Date().toISOString()])]);
      trashQuietly_(photo.fileId);
      CacheService.getScriptCache().remove(PHOTO_IDS_KEY);
    }
    return { photos: readPhotos_(ss) };
  },

  /** Something wrong with a recipe: the job asks Claude to fix it from the original. */
  report: function (req) {
    var who = visitor_(req);
    var text = String(req.text || '').trim();
    var recipeId = String(req.recipeId || '');
    if (!text || !recipeId) throw siteError_('Say what looks wrong.', 400);
    if (text.length > 5000) throw siteError_('That is too long.', 400);
    var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
    siteSheet_(REPORTS_SHEET, REPORTS_HEADERS, ss).appendRow(asText_([
      Utilities.getUuid(), recipeId, new Date().toISOString(), who.device, who.name, text, 'waiting', '', '', '', '', 0
    ]));
    scheduleSoon_();
    return { reports: readReports_(ss) };
  },

  /** Keep or undo Claude's change, or dismiss a report it couldn't act on. Anyone with the password can decide. */
  decideFix: function (req) {
    var who = visitor_(req);
    var decision = String(req.decision || '');
    if (!DECISIONS[decision]) throw siteError_('Unknown decision', 400);
    var ss = SpreadsheetApp.openById(requireProp_('SHEET_ID'));
    var sheet = siteSheet_(REPORTS_SHEET, REPORTS_HEADERS, ss);
    var report = sheetRecords_(sheet, REPORTS_HEADERS).filter(function (x) { return x.id === req.id; })[0];
    if (!report) throw siteError_('That report has gone.', 404);
    if ((decision === 'dismiss') === (report.status === 'changed')) {
      throw siteError_(report.status === 'changed' ? 'Keep or undo the change instead.' : 'There is no change to keep or undo.', 409);
    }
    sheet.getRange(report.row, 9, 1, 3).setValues([asText_([decision, who.name, new Date().toISOString()])]);
    if (decision !== 'dismiss') scheduleSoon_();
    return { reports: readReports_(ss) };
  }
};

function reply_(obj) {
  return replyText_(JSON.stringify(obj));
}

function replyText_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function siteError_(message, status) {
  var err = new Error(message);
  err.status = status;
  return err;
}

function normPassword_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Who is asking: the name typed on the device, and the device's own id (kept in the notes' email column). */
function visitor_(req) {
  var device = String(req.device || '');
  var name = String(req.name || '').trim().replace(/\s+/g, ' ');
  if (!/^device:[\w-]{8,64}$/.test(device) || !name) throw siteError_('Sign in again with your name.', 400);
  return { device: device, name: name.slice(0, 60) };
}

function notesSheet_(ss) {
  return (ss || SpreadsheetApp.openById(requireProp_('SHEET_ID'))).getSheetByName('Notes');
}

function readNotes_(ss) {
  var sheet = notesSheet_(ss);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 6).getDisplayValues()
    .map(function (v, i) {
      return { row: i + 2, id: v[0], recipeId: v[1], timestamp: v[2], email: v[3], name: v[4], text: v[5] };
    })
    .filter(function (n) { return n.id && n.text; });
}

/** Photos added on the site and not taken off again, without the device ids. */
function readPhotos_(ss) {
  return sheetRecords_(siteSheet_(PHOTOS_SHEET, PHOTOS_HEADERS, ss), PHOTOS_HEADERS)
    .filter(function (p) { return p.fileId && !p.removedAt; })
    .map(function (p) { return { id: p.id, recipeId: p.recipeId, timestamp: p.timestamp, name: p.name, fileId: p.fileId }; });
}

/** Every reported problem and what came of it, without the device ids. */
function readReports_(ss) {
  return sheetRecords_(siteSheet_(REPORTS_SHEET, REPORTS_HEADERS, ss), REPORTS_HEADERS).map(function (x) {
    return {
      id: x.id, recipeId: x.recipeId, timestamp: x.timestamp, name: x.name, text: x.text, status: x.status,
      detail: x.detail, decision: x.decision, decidedBy: x.decidedBy, decidedAt: x.decidedAt
    };
  });
}

/** A leading ' keeps whatever people type as plain text: no formulas, dates or numbers. */
function asText_(values) {
  return values.map(function (v) { return "'" + v; });
}

/** The ids of every recipe photo and added photo, kept for a while; saveIndex_ and photo changes clear it. */
function photoIds_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(PHOTO_IDS_KEY);
  var ids = cached ? JSON.parse(cached) : null;
  if (!ids) {
    ids = {};
    loadIndex_().recipes.forEach(function (r) { if (r.photoFileId) ids[r.photoFileId] = 1; });
    readPhotos_().forEach(function (p) { ids[p.fileId] = 1; });
    try { cache.put(PHOTO_IDS_KEY, JSON.stringify(ids), 6 * 3600); } catch (err) { /* too big to keep: read it each time */ }
  }
  return ids;
}

/** An uploaded file from the site: {name, data (base64)}. Checks its kind from its name. */
function uploadPart_(part, photoOnly) {
  if (!part || !part.name || !part.data) return null;
  var name = String(part.name).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim();
  var m = /^(.*?)\.([a-z0-9]+)$/i.exec(name);
  var ext = m ? m[2].toLowerCase() : '';
  var type = PHOTO_TYPES[ext] || (!photoOnly && RECIPE_TYPES[ext]);
  if (!type) {
    throw siteError_(photoOnly ? 'The dish photo should be a JPEG, PNG, WebP, GIF or HEIC picture.'
      : 'That kind of file can\'t be read. Use a PDF, a photo, a Word file (.docx) or a text file.', 400);
  }
  var base = (m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Recipe';
  return { base: base, ext: ext === 'jpeg' ? 'jpg' : ext, type: type, bytes: Utilities.base64Decode(String(part.data)) };
}

/** Processing in a minute or so, instead of waiting for the hourly run. */
function scheduleSoon_() {
  var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === SOON_HANDLER; });
  if (!pending) ScriptApp.newTrigger(SOON_HANDLER).timeBased().after(60 * 1000).create();
}

async function processSoon() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SOON_HANDLER) ScriptApp.deleteTrigger(t);
  });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { // a run is going, which may have started before this was added
    scheduleSoon_();
    return;
  }
  try {
    await processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}
