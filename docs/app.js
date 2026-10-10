// Recipe book front end. Everything goes through the web app in apps-script/Site.gs,
// which checks the shared password and reads and writes Drive and Sheets for the site.

const CFG = { siteTitle: 'Recipe book', ...window.RECIPE_BOX_CONFIG };
const DEMO = new URLSearchParams(location.search).has('demo');
const ACCESS_KEY = 'rb-access'; // {password, name} on this device
const DEVICE_KEY = 'rb-device'; // this device's own id, so its notes can be deleted from it
const NAME_KEY = 'rb-name'; // kept when the password changes, so it needn't be typed again
const TICKS_KEY = 'rb-ticks';
const TICKS_TTL = 12 * 3600_000; // ticks older than this belong to a previous cook
const UPLOAD_MAX = 20 * 1024 * 1024;

const state = {
  user: null,             // {device, name} once the password is in
  recipes: [],
  byId: new Map(),
  ingredients: new Map(), // canonical -> {name, staple, recipeIds:Set}
  mainCounts: null, // ingredient -> how many recipes it is a main ingredient of
  notes: null,            // [{row, id, recipeId, timestamp, email, name, text}]; email holds the device id
  photos: new Map(),      // fileId -> Promise<objectURL|null>
  addedPhotos: [],        // photos people added on the site: [{id, recipeId, timestamp, name, fileId}], oldest first
  reports: [],            // problems reported on the site: [{id, recipeId, timestamp, name, text, status, detail, decision, decidedBy, decidedAt}]
  fixes: {},              // recipe id -> Claude's change after a report, from recipes.json
  saved: null,            // {savedAt, version} while showing this device's saved copy
  version: null,          // which recipes.json is showing, so an unchanged one isn't downloaded again
  search: { text: '', ingredients: [], missing: [], course: '', showHidden: false },
};
const emptySearch = (text = '') => ({ text, ingredients: [], missing: [], course: '', showHidden: false });

const app = document.getElementById('app');
document.getElementById('brand').textContent = CFG.siteTitle;
document.title = CFG.siteTitle;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const canon = (item) => (item.canonical || item.name).toLowerCase().trim();

function fmtMinutes(m) {
  if (m == null) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function totalMinutes(r) {
  return r.totalMinutes ?? ((r.prepMinutes ?? 0) + (r.cookMinutes ?? 0) || null);
}

function allItems(r) {
  return r.ingredientGroups.flatMap((g) => g.items);
}

function banner(html, kind = 'info') {
  const el = document.getElementById('banner');
  el.className = `banner ${kind}`;
  el.innerHTML = html;
  el.hidden = !html;
}

// Each course has its own clay pigment; unknown courses get one by hash.
// 1 terracotta, 2 ochre, 3 mint, 4 rose clay, 5 majorelle blue, 6 olive.
const COURSE_PIGMENTS = {
  main: 1, dinner: 1, side: 3, salad: 3, vegetable: 3, dessert: 4, pudding: 4, sweet: 4,
  baking: 2, bread: 2, cake: 2, breakfast: 2, brunch: 2, lunch: 5, starter: 5, soup: 5, drink: 5,
  sauce: 6, snack: 6, preserve: 6,
};
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function pigmentFor(course) {
  if (!course) return 'pg-1';
  const key = course.toLowerCase().replace(/s$/, '');
  return `pg-${COURSE_PIGMENTS[key] ?? 1 + (hash(key) % 6)}`;
}

// ---------- ticks: shared by the recipe page and cooking mode ----------

const ticks = (() => {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(TICKS_KEY) || '{}'); } catch { /* storage blocked */ }
  for (const [id, t] of Object.entries(all)) if (!(Date.now() - t.at < TICKS_TTL)) delete all[id];
  return {
    get(id) { return all[id] ??= { ing: [], steps: [], pos: 0, at: Date.now() }; },
    has(id, kind, key) { return this.get(id)[kind].includes(key); },
    set(id, kind, key, on) {
      const t = this.get(id);
      t[kind] = t[kind].filter((k) => k !== key);
      if (on) t[kind].push(key);
      t.at = Date.now();
      this.save();
    },
    setPos(id, pos) { const t = this.get(id); t.pos = pos; t.at = Date.now(); this.save(); },
    setScale(id, f) { const t = this.get(id); t.scale = f; t.at = Date.now(); this.save(); },
    save() { try { localStorage.setItem(TICKS_KEY, JSON.stringify(all)); } catch { /* fine */ } },
  };
})();

// ---------- access: one shared password ----------

let access = null; // {password, name, device} while the password is in

function loadAccess() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCESS_KEY) || 'null');
    if (a?.password && a.name) return { ...a, device: deviceId() };
  } catch { /* storage blocked */ }
  return null;
}

function setAccess(a) {
  access = a;
  state.user = a ? { device: a.device, name: a.name } : null;
  try {
    if (a) {
      localStorage.setItem(ACCESS_KEY, JSON.stringify({ password: a.password, name: a.name }));
      localStorage.setItem(NAME_KEY, a.name);
    } else {
      localStorage.removeItem(ACCESS_KEY);
    }
  } catch { /* fine: asked again next time */ }
}

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) localStorage.setItem(DEVICE_KEY, id = `device:${crypto.randomUUID()}`);
    return id;
  } catch {
    return `device:${crypto.randomUUID()}`;
  }
}

/**
 * One request to the web app. Sent as plain text so the browser sends it without
 * asking permission first, which Apps Script can't answer. Failures throw an Error
 * with .status, as the web app reports it (0 if it couldn't be reached).
 */
async function call(action, args = {}, a = access) {
  if (!a) throw Object.assign(new Error('Enter the password to do this.'), { status: 401 });
  let res;
  try {
    res = await fetch(CFG.serviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...args, action, password: a.password, device: a.device, name: a.name }),
    });
  } catch {
    throw Object.assign(new Error(navigator.onLine === false ? 'You’re offline.' : 'Could not reach the recipe book.'), { status: 0 });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: `The recipe book sent back something unexpected (${res.status}).`, status: res.status || 500 };
  }
  if (body.error) {
    if (body.status === 401 && a === access) passwordChanged();
    throw Object.assign(new Error(body.error), { status: body.status });
  }
  return body;
}

function setSignedIn(on) {
  document.getElementById('signout').hidden = !on || DEMO;
  document.querySelector('.topbar nav a').hidden = !on;
}

function showPassword(message = '') {
  let name = '';
  try { name = localStorage.getItem(NAME_KEY) || ''; } catch { /* storage blocked */ }
  leaveCooking();
  banner('');
  setSignedIn(false);
  app.innerHTML = `
    <section class="signin">
      <form class="signin-card" id="password-form">
        <h1 class="wordmark">${esc(CFG.siteTitle)}</h1>
        <p>Our shared recipes. Enter the password, and your name to sign any notes you add.</p>
        <label class="field"><span class="vh">Password</span>${icon('lock')}
          <input id="pw" type="password" autocomplete="current-password" placeholder="Password" required></label>
        <label class="field"><span class="vh">Your name</span>${icon('person')}
          <input id="pw-name" autocomplete="given-name" placeholder="Your name" maxlength="60" value="${esc(name)}" required></label>
        <p class="error" id="pw-msg" role="alert"${message ? '' : ' hidden'}>${esc(message)}</p>
        <button class="button primary" type="submit">Open the book</button>
        ${state.saved ? '<button class="link" type="button" id="pw-back">Back to the saved copy</button>' : ''}
      </form>
    </section>`;
  const form = document.getElementById('password-form');
  const msg = document.getElementById('pw-msg');
  document.getElementById('pw-back')?.addEventListener('click', showSavedCopy);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const a = { password: form.pw.value.trim(), name: form['pw-name'].value.trim().replace(/\s+/g, ' '), device: deviceId() };
    if (!a.password || !a.name) return;
    e.submitter.disabled = true;
    msg.hidden = true;
    try {
      const book = await call('open', { since: state.version }, a);
      setAccess(a);
      await start(book);
    } catch (err) {
      msg.hidden = false;
      msg.textContent = err.status === 401 ? 'That isn’t the password.' : err.message;
      e.submitter.disabled = false;
    }
  };
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-signin]')) showPassword(); });

/** The password was changed: this device has to be given the new one. */
function passwordChanged() {
  setAccess(null);
  showPassword('The password has changed. Enter the new one.');
}

function signOut() {
  setAccess(null);
  try { localStorage.removeItem(NAME_KEY); } catch { /* fine */ }
  state.notes = null;
  state.addedPhotos = [];
  state.reports = [];
  state.saved = null;
  state.version = null;
  state.photos.clear();
  forgetSaved(); // signing out also removes the saved copy from this device
  banner('');
  showPassword();
}
document.getElementById('signout').onclick = signOut;

// ---------- saved copy: opens the book on this device straight away, and offline ----------

const SAVED = 'rb-saved';
const savedKey = (name) => new URL(`saved/${name}`, location.href).href;

/** True if it was saved. */
async function savedPut(name, body, type = 'application/json') {
  if (DEMO || !window.caches) return false;
  try {
    await (await caches.open(SAVED)).put(savedKey(name), new Response(body, { headers: { 'Content-Type': type } }));
    return true;
  } catch {
    return false; // storage full or blocked: the book still works online
  }
}

async function savedGet(name) {
  if (DEMO || !window.caches) return null;
  try { return (await (await caches.open(SAVED)).match(savedKey(name))) || null; } catch { return null; }
}

async function forgetSaved() {
  try { await caches.delete(SAVED); } catch { /* fine */ }
}

/** Uses recipes.json: the one given, the demo one, or this device's saved copy. */
async function loadRecipes(data) {
  if (!data) {
    data = DEMO ? await (await fetch('demo/recipes.json', { cache: 'no-store' })).json()
      : await (await savedGet('recipes.json')).json();
  }
  state.recipes = data.recipes.slice().sort((a, b) => a.title.localeCompare(b.title));
  state.byId = new Map(state.recipes.map((r) => [r.id, r]));
  state.fixes = data.fixes || {};
  applyUndos();
  buildIngredientIndex();
  if (!swapIndex) await loadSwaps();
}

/** What the web app's "open" sent: recipes (unless this device already has that version), notes, added photos and reports. */
async function useBook(book) {
  const fresh = !!book.index;
  if (fresh) await loadRecipes(book.index);
  state.version = book.version;
  setNotes(book.notes);
  state.undoneMeanwhile = setExtras({ photos: book.photos || [], reports: book.reports || [] });
  const kept = fresh ? await savedPut('recipes.json', JSON.stringify(book.index)) : true;
  if (kept) savedPut('about.json', JSON.stringify({ savedAt: new Date().toISOString(), version: book.version }));
  navigator.storage?.persist?.().catch(() => {});
  return fresh;
}

function buildIngredientIndex() {
  const extra = new Set(CFG.extraStaples.map((s) => s.toLowerCase()));
  const map = new Map();
  for (const r of state.recipes) {
    for (const item of allItems(r)) {
      const key = canon(item);
      if (!map.has(key)) map.set(key, { name: key, stapleVotes: 0, uses: 0, recipeIds: new Set() });
      const e = map.get(key);
      e.uses++;
      if (item.staple) e.stapleVotes++;
      e.recipeIds.add(r.id);
    }
  }
  for (const e of map.values()) e.staple = extra.has(e.name) || e.stapleVotes * 2 > e.uses;
  state.ingredients = map;
  state.mainCounts = null;
}

// A failed download isn't remembered, so the next time the photo is shown it's tried again.
const forget = (key) => { state.photos.delete(key); return null; };

function photoUrl(fileId) {
  if (!fileId) return Promise.resolve(null);
  if (!state.photos.has(fileId)) {
    state.photos.set(fileId, (DEMO ? Promise.resolve(fileId.startsWith('data:') ? fileId : `demo/${fileId}`) :
      photoBlob(fileId).then((b) => (b ? URL.createObjectURL(b) : forget(fileId)))).catch(() => forget(fileId)));
  }
  return state.photos.get(fileId);
}

/** A photo from this device's saved copy, or from the web app (then saved). Photo files are never
 * changed in place (a new photo gets a new file), so a saved one is always current. */
async function photoBlob(fileId) {
  const name = `photo/${encodeURIComponent(fileId)}`;
  const saved = await savedGet(name);
  if (saved) return saved.blob();
  if (!access) return null;
  const blob = await fetchPhoto(fileId);
  if (blob) savedPut(name, blob, blob.type || 'image/jpeg');
  return blob;
}

// Photos are asked for a few to a request, and a few requests at a time: the web
// app only runs so many requests at once, and the recipe grid wants dozens.
const photoQueue = { waiting: new Map(), timer: null, running: 0 };

function fetchPhoto(id) {
  return new Promise((resolve, reject) => {
    const q = photoQueue;
    if (!q.waiting.has(id)) q.waiting.set(id, []);
    q.waiting.get(id).push({ resolve, reject });
    q.timer ??= setTimeout(sendPhotoRequests, 30);
  });
}

function sendPhotoRequests() {
  const q = photoQueue;
  q.timer = null;
  while (q.running < 4 && q.waiting.size) {
    const batch = [...q.waiting].slice(0, 6);
    batch.forEach(([id]) => q.waiting.delete(id));
    q.running++;
    call('photos', { ids: batch.map(([id]) => id) })
      .then(({ photos }) => batch.forEach(([id, waiters]) => {
        const blob = photos[id] ? base64Blob(photos[id].data, photos[id].type) : null;
        waiters.forEach((w) => w.resolve(blob));
      }), (err) => batch.forEach(([, waiters]) => waiters.forEach((w) => w.reject(err))))
      .finally(() => { q.running--; sendPhotoRequests(); });
  }
}

function base64Blob(data, type) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** The recipe's picture; when the dish photo sits inside a page picture, cut it out. */
function recipePhotoUrl(r) {
  if (!r.photoCrop) return photoUrl(r.photoFileId);
  const key = `${r.photoFileId}#${JSON.stringify(r.photoCrop)}`;
  if (!state.photos.has(key)) {
    state.photos.set(key, photoUrl(r.photoFileId).then((url) => (url ? cropImage(url, r.photoCrop) : forget(key))).catch(() => forget(key)));
  }
  return state.photos.get(key);
}

function cropImage(url, crop) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = crop.left * img.naturalWidth, sy = crop.top * img.naturalHeight;
      const sw = crop.width * img.naturalWidth, sh = crop.height * img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('crop failed'))), 'image/jpeg', 0.9);
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function loadNotes() {
  if (DEMO) {
    try { state.notes = JSON.parse(localStorage.getItem('rb-demo-notes') || '[]'); } catch { state.notes = []; }
    return;
  }
  if (!access) {
    const saved = await savedGet('notes.json');
    state.notes = saved ? await saved.json() : [];
    return;
  }
  setNotes((await call('notes')).notes);
}

