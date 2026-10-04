// Recipe Box front end. Talks directly to Google Drive and Sheets with the
// signed-in user's own token, so it only works for people the folder is shared with.

const CFG = { siteTitle: 'Recipe Box', ...window.RECIPE_BOX_CONFIG };
const DEMO = new URLSearchParams(location.search).has('demo');
const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ');
const TOKEN_KEY = 'rb-token';

const state = {
  token: null,
  user: null,
  recipes: [],
  byId: new Map(),
  ingredients: new Map(), // canonical -> {name, staple, recipeIds:Set}
  notes: null,            // [{row, id, recipeId, timestamp, email, name, text}]
  photos: new Map(),      // fileId -> Promise<objectURL|null>
  search: { text: '', ingredients: [], course: '' },
};

const app = document.getElementById('app');
document.getElementById('brand').textContent = CFG.siteTitle;
document.title = CFG.siteTitle;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function showSignIn(message = '') {
  app.innerHTML = `
    <section class="signin">
      <h1>${esc(CFG.siteTitle)}</h1>
      <p>Our shared recipes. Sign in with the Google account the recipe folder is shared with.</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ''}
      <button class="primary" id="signin">Sign in with Google</button>
    </section>`;
  document.getElementById('signin').onclick = async () => {
    try {
      await requestToken('');
      await start();
    } catch (e) {
      showSignIn(e.message === 'access_denied' ? 'Sign-in was cancelled.' : e.message);
    }
  };
}

function signOut() {
  if (state.token && !DEMO) google.accounts.oauth2.revoke(state.token, () => {});
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* fine */ }
  state.token = null;
  state.user = null;
  document.getElementById('signout').hidden = true;
  showSignIn();
}
document.getElementById('signout').onclick = signOut;

