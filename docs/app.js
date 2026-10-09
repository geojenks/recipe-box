// Recipe book front end. Talks directly to Google Drive and Sheets with the
// signed-in user's own token, so it only works for people the folder is shared with.

const CFG = { siteTitle: 'Recipe book', ...window.RECIPE_BOX_CONFIG };
const DEMO = new URLSearchParams(location.search).has('demo');
const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ');
const TOKEN_KEY = 'rb-token';
const TICKS_KEY = 'rb-ticks';
const TICKS_TTL = 12 * 3600_000; // ticks older than this belong to a previous cook

const state = {
  token: null,
  user: null,
  recipes: [],
  byId: new Map(),
  ingredients: new Map(), // canonical -> {name, staple, recipeIds:Set}
  mainCounts: null, // ingredient -> how many recipes it is a main ingredient of
  notes: null,            // [{row, id, recipeId, timestamp, email, name, text}]
  canNote: null,          // can this user write to the notes sheet?
  photos: new Map(),      // fileId -> Promise<objectURL|null>
  saved: null,            // {savedAt} while showing this device's saved copy, signed out
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

// ---------- auth ----------

let tokenClient = null;
let tokenWaiters = [];

function loadSavedToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expires > Date.now() + 60_000) return saved;
  } catch { /* storage blocked */ }
  return null;
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: SCOPES,
    callback: (resp) => {
      const waiters = tokenWaiters;
      tokenWaiters = [];
      if (resp.error) { waiters.forEach((w) => w.reject(new Error(resp.error))); return; }
      state.token = resp.access_token;
      try {
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: resp.access_token, expires: Date.now() + resp.expires_in * 1000 }));
      } catch { /* fine */ }
      waiters.forEach((w) => w.resolve());
    },
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    tokenClient.requestAccessToken({ prompt, hint: state.user?.email });
  });
}

async function waitForGsi() {
  for (let i = 0; i < 100 && !window.google?.accounts?.oauth2; i++) await new Promise((r) => setTimeout(r, 100));
  if (!window.google?.accounts?.oauth2) throw new Error('Could not load Google sign-in. Check your connection or ad blocker.');
}

function setSignedIn(on) {
  document.getElementById('signout').hidden = !on || DEMO;
  document.querySelector('.topbar nav a').hidden = !on;
}

/** Sign in from a button. From the saved copy, a cancelled sign-in just leaves you where you were. */
async function signIn() {
  try {
    if (!tokenClient) { await waitForGsi(); initTokenClient(); } // didn't load when the book opened offline
    await requestToken('');
    await start();
  } catch (e) {
    if (state.saved) {
      if (e.message !== 'access_denied') banner(`Could not sign in: ${esc(e.message)}`, 'warn');
      return;
    }
    showSignIn(e.message === 'access_denied' ? 'Sign-in was cancelled.' : e.message);
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-signin]')) signIn(); });

function showSignIn(message = '') {
  leaveCooking();
  setSignedIn(false);
  app.innerHTML = `
    <section class="signin">
      <div class="signin-card">
        <h1 class="wordmark">${esc(CFG.siteTitle)}</h1>
        <p>Our shared recipes. Sign in with the Google account the recipe folder is shared with.</p>
        ${message ? `<p class="error">${esc(message)}</p>` : ''}
        <button class="button primary" id="signin">Sign in with Google</button>
      </div>
    </section>`;
  document.getElementById('signin').onclick = signIn;
}

function signOut() {
  if (state.token && !DEMO) google.accounts.oauth2.revoke(state.token, () => {});
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* fine */ }
  state.token = null;
  state.user = null;
  state.canNote = null;
  state.notes = null;
  state.saved = null;
  state.photos.clear();
  forgetSaved(); // signing out also removes the saved copy from this device
  banner('');
  showSignIn();
}
document.getElementById('signout').onclick = signOut;