function setNotes(notes) {
  state.notes = notes;
  savedPut('notes.json', JSON.stringify(notes));
}

/** Anyone with the password can add notes and recipes; the saved copy alone is read-only. */
async function canWriteNotes() {
  return DEMO || !!access;
}

async function addNote(recipeId, text) {
  if (DEMO) {
    state.notes.push({
      id: crypto.randomUUID(), recipeId, timestamp: new Date().toISOString(),
      email: state.user.device, name: state.user.name, text, row: state.notes.length + 2,
    });
    localStorage.setItem('rb-demo-notes', JSON.stringify(state.notes));
    return;
  }
  setNotes((await call('addNote', { recipeId, text })).notes);
}

async function deleteNote(note) {
  if (DEMO) {
    state.notes = state.notes.filter((n) => n.id !== note.id);
    localStorage.setItem('rb-demo-notes', JSON.stringify(state.notes));
    return;
  }
  setNotes((await call('deleteNote', { id: note.id })).notes);
}

async function loadStatus() {
  if (DEMO) {
    return [['example.pdf', 'ok', '1', '', new Date().toISOString()],
      ...demoAdded().reverse().map((x) => (/^https?:/.test(x)
        ? [x, 'waiting', '', `Added by ${state.user.name}. Fetched in the next few minutes.`]
        : [x, 'waiting', '', `Uploaded by ${state.user.name}. Read by Claude in the next few minutes.`]))];
  }
  return (await call('status')).rows;
}

// In the demo, web addresses and uploads are only listed in this browser.
const demoAdded = () => { try { return JSON.parse(localStorage.getItem('rb-demo-links') || '[]'); } catch { return []; } };
const demoAdd = (x) => localStorage.setItem('rb-demo-links', JSON.stringify([...demoAdded(), x]));

/** Asks the background job to fetch a recipe from a web address. */
async function addLink(url) {
  if (DEMO) return demoAdd(url);
  await call('link', { url });
}

/** Uploads a recipe file, and optionally a photo of the dish. Returns the name it was saved under. */
async function uploadRecipe(recipe, photo) {
  if (DEMO) {
    demoAdd(recipe.name);
    return recipe.name;
  }
  const part = async (file) => file && { name: file.name, data: await base64Of(file) };
  return (await call('upload', { recipe: await part(recipe), photo: await part(photo) })).file;
}

function base64Of(file) {
  return dataUrlOf(file).then((url) => url.split(',')[1] || '');
}

function dataUrlOf(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- added photos and reported problems ----------

/** Keeps the added photos and reports, on this device too (in the demo, in this browser only). True if an undo changed a recipe. */
function setExtras({ photos = state.addedPhotos, reports = state.reports }) {
  state.addedPhotos = photos;
  state.reports = reports;
  if (DEMO) {
    try {
      localStorage.setItem('rb-demo-photos', JSON.stringify(photos));
      localStorage.setItem('rb-demo-reports', JSON.stringify(reports));
    } catch {
      toast('This browser has no room to keep more of the demo’s photos.');
    }
  } else {
    savedPut('extras.json', JSON.stringify({ photos, reports }));
  }
  const undone = applyUndos();
  if (undone) buildIngredientIndex();
  return undone;
}

function loadDemoExtras() {
  const get = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  setExtras({ photos: get('rb-demo-photos', []), reports: get('rb-demo-reports', DEMO_REPORTS) });
}

// The demo's sample recipes.json has one change by Claude; this is the report behind it.
const DEMO_REPORTS = [{
  id: 'demo-report-1', recipeId: 'demo-1', timestamp: '2026-09-21T18:00:00Z', name: 'Demo user',
  text: 'Step 3 should say 15 minutes, not 10. The book says to simmer until thick.', status: 'changed',
  detail: 'Step 3 now simmers for 15 minutes, as the original says.', decision: '', decidedBy: '', decidedAt: '',
}];

const addedPhotosFor = (r) => state.addedPhotos.filter((p) => p.recipeId === r.id);

/** The picture to show for a recipe: the dish photo in the original, else the first photo added, else the page. */
function mainImage(r) {
  if (r.photoFileId && r.photoKind === 'dish') return { kind: 'dish', url: () => recipePhotoUrl(r) };
  const added = addedPhotosFor(r)[0];
  if (added) return { kind: 'added', url: () => photoUrl(added.fileId) };
  if (r.photoFileId) return { kind: r.photoKind, url: () => recipePhotoUrl(r) };
  return null;
}

/** A picture made ready to send: a JPEG at most `max` pixels across, the right way up. */
async function shrinkPhoto(file, max = DEMO ? 800 : 1600) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { // some browsers open some pictures (HEIC on an iPhone, say) only this way
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`“${file.name}” can’t be opened as a picture on this device. Try a JPEG or PNG.`));
      };
      img.src = url;
    });
  }
  const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  const f = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * f));
  canvas.height = Math.max(1, Math.round(h * f));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b)
    : reject(new Error(`Could not make “${file.name}” smaller to send.`))), 'image/jpeg', 0.85));
}

async function addPhoto(r, file) {
  const blob = await shrinkPhoto(file);
  if (DEMO) {
    const photo = { id: crypto.randomUUID(), recipeId: r.id, timestamp: new Date().toISOString(), name: state.user.name, fileId: await dataUrlOf(blob) };
    return setExtras({ photos: [...state.addedPhotos, photo] });
  }
  const { id, photos } = await call('addPhoto', { recipeId: r.id, photo: { name: 'photo.jpg', data: await base64Of(blob) } });
  const added = photos.find((p) => p.id === id);
  if (added) { // no need to download what was just sent
    state.photos.set(added.fileId, Promise.resolve(URL.createObjectURL(blob)));
    savedPut(`photo/${encodeURIComponent(added.fileId)}`, blob, 'image/jpeg');
  }
  setExtras({ photos });
}

async function removePhoto(id) {
  if (DEMO) return setExtras({ photos: state.addedPhotos.filter((p) => p.id !== id) });
  setExtras({ photos: (await call('removePhoto', { id })).photos });
}

async function sendReport(r, text) {
  if (DEMO) {
    return setExtras({ reports: [...state.reports, {
      id: crypto.randomUUID(), recipeId: r.id, timestamp: new Date().toISOString(), name: state.user.name, text,
      status: 'waiting', detail: '', decision: '', decidedBy: '', decidedAt: '',
    }] });
  }
  setExtras({ reports: (await call('report', { recipeId: r.id, text })).reports });
}

/** decision is keep or undo (Claude's change), or dismiss (a report Claude made no change for). */
async function decide(reportId, decision) {
  if (DEMO) {
    return setExtras({ reports: state.reports.map((x) => (x.id === reportId
      ? { ...x, decision, decidedBy: state.user.name, decidedAt: new Date().toISOString() } : x)) });
  }
  setExtras({ reports: (await call('decideFix', { id: reportId, decision })).reports });
}

/**
 * Claude's change to a recipe after a report: {fix, decision, by}, decision being the
 * latest keep or undo since the change (an older one was about an earlier change).
 * The hourly job carries the decision out; until then this device acts on it itself.
 */
function fixFor(r) {
  const fix = state.fixes[r.id];
  if (!fix) return null;
  const ids = new Set(fix.reports.map((x) => x.id));
  const latest = state.reports
    .filter((x) => ids.has(x.id) && (x.decision === 'keep' || x.decision === 'undo') && x.decidedAt >= fix.at)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  if (latest) return { fix, decision: latest.decision, by: latest.decidedBy };
  return { fix, decision: fix.kept ? 'keep' : null, by: fix.kept?.by };
}

/** Changes someone has undone go back on this device straight away. True if a recipe changed. */
function applyUndos() {
  let changed = false;
  for (const [id, fix] of Object.entries(state.fixes)) {
    const r = state.byId.get(id);
    if (!r || fix.undone || fixFor(r).decision !== 'undo') continue;
    Object.assign(r, fix.before);
    fix.undone = true;
    changed = true;
  }
  return changed;
}

const FIELD_NAMES = {
  title: 'Title', description: 'Description', servings: 'Serves', prepMinutes: 'Prep', cookMinutes: 'Cook',
  totalMinutes: 'Total time', timesAreEstimated: 'Times estimated', course: 'Course', cuisine: 'Cuisine', tags: 'Tags',
  ingredientGroups: 'Ingredients', steps: 'Steps', sourceNotes: 'From the original', author: 'Author', book: 'Book', sourceUrl: 'Web address',
};

const ingredientText = (i) => [[i.quantity, i.unit, i.name].filter(Boolean).join(' '), i.preparation].filter(Boolean).join(', ') +
  (i.optional ? ' (optional)' : '');