/** fetch() against Google APIs, re-requesting the token once if it has expired. */
async function gfetch(url, opts = {}, retry = true) {
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
const sheetsBase = () => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(CFG.sheetId)}`;

async function loadRecipes() {
  const data = DEMO
    ? await (await fetch('demo/recipes.json', { cache: 'no-store' })).json()
    : await (await gfetch(driveFile(CFG.recipesFileId))).json();
  state.recipes = data.recipes.slice().sort((a, b) => a.title.localeCompare(b.title));
  state.byId = new Map(state.recipes.map((r) => [r.id, r]));
  buildIngredientIndex();
}

function buildIngredientIndex() {
  const extra = new Set(CFG.extraStaples.map((s) => s.toLowerCase()));
  const map = new Map();
  for (const r of state.recipes) {
    for (const item of allItems(r)) {
      const key = (item.canonical || item.name).toLowerCase().trim();
      if (!map.has(key)) map.set(key, { name: key, stapleVotes: 0, uses: 0, recipeIds: new Set() });
      const e = map.get(key);
      e.uses++;
      if (item.staple) e.stapleVotes++;
      e.recipeIds.add(r.id);
    }
  }
  for (const e of map.values()) e.staple = extra.has(e.name) || e.stapleVotes * 2 > e.uses;
  state.ingredients = map;
}

function photoUrl(fileId) {
  if (!fileId) return Promise.resolve(null);
  if (!state.photos.has(fileId)) {
    state.photos.set(fileId, (DEMO ? Promise.resolve(`demo/${fileId}`) :
      gfetch(driveFile(fileId)).then((r) => r.blob()).then((b) => URL.createObjectURL(b))).catch(() => null));
  }
  return state.photos.get(fileId);
}

async function loadNotes() {
  if (DEMO) {
    try { state.notes = JSON.parse(localStorage.getItem('rb-demo-notes') || '[]'); } catch { state.notes = []; }
    return;
  }
  const res = await gfetch(`${sheetsBase()}/values/${encodeURIComponent('Notes!A2:F')}`);
  const rows = (await res.json()).values || [];
  state.notes = rows
    .map((v, i) => ({ row: i + 2, id: v[0], recipeId: v[1], timestamp: v[2], email: v[3], name: v[4], text: v[5] }))
    .filter((n) => n.id && n.text);
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

// ---------- search ----------

function matchingRecipes() {
  const { text, ingredients, course } = state.search;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return state.recipes.filter((r) => {
    if (course && r.course !== course) return false;
    const canon = new Set(allItems(r).map((i) => (i.canonical || i.name).toLowerCase().trim()));
    if (!ingredients.every((i) => canon.has(i))) return false;
    if (!words.length) return true;
    const hay = [r.title, r.description, r.cuisine, r.course, ...r.tags, ...allItems(r).map((i) => i.name)]
      .join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Ingredients that most often appear alongside the selected ones, staples excluded. */
function coIngredientSuggestions(recipes, limit = 12) {
  const selected = new Set(state.search.ingredients);
  const counts = new Map();
  for (const r of recipes) {
    const seen = new Set();
    for (const item of allItems(r)) {
      const key = (item.canonical || item.name).toLowerCase().trim();
      if (seen.has(key) || selected.has(key) || state.ingredients.get(key)?.staple) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

// ---------- views ----------

function recipeCard(r) {
  const t = fmtMinutes(totalMinutes(r));
  return `
    <a class="card" href="#/r/${encodeURIComponent(r.id)}">
      <div class="thumb ${r.photoKind === 'page' ? 'page' : ''}" data-photo="${esc(r.photoFileId || '')}"><span>${esc(r.title.slice(0, 1))}</span></div>
      <div class="card-body">
        <h3>${esc(r.title)}</h3>
        <p class="meta">${[r.course, t, r.servings && `Serves ${r.servings}`].filter(Boolean).map(esc).join(' · ')}</p>
      </div>
    </a>`;
}

function hydratePhotos(root) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      photoUrl(e.target.dataset.photo).then((url) => {
        if (url) e.target.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
      });
    }
  }, { rootMargin: '200px' });
  root.querySelectorAll('[data-photo]').forEach((el) => el.dataset.photo && io.observe(el));
}

function renderHome() {
  const courses = [...new Set(state.recipes.map((r) => r.course).filter(Boolean))].sort();
  const allIngredients = [...state.ingredients.values()].filter((e) => !e.staple).map((e) => e.name).sort();
  app.innerHTML = `
    <section class="search">
      <input id="q" type="search" placeholder="Search recipes…" value="${esc(state.search.text)}" autocomplete="off">
      <div class="ing-search">
        <input id="ing" list="ing-list" placeholder="Add an ingredient you have…" autocomplete="off">
        <datalist id="ing-list">${allIngredients.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>
      </div>
      <div id="chips" class="chips"></div>
      <div class="filters">
        <select id="course"><option value="">All courses</option>${courses.map((c) => `<option ${c === state.search.course ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      </div>
      <div id="suggest" class="suggest"></div>
    </section>
    <p id="count" class="muted"></p>
    <section id="grid" class="grid"></section>`;

  const q = document.getElementById('q');
  const ing = document.getElementById('ing');
  q.oninput = () => { state.search.text = q.value; update(); };
  document.getElementById('course').onchange = (e) => { state.search.course = e.target.value; update(); };
  const addIngredient = (name) => {
    const key = name.toLowerCase().trim();
    if (key && !state.search.ingredients.includes(key)) state.search.ingredients.push(key);
    ing.value = '';
    update();
  };
  ing.onchange = () => addIngredient(ing.value);
  ing.onkeydown = (e) => { if (e.key === 'Enter') addIngredient(ing.value); };

  function update() {
    const list = matchingRecipes();
    document.getElementById('chips').innerHTML = state.search.ingredients
      .map((i) => `<button class="chip on" data-remove="${esc(i)}">${esc(i)} ✕</button>`).join('');
    const sugg = state.search.ingredients.length ? coIngredientSuggestions(list) : [];
    document.getElementById('suggest').innerHTML = sugg.length
      ? `<span class="muted">Goes well with:</span> ${sugg.map(([n, c]) => `<button class="chip" data-add="${esc(n)}">${esc(n)} <small>${c}</small></button>`).join('')}`
      : '';
    document.getElementById('count').textContent = state.recipes.length
      ? `${list.length} of ${state.recipes.length} recipes`
      : 'No recipes yet. Add some via “Add recipes”.';
    const grid = document.getElementById('grid');
    grid.innerHTML = list.map(recipeCard).join('');
    hydratePhotos(grid);
  }
  app.onclick = (e) => {
    const rm = e.target.closest('[data-remove]');
    const add = e.target.closest('[data-add]');
    if (rm) { state.search.ingredients = state.search.ingredients.filter((i) => i !== rm.dataset.remove); update(); }
    if (add) addIngredient(add.dataset.add);
  };
  update();
}

function renderRecipe(id) {
  const r = state.byId.get(id);
  if (!r) { app.innerHTML = '<p class="center">Recipe not found. <a href="#/">Back to all recipes</a></p>'; return; }
  const est = r.timesAreEstimated ? ' <abbr title="Estimated, not stated in the original">est.</abbr>' : '';
  const facts = [
    ['Prep', fmtMinutes(r.prepMinutes)], ['Cook', fmtMinutes(r.cookMinutes)],
    ['Total', fmtMinutes(totalMinutes(r))], ['Serves', r.servings],
  ].filter(([, v]) => v);

  app.innerHTML = `
    <article class="recipe">
      <a href="#/" class="back">← All recipes</a>
      ${r.photoKind === 'dish' ? `<div class="hero" data-photo="${esc(r.photoFileId)}"></div>` : ''}
      <h1>${esc(r.title)}</h1>
      <p class="lede">${esc(r.description)}</p>
      <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}${k !== 'Serves' ? est : ''}</dd></div>`).join('')}</dl>
      <p class="tags">${[r.course, r.cuisine, ...r.tags].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>

      <div class="columns">
        <section class="ingredients">
          <h2>Ingredients</h2>
          ${r.ingredientGroups.map((g) => `
            ${g.name ? `<h3>${esc(g.name)}</h3>` : ''}
            <ul class="checklist">${g.items.map((i) => `
              <li class="${state.ingredients.get((i.canonical || i.name).toLowerCase().trim())?.staple ? 'staple' : ''}">
                <label><input type="checkbox">
                <span><b>${esc([i.quantity, i.unit].filter(Boolean).join(' '))}</b> ${esc(i.name)}${i.preparation ? `, <i>${esc(i.preparation)}</i>` : ''}${i.optional ? ' <small>(optional)</small>' : ''}</span></label>
              </li>`).join('')}
            </ul>`).join('')}
        </section>

        <section class="method">
          <div class="tabs" role="tablist">
            <button role="tab" class="tab on" data-tab="steps">Steps</button>
            <button role="tab" class="tab" data-tab="flow">Flowchart</button>
            <label class="awake"><input type="checkbox" id="awake"> Keep screen on</label>
          </div>
          <ol class="steps" id="steps">${r.steps.map((s) => `
            <li id="step-${esc(s.id)}"><label><input type="checkbox"><span>${esc(s.text)}${s.minutes ? ` <small class="muted">(${fmtMinutes(s.minutes)})</small>` : ''}</span></label></li>`).join('')}
          </ol>
          <div id="flow" class="flow" hidden><p class="muted">Drawing…</p></div>
        </section>
      </div>

      ${r.sourceNotes.length ? `<section><h2>From the original</h2><ul>${r.sourceNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}

      <section class="notes">
        <h2>Our notes</h2>
        <div id="notes"><p class="muted">Loading notes…</p></div>
        <form id="note-form">
          <textarea id="note-text" rows="3" placeholder="Add a note for everyone: tweaks, what worked, what to try next time…" required></textarea>
          <button class="primary" type="submit">Add note</button>
        </form>
      </section>

      <p class="source muted">
        ${r.sourceCredit ? `Source: ${esc(r.sourceCredit)}<br>` : ''}
        Added${r.addedBy ? ` by ${esc(r.addedBy)}` : ''} on ${new Date(r.addedAt).toLocaleDateString()}
        ${r.sourceFileId && !DEMO ? ` · <a href="https://drive.google.com/file/d/${encodeURIComponent(r.sourceFileId)}/view" target="_blank" rel="noopener">Original file</a>` : ''}
      </p>
    </article>`;

  hydratePhotos(app);
  app.onclick = null;

  const tabs = app.querySelectorAll('.tab');
  tabs.forEach((t) => t.onclick = () => {
    tabs.forEach((x) => x.classList.toggle('on', x === t));
    const flow = t.dataset.tab === 'flow';
    document.getElementById('steps').hidden = flow;
    document.getElementById('flow').hidden = !flow;
    if (flow) renderFlowchart(r);
  });

  setupWakeLock();
  renderNotes(r);
  document.getElementById('note-form').onsubmit = async (e) => {
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
      alert(`Could not save the note: ${err.message}`);
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
  const notes = state.notes.filter((n) => n.recipeId === r.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  el.innerHTML = notes.length ? notes.map((n) => `
    <div class="note">
      <p>${esc(n.text).replace(/\n/g, '<br>')}</p>
      <p class="muted small">${esc(n.name || n.email)} · ${new Date(n.timestamp).toLocaleDateString()}
        ${n.email === state.user.email ? `<button class="link small" data-del="${esc(n.id)}">Delete</button>` : ''}</p>
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

let wakeLock = null;
function setupWakeLock() {
  const box = document.getElementById('awake');
  if (!('wakeLock' in navigator)) { box.parentElement.hidden = true; return; }
  box.checked = !!wakeLock;
  box.onchange = async () => {
    if (box.checked) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { box.checked = false; }
    } else {
      await wakeLock?.release();
      wakeLock = null;
    }
  };
}
document.addEventListener('visibilitychange', async () => {
  // The browser drops the lock when the tab is hidden; take it back on return.
  if (wakeLock && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
});

// ---------- flowchart ----------

let mermaidReady = null;
function loadMermaid() {
  mermaidReady ??= import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(({ default: m }) => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    m.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict', flowchart: { useMaxWidth: true, htmlLabels: true } });
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
  return lines.join('\n');
}

async function renderFlowchart(r) {
  const el = document.getElementById('flow');
  if (el.dataset.done === r.id) return;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`fc-${Date.now()}`, flowchartSource(r));
    el.innerHTML = `${svg}<p class="muted small">Tap a box to see the full step. Boxes side by side can be done at the same time.</p><div id="flow-detail" class="flow-detail" hidden></div>`;
    el.dataset.done = r.id;
    el.querySelectorAll('g.node').forEach((node) => {
      const m = node.id.match(/flowchart-(.+)-\d+$/);
      const step = m && r.steps.find((s) => s.id === m[1]);
      if (!step) return;
      node.style.cursor = 'pointer';
      node.onclick = () => {
        const d = document.getElementById('flow-detail');
        d.hidden = false;
        d.innerHTML = `<b>Step ${r.steps.indexOf(step) + 1}.</b> ${esc(step.text)}`;
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="error">Could not draw the flowchart: ${esc(e.message)}</p>`;
  }
}

// ---------- inbox / status ----------

async function renderInbox() {
  const folderUrl = `https://drive.google.com/drive/folders/${encodeURIComponent(CFG.inboxFolderId)}`;
  app.innerHTML = `
    <section class="inbox">
      <a href="#/" class="back">← All recipes</a>
      <h1>Add recipes</h1>
      <ol>
        <li>Open the <a href="${folderUrl}" target="_blank" rel="noopener">Recipe Box folder in Google Drive</a>.</li>
        <li>Upload a PDF, a photo of a recipe (cookbook page, handwritten card), a Google Doc, a Word file or a text file. Subfolders are fine.</li>
        <li>Want a nice photo of the finished dish? Upload it with the <b>same name</b> as the recipe file, e.g. <code>Lasagne.pdf</code> + <code>Lasagne.jpg</code>.</li>
        <li>New files are picked up within the hour. To fix a recipe, edit or replace the file; delete it to remove the recipe.</li>
      </ol>
      <h2>Processing status</h2>
      <div id="status"><p class="muted">Loading…</p></div>
    </section>`;
  app.onclick = null;
  try {
    const rows = await loadStatus();
    document.getElementById('status').innerHTML = rows.length ? `
      <table class="status"><thead><tr><th>File</th><th>Status</th><th>Recipes</th></tr></thead><tbody>
      ${rows.map(([file, status, n, detail]) => `<tr class="${status === 'error' || status.startsWith('unsupported') ? 'bad' : ''}"><td>${esc(file)}${detail ? `<br><small>${esc(detail)}</small>` : ''}</td><td>${esc(status)}</td><td>${esc(n)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Nothing processed yet.</p>';
  } catch (e) {
    document.getElementById('status').innerHTML = `<p class="error">Could not load status: ${esc(e.message)}</p>`;
  }
}

// ---------- routing & startup ----------

function route() {
  if (!state.user) return;
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  if (hash.startsWith('#/r/')) renderRecipe(decodeURIComponent(hash.slice(4)));
  else if (hash === '#/inbox') renderInbox();
  else renderHome();
}
window.addEventListener('hashchange', route);

async function start() {
  app.innerHTML = '<p class="muted center">Loading recipes…</p>';
  if (DEMO) {
    state.user = { email: 'demo@example.com', name: 'Demo user' };
  } else {
    const info = await (await gfetch('https://www.googleapis.com/oauth2/v3/userinfo')).json();
    state.user = { email: info.email, name: info.given_name || info.name || info.email };
  }
  document.getElementById('signout').hidden = DEMO;
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
  await waitForGsi();
  initTokenClient();
  const saved = loadSavedToken();
  if (saved) {
    state.token = saved.token;
    return start();
  }
  showSignIn();
}

boot().catch((e) => {
  app.innerHTML = `<p class="error center">Something went wrong: ${esc(e.message)}</p>`;
});