/** fetch() against Google APIs, re-requesting the token once if it has expired. */
async function gfetch(url, opts = {}, retry = true) {
  if (!state.token) {
    const err = new Error('Sign in to do this.');
    err.status = 401;
    throw err;
  }
  const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${state.token}` } });
  if (res.status === 401 && retry) {
    banner('Your sign-in expired. <button id="reauth" class="link">Continue</button>', 'warn');
    await new Promise((resolve, reject) => {
      document.getElementById('reauth').onclick = () => requestToken('').then(resolve, reject);
    });
    banner('');
    return gfetch(url, opts, false);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* not JSON */ }
    const err = new Error(`${res.status} ${detail}`.trim());
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- data: Google APIs (or demo files) ----------

const driveFile = (id) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
const driveMeta = (id, fields) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
const sheetsBase = () => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(CFG.sheetId)}`;

// ---------- saved copy: lets the book open on this device without signing in ----------

const SAVED = 'rb-saved';
const savedKey = (name) => new URL(`saved/${name}`, location.href).href;

async function savedPut(name, body, type = 'application/json') {
  if (DEMO || !window.caches) return;
  try {
    await (await caches.open(SAVED)).put(savedKey(name), new Response(body, { headers: { 'Content-Type': type } }));
  } catch { /* storage full or blocked: the book still works signed in */ }
}

async function savedGet(name) {
  if (DEMO || !window.caches) return null;
  try { return (await (await caches.open(SAVED)).match(savedKey(name))) || null; } catch { return null; }
}

async function forgetSaved() {
  try { await caches.delete(SAVED); } catch { /* fine */ }
}

async function loadRecipes() {
  let data;
  if (DEMO) {
    data = await (await fetch('demo/recipes.json', { cache: 'no-store' })).json();
  } else if (!state.token) {
    data = await (await savedGet('recipes.json')).json();
  } else {
    const text = await (await gfetch(driveFile(CFG.recipesFileId))).text();
    data = JSON.parse(text);
    savedPut('recipes.json', text).then(() => savedPut('about.json', JSON.stringify({ savedAt: new Date().toISOString() })));
    navigator.storage?.persist?.().catch(() => {});
  }
  state.recipes = data.recipes.slice().sort((a, b) => a.title.localeCompare(b.title));
  state.byId = new Map(state.recipes.map((r) => [r.id, r]));
  buildIngredientIndex();
  if (!swapIndex) await loadSwaps();
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
    state.photos.set(fileId, (DEMO ? Promise.resolve(`demo/${fileId}`) :
      photoBlob(fileId).then((b) => (b ? URL.createObjectURL(b) : forget(fileId)))).catch(() => forget(fileId)));
  }
  return state.photos.get(fileId);
}

/** A photo from this device's saved copy, or from Drive (then saved). Photo files are never
 * changed in place (a new photo gets a new file), so a saved one is always current. */
async function photoBlob(fileId) {
  const name = `photo/${encodeURIComponent(fileId)}`;
  const saved = await savedGet(name);
  if (saved) return saved.blob();
  if (!state.token) return null;
  const blob = await (await gfetch(driveFile(fileId))).blob();
  savedPut(name, blob, blob.type || 'image/jpeg');
  return blob;
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
  if (!state.token) {
    const saved = await savedGet('notes.json');
    state.notes = saved ? await saved.json() : [];
    return;
  }
  const res = await gfetch(`${sheetsBase()}/values/${encodeURIComponent('Notes!A2:F')}`);
  const rows = (await res.json()).values || [];
  state.notes = rows
    .map((v, i) => ({ row: i + 2, id: v[0], recipeId: v[1], timestamp: v[2], email: v[3], name: v[4], text: v[5] }))
    .filter((n) => n.id && n.text);
  savedPut('notes.json', JSON.stringify(state.notes));
}

/** Everyone can read the notes sheet, but only editors can add to it. */
async function canWriteNotes() {
  if (DEMO) return true;
  if (!state.token) return false;
  if (state.canNote == null) {
    try {
      state.canNote = !!(await (await gfetch(driveMeta(CFG.sheetId, 'capabilities(canEdit)'))).json()).capabilities?.canEdit;
    } catch {
      return true; // can't tell; let them try, and a refused save says why
    }
  }
  return state.canNote;
}