/** What the changed parts said before, as first read from the original. Lists show only the entries that went or changed. */
function beforeHtml(r, fix) {
  const now = fix.undone ? fix.fields : r;
  return Object.entries(fix.before).map(([k, old]) => {
    let body;
    if (k === 'steps') {
      const kept = new Set((now.steps || []).map((s) => s.text));
      const gone = (old || []).map((s, i) => [i, s]).filter(([, s]) => !kept.has(s.text));
      body = gone.length ? `<ul class="tips">${gone.map(([i, s]) => `<li><b>Step ${i + 1}:</b> ${esc(s.text)}</li>`).join('')}</ul>`
        : '<p>The same steps, in a different order or joined up differently in the flowchart.</p>';
    } else if (k === 'ingredientGroups') {
      const line = (g, i) => `${g.name ? `${g.name}: ` : ''}${ingredientText(i)}`;
      const kept = new Set((now.ingredientGroups || []).flatMap((g) => g.items.map((i) => line(g, i))));
      const gone = (old || []).flatMap((g) => g.items.map((i) => line(g, i))).filter((x) => !kept.has(x));
      body = gone.length ? `<ul class="tips">${gone.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
        : '<p>The same ingredients, grouped or ordered differently.</p>';
    } else if (Array.isArray(old)) {
      body = old.length ? `<ul class="tips">${old.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Nothing.</p>';
    } else {
      body = `<p>${old == null || old === '' ? 'Nothing.' : esc(typeof old === 'boolean' ? (old ? 'Yes' : 'No') : old)}</p>`;
    }
    return `<div class="before-field"><h4>${esc(FIELD_NAMES[k] || k)}</h4>${body}</div>`;
  }).join('');
}

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const canWrite = () => DEMO || !!access;

function reportQuote(x) {
  return `<blockquote class="report-text"><p>${esc(x.text).replace(/\n/g, '<br>')}</p>
    <footer>${esc(x.name || x.by || 'Someone')}, ${shortDate(x.timestamp || x.at)}</footer></blockquote>`;
}

/** Claude's change and the reports behind it, with Keep and Undo (just Undo once kept). */
function changeSlip(r, f) {
  const last = f.fix.reports.at(-1);
  const kept = f.decision === 'keep';
  const buttons = canWrite() ? (kept
    ? `<button class="link" data-decide="undo" data-report="${esc(last.id)}">Undo the change</button>`
    : `<button class="button primary" data-decide="keep" data-report="${esc(last.id)}">${icon('check')} Keep the change</button>
       <button class="button" data-decide="undo" data-report="${esc(last.id)}">${icon('undo')} Undo it</button>`) : '';
  return `<div class="slip fix-slip ${kept ? 'kept' : ''}">
    <p class="fix-head">${icon(kept ? 'check' : 'flag')} <b>${kept ? `Changed by Claude after a report, and kept by ${esc(f.by || 'someone')}`
      : 'Changed by Claude after a report. Does it look right?'}</b></p>
    ${f.fix.reports.map((x) => `${reportQuote(x)}${x.summary ? `<p class="fix-summary">${esc(x.summary)}</p>` : ''}`).join('')}
    <details class="before"><summary>What it said before</summary>${beforeHtml(r, f.fix)}</details>
    ${buttons ? `<p class="fix-actions">${buttons}</p>` : ''}
  </div>`;
}

/** Reports on this recipe that are still open, and Claude's change, if any. */
function renderFix(r) {
  const el = document.getElementById('fix');
  if (!el) return;
  const f = fixFor(r);
  const inFix = new Set(f ? f.fix.reports.map((x) => x.id) : []);
  const mine = state.reports.filter((x) => x.recipeId === r.id);
  const waiting = mine.filter((x) => (x.status === 'waiting' && x.decision !== 'dismiss') || (x.status === 'changed' && !inFix.has(x.id)));
  const unanswered = mine.filter((x) => (x.status === 'no change' || x.status === 'error') && !x.decision);
  el.innerHTML = [
    f && f.decision !== 'undo' ? changeSlip(r, f) : '',
    f && f.decision === 'undo' ? `<p class="checked-line">${icon('undo')} Claude’s change was undone by ${esc(f.by || 'someone')}. This is the recipe as first read.</p>` : '',
    ...waiting.map((x) => `<div class="slip report-slip">${reportQuote(x)}
      <p class="muted">${x.status === 'changed' ? 'Claude has changed the recipe. The change shows next time the book is opened.'
        : `Claude is checking this against the original${x.detail ? ` (last try: ${esc(x.detail)})` : ''}.`}</p></div>`),
    ...unanswered.map((x) => `<div class="slip report-slip">${reportQuote(x)}
      <p>${x.status === 'error' ? '' : 'Claude made no change. '}${esc(x.detail)}</p>
      ${canWrite() ? `<p><button class="link" data-decide="dismiss" data-report="${esc(x.id)}">Dismiss</button></p>` : ''}</div>`),
  ].join('');
}

/** Click handler for Keep, Undo, Dismiss and removing a photo; `after` redraws the page. */
function onFixClick(after) {
  return async (e) => {
    const b = e.target.closest('[data-decide],[data-remove-photo]');
    if (!b) return;
    if (b.dataset.removePhoto && !confirm('Remove this photo for everyone?')) return;
    b.disabled = true;
    try {
      if (b.dataset.decide) await decide(b.dataset.report, b.dataset.decide);
      else await removePhoto(b.dataset.removePhoto);
      if (b.dataset.decide === 'undo') toast('Undone. The recipe is back to how it was first read.');
      after(b.dataset.decide);
    } catch (err) {
      if (err.status !== 401) alert(`Could not do that: ${err.message}`);
      b.disabled = false;
    }
  };
}

// ---------- search ----------

/** Does the recipe need (not just optionally use) any ingredient the user doesn't have? */
function needsMissing(r) {
  if (!state.search.missing.length) return [];
  const missing = new Set(state.search.missing);
  return [...new Set(allItems(r).filter((i) => !i.optional && missing.has(canon(i))).map(canon))];
}

/** Is a recipe ingredient covered by one you've ticked? "tomato" covers "chopped tomato". */
const covers = (ticked, ingredient) => ticked === ingredient ||
  new RegExp(`\\b${ticked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(ingredient);

/** The ingredients you've ticked that this recipe uses. */
function usesHave(r) {
  if (!state.search.ingredients.length) return [];
  const used = [...new Set(allItems(r).map(canon))];
  return state.search.ingredients.filter((i) => used.some((u) => covers(i, u)));
}

/** Does the recipe need (not just optionally use) this ingredient? */
const needsKey = (r, key) => allItems(r).some((i) => !i.optional && canon(i) === key);

/**
 * Recipes matching the search, split into those you can make and those needing
 * something you lack. Ingredients you have never hide a recipe: they sort the ones
 * using most of them to the top, then the ones needing fewest other ingredients.
 */
function matchingRecipes() {
  const { text, ingredients, course } = state.search;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  let found = state.recipes.filter((r) => {
    if (course && r.course !== course) return false;
    if (!words.length) return true;
    const hay = [r.title, r.description, r.cuisine, r.course, r.author, r.book, r.sourceCredit, ...r.tags, ...allItems(r).map((i) => i.name)]
      .join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  let using = 0;
  if (ingredients.length) {
    const toGet = (r) => new Set(allItems(r).filter((i) => !i.optional).map(canon)
      .filter((k) => !ingredients.some((i) => covers(i, k)) && !state.ingredients.get(k)?.staple)).size;
    found = found.map((r) => ({ r, uses: usesHave(r).length, toGet: toGet(r) }))
      .sort((a, b) => b.uses - a.uses || a.toGet - b.toGet)
      .map((x) => x.r);
  }
  const list = found.filter((r) => !needsMissing(r).length);
  if (ingredients.length) using = list.filter((r) => usesHave(r).length).length;
  return { list, hidden: found.filter((r) => needsMissing(r).length), using };
}

/** Ingredients that most often appear alongside the selected ones, staples excluded. */
function coIngredientSuggestions(recipes, limit) {
  const skip = new Set([...state.search.ingredients, ...state.search.missing]);
  const counts = new Map();
  for (const r of recipes) {
    const seen = new Set();
    for (const item of allItems(r)) {
      const key = canon(item);
      if (seen.has(key) || skip.has(key) || state.ingredients.get(key)?.staple) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

/** How many recipes each ingredient is a main ingredient of (the ones shown on the cards). */
function mainCounts() {
  if (!state.mainCounts) {
    state.mainCounts = new Map();
    for (const r of state.recipes) {
      for (const k of keyIngredients(r)) state.mainCounts.set(k, (state.mainCounts.get(k) || 0) + 1);
    }
  }
  return state.mainCounts;
}

/**
 * Offered when the ingredient box opens: the ingredients that decide what you can
 * cook, not the pantry things everyone has. Those that are a main ingredient of the
 * most recipes come first, then the rarer ones.
 */
function distinctiveIngredients(limit) {
  const skip = new Set([...state.search.ingredients, ...state.search.missing]);
  const main = mainCounts();
  return [...state.ingredients.values()]
    .filter((e) => !e.staple && !skip.has(e.name))
    .sort((a, b) => (main.get(b.name) || 0) - (main.get(a.name) || 0) ||
      a.recipeIds.size - b.recipeIds.size || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => [e.name, e.recipeIds.size]);
}

// Units that tell us an ingredient is the bulk of a dish, in grams or millilitres.
const BULK_UNITS = { g: 1, gram: 1, kg: 1000, ml: 1, l: 1000, litre: 1000, liter: 1000, oz: 28, lb: 454 };

/**
 * The few ingredients that decide whether you can make this: the bulk of the dish
 * first (200 g or more), then the ones fewest other recipes use. Staples and
 * optional extras are left out.
 */
function keyIngredients(r, limit = 3) {
  const out = new Map();
  for (const item of allItems(r)) {
    const key = canon(item);
    const e = state.ingredients.get(key);
    if (item.optional || !e || e.staple || out.has(key)) continue;
    const unit = (item.unit || '').toLowerCase().replace(/\.$/, '').replace(/s$/, '');
    const amount = (parseFloat(item.quantity) || 0) * (BULK_UNITS[unit] || 0);
    out.set(key, { key, amount, bulk: amount >= 200, uses: e.recipeIds.size });
  }
  return [...out.values()]
    .sort((a, b) => b.bulk - a.bulk || (a.bulk && b.amount - a.amount) || a.uses - b.uses || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((x) => x.key);
}

// ---------- equipment, complexity and the check of each conversion ----------
// Recipes the Apps Script job hasn't checked yet have no equipment, unclear or certainty.

const equipment = (r) => r.equipment || [];
const equipmentName = (e) => (e.kind === 'other' ? e.other || 'other' : e.kind);
const equipmentIcon = (e) => icon(`eq-${e.kind.replace(/ /g, '-')}`);

/** Equipment as small icons with ×N, each named for screen readers and on hover. */
function kitIcons(r) {
  return equipment(r).map((e) => {
    const name = `${equipmentName(e)}${e.count > 1 ? ` ×${e.count}` : ''}`;
    return `<span class="kit-icon" role="img" aria-label="${esc(name)}" title="${esc(name)}">${equipmentIcon(e)}${e.count > 1 ? `<small>×${e.count}</small>` : ''}</span>`;
  }).join('');
}

/** How involved a recipe is, from the flowchart links and the equipment. One-pot recipes score 0. */
function complexity(r) {
  const ids = new Set(r.steps.map((s) => s.id));
  const links = (s) => s.dependsOn.filter((d) => ids.has(d) && d !== s.id); // as the flowchart draws them
  const starts = r.steps.filter((s) => !links(s).length).length;
  const joins = r.steps.filter((s) => links(s).length > 1).length;
  const kit = equipment(r).reduce((n, e) => n + e.count, 0);
  return { steps: r.steps.length, starts, joins, kit, score: Math.max(0, starts - 1) + joins + Math.max(0, kit - 1) };
}

function complexityText(c) {
  return [
    `${c.steps} step${c.steps === 1 ? '' : 's'}`,
    c.starts > 1 && `${c.starts} started separately`,
    c.joins && `${c.joins} point${c.joins === 1 ? '' : 's'} where they combine`,
  ].filter(Boolean).join(', ');
}

const CHECKED_PREFIX = 'Checked against the original';
/** The note saying someone compared the steps with the original and they are right. */
const checkedNote = (r) => (state.notes || []).find((n) => n.recipeId === r.id && n.text.startsWith(CHECKED_PREFIX) &&
  !(state.fixes[r.id] && !state.fixes[r.id].undone && n.timestamp < state.fixes[r.id].at)); // a check from before Claude's change no longer counts
const hasCheck = (r) => typeof r.certainty === 'number';
/** Unclear points still worth showing: none once someone has checked the recipe against the original. */
const unclearFor = (r) => (checkedNote(r) ? [] : r.unclear || []);

// ---------- views ----------

function recipeCard(r) {
  const t = fmtMinutes(totalMinutes(r));
  const missing = new Set(state.search.missing);
  const needs = needsMissing(r);
  const keys = keyIngredients(r);
  const uses = usesHave(r);
  return `
    <article class="card ${pigmentFor(r.course)} ${needs.length ? 'needs' : ''}" data-id="${esc(r.id)}">
      <a class="card-link" href="#/r/${encodeURIComponent(r.id)}">
        <div class="thumb ${mainImage(r)?.kind === 'page' ? 'page' : ''}" data-photo="${esc(r.id)}" style="--shift:${hash(r.id) % 32}px"></div>
        <h3>${esc(r.title)}</h3>
        ${r.author || r.book ? `<p class="meta source-line">${esc([r.author, r.book].filter(Boolean).join(' · '))}</p>` : ''}
        <p class="meta">${[t, r.servings && `serves ${r.servings}`].filter(Boolean).map(esc).join(' · ')}${equipment(r).length ? `<span class="kit" aria-label="Equipment">${kitIcons(r)}</span>` : ''}</p>
        ${uses.length ? `<p class="meta uses-line">${icon('check')}<span>Uses ${esc(uses.join(', '))}</span></p>` : ''}
        ${needs.length ? `<p class="meta needs-line">Needs ${esc(needs.join(', '))}</p>` : ''}
      </a>
      ${keys.length ? `<ul class="keys" aria-label="Main ingredients">${keys.map((k) =>
        `<li class="key ${missing.has(k) ? 'lacking' : ''}" data-key="${esc(k)}">${keyInner(k, missing.has(k))}</li>`).join('')}</ul>` : ''}
    </article>`;
}

/** One main ingredient on a card, with a cross for "I don't have this" (an undo arrow once crossed out). */
function keyInner(k, lacking) {
  return `<span>${esc(k)}</span><button class="key-x" data-lack="${esc(k)}" aria-pressed="${lacking}"
    aria-label="${lacking ? `I do have ${esc(k)}` : `I don’t have ${esc(k)}`}">${icon(lacking ? 'undo' : 'close')}</button>`;
}

/** "By <author> · <book> · Website" with author and book linking to a search for them. */
function byline(r) {
  const parts = [];
  if (r.author) parts.push(`By <a href="#/" data-search="${esc(r.author)}">${esc(r.author)}</a>`);
  if (r.book) parts.push(`<a href="#/" data-search="${esc(r.book)}"><cite>${esc(r.book)}</cite></a>`);
  if (r.sourceUrl && /^https?:\/\//i.test(r.sourceUrl)) {
    parts.push(`<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">Website</a>`);
  }
  return parts.length ? `<p class="byline">${parts.join(' · ')}</p>` : '';
}

// Clicking an author or book shows every recipe from them.
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-search]');
  if (!link) return;
  e.preventDefault();
  state.search = emptySearch(link.dataset.search);
  if (location.hash === '#/' || location.hash === '') route();
  else location.hash = '#/';
});

function hydratePhotos(root) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const r = state.byId.get(e.target.dataset.photo);
      mainImage(r)?.url().then((url) => {
        if (!url) return;
        // Photos are shown plainly, never tinted or framed.
        const img = document.createElement('img');
        img.className = 'photo';
        img.src = url;
        img.alt = e.target.classList.contains('plate') ? `Photo of ${r.title}` : '';
        e.target.append(img);
        e.target.classList.add('has-photo');
        if (e.target.classList.contains('plate')) img.onclick = () => zoom(url, img.alt);
      });
    }
  }, { rootMargin: '200px' });
  root.querySelectorAll('[data-photo]').forEach((el) => {
    const r = state.byId.get(el.dataset.photo);
    if (r && mainImage(r)) io.observe(el);
  });
}

function zoom(url, alt) {
  const z = document.createElement('div');
  z.className = 'zoom';
  z.innerHTML = `<img src="${esc(url)}" alt="${esc(alt)}">`;
  const close = () => { z.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  z.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(z);
}

/** A short message at the bottom of the screen with an Undo button. */
let toastTimer = null;
function toast(text, undo) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button class="link">Undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.remove(); undo(); };
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

let homeCtl = null;