async function addNote(recipeId, text) {
  const note = {
    id: crypto.randomUUID(), recipeId, timestamp: new Date().toISOString(),
    email: state.user.email, name: state.user.name, text,
  };
  if (DEMO) {
    state.notes.push({ ...note, row: state.notes.length + 2 });
    localStorage.setItem('rb-demo-notes', JSON.stringify(state.notes));
    return;
  }
  await gfetch(`${sheetsBase()}/values/${encodeURIComponent('Notes!A:F')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[note.id, note.recipeId, note.timestamp, note.email, note.name, note.text]] }),
  });
  await loadNotes();
}

async function deleteNote(note) {
  if (DEMO) {
    state.notes = state.notes.filter((n) => n.id !== note.id);
    localStorage.setItem('rb-demo-notes', JSON.stringify(state.notes));
    return;
  }
  // Rows are only ever appended or blanked, never removed, so row numbers are stable.
  // Still, check the row holds this note before clearing it.
  const range = encodeURIComponent(`Notes!A${note.row}:F${note.row}`);
  const current = (await (await gfetch(`${sheetsBase()}/values/${range}`)).json()).values?.[0];
  if (current?.[0] === note.id) await gfetch(`${sheetsBase()}/values/${range}:clear`, { method: 'POST' });
  await loadNotes();
}

async function loadStatus() {
  if (DEMO) return [['example.pdf', 'ok', '1', '', new Date().toISOString()]];
  const res = await gfetch(`${sheetsBase()}/values/${encodeURIComponent('Status!A2:E')}`);
  return (await res.json()).values || [];
}

/** Can this user upload to the recipe folder, and who owns it? */
async function inboxAccess() {
  if (DEMO) return { canAdd: true, owners: [] };
  try {
    const f = await (await gfetch(driveMeta(CFG.inboxFolderId, 'capabilities(canAddChildren),owners(displayName)'))).json();
    return { canAdd: !!f.capabilities?.canAddChildren, owners: (f.owners || []).map((o) => o.displayName).filter(Boolean) };
  } catch {
    return { canAdd: true, owners: [] };
  }
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
const checkedNote = (r) => (state.notes || []).find((n) => n.recipeId === r.id && n.text.startsWith(CHECKED_PREFIX));
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
        <div class="thumb ${r.photoKind === 'page' ? 'page' : ''}" data-photo="${esc(r.id)}" style="--shift:${hash(r.id) % 32}px"></div>
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
      recipePhotoUrl(r).then((url) => {
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
  root.querySelectorAll('[data-photo]').forEach((el) => state.byId.get(el.dataset.photo)?.photoFileId && io.observe(el));
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
        ${r.photoKind === 'dish' && r.photoFileId ? `<figure class="plate" data-photo="${esc(r.id)}"></figure>` : ''}
      </header>
      <ul class="tags">${[r.course, r.cuisine, ...r.tags].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>

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

      <section class="notes">
        <h2 class="section-title">Our notes</h2>
        <div id="notes"><p class="muted">Loading notes…</p></div>
        <form id="note-form" hidden>
          <label class="vh" for="note-text">Add a note</label>
          <textarea id="note-text" rows="3" placeholder="Add a note for everyone: tweaks, what worked, what to try next time" required></textarea>
          <button class="button" type="submit">Add note</button>
        </form>
        <p id="note-readonly" class="readonly-note" hidden>You can read notes but not add them. To add notes, ask whoever owns the shared recipe folder for edit access to the notes sheet.</p>
      </section>

      <footer class="colophon">
        ${!r.author && !r.book && r.sourceCredit ? `<span>Source: ${esc(r.sourceCredit)}</span>` : ''}
        <span>Added${r.addedBy ? ` by ${esc(r.addedBy)}` : ''} on ${new Date(r.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        ${r.sourceFileId && !DEMO ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(r.sourceFileId)}/view" target="_blank" rel="noopener">${icon('file')} Original file</a>` : ''}
      </footer>
    </article>`;

  hydratePhotos(app);
  app.onclick = null;
  app.onchange = onTick(r);
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

async function setupNoteForm(r) {
  const form = document.getElementById('note-form');
  const writable = await canWriteNotes();
  if (!form.isConnected) return;
  form.hidden = !writable;
  const readonly = document.getElementById('note-readonly');
  readonly.hidden = writable;
  if (!state.token && !DEMO) readonly.innerHTML = '<button class="link" data-signin>Sign in</button> to add notes.';
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
      if (err.status === 403) {
        state.canNote = false;
        form.hidden = true;
        document.getElementById('note-readonly').hidden = false;
      } else {
        alert(`Could not save the note: ${err.message}`);
      }
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
        ${n.email === state.user?.email ? `<button class="link" data-del="${esc(n.id)}">Delete</button>` : ''}</p>
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
  if (!state.token && !DEMO) {
    app.innerHTML = `<section class="inbox">
      <a href="#/" class="back">${icon('back')} All recipes</a>
      <header class="page-head"><h1>Add recipes</h1>
        <p class="lede"><button class="link" data-signin>Sign in</button> to add recipes.</p></header>
    </section>`;
    return;
  }
  const folderUrl = `https://drive.google.com/drive/folders/${encodeURIComponent(CFG.inboxFolderId)}`;
  app.innerHTML = `
    <section class="inbox">
      <a href="#/" class="back">${icon('back')} All recipes</a>
      <header class="page-head"><h1>Add recipes</h1>
        <p class="lede">Recipes are added in Google Drive, not on this site. Anything put in the shared recipe folder appears here within the hour.</p></header>
      <div id="access" class="access"></div>
      <h2 class="section-title">How to add one</h2>
      <ol>
        <li>Open the <a href="${folderUrl}" target="_blank" rel="noopener">shared recipe folder in Google Drive</a>.</li>
        <li>Upload a PDF, a photo of a recipe (cookbook page, handwritten card), a Google Doc, a Word file or a text file. Subfolders are fine.</li>
        <li>Want a nice photo of the finished dish? Upload it with the <b>same name</b> as the recipe file, for example <code>Lasagne.pdf</code> and <code>Lasagne.jpg</code>.</li>
        <li>New files are picked up within the hour. To fix a recipe, edit or replace the file; delete it to remove the recipe.</li>
      </ol>
      <h2 class="section-title">Checking the conversions</h2>
      <p>After converting a recipe, Claude reads it again for steps that may have come out wrong, and lists the equipment it needs.
        <a href="#/review">See which recipes to check against the original</a>.</p>
      <h2 class="section-title">Processing status</h2>
      <div id="status"><p class="muted">Loading…</p></div>
    </section>`;
  app.onclick = null;
  app.onchange = null;

  inboxAccess().then(({ canAdd, owners }) => {
    const el = document.getElementById('access');
    if (!el || canAdd) return;
    const who = owners.length ? esc(owners.join(' or ')) : 'whoever shares the recipe folder with you';
    el.innerHTML = `<div class="slip"><p><b>Your account can read the recipe folder but not add to it.</b></p>
      <p>To add recipes, ask ${who} to make you an editor of the folder. Until then you can still browse, search and cook from everything here.</p></div>`;
  });

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

  const others = new Map();
  for (const r of state.recipes) {
    for (const e of equipment(r)) {
      if (e.kind === 'other') others.set(equipmentName(e).toLowerCase(), (others.get(equipmentName(e).toLowerCase()) || 0) + 1);
    }
  }

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
      ${others.size ? `<h2 class="section-title">Other equipment</h2>
        <p class="muted">Equipment that isn't one of the usual kinds. Anything that keeps coming up could get its own icon.</p>
        <ul class="tags">${[...others].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `<li>${esc(name)} <b>${n}</b></li>`).join('')}</ul>` : ''}
    </section>`;
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

async function start() {
  app.innerHTML = '<p class="muted center">Opening the book…</p>';
  if (!DEMO) { state.saved = null; state.notes = null; banner(''); }
  if (DEMO) {
    state.user = { email: 'demo@example.com', name: 'Demo user' };
  } else {
    const info = await (await gfetch('https://www.googleapis.com/oauth2/v3/userinfo')).json();
    state.user = { email: info.email, name: info.given_name || info.name || info.email };
  }
  setSignedIn(true);
  try {
    await loadRecipes();
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      showSignIn(`Signed in as ${state.user.email}, but that account can't see the recipe folder. Ask for it to be shared with you, or sign in with a different account.`);
      state.user = null;
      return;
    }
    throw e;
  }
  route();
}