function renderHome() {
  const courses = [...new Set(state.recipes.map((r) => r.course).filter(Boolean))].sort();
  const allIngredients = [...state.ingredients.values()].filter((e) => !e.staple).map((e) => e.name).sort();
  app.innerHTML = `
    <section class="finder">
      <div class="finder-panel">
        <label class="field"><span class="vh">Search by name, book, author or cuisine</span>${icon('search')}
          <input id="q" type="search" placeholder="Search recipes, books, cooks" value="${esc(state.search.text)}" autocomplete="off"></label>
        <label class="field"><span class="vh">Ingredients you have</span>${icon('carrot')}
          <input id="ing" list="ing-list" placeholder="Ingredients you have" autocomplete="off" aria-controls="suggest"></label>
        <datalist id="ing-list">${allIngredients.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>
        <div id="chips" class="chips"></div>
        <div id="suggest" class="suggest" hidden></div>
      </div>
    </section>
    <nav class="swatches" aria-label="Courses">
      ${[['', 'All'], ...courses.map((c) => [c, c])].map(([value, label]) =>
        `<button class="swatch ${value ? pigmentFor(value) : 'all'}" data-course="${esc(value)}"><span class="dot" aria-hidden="true"></span><span class="name">${esc(label)}</span></button>`).join('')}
    </nav>
    <p id="count" class="count" aria-live="polite"></p>
    <div id="grid" class="grid"></div>
    <div id="hidden" class="hidden-recipes"></div>`;

  const q = document.getElementById('q');
  const ing = document.getElementById('ing');
  const suggest = document.getElementById('suggest');
  let open = false; // the ingredient suggestions stay open while you pick, until you tap elsewhere
  const FIRST_SUGGESTIONS = 16;
  const MORE_SUGGESTIONS = 15;
  let suggestLimit = FIRST_SUGGESTIONS;
  const close = () => { open = false; suggestLimit = FIRST_SUGGESTIONS; update(); };

  q.oninput = () => { state.search.text = q.value; update(); };
  const addIngredient = (name) => {
    const key = name.toLowerCase().trim();
    if (key && !state.search.ingredients.includes(key)) state.search.ingredients.push(key);
    state.search.missing = state.search.missing.filter((m) => m !== key);
    ing.value = '';
    update();
  };
  const markLacking = (key, lacking) => {
    state.search.missing = state.search.missing.filter((m) => m !== key);
    if (lacking) {
      state.search.missing.push(key);
      state.search.ingredients = state.search.ingredients.filter((i) => i !== key);
    }
  };
  const setLacking = (key, lacking) => { markLacking(key, lacking); update(); };

  // Crossing out an ingredient fades the recipes that need it for a few seconds
  // before hiding them, so a mis-tap can be undone in place.
  const FADE_MS = 4000;
  const leaving = new Map(); // ingredient -> timer
  const setKeys = (key, lacking) => app.querySelectorAll(`.key[data-key="${CSS.escape(key)}"]`).forEach((li) => {
    li.classList.toggle('lacking', lacking);
    li.innerHTML = keyInner(key, lacking);
  });
  const startLeaving = (key) => {
    setKeys(key, true);
    for (const card of app.querySelectorAll('.card[data-id]')) {
      if (!needsKey(state.byId.get(card.dataset.id), key)) continue;
      card.style.setProperty('--fade', `${FADE_MS}ms`);
      card.classList.add('leaving');
      card.insertAdjacentHTML('beforeend', `<p class="leaving-line" data-leaving="${esc(key)}">
        <span>No ${esc(key)}, so hiding this</span><button class="link" data-lack="${esc(key)}">Keep</button></p>`);
    }
    leaving.set(key, setTimeout(() => {
      leaving.delete(key);
      if (!app.contains(ing)) { markLacking(key, true); return; } // you've moved on to another page
      const before = matchingRecipes().list.length;
      setLacking(key, true);
      const gone = before - matchingRecipes().list.length;
      if (gone > 0) toast(`Hid ${gone === 1 ? '1 recipe that needs' : `${gone} recipes that need`} ${key}`, () => setLacking(key, false));
    }, FADE_MS));
  };
  const stopLeaving = (key) => {
    clearTimeout(leaving.get(key));
    leaving.delete(key);
    setKeys(key, false);
    app.querySelectorAll(`.leaving-line[data-leaving="${CSS.escape(key)}"]`).forEach((line) => {
      const card = line.closest('.card');
      line.remove();
      if (!card.querySelector('.leaving-line')) card.classList.remove('leaving');
    });
  };
  // Anything else that redraws the list settles the fades first.
  const settleLeaving = () => {
    for (const [key, timer] of leaving) { clearTimeout(timer); markLacking(key, true); }
    leaving.clear();
  };
  ing.onchange = () => addIngredient(ing.value);
  ing.onkeydown = (e) => {
    if (e.key === 'Enter') addIngredient(ing.value);
    if (e.key === 'Escape') close();
  };
  ing.onfocus = () => { if (!open) { open = true; update(); } };

  homeCtl?.abort();
  homeCtl = new AbortController();
  document.addEventListener('pointerdown', (e) => {
    if (!app.contains(ing)) { homeCtl.abort(); return; }
    if (open && !e.target.closest('.finder')) close();
  }, { signal: homeCtl.signal });

  function update() {
    settleLeaving();
    const { list, hidden, using } = matchingRecipes();
    const { ingredients, missing } = state.search;
    app.querySelectorAll('[data-course]').forEach((t) => {
      const on = t.dataset.course === state.search.course;
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', on);
    });
    document.getElementById('chips').innerHTML = [
      ...ingredients.map((i) => `<button class="chip have" data-remove="${esc(i)}" aria-label="Remove ${esc(i)}">${icon('check')}${esc(i)} ${icon('close')}</button>`),
      ...missing.map((i) => `<button class="chip lacking" data-unlack="${esc(i)}" aria-label="I do have ${esc(i)} after all">No ${esc(i)} ${icon('close')}</button>`),
    ].join('');
    // one extra tells us whether there are more to offer
    const sugg = ingredients.length ? coIngredientSuggestions(list.slice(0, using), suggestLimit + 1)
      : distinctiveIngredients(suggestLimit + 1);
    const more = sugg.length > suggestLimit;
    if (more) sugg.pop();
    suggest.hidden = !open || !sugg.length;
    ing.setAttribute('aria-expanded', !suggest.hidden);
    suggest.innerHTML = sugg.length ? `
      <p class="suggest-head">${ingredients.length ? 'Goes well with' : 'Tap what you have'}</p>
      <div class="suggest-chips">${sugg.map(([n, c]) => `<button class="chip" data-add="${esc(n)}">${esc(n)} <small>${c}</small></button>`).join('')}
        ${more ? `<button class="chip more" data-more>More ${icon('down')}</button>` : ''}</div>` : '';
    const filtered = state.search.text || ingredients.length || missing.length || state.search.course;
    const shown = filtered ? `${list.length} of ${state.recipes.length} recipes` : `${state.recipes.length} recipes`;
    document.getElementById('count').textContent = !ingredients.length ? shown
      : !using ? `None of ${list.length} recipes use what you’ve ticked`
      : `${using} of ${list.length} recipes use what you have, best matches first`;
    const grid = document.getElementById('grid');
    if (!state.recipes.length) {
      grid.innerHTML = '<p class="empty">No recipes yet. <a href="#/inbox">Add the first one</a>.</p>';
    } else if (!list.length) {
      grid.innerHTML = '<p class="empty">Nothing matches all of that. <button class="link" data-clear>Clear the search</button></p>';
    } else {
      const cards = list.map(recipeCard);
      if (using && using < list.length) {
        cards.splice(using, 0, '<p class="grid-break">These don’t use anything you’ve ticked</p>');
      }
      grid.innerHTML = cards.join('');
      hydratePhotos(grid);
    }
    const hid = document.getElementById('hidden');
    if (!hidden.length) {
      hid.innerHTML = '';
    } else {
      const n = hidden.length === 1 ? '1 recipe needs' : `${hidden.length} recipes need`;
      hid.innerHTML = `
        <p class="hidden-line">${n} something you don’t have.
          <button class="link" data-show-hidden>${state.search.showHidden ? 'Hide them' : 'Show them'}</button></p>
        ${state.search.showHidden ? `<div class="grid">${hidden.map(recipeCard).join('')}</div>` : ''}`;
      if (state.search.showHidden) hydratePhotos(hid);
    }
  }

  app.onclick = (e) => {
    const rm = e.target.closest('[data-remove]');
    const unlack = e.target.closest('[data-unlack]');
    const add = e.target.closest('[data-add]');
    if (e.target.closest('[data-more]')) { suggestLimit += MORE_SUGGESTIONS; update(); }
    const lack = e.target.closest('[data-lack]');
    const course = e.target.closest('[data-course]');
    if (rm) { state.search.ingredients = state.search.ingredients.filter((i) => i !== rm.dataset.remove); update(); }
    if (unlack) setLacking(unlack.dataset.unlack, false);
    if (add) addIngredient(add.dataset.add);
    if (lack) {
      const key = lack.dataset.lack;
      if (leaving.has(key)) stopLeaving(key);
      else if (state.search.missing.includes(key)) setLacking(key, false);
      else startLeaving(key);
    }
    if (course) { state.search.course = course.dataset.course; update(); }
    if (e.target.closest('[data-show-hidden]')) { state.search.showHidden = !state.search.showHidden; update(); }
    if (e.target.closest('[data-clear]')) {
      state.search = emptySearch();
      q.value = '';
      update();
    }
  };
  app.onchange = null;
  update();
}

// ---------- scaling: everything is multiplied by one factor, kept with the ticks ----------
// Quantities are free text as written ("1 1/2", "200", "2-3", "a pinch"), so only the
// first number (and the second of a range) is scaled; the rest is kept as it is.