async function boot() {
  if (DEMO) {
    banner('Demo mode: showing sample data, notes are saved only in this browser.', 'info');
    return start();
  }
  if (CFG.clientId.startsWith('PASTE')) {
    app.innerHTML = '<p class="center">Site not configured yet: fill in <code>docs/config.js</code>. Or try the <a href="?demo">demo</a>.</p>';
    return;
  }
  const saved = loadSavedToken();
  // Not signed in: open the saved copy straight away, and let Google sign-in load behind it.
  if (!saved && await openSaved()) {
    waitForGsi().then(initTokenClient, () => { /* offline; Sign in tries again */ });
    return;
  }
  try {
    await waitForGsi();
    initTokenClient();
  } catch (e) {
    if (await openSaved()) return; // offline: Google sign-in can't load, but the saved copy can
    throw e;
  }
  if (saved) {
    state.token = saved.token;
    try {
      return await start();
    } catch (e) {
      if (await openSaved()) return; // offline, say: show the saved copy instead
      throw e;
    }
  }
  showSignIn();
}

/** Show this device's saved copy, signed out. False if there isn't one. */
async function openSaved() {
  const about = await savedGet('about.json');
  if (!about) return false;
  state.token = null;
  state.user = null;
  state.saved = await about.json();
  try {
    await loadRecipes();
  } catch {
    state.saved = null;
    return false;
  }
  setSignedIn(false);
  const when = new Date(state.saved.savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  banner(`Saved copy from ${when}. <button class="link" data-signin>Sign in</button> for new recipes and notes.`, 'info');
  route();
  return true;
}

boot().catch((e) => {
  app.innerHTML = `<p class="error center">Something went wrong: ${esc(e.message)}</p>`;
});