const VULGAR = { '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
const NUM = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?(?:\s*[¼½¾⅓⅔⅛⅜⅝⅞])?|\.\d+|[¼½¾⅓⅔⅛⅜⅝⅞]`;
const AMOUNT = new RegExp(`(${NUM})(?:(\\s*(?:-|–|to|or)\\s*)(${NUM}))?`);
const DECIMAL_UNITS = new Set(['g', 'gram', 'kg', 'mg', 'ml', 'cl', 'dl', 'l', 'litre', 'liter']);

/** "1 1/2", "1½", "3/4", "0.5" or "½" as a number. */
function parseNumber(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return m[1] / m[2];
  if ((m = s.match(/^(\d*\.?\d*)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/))) return (+m[1] || 0) + VULGAR[m[2]];
  return parseFloat(s);
}

/** The first amount in some text: {value, index, length} or null. */
function firstAmount(text) {
  const m = AMOUNT.exec(text || '');
  const value = m && parseNumber(m[1]);
  return value > 0 ? { value, m } : null;
}

/** Kitchen-friendly rounding: grams and millilitres as decimals, everything else in quarters and thirds. */
function fmtAmount(v, unit) {
  if (DECIMAL_UNITS.has((unit || '').toLowerCase().replace(/\.$/, '').replace(/s$/, ''))) {
    const r = v >= 100 ? Math.round(v / 5) * 5 : v >= 10 ? Math.round(v) : +v.toPrecision(2);
    return String(r);
  }
  if (v >= 10) return String(Math.round(v));
  const fracs = v < 1 ? [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1] : [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
  let whole = Math.floor(v);
  let frac = fracs.reduce((a, b) => (Math.abs(b - (v - whole)) < Math.abs(a - (v - whole)) ? b : a));
  if (frac === 1) { whole += 1; frac = 0; }
  if (!whole && !frac) frac = 1 / 8;
  const glyph = Object.keys(VULGAR).find((k) => Math.abs(VULGAR[k] - frac) < 1e-9) || '';
  return `${whole || ''}${glyph}` || '0';
}

/** Text with its first amount (or range) multiplied by f; unchanged when it has no amount. */
function scaleText(text, f, unit) {
  const a = firstAmount(text);
  if (!a || Math.abs(f - 1) < 1e-9) return text;
  const [all, , sep, second] = a.m;
  const to = second ? `${sep}${fmtAmount(parseNumber(second) * f, unit)}` : '';
  return text.slice(0, a.m.index) + fmtAmount(a.value * f, unit) + to + text.slice(a.m.index + all.length);
}

const scaleOf = (r) => ticks.get(r.id).scale || 1;
const isScaled = (r) => Math.abs(scaleOf(r) - 1) > 1e-9;
/** Serves (or makes) how many, as a number, when the recipe says. */
const baseServings = (r) => firstAmount(r.servings)?.value || null;

function ingredientLine(i, f = 1, editable = '') {
  const amount = [scaleText(i.quantity, f, i.unit), i.unit].filter(Boolean).join(' ');
  const amountHtml = editable && firstAmount(i.quantity)
    ? `<button type="button" class="amount" data-amount="${editable}" aria-label="Change the amount of ${esc(i.name)}, now ${esc(amount)}">${esc(amount)}</button>`
    : `<b>${esc(amount)}</b>`;
  return `${amountHtml} ${esc(i.name)}${i.preparation ? `, <i>${esc(i.preparation)}</i>` : ''}${i.optional ? ' <small class="muted">(optional)</small>' : ''}`;
}

// ---------- swaps: close equivalents for an ingredient, from swaps.json ----------
// Each pair says how much of b replaces 1 of a (factor, in the same unit unless the sides
// give units), how alike they are (1 to 3), and what changes.

const LIKENESS = { 3: 'Barely notice', 2: 'Small difference', 1: 'Works in a pinch' };
// A line with no form word is taken to be fresh (herbs, tomatoes), fine (salt) or uncooked (rice).
const DEFAULT_FORMS = new Set(['fresh', 'fine', 'uncooked']);
const WEIGHT_UNITS = /^(g|gram|kg|kilo|oz|ounce|lb|pound)$/;
const SPOON_UNITS = /^(tsp|tbsp)$/;
let swapIndex = null; // swapKey(name) -> [{e, from: 'a' or 'b'}]
const openSwaps = new Set(); // "recipeId gi-ii" of swap lists left open, so rescaling keeps them

/** Lower case, no accents or hyphens, last word singular: "Flat-leaf parsley" meets "flat leaf parsley". */
function swapKey(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/yogurt/g, 'yoghurt').replace(/\bsoured\b/g, 'sour').replace(/[-\s]+/g, ' ').trim()
    .replace(/chillies$/, 'chilli').replace(/leaves$/, 'leaf')
    .replace(/(oes|ies|[sc]hes|s)$/, (m) => (m === 'ies' ? 'y' : m === 's' ? '' : m.slice(0, -2)));
}

/** "g jar" -> "g", "teaspoons" -> "tsp", "cloves" -> "clove". */
function unitWord(unit) {
  const u = swapKey(String(unit || '').split(/[\s(,]/)[0]).replace(/\.$/, '');
  return { teaspoon: 'tsp', tablespoon: 'tbsp', tbs: 'tbsp', tblsp: 'tbsp' }[u] || u;
}

async function loadSwaps() {
  try {
    const res = await fetch('swaps.json');
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    indexSwaps(JSON.parse(text));
    savedPut('swaps.json', text);
  } catch {
    const saved = await savedGet('swaps.json'); // offline
    if (saved) indexSwaps(await saved.json());
  }
}

function indexSwaps(data) {
  swapIndex = new Map();
  formWords = new Set();
  for (const e of data.swaps) {
    for (const from of ['a', 'b']) {
      const k = swapKey(e[from].name);
      if (!swapIndex.has(k)) swapIndex.set(k, []);
      swapIndex.get(k).push({ e, from });
      for (const w of formsOf(e[from]) || []) formWords.add(w);
    }
  }
}

// A strong form word on the line ("ground", "jarred") has to be in the swap's own name or label too:
// ground coriander is not fresh coriander. Softer words ("chopped", "handful") don't rule anything out.
const STRONG_FORMS = [['dried', 'dry'], ['tin', 'tinned', 'can', 'canned', 'jar', 'jarred', 'pouch'], ['frozen'], ['cooked'],
  ['ground'], ['powder'], ['paste', 'puree', 'purée'], ['flakes'], ['granules'], ['cube', 'cubes', 'bouillon']];
const strongGroup = (w) => STRONG_FORMS.find((g) => g.includes(w));
let formWords = new Set(); // every form word in swaps.json
const VARIETY = new Set(['mature', 'mild', 'medium', 'strong', 'extra', 'large', 'small', 'big', 'baby', 'banana', 'vine',
  'ripe', 'swiss', 'rainbow', 'plain', 'natural', 'apple', 'sea', 'unsalted', 'salted', 'organic', 'brown', 'light', 'soft']);

/** Whole word, plural allowed: "tin" is in "2 x 400g tins" but not in "tint". */
const hasWord = (text, w) => new RegExp(`(?<!\\p{L})${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?(?!\\p{L})`, 'iu').test(text);
const formsOf = (side) => (side.form ? side.form.split(' or ') : null);

function swapSides(item) {
  // The canonical name first, then the name as written: canonical "tofu" may be "firm tofu" on the line.
  for (const key of new Set([swapKey(canon(item)), swapKey(item.name || '')])) {
    if (!key) continue;
    const words = key.split(' ');
    const tries = [key, key.replace(/^(dried|fresh|frozen|tinned|canned|ground|whole) /, '')];
    if (words.length > 1 && formWords.has(words.at(-1))) tries.push(words.slice(0, -1).join(' ')); // "stock cube"
    // "mature cheddar", "light soy sauce": only words that don't change what it is, so not "preserved lemon".
    for (let i = 0; i < words.length - 1 && VARIETY.has(words[i]); i++) tries.push(words.slice(i + 1).join(' '));
    for (const k of tries) if (swapIndex.has(k)) return swapIndex.get(k);
  }
  return [];
}

/** The swaps for an ingredient line, closest first: [{from, to, factor, likeness, note}]. */
function swapsFor(item) {
  if (!swapIndex) return [];
  const sides = swapSides(item);
  // The form is in the name or the unit ("dried chickpeas", "400g tin"). Not the preparation:
  // "tomatoes, chopped" are fresh, though "chopped" is a word for tinned tomatoes.
  const text = [item.canonical, item.name, item.unit].filter(Boolean).join(' ');
  const onLine = [...formWords].filter((w) => hasWord(text, w));
  const known = new Set(sides.flatMap(({ e, from }) => formsOf(e[from]) || []));
  const said = onLine.filter((w) => known.has(w));
  // "chickpeas, drained and rinsed" came from a tin, if tinned is a form this ingredient has.
  if (!said.length && known.has('tinned') && /\b(drained|rinsed)\b/i.test(item.preparation || '')) said.push('tinned');
  const strong = onLine.filter((w) => !said.includes(w)).map(strongGroup).filter(Boolean);
  const seen = new Set();
  return sides.filter(({ e, from }) => {
    const side = e[from];
    const forms = formsOf(side);
    const fits = (!forms || (said.length ? forms.some((w) => said.includes(w)) : forms.some((w) => DEFAULT_FORMS.has(w))))
      && strong.every((g) => g.some((w) => hasWord(`${side.name} ${side.label}`, w)));
    // "chilli flakes, plus a pinch of smoked paprika" says what to use; it only works one way.
    if (!fits || seen.has(e) || / plus /.test(side.label)) return false;
    seen.add(e);
    return true;
  }).map(({ e, from }) => ({
    from: e[from], to: e[from === 'a' ? 'b' : 'a'], factor: from === 'a' ? e.factor : 1 / e.factor, likeness: e.similarity, note: e.note,
  })).sort((x, y) => y.likeness - x.likeness);
}

const DRAINED = 0.6; // a 400g tin of beans or chickpeas holds about 240g drained

/** How much of the swap to use for this line at this scale, e.g. "240 g"; '' when it can't say. */
function swapAmount(item, f, s) {
  const a = firstAmount(item.quantity);
  if (!a) return '';
  let v = a.value * f * s.factor;
  let unit = unitWord(item.unit);
  if (s.from.unit) { // the swap changes unit: per clove, ¼ tsp
    if (unit !== s.from.unit && (unit || SPOON_UNITS.test(s.from.unit))) return '';
    const plural = v > 1 && !SPOON_UNITS.test(s.to.unit) ? (s.to.unit.endsWith('i') ? 'es' : 's') : '';
    return `${fmtAmount(v, s.to.unit)} ${s.to.unit}${plural}`;
  }
  // Tins by size ("400g tin", "2 x 400g tins") to dried: go by what's in them once drained.
  const tin = String(item.unit || '').match(/(?:^|x\s*)(\d+)\s*g\b.*\b(tin|can|jar)s?\b|^g\s+(tin|can|jar)s?\b/i);
  if (tin && /drained/.test(s.from.label)) {
    v *= (tin[1] ? +tin[1] : 1) * DRAINED;
    unit = 'g';
  }
  const kind = WEIGHT_UNITS.test(unit) ? 'weight' : SPOON_UNITS.test(unit) ? 'spoon' : unit ? 'other' : 'count';
  const note = s.note.toLowerCase();
  if (/^by weight or spoon/.test(note)) { if (kind !== 'weight' && kind !== 'spoon') return ''; }
  else if (/^(weight only|weight for weight|same weight|by weight)/.test(note) && kind !== 'weight') return '';
  else if (/^spoon (only|for spoon)/.test(note) && kind !== 'spoon') return '';
  if (kind === 'other' && Math.abs(s.factor - 1) > 0.01) return '';
  if (kind === 'count' && Math.abs(s.factor - 1) > 0.01 && !/count/.test(note)) return '';
  const shown = tin && unit === 'g' ? 'g' : kind === 'weight' || kind === 'spoon' ? String(item.unit).split(/[\s(,]/)[0] : item.unit;
  const amount = [fmtAmount(v, shown), shown].filter(Boolean).join(' ');
  // Dried to tinned: say how many tins that is.
  if (kind === 'weight' && /drained/.test(s.to.label) && /^(g|gram|kg|kilo)$/.test(unit)) {
    const tins = Math.round((v * (/^k/.test(unit) ? 1000 : 1)) / (400 * DRAINED) * 2) / 2;
    if (tins >= 0.5) return `${amount} (about ${fmtAmount(tins, '')} × 400g tin${tins > 1 ? 's' : ''})`;
  }
  return amount;
}

function swapList(item, f, swaps = swapsFor(item)) {
  return `<div class="swaps">
    <ul>${swaps.map((s) => {
      const amount = swapAmount(item, f, s);
      // Only when it narrows things down: "cornflour (for coating)", not just "chilli flakes".
      const instead = /[(,]/.test(s.from.label) ? `<p class="swaps-head">Instead of ${esc(s.from.label)}</p>` : '';
      return `<li>
        ${instead}
        <p class="swap-name"><b>${esc(s.to.label)}</b>${amount ? `<span class="swap-amount">${esc(amount)}</span>` : ''}</p>
        <p class="likeness l${s.likeness}"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${LIKENESS[s.likeness]}</p>
        <p class="swap-note">${esc(s.note)}</p>
      </li>`;
    }).join('')}</ul>
  </div>`;
}

/** Opens and closes the swap lists inside root, in place. */
function wireSwaps(root, r) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-swap]');
    if (!btn) return;
    const key = `${r.id} ${btn.dataset.swap}`;
    const li = btn.closest('li');
    const open = li.querySelector('.swaps');
    if (open) {
      open.remove();
      openSwaps.delete(key);
    } else {
      const [gi, ii] = btn.dataset.swap.split('-').map(Number);
      li.insertAdjacentHTML('beforeend', swapList(r.ingredientGroups[gi].items[ii], scaleOf(r)));
      openSwaps.add(key);
    }
    btn.setAttribute('aria-expanded', String(!open));
  });
}

/** Ingredient checklist, scaled; ticks and the scale are shared with cooking mode. */
function ingredientList(r) {
  const f = scaleOf(r);
  return r.ingredientGroups.map((g, gi) => `
    ${g.name ? `<h3 class="group-name">${esc(g.name)}</h3>` : ''}
    <ul class="checklist">${g.items.map((i, ii) => {
      const key = `${gi}-${ii}`;
      const swaps = swapsFor(i);
      const open = swaps.length > 0 && openSwaps.has(`${r.id} ${key}`);
      const cls = [state.ingredients.get(canon(i))?.staple && 'staple', swaps.length && 'has-swaps'].filter(Boolean).join(' ');
      return `
      <li class="${cls}">
        <label class="tick"><input type="checkbox" data-tick="ing:${key}" ${ticks.has(r.id, 'ing', key) ? 'checked' : ''}>
        <span>${ingredientLine(i, f, key)}</span></label>
        ${swaps.length ? `<button type="button" class="swap-btn" data-swap="${key}" aria-expanded="${open}" aria-label="Swaps for ${esc(i.name)}" title="Swaps">${icon('swap')}</button>` : ''}
        ${open ? swapList(i, f, swaps) : ''}
      </li>`;
    }).join('')}
    </ul>`).join('');
}

/** How many it serves, with − and + to change it, and a way back to the original. */
// A tin, dish or tray in the oven: to keep the same depth, its area has to change by the
// same factor as the amounts, so each side changes by the square root. Loaf tins go by weight.
const TIN_KINDS = new Set(['roasting tin', 'baking tray', 'baking dish', 'cake tin']);
const TIN_SIZE = /(\d+(?:\.\d+)?)\s*(?:cm)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*cm|(\d+(?:\.\d+)?)\s*cm\b|(\d+(?:\.\d+)?)\s*(g|kg|lb)\b(?=\s+loaf)/gi;
// The same size in inches may follow; then up to three words before the tin, so "2cm pieces
// and put in a dish" doesn't count.
const INCHES = String.raw`[\d.]+(?:\s*(?:x|×|by)\s*[\d.]+)?\s*(?:in|inch|inches|")`;
const TIN_AFTER = new RegExp(String.raw`^(?:\s*\(${INCHES}\)|\s*\/\s*${INCHES})?((?:[\s-]+[a-z]+){0,3}?[\s-]+(?:springform(?:\s+tin)?|tin|dish|tray|pan|sheet))\b`, 'i');
const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six'];

/** The tin the recipe gives a size for, e.g. {sides: [30, 20], text: '30 x 20cm', what: 'roasting tin'}; else null. */
function tinSize(r) {
  for (const t of [...r.steps.map((s) => s.text), ...(r.sourceNotes || [])]) {
    for (const m of String(t).matchAll(TIN_SIZE)) {
      const after = TIN_AFTER.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 60));
      if (!after) continue;
      const what = after[1].trim().replace(/^-+/, '');
      if (m[4]) return { weight: +m[4], unit: m[5].toLowerCase(), text: m[0].trim(), what };
      const sides = m[3] ? [+m[3]] : [+m[1], +m[2]];
      if (sides.some((n) => n < 5 || n > 60)) continue;
      return { sides, text: m[0].trim(), what };
    }
  }
  return null;
}

/** What to do about the tin when the recipe is scaled; '' when it doesn't matter. */
function tinNote(r) {
  const f = scaleOf(r);
  const tin = tinSize(r);
  const kinds = equipment(r).filter((e) => TIN_KINDS.has(e.kind)).map((e) => e.kind);
  if (Math.abs(f - 1) < 0.15 || !tin && !kinds.length) return '';
  const word = tin ? (/dish/i.test(tin.what) ? 'dish' : /tray|sheet/i.test(tin.what) ? 'tray' : 'tin')
    : kinds[0] === 'baking dish' ? 'dish' : kinds[0] === 'baking tray' ? 'tray' : 'tin';
  const timing = 'Check it a little early, as times change with the size.';
  const n = Math.round(f);
  const several = f >= 1.7 && n < COUNT_WORDS.length ? `, or ${COUNT_WORDS[n]} of the original size` : '';
  if (!tin) return f > 1
    ? `Use a bigger ${word}, or two, so it cooks at the same depth. ${timing}`
    : `Use a smaller ${word} so it cooks at the same depth. ${timing}`;
  let size;
  if (tin.weight) {
    const w = tin.weight * f;
    size = tin.unit === 'lb' ? `a ${fmtAmount(w)}lb` : w >= 1000 || tin.unit === 'kg' ? `a ${+(tin.unit === 'kg' ? w : w / 1000).toFixed(1)}kg` : `a ${Math.round(w / 50) * 50}g`;
    size += ` ${esc(tin.what)}`;
  } else {
    const k = Math.sqrt(f);
    const sides = tin.sides.map((x) => Math.round(x * k)).join(' × ');
    size = `one about ${tin.sides.length === 2 ? `${sides}cm` : /square/i.test(tin.what) ? `${sides}cm square` : `${sides}cm across`}`;
  }
  return `The original uses a ${esc(tin.text)} ${esc(tin.what)}. For the same depth, use ${size}${several}. ${timing}`;
}

function scaleBar(r) {
  const f = scaleOf(r);
  const base = baseServings(r);
  const tin = tinNote(r);
  const now = base ? scaleText(r.servings, f) : `${fmtAmount(f)} × the recipe`;
  // "4" or "4-6" serves; "10 slices" makes; "Makes 12" says so itself
  const label = !base || !/^\s*\d/.test(r.servings) ? '' : /[a-z]/i.test(r.servings) ? 'Makes' : 'Serves';
  return `
    <div class="scale-bar">
      <button type="button" class="step-btn" data-scale="-1" aria-label="Fewer" ${!base && f <= 0.5 ? 'disabled' : ''}>${icon('minus')}</button>
      <span class="scale-now" aria-live="polite">${label ? `<span>${label}</span> ` : ''}<b>${esc(now)}</b></span>
      <button type="button" class="step-btn" data-scale="1" aria-label="More">${icon('plus')}</button>
    </div>
    <p class="scale-note">${isScaled(r)
      ? `Scaled from ${base ? esc(r.servings) : 'the original'}. The steps still give the original amounts. <button type="button" class="link" data-scale="reset">Back to the original</button>`
      : 'Tap an amount to scale everything to it.'}</p>
    ${tin ? `<p class="scale-note tin-note">${tin}</p>` : ''}`;
}

/** − / + step by one serving (or by halves of the recipe when it doesn't say how many). */
function nextScale(r, dir) {
  const f = scaleOf(r);
  const base = baseServings(r);
  if (!base) return Math.max(0.5, (dir > 0 ? Math.floor(f * 2 + 1e-9) + 1 : Math.ceil(f * 2 - 1e-9) - 1) / 2);
  const n = f * base;
  const next = dir > 0 ? Math.floor(n + 1e-9) + 1 : Math.ceil(n - 1e-9) - 1;
  return Math.max(1, next) / base;
}

/**
 * Wires the scale controls inside root. rerender redraws whatever shows amounts.
 * Tapping an amount swaps it for a box; the number typed there sets the scale.
 */
function wireScaling(root, r, rerender) {
  const apply = (f, focus) => {
    ticks.setScale(r.id, f);
    rerender();
    if (focus) root.querySelector(focus)?.focus();
  };
  root.addEventListener('click', (e) => {
    const step = e.target.closest('[data-scale]');
    if (step) {
      const v = step.dataset.scale;
      apply(v === 'reset' ? 1 : nextScale(r, +v), v === 'reset' ? '.scale-bar [data-scale="1"]' : `[data-scale="${v}"]`);
      return;
    }
    const btn = e.target.closest('[data-amount]');
    if (!btn) return;
    e.preventDefault();
    const [gi, ii] = btn.dataset.amount.split('-').map(Number);
    const item = r.ingredientGroups[gi].items[ii];
    const base = firstAmount(item.quantity).value;
    const box = document.createElement('input');
    box.className = 'amount-box';
    box.inputMode = 'decimal';
    box.value = fmtAmount(base * scaleOf(r), item.unit);
    box.setAttribute('aria-label', `New amount of ${item.name}${item.unit ? ` in ${item.unit}` : ''}`);
    btn.replaceWith(box);
    box.focus();
    box.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = keep && firstAmount(box.value)?.value;
      if (v) apply(v / base, `[data-amount="${btn.dataset.amount}"]`);
      else rerender();
    };
    box.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') finish(false);
    };
    box.onblur = () => finish(true);
    box.onclick = (ev) => ev.preventDefault(); // stay out of the tick box's label
  });
}

function onTick(r) {
  return (e) => {
    const box = e.target.closest('[data-tick]');
    if (!box) return;
    const [kind, key] = box.dataset.tick.split(':');
    ticks.set(r.id, kind, key, box.checked);
  };
}

function renderRecipe(id) {
  const r = state.byId.get(id);
  if (!r) { app.innerHTML = '<p class="center">Recipe not found. <a href="#/">Back to all recipes</a></p>'; return; }
  const t = ticks.get(r.id);
  const started = t.pos > 0 || t.steps.length > 0;
  const est = r.timesAreEstimated ? '<abbr title="Estimated, not stated in the original">est.</abbr>' : '';
  const facts = [
    ['Prep', fmtMinutes(r.prepMinutes)], ['Cook', fmtMinutes(r.cookMinutes)],
    ['Total', fmtMinutes(totalMinutes(r))], ['Serves', scaleText(r.servings, scaleOf(r))],
  ].filter(([, v]) => v);
  const cookHref = `#/r/${encodeURIComponent(r.id)}/cook`;

  app.innerHTML = `
    <article class="recipe ${pigmentFor(r.course)}">
      <a href="#/" class="back">${icon('back')} All recipes</a>
      <header class="recipe-head">
        <div class="recipe-intro">
          <h1>${esc(r.title)}</h1>
          ${byline(r)}
          ${r.description ? `<p class="lede">${esc(r.description)}</p>` : ''}
          ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd data-fact="${k}">${esc(v)}${k !== 'Serves' ? est : ''}</dd></div>`).join('')}</dl>` : ''}
          ${r.steps.length ? `<a class="button primary cook-start" href="${cookHref}">${icon('pan')} ${started ? `Carry on cooking, step ${Math.min(t.pos, r.steps.length - 1) + 1}` : 'Start cooking'}</a>` : ''}
        </div>
        ${['dish', 'added'].includes(mainImage(r)?.kind) ? `<figure class="plate" data-photo="${esc(r.id)}"></figure>` : ''}
      </header>
      <ul class="tags">${[r.course, r.cuisine, ...r.tags].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div id="fix" class="fix"></div>

      <div class="columns">
        <section class="ingredients">
          <h2 class="section-title">Ingredients</h2>
          <div id="scaled">${scaleBar(r)}${ingredientList(r)}</div>
          ${equipment(r).length ? `<h2 class="section-title kit-title">Equipment</h2>
          <ul class="kit-list">${equipment(r).map((e) => `<li>${equipmentIcon(e)}<span>${esc(equipmentName(e))}</span>${e.count > 1 ? `<b>×${e.count}</b>` : ''}</li>`).join('')}</ul>` : ''}
        </section>

        <section class="method">
          <div id="doubt"></div>
          <div class="method-tabs" role="tablist">
            <button role="tab" class="seg on" aria-selected="true" data-tab="steps">Steps</button>
            <button role="tab" class="seg" aria-selected="false" data-tab="flow">Flowchart</button>
            <label class="awake"><input type="checkbox" id="awake"> Keep screen on</label>
          </div>
          <ol class="steps" id="steps"></ol>
          <div id="flow" class="flow" hidden><p class="muted">Drawing…</p></div>
        </section>
      </div>

      ${r.sourceNotes.length ? `<section>
        <h2 class="section-title">From the original</h2>
        <div class="slip"><ul class="tips">${r.sourceNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
      </section>` : ''}

      <section class="gallery-section">
        <h2 class="section-title">Our photos</h2>
        <div id="gallery"></div>
      </section>

      <section class="notes">
        <h2 class="section-title">Our notes</h2>
        <div id="notes"><p class="muted">Loading notes…</p></div>
        <form id="note-form" hidden>
          <label class="vh" for="note-text">Add a note</label>
          <textarea id="note-text" rows="3" placeholder="Add a note for everyone: tweaks, what worked, what to try next time" required></textarea>
          <button class="button" type="submit">Add note</button>
        </form>
        <p id="note-readonly" class="readonly-note" hidden><button class="link" data-signin>Enter the password</button> to add notes.</p>
      </section>

      <section class="report-problem">
        <h2 class="section-title">Something wrong?</h2>
        ${canWrite() ? `<form id="report-form">
          <p>If something doesn’t match the original, or doesn’t make sense, say what. Claude compares the recipe with the original file and corrects it. Anyone can then keep or undo the change.</p>
          <label class="vh" for="report-text">What looks wrong</label>
          <textarea id="report-text" rows="3" maxlength="5000" placeholder="For example: step 4 says 200 g of flour, but the book says 250 g" required></textarea>
          <button class="button" type="submit">Send to Claude</button>
          <p id="report-msg" class="link-msg" role="status" hidden></p>
        </form>` : '<p class="readonly-note"><button class="link" data-signin>Enter the password</button> to report a problem.</p>'}
      </section>

      <footer class="colophon">
        ${!r.author && !r.book && r.sourceCredit ? `<span>Source: ${esc(r.sourceCredit)}</span>` : ''}
        <span>Added${r.addedBy ? ` by ${esc(r.addedBy)}` : ''}${r.addedFrom ? ` from <a href="${esc(r.addedFrom)}" target="_blank" rel="noopener">${esc(siteName(r.addedFrom))}</a>` : ''} on ${new Date(r.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        ${r.sourceFileId && !DEMO ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(r.sourceFileId)}/view" target="_blank" rel="noopener">${icon('file')} Original file</a>` : ''}
      </footer>
    </article>`;

  hydratePhotos(app);
  // Undo changes the recipe, and a new first photo heads the page: redraw it all. Otherwise just the parts that changed.
  const head = addedPhotosFor(r)[0]?.id;
  app.onclick = onFixClick((decision) => (decision === 'undo' || addedPhotosFor(r)[0]?.id !== head ? renderRecipe(r.id)
    : (renderFix(r), renderGallery(r))));
  app.onchange = onTick(r);
  renderFix(r);
  renderGallery(r);
  setupReportForm(r);
  renderSteps(r);
  const scaled = document.getElementById('scaled');
  wireSwaps(scaled, r);
  wireScaling(scaled, r, () => {
    scaled.innerHTML = scaleBar(r) + ingredientList(r);
    const serves = app.querySelector('[data-fact="Serves"]');
    if (serves) serves.textContent = scaleText(r.servings, scaleOf(r));
  });

  const tabs = app.querySelectorAll('.seg');
  tabs.forEach((tab) => tab.onclick = () => {
    tabs.forEach((x) => { x.classList.toggle('on', x === tab); x.setAttribute('aria-selected', x === tab); });
    const flow = tab.dataset.tab === 'flow';
    document.getElementById('steps').hidden = flow;
    document.getElementById('flow').hidden = !flow;
    if (flow) renderFlowchart(r);
  });

  setupWakeLock();
  renderNotes(r).then(() => { if (document.getElementById('doubt')) renderSteps(r); });
  setupNoteForm(r);
}

/**
 * The steps, with any that came out unclear in the conversion marked and explained,
 * and a slip above the method when something serious needs checking against the original.
 */
function renderSteps(r) {
  const t = ticks.get(r.id);
  const started = t.pos > 0 || t.steps.length > 0;
  const unclear = unclearFor(r);
  const notesFor = (id) => unclear.filter((u) => u.step === id);
  document.getElementById('steps').innerHTML = r.steps.map((s, i) => {
    const notes = notesFor(s.id);
    const level = notes.some((u) => u.serious) ? 'doubt' : notes.length ? 'doubt minor' : '';
    return `
      <li class="${started && i === t.pos ? 'here' : ''} ${level}">
        <label class="tick"><input type="checkbox" data-tick="steps:${esc(s.id)}" ${t.steps.includes(s.id) ? 'checked' : ''}>
          <span class="num">${i + 1}</span>
          <span class="txt">${esc(s.text)}${s.minutes ? ` <span class="step-time">(${fmtMinutes(s.minutes)})</span>` : ''}</span></label>
        ${notes.map((u) => `<p class="step-note">${icon('flag')}<span>${esc(u.note)}</span></p>`).join('')}
      </li>`;
  }).join('');

  const el = document.getElementById('doubt');
  const checked = checkedNote(r);
  const serious = unclear.filter((u) => u.serious).length;
  const general = unclear.filter((u) => !u.step);
  const original = r.sourceFileId && !DEMO
    ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(r.sourceFileId)}/view" target="_blank" rel="noopener">the original file</a>`
    : 'the original';
  if (checked) {
    el.innerHTML = `<p class="checked-line">${icon('check')} Checked against the original by ${esc(checked.name || checked.email)},
      ${new Date(checked.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.</p>`;
  } else if (serious || general.length) {
    el.innerHTML = `<div class="slip doubt-slip">
      <p class="doubt-head">${icon('flag')} <b>${serious ? 'The steps may not match the original' : 'One thing to check'}</b>
        ${hasCheck(r) ? `<span class="certainty">Certainty ${r.certainty}%</span>` : ''}</p>
      <p>${serious ? `When this recipe was converted, ${serious === 1 ? 'one step' : `${serious} steps`} came out unclear. ` : ''}${
        unclear.some((u) => u.step) ? 'They are marked below. ' : ''}Check against ${original} before cooking.</p>
      ${general.length ? `<ul class="tips">${general.map((u) => `<li>${esc(u.note)}</li>`).join('')}</ul>` : ''}
      <p><button class="button" id="mark-checked" hidden>${icon('check')} The steps match the original</button></p>
    </div>`;
    canWriteNotes().then((ok) => {
      const b = document.getElementById('mark-checked');
      if (!b || !ok) return;
      b.hidden = false;
      b.onclick = async () => {
        b.disabled = true;
        try {
          await addNote(r.id, `${CHECKED_PREFIX}: the steps are right.`);
          renderSteps(r);
          renderNotes(r);
        } catch (err) {
          alert(`Could not save: ${err.message}`);
          b.disabled = false;
        }
      };
    });
  } else {
    el.innerHTML = '';
  }
  const flow = document.getElementById('flow');
  if (flow?.dataset.done) { delete flow.dataset.done; if (!flow.hidden) renderFlowchart(r); } // marks may have changed
}

/** Photos people added of the dish as they made it, with a way to add more. */
function renderGallery(r) {
  const el = document.getElementById('gallery');
  if (!el) return;
  const photos = addedPhotosFor(r);
  el.innerHTML = `${photos.length ? `<ul class="gallery">${photos.map((p) => `<li>
      <button class="gallery-img" data-photo-id="${esc(p.id)}" aria-label="Photo by ${esc(p.name)}, shown larger"></button>
      <p class="sig"><span>${esc(p.name)}, ${shortDate(p.timestamp)}</span>
        ${canWrite() ? `<button class="link" data-remove-photo="${esc(p.id)}">Remove</button>` : ''}</p></li>`).join('')}</ul>`
    : `<p class="muted">No photos yet.${canWrite() ? ' Add one when you’ve made it.' : ''}</p>`}
    ${canWrite() ? `<p class="gallery-add"><button class="button" type="button" id="add-photo">${icon('plus')} Add photos</button>
      <input type="file" id="add-photo-file" accept="image/*,.heic,.heif" multiple hidden></p>
      <p id="photo-msg" class="link-msg" role="status" hidden></p>` : ''}`;
  el.querySelectorAll('[data-photo-id]').forEach((b) => {
    const p = photos.find((x) => x.id === b.dataset.photoId);
    photoUrl(p.fileId).then((url) => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      b.append(img);
      b.onclick = () => zoom(url, `Photo of ${r.title} by ${p.name}`);
    });
  });
  const input = document.getElementById('add-photo-file');
  if (!input) return;
  const head = photos[0]?.id;
  document.getElementById('add-photo').onclick = () => input.click();
  const say = formMessage('photo-msg');
  input.onchange = async () => {
    const files = [...input.files];
    input.value = '';
    for (const [i, file] of files.entries()) {
      say(files.length > 1 ? `Adding photo ${i + 1} of ${files.length}…` : 'Adding the photo…');
      try {
        await addPhoto(r, file);
      } catch (err) {
        renderGallery(r); // shows any that went in before this one
        if (err.status !== 401) formMessage('photo-msg')(`Could not add ${files.length > 1 ? `“${esc(file.name)}”` : 'it'}: ${esc(err.message)}`, true);
        return;
      }
    }
    if (!document.getElementById('gallery')) return; // gone to another page meanwhile
    if (addedPhotosFor(r)[0]?.id !== head) renderRecipe(r.id); // the first photo may now head the page
    else renderGallery(r);
  };
}

function setupReportForm(r) {
  const form = document.getElementById('report-form');
  if (!form) return;
  const say = formMessage('report-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const box = document.getElementById('report-text');
    const text = box.value.trim();
    if (!text) return;
    e.submitter.disabled = true;
    try {
      await sendReport(r, text);
      box.value = '';
      say(DEMO ? 'Kept in this browser. The demo doesn’t send anything to Claude.'
        : 'Sent. Claude checks it against the original in the next few minutes. Its change shows at the top of this recipe for anyone to keep or undo.');
      renderFix(r);
    } catch (err) {
      if (err.status !== 401) say(`Could not send it: ${esc(err.message)}`, true);
    } finally {
      e.submitter.disabled = false;
    }
  };
}

async function setupNoteForm(r) {
  const form = document.getElementById('note-form');
  const writable = await canWriteNotes();
  if (!form.isConnected) return;
  form.hidden = !writable;
  const readonly = document.getElementById('note-readonly');
  readonly.hidden = writable;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const box = document.getElementById('note-text');
    const text = box.value.trim();
    if (!text) return;
    e.submitter.disabled = true;
    try {
      await addNote(r.id, text);
      box.value = '';
      renderNotes(r);
    } catch (err) {
      if (err.status !== 401) alert(`Could not save the note: ${err.message}`);
    } finally {
      e.submitter.disabled = false;
    }
  };
}

async function renderNotes(r) {
  const el = document.getElementById('notes');
  try {
    if (!state.notes) await loadNotes();
  } catch (e) {
    el.innerHTML = `<p class="error">Could not load notes: ${esc(e.message)}</p>`;
    return;
  }
  if (!el.isConnected) return;
  const notes = state.notes.filter((n) => n.recipeId === r.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  el.innerHTML = notes.length ? notes.map((n) => `
    <div class="slip">
      <p>${esc(n.text).replace(/\n/g, '<br>')}</p>
      <p class="sig"><span>${esc(n.name || n.email)}, ${new Date(n.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        ${n.email === state.user?.device ? `<button class="link" data-del="${esc(n.id)}">Delete</button>` : ''}</p>
    </div>`).join('') : '<p class="muted">No notes yet.</p>';
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this note?')) return;
    try {
      await deleteNote(state.notes.find((n) => n.id === b.dataset.del));
      renderNotes(r);
    } catch (err) {
      alert(`Could not delete: ${err.message}`);
    }
  });
}

// ---------- screen wake lock ----------

let wakeLock = null;
let cookTookLock = false; // cooking mode took the lock itself, so it gives it back on leaving

async function takeWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); return true; } catch { return false; }
}
async function dropWakeLock() {
  await wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function setupWakeLock() {
  const box = document.getElementById('awake');
  if (!('wakeLock' in navigator)) { box.parentElement.hidden = true; return; }
  box.checked = !!wakeLock;
  box.onchange = async () => {
    cookTookLock = false;
    if (box.checked) box.checked = await takeWakeLock();
    else await dropWakeLock();
  };
}
document.addEventListener('visibilitychange', async () => {
  // The browser drops the lock when the tab is hidden; take it back on return.
  if (wakeLock && document.visibilityState === 'visible') await takeWakeLock();
});

// ---------- cooking mode: one step per screen, a rail shows how far you are ----------

let cookCtl = null;

function leaveCooking() {
  if (!cookCtl) return;
  cookCtl.abort();
  cookCtl = null;
  document.body.classList.remove('cooking');
  if (cookTookLock) { cookTookLock = false; dropWakeLock(); }
}

function renderCook(id) {
  const r = state.byId.get(id);
  if (!r || !r.steps.length) { location.replace(`#/r/${encodeURIComponent(id)}`); return; }
  const n = r.steps.length;
  const t = ticks.get(r.id);
  let pos = Math.min(t.pos, n - 1);
  if (pos === 0 && t.steps.length) pos = Math.max(0, r.steps.findIndex((s) => !t.steps.includes(s.id)));
  const recipeHref = `#/r/${encodeURIComponent(r.id)}`;

  cookCtl = new AbortController();
  const { signal } = cookCtl;
  document.body.classList.add('cooking');
  if ('wakeLock' in navigator && !wakeLock) takeWakeLock().then((ok) => { cookTookLock = ok && !!cookCtl; });

  app.onclick = null;
  app.innerHTML = `
    <section class="cook ${pigmentFor(r.course)}" aria-label="Cooking ${esc(r.title)}">
      <header class="cook-bar">
        <a class="icon-button" href="${recipeHref}" aria-label="Leave cooking mode">${icon('close')}</a>
        <span class="title">${esc(r.title)}</span>
        <button class="icon-button" id="ings" aria-expanded="false" aria-controls="drawer">${icon('list')} Ingredients</button>
      </header>
      <div class="cook-page" id="cook-page">
        <div class="rail" aria-hidden="true">
          ${r.steps.map((s, i) => `<span class="dot" data-dot="${esc(s.id)}" style="top:${((i + 0.5) / n) * 100}%"></span>`).join('')}
          <span class="mark"></span>
        </div>
        <div id="cook-step" aria-live="polite"></div>
      </div>
      <nav class="cook-nav">
        <button class="prev" id="prev">${icon('back')} Back</button>
        <button class="next" id="next"></button>
      </nav>
      <aside class="drawer" id="drawer" aria-label="Ingredients">
        <div class="drawer-head"><h2>Ingredients</h2>
          <button class="icon-button" id="drawer-close" aria-label="Close ingredients">${icon('close')}</button></div>
        <div id="drawer-list">${scaleBar(r)}${ingredientList(r)}</div>
      </aside>
    </section>`;

  const stepEl = document.getElementById('cook-step');
  const page = document.getElementById('cook-page');
  const mark = app.querySelector('.rail .mark');
  const drawer = document.getElementById('drawer');
  const ingsBtn = document.getElementById('ings');
  app.onchange = onTick(r);
  const drawerList = document.getElementById('drawer-list');
  wireSwaps(drawerList, r);
  wireScaling(drawerList, r, () => { drawerList.innerHTML = scaleBar(r) + ingredientList(r); });

  function show() {
    const done = pos >= n; // the "that's everything" page after the last step
    ticks.setPos(r.id, Math.min(pos, n - 1));
    mark.style.setProperty('--to', `${((Math.min(pos, n - 1) + 0.5) / n) * 100}%`);
    app.querySelectorAll('[data-dot]').forEach((d) => d.classList.toggle('done', ticks.has(r.id, 'steps', d.dataset.dot)));
    if (done) {
      stepEl.innerHTML = `
        <div class="cook-step cook-end">
          <h2>That’s everything</h2>
          <p>All ${n} steps of ${esc(r.title)}. Enjoy it, and leave a note on the recipe if you changed anything.</p>
        </div>`;
    } else {
      const s = r.steps[pos];
      const isDone = ticks.has(r.id, 'steps', s.id);
      stepEl.innerHTML = `
        <div class="cook-step ${isDone ? 'done' : ''}">
          <p class="cook-count"><span class="label-name">Step ${pos + 1}</span> of ${n}</p>
          <p class="cook-text ${s.text.length <= 70 ? 'short' : s.text.length <= 140 ? 'mid' : ''}">${esc(s.text)}</p>
          ${s.minutes ? `<p class="cook-time">About ${fmtMinutes(s.minutes)}</p>` : ''}
          ${unclearFor(r).filter((u) => u.step === s.id).map((u) => `<p class="step-note">${icon('flag')}<span>${esc(u.note)}</span></p>`).join('')}
          <button class="cook-done" id="done" aria-pressed="${isDone}"><span class="box">${icon('check')}</span> ${isDone ? 'Done' : 'Mark done'}</button>
        </div>`;
      document.getElementById('done').onclick = () => { ticks.set(r.id, 'steps', s.id, !isDone); show(); };
    }
    document.getElementById('prev').disabled = pos === 0;
    document.getElementById('next').innerHTML = done ? `Close ${icon('close')}` : pos === n - 1 ? `Finish ${icon('check')}` : `Next ${icon('next')}`;
    page.scrollTop = 0;
  }
  function go(delta) {
    if (delta > 0 && pos >= n) { location.hash = recipeHref; return; }
    pos = Math.max(0, Math.min(n, pos + delta));
    show();
  }
  function toggleDrawer(open = !drawer.classList.contains('open')) {
    drawer.classList.toggle('open', open);
    ingsBtn.setAttribute('aria-expanded', open);
    if (open) document.getElementById('drawer-close').focus();
  }

  document.getElementById('prev').onclick = () => go(-1);
  document.getElementById('next').onclick = () => go(1);
  ingsBtn.onclick = () => toggleDrawer();
  document.getElementById('drawer-close').onclick = () => { toggleDrawer(false); ingsBtn.focus(); };

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') { if (drawer.classList.contains('open')) toggleDrawer(false); else location.hash = recipeHref; }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
  }, { signal });

  let touch = null;
  page.addEventListener('touchstart', (e) => { touch = e.touches[0]; }, { passive: true, signal });
  page.addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.clientX, dy = e.changedTouches[0].clientY - touch.clientY;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { signal });

  show();
}

// ---------- flowchart ----------

let mermaidReady = null;
function loadMermaid() {
  mermaidReady ??= import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(({ default: m }) => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    m.initialize({
      startOnLoad: false, theme: 'base', securityLevel: 'strict',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
      themeVariables: dark
        ? { background: '#1e1612', primaryColor: '#2a201a', primaryBorderColor: '#e0784f', primaryTextColor: '#f2e6da', lineColor: '#c2a998', fontFamily: 'Nunito, system-ui, sans-serif', fontSize: '15px' }
        : { background: '#f6efe6', primaryColor: '#fffaf4', primaryBorderColor: '#b4502c', primaryTextColor: '#3b2a21', lineColor: '#7a5f4f', fontFamily: 'Nunito, system-ui, sans-serif', fontSize: '15px' },
    });
    return m;
  });
  return mermaidReady;
}

function mermaidLabel(s) {
  return String(s).replace(/["#<>]/g, (c) => ({ '"': '#quot;', '#': '#35;', '<': '#lt;', '>': '#gt;' }[c]));
}

/** Builds a Mermaid flowchart from step dependencies; independent branches render side by side. */
function flowchartSource(r) {
  const ids = new Set(r.steps.map((s) => s.id));
  const lines = ['flowchart TD'];
  r.steps.forEach((s, i) => {
    const time = s.minutes ? `<br/><small>${fmtMinutes(s.minutes)}</small>` : '';
    lines.push(`  ${s.id}["${i + 1}. ${mermaidLabel(s.label)}${time}"]`);
  });
  const hasIncoming = new Set();
  for (const s of r.steps) {
    for (const d of s.dependsOn) {
      if (ids.has(d) && d !== s.id) { lines.push(`  ${d} --> ${s.id}`); hasIncoming.add(s.id); }
    }
  }
  // Steps that nothing depends on, other than the last, are loose ends; link them to
  // the final step so the chart always converges on "done".
  const last = r.steps[r.steps.length - 1]?.id;
  const usedAsDep = new Set(r.steps.flatMap((s) => s.dependsOn));
  for (const s of r.steps) {
    if (s.id !== last && !usedAsDep.has(s.id)) lines.push(`  ${s.id} -.-> ${last}`);
  }
  // Steps that came out unclear in the conversion: dashed outline in the error colour.
  const doubt = [...new Set(unclearFor(r).filter((u) => u.step && ids.has(u.step)).map((u) => u.step))];
  if (doubt.length) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    lines.push(`  classDef doubt fill:${dark ? '#3a211b' : '#fbeae4'},stroke:${dark ? '#ff9d8f' : '#a3261b'},stroke-width:2.5px,stroke-dasharray:6 3`);
    lines.push(`  class ${doubt.join(',')} doubt`);
  }
  return lines.join('\n');
}

async function renderFlowchart(r) {
  const el = document.getElementById('flow');
  if (el.dataset.done === r.id) return;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`fc-${Date.now()}`, flowchartSource(r));
    el.innerHTML = `${svg}<p class="flow-hint">Tap a box to see the full step. Boxes side by side can be done at the same time.</p><div id="flow-detail" class="flow-detail" hidden></div>`;
    el.dataset.done = r.id;
    el.querySelectorAll('g.node').forEach((node) => {
      const m = node.id.match(/flowchart-(.+)-\d+$/);
      const step = m && r.steps.find((s) => s.id === m[1]);
      if (!step) return;
      node.style.cursor = 'pointer';
      node.onclick = () => {
        const d = document.getElementById('flow-detail');
        d.hidden = false;
        d.innerHTML = `<b>Step ${r.steps.indexOf(step) + 1}.</b> ${esc(step.text)}${unclearFor(r).filter((u) => u.step === step.id)
          .map((u) => `<p class="step-note">${icon('flag')}<span>${esc(u.note)}</span></p>`).join('')}`;
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="error">Could not draw the flowchart: ${esc(e.message)}</p>`;
  }
}

// ---------- add recipes / status ----------

async function renderInbox() {
  if (!access && !DEMO) {
    app.innerHTML = `<section class="inbox">
      <a href="#/" class="back">${icon('back')} All recipes</a>
      <header class="page-head"><h1>Add recipes</h1>
        <p class="lede"><button class="link" data-signin>Enter the password</button> to add recipes.</p></header>
    </section>`;
    return;
  }
  const folderUrl = `https://drive.google.com/drive/folders/${encodeURIComponent(CFG.inboxFolderId)}`;
  app.innerHTML = `
    <section class="inbox">
      <a href="#/" class="back">${icon('back')} All recipes</a>
      <header class="page-head"><h1>Add recipes</h1>
        <p class="lede">Add a recipe from a web address or a file. Claude reads it and it appears here within a few minutes.</p></header>
      <h2 class="section-title">From a web address</h2>
      <form id="link-form" class="link-form">
        <label class="field"><span class="vh">Web address of a recipe</span>${icon('link')}
          <input id="link-url" type="url" inputmode="url" autocomplete="off" placeholder="Web address of a recipe" required></label>
        <button class="button primary" type="submit">Add</button>
      </form>
      <p id="link-msg" class="link-msg" role="status" hidden></p>
      <p class="link-help">The page's recipe and photo are fetched. If a website won't let it be read, or it needs a sign-in, save the page as a PDF and upload that instead.</p>
      <h2 class="section-title">From a file</h2>
      <form id="upload-form" class="upload-form">
        <label class="file-pick"><span class="file-label">Recipe</span>
          <span class="file-hint">A PDF, a photo of a cookbook page or card, a Word file or a text file.</span>
          <input id="up-recipe" type="file" required
            accept=".pdf,.docx,.txt,.md,.html,.htm,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,application/pdf,image/*"></label>
        <label class="file-pick"><span class="file-label">Photo of the finished dish <small>optional</small></span>
          <span class="file-hint">Shown with the recipe. Not needed with a photo of a cookbook page: the dish photo is found on the page.</span>
          <input id="up-photo" type="file" accept="image/*,.heic,.heif"></label>
        <button class="button primary" type="submit">Upload</button>
      </form>
      <p id="upload-msg" class="link-msg" role="status" hidden></p>
      <p class="link-help">Up to 20 MB.</p>
      <h2 class="section-title">In Google Drive</h2>
      <p class="drive-note">If the <a href="${folderUrl}" target="_blank" rel="noopener">shared recipe folder</a> is shared with you, you can put files straight into it.
        A photo with the <b>same name</b> as a recipe file goes with it, for example <code>Lasagne.pdf</code> and <code>Lasagne.jpg</code>.
        To fix a recipe there, edit or replace its file; delete the file to remove the recipe.</p>
      <h2 class="section-title">Checking the conversions</h2>
      <p>After converting a recipe, Claude reads it again for steps that may have come out wrong, and lists the equipment it needs.
        <a href="#/review">See which recipes to check against the original</a>.
        On any recipe, <b>Something wrong?</b> asks Claude to correct it from the original; anyone can then keep or undo the change.</p>
      <h2 class="section-title">Processing status</h2>
      <div id="status"><p class="muted">Loading…</p></div>
    </section>`;
  app.onclick = null;
  app.onchange = null;

  setupLinkForm();
  setupUploadForm();
  showStatus();
}

async function showStatus() {
  try {
    const rows = await loadStatus();
    const el = document.getElementById('status');
    if (!el) return;
    el.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="status"><thead><tr><th>File</th><th>Status</th><th>Recipes</th></tr></thead><tbody>
      ${rows.map(([file, status, n, detail]) => `<tr class="${status === 'error' || status.startsWith('unsupported') ? 'bad' : ''}"><td>${esc(file)}${detail ? `<br><small>${esc(detail)}</small>` : ''}</td><td>${esc(status)}</td><td>${esc(n)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nothing processed yet.</p>';
  } catch (e) {
    const el = document.getElementById('status');
    if (el) el.innerHTML = `<p class="error">Could not load status: ${esc(e.message)}</p>`;
  }
}

function formMessage(id) {
  const msg = document.getElementById(id);
  return (html, bad) => { msg.hidden = false; msg.className = `link-msg${bad ? ' error' : ''}`; msg.innerHTML = html; };
}

function setupLinkForm() {
  const form = document.getElementById('link-form');
  const say = formMessage('link-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const box = document.getElementById('link-url');
    const url = box.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return say('That doesn’t look like a web address. It should start with https://', true);
    e.submitter.disabled = true;
    try {
      await addLink(url);
      box.value = '';
      say('Added. It’s fetched in the next few minutes, then appears in the book.');
      showStatus();
    } catch (err) {
      if (err.status !== 401) say(`Could not add it: ${esc(err.message)}`, true);
    } finally {
      e.submitter.disabled = false;
    }
  };
}

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

function setupUploadForm() {
  const form = document.getElementById('upload-form');
  const say = formMessage('upload-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const recipe = form['up-recipe'].files[0];
    const photo = form['up-photo'].files[0] || null;
    if (!recipe) return;
    if (photo && IMAGE_NAME.test(recipe.name)) {
      return say('A photo of the dish can go with a PDF, Word or text file. For a photo of a cookbook page, upload just that: the dish photo is found on the page.', true);
    }
    if (photo && !IMAGE_NAME.test(photo.name)) return say('The dish photo should be a picture: JPEG, PNG, WebP, GIF or HEIC.', true);
    if (recipe.size + (photo?.size || 0) > UPLOAD_MAX) return say('That’s too big. Files can be up to 20 MB in all.', true);
    e.submitter.disabled = true;
    say('Uploading…');
    try {
      const name = await uploadRecipe(recipe, photo);
      form.reset();
      say(`Uploaded as “${esc(name)}”. Claude reads it in the next few minutes, then it appears in the book.`);
      showStatus();
    } catch (err) {
      if (err.status !== 401) say(`Could not upload it: ${esc(err.message)}`, true);
    } finally {
      e.submitter.disabled = false;
    }
  };
}

/** "https://www.bbcgoodfood.com/recipes/x" -> "bbcgoodfood.com" */
function siteName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * Recipes to check against the original: those Claude was least sure of first, then
 * the most complex. Recipes Claude hasn't read yet come after, most complex first.
 */
async function renderReview() {
  app.innerHTML = '<p class="muted center">Loading…</p>';
  app.onclick = null;
  app.onchange = null;
  try { if (!state.notes) await loadNotes(); } catch { state.notes = []; }
  if (location.hash !== '#/review') return;

  const rows = state.recipes.map((r) => ({ r, c: complexity(r), done: checkedNote(r) }));
  const byComplexity = (a, b) => b.c.score - a.c.score || b.c.steps - a.c.steps || a.r.title.localeCompare(b.r.title);
  const read = rows.filter((x) => hasCheck(x.r) && !x.done);
  const toCheck = read.filter((x) => (x.r.unclear || []).length).sort((a, b) => a.r.certainty - b.r.certainty || byComplexity(a, b));
  const clear = read.filter((x) => !(x.r.unclear || []).length).sort(byComplexity);
  const notYet = rows.filter((x) => !hasCheck(x.r) && !x.done).sort(byComplexity);
  const done = rows.filter((x) => x.done).sort((a, b) => b.done.timestamp.localeCompare(a.done.timestamp));
  // Added on this site rather than in Drive: one entry per file, newest first.
  const files = new Map();
  for (const r of state.recipes) if (r.addedVia && !files.has(r.sourceFileId || r.id)) files.set(r.sourceFileId || r.id, r);
  const onSite = [...files.values()].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));

  const others = new Map();
  for (const r of state.recipes) {
    for (const e of equipment(r)) {
      if (e.kind === 'other') others.set(equipmentName(e).toLowerCase(), (others.get(equipmentName(e).toLowerCase()) || 0) + 1);
    }
  }

  // Reported problems and Claude's changes, and photos people added.
  const changes = state.recipes.map((r) => ({ r, f: fixFor(r) })).filter((x) => x.f && x.f.decision !== 'undo')
    .sort((a, b) => b.f.fix.at.localeCompare(a.f.fix.at));
  const toDecide = changes.filter((x) => x.f.decision !== 'keep');
  const kept = changes.filter((x) => x.f.decision === 'keep');
  const titleOf = (x) => {
    const r = state.byId.get(x.recipeId);
    return r ? `<a class="review-title" href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>` : '<span class="muted">A recipe no longer in the book</span>';
  };
  const waiting = state.reports.filter((x) => x.status === 'waiting' && x.decision !== 'dismiss');
  const unanswered = state.reports.filter((x) => (x.status === 'no change' || x.status === 'error') && !x.decision);
  const photos = state.addedPhotos.slice().reverse();

  const band = (c) => (c < 60 ? 'low' : c < 90 ? 'mid' : 'high');
  const row = ({ r, c }) => {
    const unclear = r.unclear || [];
    const first = unclear.find((u) => u.serious) || unclear[0];
    return `<li class="review-row">
      ${hasCheck(r) ? `<span class="score ${band(r.certainty)}"><b>${r.certainty}%</b><small>certainty</small></span>` : '<span class="score none"><b>?</b><small>not read</small></span>'}
      <div>
        <a class="review-title" href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>
        <p class="meta">${esc(complexityText(c))}</p>
        ${equipment(r).length ? `<p class="meta"><span class="kit">${kitIcons(r)}</span></p>` : ''}
        ${first ? `<p class="review-note">${esc(first.note)}${unclear.length > 1 ? ` <span class="muted">And ${unclear.length - 1} more.</span>` : ''}</p>` : ''}
      </div>
    </li>`;
  };

  app.innerHTML = `
    <section class="review">
      <a href="#/inbox" class="back">${icon('back')} Add recipes</a>
      <header class="page-head"><h1>Recipes to check</h1>
        <p class="lede">Claude reread each converted recipe for steps that could send a cook wrong, and scored how sure it is that the steps and flowchart match the original. The least certain come first, then the most complex. Open one, compare it with the original file, and mark it as checked.</p></header>
      ${toDecide.length ? `<h2 class="section-title">Changes to keep or undo</h2>
        <p class="muted">Claude changed these after someone reported a problem. Keep a change if it looks right; undo it if not.</p>
        <ul class="fix-list">${toDecide.map(({ r, f }) => `<li><a class="review-title" href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>${changeSlip(r, f)}</li>`).join('')}</ul>` : ''}
      ${waiting.length ? `<h2 class="section-title">Reports Claude is checking</h2>
        <ul class="fix-list">${waiting.map((x) => `<li>${titleOf(x)}<div class="slip report-slip">${reportQuote(x)}</div></li>`).join('')}</ul>` : ''}
      ${unanswered.length ? `<h2 class="section-title">Reports Claude made no change for</h2>
        <ul class="fix-list">${unanswered.map((x) => `<li>${titleOf(x)}<div class="slip report-slip">${reportQuote(x)}<p>${esc(x.detail)}</p>
          ${canWrite() ? `<p><button class="link" data-decide="dismiss" data-report="${esc(x.id)}">Dismiss</button></p>` : ''}</div></li>`).join('')}</ul>` : ''}
      ${onSite.length ? `<h2 class="section-title">Added on this website</h2>
        <p class="muted">Recipes added here rather than in the shared Drive folder, newest first. To remove one, delete its file in Drive.</p>
        <ul class="review-done site-added">${onSite.map((r) => `<li><a href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>
          <span class="muted">${esc(r.addedBy || 'Someone')}, ${new Date(r.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })},
          ${r.addedVia === 'link' && r.addedFrom ? `from <a href="${esc(r.addedFrom)}" target="_blank" rel="noopener">${esc(siteName(r.addedFrom))}</a>` : 'uploaded'}${
          DEMO || !r.sourceFileId ? '' : ` · <a href="https://drive.google.com/file/d/${encodeURIComponent(r.sourceFileId)}/view" target="_blank" rel="noopener">file in Drive</a>`}</span></li>`).join('')}</ul>
        <h2 class="section-title">Checking the conversions</h2>` : ''}
      <p class="review-count">${[`${toCheck.length} with something unclear`, clear.length && `${clear.length} with nothing unclear`,
        notYet.length && `${notYet.length} not read by Claude yet`, done.length && `${done.length} checked against the original`].filter(Boolean).join(', ')}.</p>
      ${toCheck.length ? `<ol class="review-list">${toCheck.map(row).join('')}</ol>` : ''}
      ${clear.length ? `<h2 class="section-title">Nothing unclear</h2>
        <p class="muted">Claude found nothing unclear in these. Most complex first, as those are the likeliest to have slipped through.</p>
        <ol class="review-list">${clear.map(row).join('')}</ol>` : ''}
      ${notYet.length ? `<h2 class="section-title">Not read by Claude yet</h2>
        <p class="muted">Claude reads these over the next few hourly runs. Most complex first.</p>
        <ol class="review-list">${notYet.map(row).join('')}</ol>` : ''}
      ${done.length ? `<h2 class="section-title">Checked against the original</h2>
        <ul class="review-done">${done.map(({ r, done: n }) => `<li><a href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>
          <span class="muted">${esc(n.name || n.email)}, ${new Date(n.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></li>`).join('')}</ul>` : ''}
      ${kept.length ? `<h2 class="section-title">Changes kept</h2>
        <ul class="review-done">${kept.map(({ r, f }) => `<li><a href="#/r/${encodeURIComponent(r.id)}">${esc(r.title)}</a>
          <span class="muted">${esc(f.fix.reports.at(-1).summary || '')} Kept by ${esc(f.by || 'someone')}.</span>
          ${canWrite() ? `<button class="link" data-decide="undo" data-report="${esc(f.fix.reports.at(-1).id)}">Undo</button>` : ''}</li>`).join('')}</ul>` : ''}
      ${photos.length ? `<h2 class="section-title">Added photos</h2>
        <p class="muted">Photos people added to recipes, newest first. Remove any that don’t belong.</p>
        <ul class="gallery review-photos">${photos.map((p) => `<li>
          <button class="gallery-img" data-photo-id="${esc(p.id)}" aria-label="Photo by ${esc(p.name)}, shown larger"></button>
          <p class="sig"><span>${titleOf(p)}<br>${esc(p.name)}, ${shortDate(p.timestamp)}</span>
            ${canWrite() ? `<button class="link" data-remove-photo="${esc(p.id)}">Remove</button>` : ''}</p></li>`).join('')}</ul>` : ''}
      ${others.size ? `<h2 class="section-title">Other equipment</h2>
        <p class="muted">Equipment that isn't one of the usual kinds. Anything that keeps coming up could get its own icon.</p>
        <ul class="tags">${[...others].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `<li>${esc(name)} <b>${n}</b></li>`).join('')}</ul>` : ''}
    </section>`;
  app.onclick = onFixClick(renderReview);
  app.querySelectorAll('[data-photo-id]').forEach((b) => {
    const p = state.addedPhotos.find((x) => x.id === b.dataset.photoId);
    photoUrl(p.fileId).then((url) => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      b.append(img);
      b.onclick = () => zoom(url, `Photo by ${p.name}`);
    });
  });
}

// ---------- routing & startup ----------

function route() {
  if (!state.user && !state.saved) return;
  leaveCooking();
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  const m = hash.match(/^#\/r\/([^/]+)(\/cook)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2]) renderCook(id); else renderRecipe(id);
  } else if (hash === '#/inbox') renderInbox();
  else if (hash === '#/review') renderReview();
  else renderHome();
}
window.addEventListener('hashchange', route);

/** Shows the book. `book` is what the web app's "open" sent, if it has already been asked. */
async function start(book) {
  if (DEMO) {
    state.user = { device: 'device:demo', name: 'Demo user' };
    await loadRecipes();
    loadDemoExtras();
  } else {
    if (!book) {
      app.innerHTML = '<p class="muted center">Opening the book…</p>';
      book = await call('open', { since: state.version });
    }
    await useBook(book);
    state.saved = null;
    banner('');
  }
  setSignedIn(true);
  route();
}

async function boot() {
  if (DEMO) {
    banner('Demo mode: showing sample data, notes are saved only in this browser.', 'info');
    return start();
  }
  if (!CFG.serviceUrl || CFG.serviceUrl.startsWith('PASTE')) {
    app.innerHTML = '<p class="center">Site not configured yet: fill in <code>docs/config.js</code>. Or try the <a href="?demo">demo</a>.</p>';
    return;
  }
  setAccess(loadAccess());
  // This device's saved copy opens straight away; the latest is fetched behind it.
  const opened = await openSaved();
  if (!access) {
    return opened ? showSavedCopy() : showPassword();
  }
  if (!opened) return start();
  setSignedIn(true);
  route();
  refresh();
}

/** Brings the saved copy up to date. New recipes show at once on an untouched home page; otherwise on request. */
async function refresh() {
  try {
    const fresh = await useBook(await call('open', { since: state.version }));
    state.saved = null;
    if (!access) return;
    if (!fresh) { // the recipes are as they were, but reports and photos may have moved on
      const m = (location.hash || '').match(/^#\/r\/([^/]+)$/);
      const r = m && state.byId.get(decodeURIComponent(m[1]));
      if (r && document.getElementById('fix')) {
        if (state.undoneMeanwhile) renderRecipe(r.id); // someone undid a change on another device
        else { renderFix(r); renderGallery(r); }
      }
      return;
    }
    const home = (location.hash || '#/') === '#/';
    if (home && window.scrollY < 40 && !state.search.text && !state.search.ingredients.length) return route();
    banner('The book has changed since this page opened. <button class="link" id="show-new">Show the latest</button>', 'info');
    document.getElementById('show-new').onclick = () => { banner(''); route(); };
  } catch (err) {
    if (err.status !== 401 && state.saved) banner(`Showing the copy saved on this device on ${savedWhen()}. ${esc(err.message)}`, 'warn');
  }
}

/** Loads this device's saved copy. False if there isn't one. */
async function openSaved() {
  const about = await savedGet('about.json');
  if (!about) return false;
  try {
    const saved = await about.json();
    await loadRecipes();
    state.saved = saved;
    state.version = saved.version || null;
    const notes = await savedGet('notes.json'); // the latest come with the refresh
    state.notes = notes ? await notes.json() : null;
    const extras = await savedGet('extras.json');
    if (extras) {
      const { photos, reports } = await extras.json();
      state.addedPhotos = photos || [];
      state.reports = reports || [];
      if (applyUndos()) buildIngredientIndex();
    }
    return true;
  } catch {
    return false;
  }
}

/** This device's saved copy, read-only, without the password. */
function showSavedCopy() {
  setSignedIn(false);
  banner(`Saved copy from ${savedWhen()}. <button class="link" data-signin>Enter the password</button> for new recipes and notes.`, 'info');
  route();
}

const savedWhen = () => new Date(state.saved.savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

boot().catch((e) => {
  app.innerHTML = `<p class="error center">Something went wrong: ${esc(e.message)}</p>`;
});
