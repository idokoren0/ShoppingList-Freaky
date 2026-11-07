'use strict';

const $ = (id) => document.getElementById(id);
let money, dateFmt, shortDate, monthFmt, monthShort, relTime, numFmt, currencySymbol;
function setupFormats(currency) {
  const loc = LANGS[LANG].locale;
  money = new Intl.NumberFormat(loc, { style: 'currency', currency });
  dateFmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' });
  shortDate = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' });
  monthFmt = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' });
  monthShort = new Intl.DateTimeFormat(loc, { month: 'short' });
  relTime = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
  numFmt = new Intl.NumberFormat(loc);
  currencySymbol = new Intl.NumberFormat(loc, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find((p) => p.type === 'currency')?.value || currency;
}

// One shared "things we need" list. The multi-list code stays: set false to bring the list tabs back.
const SINGLE_LIST = true;

const state = {
  me: null,
  people: [],
  lists: [],
  listId: null,
  serverItems: [], // last copy from the server
  items: [], // serverItems with not-yet-synced changes applied
  catalog: [],
  purchases: [],
  storeMode: false, // this phone is in the store: tap = into the cart
  cart: new Set(), // item ids in the cart (this phone, store mode only)
  song: null, // the store song on show
  aiEnabled: false,
  config: null, // household settings from the server (language, currency, OpenAI status)
  sections: [],
  categories: [],
  month: new Date(),
  view: 'list',
  draft: null, // purchase being recorded or edited
  editItem: null, // item in the edit sheet
  editList: null,
  importDraft: null, // list being imported from a note, link or text
  saved: [], // saved recipes and recurring batches
  savedOpen: null, // the saved set being merged into the list
  savedEdit: null, // the saved set being created or edited
  outbox: [], // changes waiting for the server (works offline)
  online: navigator.onLine,
  syncing: false,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const itemKey = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const sectionName = (key) => state.sections.find(([k]) => k === key)?.[1] || t('sorting');
const categoryName = (key) => state.categories.find(([k]) => k === key)?.[1] || key;

function personColor(id) {
  const idx = state.people.findIndex((p) => p.id === id);
  return idx >= 0 && idx < 2 ? `var(--chart-${idx})` : `var(--person-${(idx < 0 ? 0 : idx) % 4})`;
}

// ---------- Toast with optional undo ----------
function toast(msg, action) {
  const box = $('toast');
  $('toast-text').textContent = msg;
  const btn = $('toast-action');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label || t('undo');
    btn.onclick = () => {
      box.hidden = true;
      action.run();
    };
  }
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.hidden = true), action ? 6000 : 2600);
}

// ---------- Local storage ----------
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}
function saveJSON(key, val) {
  storageSet(key, JSON.stringify(val));
}
function loadJSON(key, fallback) {
  try { return JSON.parse(storageGet(key)) ?? fallback; } catch { return fallback; }
}

// Snapshot of server data, so the app opens and works with no connection
function saveSnapshot() {
  saveJSON('snapshot', {
    people: state.people,
    lists: state.lists,
    items: state.serverItems,
    catalog: state.catalog,
    purchases: state.purchases.slice(0, 100),
    saved: state.saved,
    sections: state.sections,
    categories: state.categories,
    aiEnabled: state.aiEnabled,
    config: state.config,
  });
}

// Receipt photos taken offline wait in IndexedDB until they can be uploaded
const photoStore = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('shopping-photos', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos');
      req.onsuccess = () => resolve((this.db = req.result));
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tr = db.transaction('photos', mode);
      const req = fn(tr.objectStore('photos'));
      tr.oncomplete = () => resolve(req?.result);
      tr.onerror = () => reject(tr.error);
    });
  },
  put(key, blob) { return this.run('readwrite', (s) => s.put(blob, key)); },
  get(key) { return this.run('readonly', (s) => s.get(key)); },
  del(key) { return this.run('readwrite', (s) => s.delete(key)); },
};

// ---------- Server calls ----------
class OfflineError extends Error {}

async function api(path, opts = {}) {
  const init = { ...opts, headers: {} };
  if (state.me) init.headers['X-Person-Id'] = String(state.me.id); // for the server's access log
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    setOnline(false);
    throw new OfflineError(t('noConnection'));
  }
  // Tailscale answers 502 when the PC's app is down: treat it like no connection
  if ([502, 503, 504].includes(res.status)) {
    setOnline(false);
    throw new OfflineError(t('serverDown'));
  }
  setOnline(true);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || t('errorStatus', { status: res.status }));
  return body;
}

function setOnline(on) {
  if (state.online === on) return;
  state.online = on;
  renderNet();
  if (on) flush();
}

function renderNet() {
  const pending = state.outbox.length;
  const banner = $('net-banner');
  if (state.online && !pending) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.classList.toggle('syncing', state.online);
  $('net-text').textContent = state.online
    ? t('syncingN', { n: pending })
    : pending
      ? t('offlinePending', { n: pending })
      : t('offlineIdle');
}

function requireOnline() {
  if (state.online) return true;
  toast(t('needsOnline'));
  return false;
}

// ---------- Offline outbox ----------
// Every list change is applied locally at once, queued, and sent in order.
let tempId = -Number(storageGet('tempId') || 1);

function enqueue(op) {
  op.opId = uid();
  state.outbox.push(op);
  saveJSON('outbox', state.outbox);
  applyLocal();
  flush();
  return op;
}

function dropOp(op) {
  state.outbox = state.outbox.filter((o) => o !== op && o.opId !== op.opId);
  saveJSON('outbox', state.outbox);
  applyLocal();
}

function remapId(from, to) {
  for (const op of state.outbox) {
    if (op.itemId === from) op.itemId = to;
    if (op.ids) op.ids = op.ids.map((x) => (x === from ? to : x));
    if (op.body?.item_ids) op.body.item_ids = op.body.item_ids.map((x) => (x === from ? to : x));
    if (op.body?.lines) for (const l of op.body.lines) if (l.item_id === from) l.item_id = to;
  }
  if (state.cart.delete(from)) {
    state.cart.add(to);
    saveCart();
  }
}

// serverItems + queued changes = what the phone shows
function replay(items, outbox) {
  let out = items.map((i) => ({ ...i }));
  for (const op of outbox) {
    if (op.type === 'addItem') {
      const dup = out.find((i) => i.list_id === op.body.list_id && itemKey(i.name) === itemKey(op.body.name));
      if (dup) {
        dup.quantity = Math.min(99, (dup.quantity || 1) + op.body.quantity);
      } else {
        const known = state.catalog.find((c) => c.key === itemKey(op.body.name));
        out.push({
          id: op.tempId,
          name: op.body.name,
          quantity: op.body.quantity,
          list_id: op.body.list_id,
          section: known?.section || null,
          note: op.body.note || null,
          added_by_name: state.me?.name,
          pending: true,
        });
      }
    } else if (op.type === 'patchItem') {
      const it = out.find((i) => i.id === op.itemId);
      if (it) Object.assign(it, op.body);
    } else if (op.type === 'deleteItems') {
      out = out.filter((i) => !op.ids.includes(i.id));
    } else if (op.type === 'addPurchase') {
      out = out.filter((i) => !op.body.item_ids.includes(i.id));
    }
  }
  return out;
}

function applyLocal() {
  state.items = replay(state.serverItems, state.outbox);
  renderLists();
  renderItems();
  if (state.draft) renderPickItems();
  renderNet();
}

async function sendOp(op) {
  if (op.type === 'addItem') {
    const r = await api('/api/items', { json: op.body });
    remapId(op.tempId, r.id);
  } else if (op.type === 'patchItem') {
    if (op.itemId > 0) await api(`/api/items/${op.itemId}`, { method: 'PATCH', json: op.body });
  } else if (op.type === 'deleteItems') {
    const ids = op.ids.filter((x) => x > 0);
    if (ids.length) op.result = (await api('/api/items/delete', { json: { ids } })).undo;
  } else if (op.type === 'addPurchase') {
    if (op.photoKey && !op.body.receipt_file) {
      const blob = await photoStore.get(op.photoKey);
      if (blob) {
        const fd = new FormData();
        fd.append('photo', blob, 'receipt.jpg');
        op.body.receipt_file = (await api('/api/receipt', { method: 'POST', body: fd })).file;
      }
    }
    op.body.item_ids = op.body.item_ids.filter((x) => x > 0);
    op.resultId = (await api('/api/purchases', { json: op.body })).id;
    if (op.photoKey) photoStore.del(op.photoKey).catch(() => {});
  }
}

async function flush() {
  if (state.syncing || !state.outbox.length) return;
  state.syncing = true;
  renderNet();
  try {
    while (state.outbox.length) {
      const op = state.outbox[0];
      try {
        await sendOp(op);
      } catch (err) {
        if (err instanceof OfflineError) break;
        toast(t('changeNotSaved', { msg: err.message }));
      }
      state.sent.set(op.opId, op);
      state.outbox.shift();
      saveJSON('outbox', state.outbox);
    }
  } finally {
    state.syncing = false;
    saveJSON('outbox', state.outbox);
    renderNet();
    if (!state.outbox.length) scheduleRefresh();
  }
}
state.sent = new Map(); // ops already sent this session, for undo

// Undo a queued change: drop it if it hasn't been sent, otherwise ask the server
async function undoOp(op) {
  if (state.outbox.some((o) => o.opId === op.opId)) {
    dropOp(op);
    return;
  }
  const sent = state.sent.get(op.opId) || op;
  try {
    if (sent.type === 'deleteItems' && sent.result) await api('/api/undo', { json: sent.result });
    if (sent.type === 'addPurchase' && sent.resultId) await api(`/api/purchases/${sent.resultId}`, { method: 'DELETE' });
    if (sent.type === 'addItem') {
      const id = state.items.find((i) => itemKey(i.name) === itemKey(sent.body.name) && i.list_id === sent.body.list_id)?.id;
      if (id) await api('/api/items/delete', { json: { ids: [id] } });
    }
    await refreshAll();
  } catch (err) {
    toast(err instanceof OfflineError ? t('undoOffline') : err.message);
  }
}

// ---------- Theme (per phone) ----------
// bar: browser theme-color, light and dark; swatch: the picker's preview of each world
const THEMES = {
  modern: { name: 'themeModern', bar: ['#ffffff', '#121212'], swatch: ['#ffffff', '#1b1b1b', '#009944', '#e60012', '#0079c2'] },
  washi: { name: 'themeWashi', bar: ['#23395d', '#203760'], swatch: ['#f2eee5', '#23395d', '#c0392b', '#e3b448'] },
  konbini: { name: 'themeKonbini', bar: ['#ffffff', '#16181c'], swatch: ['#ffffff', '#f58220', '#00873c', '#e60012', '#ffd400'] },
  shire: { name: 'themeShire', bar: ['#4a2c14', '#140d06'], swatch: ['#eee7d8', '#4a2c14', '#2e5e34', '#a3302a'] },
};
const THEME_ALIASES = { wa: 'washi' }; // the first Japanese theme, retired
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// Display mode, per phone: auto follows the phone's dark mode, moon is always dark, sun always light
const MODES = {
  auto: { icon: 'auto', label: 'modeAuto' },
  dark: { icon: 'moon', label: 'modeDark' },
  light: { icon: 'sun', label: 'modeLight' },
};
const MODE_ORDER = ['auto', 'dark', 'light'];
const currentMode = () => document.documentElement.dataset.mode || 'auto';
const isDark = () => currentMode() === 'dark' || (currentMode() === 'auto' && darkQuery.matches);

function applyMode(mode) {
  const m = MODES[mode] ? mode : 'auto';
  if (m === 'auto') delete document.documentElement.dataset.mode;
  else document.documentElement.dataset.mode = m;
  const btn = $('mode-toggle');
  btn.querySelector('use').setAttribute('href', `#i-${MODES[m].icon}`);
  btn.setAttribute('aria-label', t('modeToggleAria', { mode: t(MODES[m].label) }));
  btn.title = t(MODES[m].label);
  applyTheme(document.documentElement.dataset.theme);
}

$('mode-toggle').addEventListener('click', () => {
  const next = MODE_ORDER[(MODE_ORDER.indexOf(currentMode()) + 1) % MODE_ORDER.length];
  storageSet('mode', next);
  applyMode(next);
  toast(t(MODES[next].label));
});

function applyTheme(name) {
  const wanted = THEME_ALIASES[name] || name;
  const theme = THEMES[wanted] ? wanted : 'modern';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]').content = THEMES[theme].bar[isDark() ? 1 : 0];
}

function renderThemeOptions() {
  const current = document.documentElement.dataset.theme;
  $('theme-options').innerHTML = Object.entries(THEMES).map(([key, th]) => `
    <button type="button" class="theme-option" role="radio" aria-checked="${key === current}" data-theme-pick="${key}">
      <span class="theme-swatch" aria-hidden="true">${th.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      <span class="theme-option-name">${esc(t(th.name))}</span>
    </button>`).join('');
}

$('theme-options').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-theme-pick]');
  if (!pick) return;
  storageSet('theme', pick.dataset.themePick);
  applyTheme(pick.dataset.themePick);
  renderThemeOptions();
});
darkQuery.addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));

// ---------- Identity ----------
function renderWho() {
  $('who-name').textContent = state.me ? state.me.name : t('whoAmI');
}

function openWhoModal() {
  $('people-buttons').innerHTML = state.people
    .map((p) => `<button type="button" class="btn" data-person="${p.id}">${esc(p.name)}</button>`)
    .join('');
  $('who-modal').hidden = false;
}

function setMe(person) {
  state.me = person;
  storageSet('personId', String(person.id));
  $('who-modal').hidden = true;
  renderWho();
}

$('who').addEventListener('click', openWhoModal);
$('people-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-person]');
  const p = btn && state.people.find((x) => x.id === Number(btn.dataset.person));
  if (p) setMe(p);
});
$('person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('person-name').value.trim();
  if (!name || !requireOnline()) return;
  try {
    const p = await api('/api/people', { json: { name } });
    $('person-name').value = '';
    await loadPeople();
    setMe(p);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Bottom tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});

function showView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'saved') renderSaved();
  if (view === 'history') loadPurchases();
  if (view === 'summary') loadSummary();
  window.scrollTo(0, 0);
}

// ---------- Lists ----------
function renderLists() {
  if (!state.lists.some((l) => l.id === state.listId)) state.listId = state.lists[0]?.id ?? 1;
  $('list-tabs').hidden = SINGLE_LIST;
  if (SINGLE_LIST) {
    state.listId = state.lists[0]?.id ?? 1; // new items go on the first list
    return;
  }
  const count = (id) => state.items.filter((i) => i.list_id === id).length;
  $('list-tabs').innerHTML = state.lists.map((l) => `
    <button type="button" class="list-tab ${l.id === state.listId ? 'active' : ''}" data-list="${l.id}"
      ${l.id === state.listId ? `aria-current="true" title="${t('tapAgainToEdit')}"` : ''}>
      ${esc(l.name)}<span class="list-count num">${count(l.id) || ''}</span>
      ${l.id === state.listId ? icon('more') : ''}
    </button>`).join('')
    + `<button type="button" class="list-tab add" data-list-add aria-label="${t('newList')}">${icon('plus')}</button>`;
}

$('list-tabs').addEventListener('click', async (e) => {
  if (e.target.closest('[data-list-add]')) {
    if (!requireOnline()) return;
    const name = prompt(t('newListPrompt'));
    if (!name?.trim()) return;
    try {
      const l = await api('/api/lists', { json: { name } });
      state.listId = l.id;
      storageSet('listId', String(l.id));
      await loadLists();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const tab = e.target.closest('[data-list]');
  if (!tab) return;
  const id = Number(tab.dataset.list);
  if (id === state.listId) return openListModal(state.lists.find((l) => l.id === id));
  state.listId = id;
  storageSet('listId', String(id));
  renderLists();
  renderItems();
});

function openListModal(list) {
  state.editList = list;
  $('l-name').value = list.name;
  $('l-delete').hidden = state.lists.length <= 1;
  openModal($('list-modal'));
}

$('list-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('l-name').value.trim();
  if (!name || !requireOnline()) return;
  try {
    await api(`/api/lists/${state.editList.id}`, { method: 'PATCH', json: { name } });
    closeModal($('list-modal'));
    await loadLists();
  } catch (err) {
    toast(err.message);
  }
});

$('l-delete').addEventListener('click', async () => {
  const list = state.editList;
  if (!requireOnline()) return;
  const n = state.items.filter((i) => i.list_id === list.id).length;
  if (!confirm(t('deleteListConfirm', { name: list.name, items: n ? t('deleteListItems', { n }) : '' }))) return;
  try {
    const r = await api(`/api/lists/${list.id}`, { method: 'DELETE' });
    closeModal($('list-modal'));
    await refreshAll();
    toast(t('listDeleted', { name: list.name }), { run: () => api('/api/undo', { json: r.undo }).then(refreshAll).catch((err) => toast(err.message)) });
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Shopping list ----------
function currentItems() {
  return SINGLE_LIST ? state.items : state.items.filter((i) => i.list_id === state.listId);
}

// The cart lives only on this phone and only while in store mode
const inCart = (i) => state.storeMode && state.cart.has(i.id);
const cartItems = () => state.items.filter(inCart);

function itemRow(i) {
  const sel = inCart(i);
  const meta = sel ? '' : [
    i.note,
    i.added_by_name && t('addedBy', { name: i.added_by_name }),
    i.last_price != null && t('lastTimePrice', { price: money.format(i.last_price) }),
  ].filter(Boolean).join(' · ');
  return `
    <li class="item ${sel ? 'selected' : ''} ${i.pending ? 'pending' : ''}" data-id="${i.id}">
      <input type="checkbox" class="tick" ${sel ? 'checked' : ''} aria-label="${esc(t('inCartAria', { name: i.name }))}">
      <div class="item-main" data-edit>
        <div class="item-name">${esc(i.name)}${i.quantity > 1 ? ` <span class="qty num">×${i.quantity}</span>` : ''}</div>
        ${meta ? `<div class="item-meta">${esc(meta)}</div>` : ''}
      </div>
      <button type="button" class="icon-btn" data-delete aria-label="${esc(t('deleteAria', { name: i.name }))}">${icon('x')}</button>
    </li>`;
}

function renderItems() {
  const items = currentItems();
  const left = items.filter((i) => !inCart(i));
  const cart = items.filter(inCart);
  const order = state.sections.map(([k]) => k);
  const groups = new Map();
  for (const i of left) {
    const key = order.includes(i.section) ? i.section : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === null) - (b === null) || order.indexOf(a) - order.indexOf(b));
  // data-code / --sec-c / data-count feed each theme's section signage (metro line, shelf rail count)
  const sections = keys.map((k) => `
    <section class="sec" data-sec="${k || 'unsorted'}" style="--sec-c: var(--sec-${k || 'other'})">
      <h3 class="sec-title" data-code="${k ? String(order.indexOf(k) + 1).padStart(2, '0') : '··'}" data-count="${groups.get(k).length}">${esc(sectionName(k))}</h3>
      <ul class="items">${groups.get(k).map(itemRow).join('')}</ul>
    </section>`).join('');
  // What's in the cart sinks to the bottom, folded away
  const folded = state.cartFolded !== false;
  const cartSec = cart.length ? `
    <section class="sec cart-sec ${folded ? 'folded' : ''}" data-sec="cart" style="--sec-c: var(--muted)">
      <h3 class="sec-title" data-code="✓" data-count="${cart.length}">
        <button type="button" class="cart-fold" data-cart-fold aria-expanded="${!folded}">${esc(t('inCartN', { n: cart.length }))}<span class="flip-rtl">${icon('chev-r')}</span></button>
      </h3>
      <ul class="items">${cart.map(itemRow).join('')}</ul>
    </section>` : '';
  $('items').innerHTML = sections + (state.storeMode && !left.length && cart.length
    ? `<p class="store-done">${esc(t('allInCart'))}</p>` : '') + cartSec;

  $('items').hidden = items.length === 0;
  $('items-empty').hidden = items.length > 0;
  $('list-hint').hidden = items.length === 0;
  $('list-hint').textContent = state.storeMode ? t('storeHint') : t('listHint');
  $('list-count').textContent = state.storeMode
    ? (items.length ? t('leftOfTotal', { left: left.length, total: items.length }) : '')
    : (left.length ? String(left.length) : '');
  $('list-title').textContent = state.storeMode ? t('inStore')
    : !SINGLE_LIST && state.lists.length > 1
      ? (state.lists.find((l) => l.id === state.listId)?.name || t('toBuy'))
      : t('toBuy');
  $('store-toggle').setAttribute('aria-pressed', String(state.storeMode));
  $('store-toggle').classList.toggle('primary', state.storeMode);
  $('store-toggle-label').textContent = state.storeMode ? t('leaveStore') : t('inStoreButton');
  renderActionLabel();
}

function renderActionLabel() {
  const n = cartItems().length;
  $('open-purchase').textContent = state.storeMode ? (n ? t('doneN', { n }) : t('done')) : t('recordPurchase');
}

// ---------- Store mode (per phone) ----------
// Tap = into the cart; no editing or deleting by accident; the screen stays on
const STORE_MODE_HOURS = 6;
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or refused: the app works the same */ }
}
document.addEventListener('visibilitychange', () => { if (state.storeMode) keepAwake(true); });

const saveCart = () => saveJSON('cart', [...state.cart]);

// Leaving store mode empties the cart: nothing carries over to the list screen
function setStoreMode(on, { restore = false } = {}) {
  state.storeMode = on;
  state.cartFolded = undefined;
  if (!restore) state.cart = new Set();
  saveCart();
  storageSet('storeMode', on ? (restore ? storageGet('storeMode') : String(Date.now())) : '');
  document.body.classList.toggle('store-mode', on);
  keepAwake(on);
  if (on && !restore) pickSong();
  renderSong();
  renderItems();
}

function enterStore(firstId) {
  setStoreMode(true);
  if (firstId) {
    state.cart.add(firstId);
    saveCart();
    renderItems();
  }
  const bar = document.querySelector('.topbar').offsetHeight + ($('net-banner').hidden ? 0 : $('net-banner').offsetHeight);
  window.scrollTo({ top: $('list-title').getBoundingClientRect().top + window.scrollY - bar - 16, behavior: 'smooth' });
}

$('store-toggle').addEventListener('click', () => (state.storeMode ? setStoreMode(false) : enterStore()));

// ---------- A song for the store (from songs.js, no AI) ----------
// A Hebrew app mixes Hebrew and English songs; any other language gets English only
const songPool = () => (LANG === 'he' ? SONGS : SONGS.filter((s) => !s.he));

// The list item a song is about, if any: "word*" is a word prefix, otherwise a whole word
function songMatch(song, items) {
  if (!song.tags) return null;
  for (const it of items) {
    const name = itemKey(it.name);
    const words = name.split(/[\s,.\-–]+/);
    for (const tag of song.tags) {
      const hit = tag.endsWith('*')
        ? words.some((w) => w.startsWith(tag.slice(0, -1)))
        : words.includes(tag) || (tag.includes(' ') && name.includes(tag));
      if (hit) return it;
    }
  }
  return null;
}

// Songs about something on the list come first, then the rest, each part shuffled
function pickSong() {
  const items = currentItems();
  const shuffle = (a) => {
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  };
  const pool = songPool().map((s) => ({ s, about: songMatch(s, items) }));
  const queue = [...shuffle(pool.filter((p) => p.about)), ...shuffle(pool.filter((p) => !p.about))];
  state.song = { queue: queue.map((p) => ({ i: SONGS.indexOf(p.s), about: p.about?.name || null })), at: 0 };
  saveJSON('song', state.song);
}

function renderSong() {
  const box = $('store-song');
  if (!state.storeMode) { box.hidden = true; return; }
  if (!state.song) state.song = loadJSON('song', null);
  if (!state.song?.queue?.length) pickSong();
  const cur = state.song.queue[state.song.at % state.song.queue.length];
  const song = SONGS[cur.i];
  if (!song) { box.hidden = true; return; }
  box.hidden = false;
  $('store-song-title').textContent = `${song.t} · ${song.a}`;
  $('store-song-why').textContent = cur.about ? t('songBecause', { name: cur.about }) : '';
  $('store-song-why').hidden = !cur.about;
  $('store-song-play').href = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${song.t} ${song.a}`)}`;
}

$('store-song-next').addEventListener('click', () => {
  if (!state.song) return;
  state.song.at += 1;
  saveJSON('song', state.song);
  renderSong();
});

// Store mode (and its cart) survives a reload in the store, but not until tomorrow
function restoreStoreMode() {
  const since = Number(storageGet('storeMode'));
  if (since && Date.now() - since < STORE_MODE_HOURS * 3600e3) {
    state.cart = new Set(loadJSON('cart', []));
    setStoreMode(true, { restore: true });
  } else if (since) {
    setStoreMode(false);
  }
}

function setInCart(li, on) {
  const id = Number(li.dataset.id);
  const tick = li.querySelector('.tick');
  tick.checked = on;
  if (on) stamp(tick);
  // A moment to see the tick land before the row moves to the cart
  li.dataset.moving = '1';
  setTimeout(() => {
    if (on) state.cart.add(id);
    else state.cart.delete(id);
    saveCart();
    renderItems();
  }, on ? 280 : 0);
}

// The seal "stamps" only on the tick that was just pressed, not on re-renders
function stamp(input) {
  input.classList.remove('stamp');
  void input.offsetWidth;
  input.classList.add('stamp');
  input.addEventListener('animationend', () => input.classList.remove('stamp'), { once: true });
}

function deleteItems(ids) {
  const names = state.items.filter((i) => ids.includes(i.id)).map((i) => i.name);
  const op = enqueue({ type: 'deleteItems', ids });
  toast(ids.length === 1 ? t('itemDeleted', { name: names[0] }) : t('itemsDeleted', { n: ids.length }), { run: () => undoOp(op) });
}

$('items').addEventListener('click', (e) => {
  if (e.target.closest('[data-cart-fold]')) {
    state.cartFolded = !e.target.closest('.cart-sec').classList.contains('folded');
    renderItems();
    return;
  }
  const li = e.target.closest('.item');
  if (!li || li.dataset.swiped || li.dataset.moving) return;
  const id = Number(li.dataset.id);
  if (state.storeMode) {
    // The whole row is one big tick; the checkbox itself already flipped
    const tick = li.querySelector('.tick');
    return setInCart(li, e.target === tick ? tick.checked : !tick.checked);
  }
  if (e.target.closest('[data-delete]')) return deleteItems([id]);
  if (e.target.closest('[data-edit]')) return openItemModal(state.items.find((i) => i.id === id));
  // Ticking something means you're shopping: switch to store mode with it in the cart
  if (e.target.matches('.tick')) {
    e.target.checked = false;
    enterStore(id);
    toast(t('switchedToStore'));
  }
});

// Swipe right to tick, swipe left to delete
(function swipe() {
  const THRESHOLD = 80;
  let s = null;
  const list = $('items');
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('.item');
    if (!li || e.button !== 0 || e.target.closest('button')) return;
    s = { li, x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId };
  });
  list.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
      if (Math.abs(dx) < 10) return;
      s.active = true;
      s.li.setPointerCapture(e.pointerId);
      s.li.classList.add('dragging');
    }
    s.dx = dx;
    s.li.style.transform = `translateX(${dx}px)`;
    s.li.dataset.swipe = dx > THRESHOLD ? 'tick' : dx < -THRESHOLD && !state.storeMode ? 'delete' : '';
  });
  const end = () => {
    if (!s) return;
    const { li, dx, active } = s;
    s = null;
    if (!active) return;
    li.classList.remove('dragging');
    li.style.transform = '';
    delete li.dataset.swipe;
    // the click that follows a drag must not open the editor
    li.dataset.swiped = '1';
    setTimeout(() => delete li.dataset.swiped, 50);
    if (li.dataset.moving) return;
    if (dx > THRESHOLD && state.storeMode) setInCart(li, !li.querySelector('.tick').checked);
    else if (dx > THRESHOLD) { enterStore(Number(li.dataset.id)); toast(t('switchedToStore')); }
    else if (dx < -THRESHOLD && !state.storeMode) deleteItems([Number(li.dataset.id)]);
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}());

// ---------- Adding items, with suggestions ----------
// "eggs x2", "eggs 2", "2x eggs" -> name + quantity
function parseEntry(text) {
  const t = text.trim();
  let m = /^(.*?)\s*[x×*]\s*(\d{1,2})$/i.exec(t) || /^(.*?)\s+(\d{1,2})$/.exec(t);
  if (m && m[1]) return { name: m[1].trim(), quantity: Number(m[2]) };
  m = /^(\d{1,2})\s*[x×*]?\s+(.+)$/i.exec(t);
  if (m) return { name: m[2].trim(), quantity: Number(m[1]) };
  return { name: t, quantity: 1 };
}

function queueItem({ name, quantity = 1, note = null, listId = state.listId }) {
  tempId -= 1;
  storageSet('tempId', String(-tempId));
  const op = enqueue({
    type: 'addItem',
    tempId,
    body: { name, quantity, note, list_id: listId, added_by: state.me?.id, client_uid: uid() },
  });
  // Learn the name right away so suggestions work offline too
  const key = itemKey(name);
  const known = state.catalog.find((c) => c.key === key);
  if (known) known.uses += 1;
  else state.catalog.unshift({ key, name, section: null, list_id: listId, uses: 1 });
  return op;
}

function addItem(text) {
  const { name, quantity } = parseEntry(text);
  if (!name) return;
  const dup = currentItems().find((i) => itemKey(i.name) === itemKey(name));
  const op = queueItem({ name, quantity });
  if (dup) {
    toast(t('alreadyOnListNow', { name: dup.name, n: Math.min(99, (dup.quantity || 1) + quantity) }), { run: () => undoOp(op) });
  }
}

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('add-name');
  if (!input.value.trim()) return;
  addItem(input.value);
  input.value = '';
  hideSuggest();
  input.focus();
});

function hideSuggest() {
  $('suggest').hidden = true;
  $('add-name').setAttribute('aria-expanded', 'false');
}

function renderSuggest() {
  const { name } = parseEntry($('add-name').value);
  const q = itemKey(name);
  if (!q) return hideSuggest();
  const onList = new Set(currentItems().map((i) => itemKey(i.name)));
  const rank = (c) => (c.key.startsWith(q) ? 0 : c.key.split(' ').some((w) => w.startsWith(q)) ? 1 : 2);
  const hits = state.catalog
    .filter((c) => c.key.includes(q) && c.key !== q && !onList.has(c.key))
    .sort((a, b) => rank(a) - rank(b) || (b.list_id === state.listId) - (a.list_id === state.listId) || b.uses - a.uses)
    .slice(0, 6);
  if (!hits.length) return hideSuggest();
  $('suggest').innerHTML = hits.map((c) => `
    <li role="option">
      <button type="button" class="suggest-pick" data-name="${esc(c.name)}">${esc(c.name)}</button>
      <button type="button" class="icon-btn suggest-forget" data-forget="${esc(c.key)}" aria-label="${esc(t('stopSuggesting', { name: c.name }))}">${icon('x')}</button>
    </li>`).join('');
  $('suggest').hidden = false;
  $('add-name').setAttribute('aria-expanded', 'true');
}

$('add-name').addEventListener('input', renderSuggest);
$('add-name').addEventListener('blur', () => setTimeout(hideSuggest, 200));
$('suggest').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
$('suggest').addEventListener('click', (e) => {
  const forget = e.target.closest('[data-forget]');
  if (forget) {
    const key = forget.dataset.forget;
    state.catalog = state.catalog.filter((c) => c.key !== key);
    api(`/api/catalog/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
    return renderSuggest();
  }
  const pick = e.target.closest('[data-name]');
  if (!pick) return;
  const { quantity } = parseEntry($('add-name').value);
  addItem(quantity > 1 ? `${pick.dataset.name} ×${quantity}` : pick.dataset.name);
  $('add-name').value = '';
  hideSuggest();
});

// ---------- Item editor ----------
function openItemModal(item) {
  if (!item) return;
  state.editItem = { ...item };
  $('i-name').value = item.name;
  $('i-qty').textContent = item.quantity || 1;
  $('i-note').value = item.note || '';
  $('i-section').innerHTML = `<option value="">${t('sortAutomatically')}</option>`
    + state.sections.map(([k, he]) => `<option value="${k}" ${k === item.section ? 'selected' : ''}>${esc(he)}</option>`).join('');
  $('i-list-field').hidden = SINGLE_LIST;
  $('i-list-pick').innerHTML = state.lists.map((l) => `<option value="${l.id}" ${l.id === item.list_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  $('i-prices').hidden = true;
  openModal($('item-modal'));
  if (state.online) {
    api(`/api/prices?name=${encodeURIComponent(item.name)}`).then((rows) => {
      if (!rows.length || state.editItem?.id !== item.id) return;
      $('i-prices-list').innerHTML = rows.slice(0, 6).map((r) => `
        <li><span class="num">${money.format(r.price)}</span>
          <span>${esc(r.store || '—')} · ${shortDate.format(new Date(r.purchased_at))}</span>
          <span class="line-name">${esc(r.name)}</span></li>`).join('');
      $('i-prices').hidden = false;
    }).catch(() => {});
  }
}

$('item-form').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (!step) return;
  const q = Math.max(1, Math.min(99, Number($('i-qty').textContent) + Number(step.dataset.step)));
  $('i-qty').textContent = q;
});

$('item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const it = state.editItem;
  const name = $('i-name').value.trim();
  if (!name) return;
  const body = {
    name,
    quantity: Number($('i-qty').textContent),
    note: $('i-note').value.trim() || null,
    list_id: Number($('i-list-pick').value),
  };
  if ($('i-section').value) body.section = $('i-section').value;
  enqueue({ type: 'patchItem', itemId: it.id, body });
  closeModal($('item-modal'));
});

$('i-delete').addEventListener('click', () => {
  const id = state.editItem.id;
  closeModal($('item-modal'));
  deleteItems([id]);
});

// ---------- Modals ----------
function openModal(modal) {
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.hidden = true;
  if (modal.id === 'purchase-modal') { state.draft?.reading?.abort(); state.draft = null; }
  if (modal.id === 'item-modal') state.editItem = null;
  if (modal.id === 'import-modal') { state.importDraft?.reading?.abort(); state.importDraft = null; }
  if (modal.id === 'saved-modal') state.savedOpen = null;
  if (modal.id === 'saved-edit-modal') state.savedEdit = null;
  if (modal.id === 'camera-modal') camera.stop();
  if ([...document.querySelectorAll('.modal')].every((m) => m.hidden)) document.body.style.overflow = '';
}

document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || (e.target === modal && !['who-modal', 'setup-modal'].includes(modal.id))) closeModal(modal);
  });
});

// ---------- Recording / editing a purchase ----------
function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fillPurchaseSelects(buyerId, category) {
  $('p-buyer').innerHTML = state.people
    .map((p) => `<option value="${p.id}" ${p.id === buyerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('p-category').innerHTML = state.categories
    .map(([k, he]) => `<option value="${k}" ${k === category ? 'selected' : ''}>${esc(he)}</option>`).join('');
}

// fromList: opened from the list (ticked items pre-selected); otherwise a standalone purchase (e.g. a TV)
function openPurchase({ fromList = true, cartIds = [] } = {}) {
  if (!state.me) return openWhoModal();
  state.draft?.reading?.abort();
  state.draft = {
    editId: null,
    receiptFile: null,
    photoBlob: null,
    aiParsed: false,
    aiMatched: new Map(),
    lines: [],
    linesKind: null,
    editingLine: null,
    // What was in the cart is what was bought; the receipt can add to it
    cartIds: new Set(cartIds),
    checked: new Set(cartIds),
  };
  $('purchase-form').reset();
  $('purchase-title').textContent = fromList ? t('recordPurchase') : t('newPurchase');
  fillPurchaseSelects(state.me.id, 'groceries');
  $('p-date').value = todayStr();
  $('receipt-box').hidden = false;
  $('photo-kind').hidden = !state.aiEnabled;
  $('receipt-preview').hidden = true;
  $('receipt-preview').removeAttribute('src');
  setStatus(null);
  $('receipt-read').hidden = true;
  readBusy('receipt-read', null);
  $('photo-camera').classList.add('primary');
  $('p-items-field').hidden = !fromList && !state.items.length;
  $('p-lines').open = false;
  $('p-line-add-name').value = '';
  $('p-monster-line').hidden = !state.aiEnabled;
  applyPhotoKind();
  openModal($('purchase-modal'));
}

function openEditPurchase(p) {
  if (!requireOnline()) return;
  state.draft = { editId: p.id, checked: new Set(), aiMatched: new Map(), lines: [], allowZero: p.total === 0 };
  $('purchase-form').reset();
  setTotalRequired(p.total !== 0);
  $('purchase-title').textContent = t('editPurchase');
  fillPurchaseSelects(p.buyer_id, p.category);
  $('p-total').value = p.total.toFixed(2);
  $('p-store').value = p.store || '';
  $('p-note').value = p.note || '';
  $('p-date').value = todayStr(new Date(p.purchased_at));
  $('receipt-box').hidden = true;
  $('p-items-field').hidden = true;
  $('p-lines').hidden = true;
  $('p-monster-line').hidden = true;
  openModal($('purchase-modal'));
}

// "Done" hands the cart to the purchase sheet once, then leaves store mode (the cart is emptied)
$('open-purchase').addEventListener('click', () => {
  const cartIds = cartItems().map((i) => i.id);
  if (state.storeMode) setStoreMode(false);
  openPurchase({ fromList: true, cartIds });
});
$('new-purchase').addEventListener('click', () => openPurchase({ fromList: false }));

function renderPickItems() {
  const d = state.draft;
  if (!d || d.editId) return;
  const products = d.linesKind === 'products';
  // Current list first; other lists below, since one receipt can cover several lists
  const lists = [...state.lists].sort((a, b) => (b.id === state.listId) - (a.id === state.listId));
  const groups = lists
    .map((l) => ({ l, items: state.items.filter((i) => i.list_id === l.id) }))
    .filter((g) => g.items.length);
  $('p-items').innerHTML = groups.map(({ l, items }) => `
    ${groups.length > 1 ? `<h4 class="pick-list-title">${esc(l.name)}</h4>` : ''}
    <ul class="pick-items">${items.map((i) => {
      const m = d.aiMatched.get(i.id);
      let match = '';
      if (!m && d.aiParsed && d.cartIds?.has(i.id) && d.checked.has(i.id)) {
        match = `<span class="match-line warn">${esc(t(products ? 'fromCartNotInPhoto' : 'fromCartNotOnReceipt'))}</span>`;
      } else if (m) {
        const was = i.last_price != null && m.price != null && Math.abs(i.last_price - m.price) >= 0.01
          ? t('lastTimeParen', { price: money.format(i.last_price) }) : '';
        match = `<span class="match-line">${esc(t(products ? 'inPhoto' : 'onReceipt', { line: m.line }))}${m.price != null ? ` · ${money.format(m.price)}` : ''}${was}</span>`;
      }
      return `<li><label>
        <input type="checkbox" class="tick" value="${i.id}" ${d.checked.has(i.id) ? 'checked' : ''}>
        <span class="pick-text"><span>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}</span>${match}</span>
      </label></li>`;
    }).join('')}</ul>`).join('');
  const n = d.aiMatched.size;
  // Cart items the reading didn't find stay ticked (receipts abbreviate), but are pointed out
  const missing = d.aiParsed ? [...d.checked].filter((id) => d.cartIds?.has(id) && !d.aiMatched.has(id)) : [];
  const parts = [];
  if (!d.aiParsed && d.cartIds?.size) parts.push(t('cartTicked', { n: d.cartIds.size }));
  if (n) parts.push(t(products ? 'tickedFromPhoto' : 'tickedFromReceipt', { n }));
  if (missing.length) parts.push(t(products ? 'cartMissingPhoto' : 'cartMissingReceipt', { n: missing.length }));
  else if (n) parts.push(t('untickIfWrong'));
  $('p-items-hint').hidden = parts.length === 0;
  $('p-items-hint').classList.toggle('warn', missing.length > 0);
  $('p-items-hint').textContent = parts.join(' ');
  $('p-items-empty').hidden = groups.length > 0;
}

// What the photo is of: a receipt, or the groceries themselves (no receipt, or a gift)
const photoKind = () => document.querySelector('input[name=photo-kind]:checked').value;
const KIND_TEXT = {
  receipt: { camera: 'takeReceipt', alt: 'receiptPhotoAlt', go: 'readReceipt', basic: 'readBasic', strong: 'readStrong', hint: 'readHintReceipt', ready: 'photoStagedAi' },
  products: { camera: 'takeProducts', alt: 'productsPhotoAlt', go: 'readProductsGo', basic: 'productsBasic', strong: 'productsStrong', hint: 'productsStrongHint', ready: 'productsStaged' },
};

function setTotalRequired(required) {
  $('p-total').required = required;
  $('p-total').placeholder = required ? '0.00' : t('optional');
}

function applyPhotoKind() {
  const d = state.draft;
  if (!d || d.editId) return;
  const txt = KIND_TEXT[photoKind()];
  $('photo-camera-label').textContent = d.photoBlob ? t('retake') : t(txt.camera);
  $('receipt-preview').alt = t(txt.alt);
  $('receipt-read-go').textContent = t(txt.go);
  $('receipt-read-hint').textContent = t(txt.hint);
  const [basic, strong] = document.querySelectorAll('#receipt-read .segmented span');
  basic.textContent = t(txt.basic);
  strong.textContent = t(txt.strong);
  // Groceries someone gave you cost nothing, so the amount is optional here
  d.allowZero = photoKind() === 'products';
  setTotalRequired(!d.allowZero);
  if (d.photoBlob && !d.aiParsed && !d.reading && state.aiEnabled) setStatus(t(txt.ready));
  renderPickItems();
  renderLines();
}

function renderLines() {
  const d = state.draft;
  const lines = d?.lines || [];
  const products = Boolean(d && !d.editId) && (lines.length ? d.linesKind === 'products' : photoKind() === 'products');
  $('p-lines').hidden = !lines.length && !products;
  $('p-line-add').hidden = !products;
  if (products) $('p-lines').open = true;
  if (!lines.length && !products) return;
  $('p-lines-summary').textContent = products
    ? (lines.length ? t('productsN', { n: lines.length }) : t('products'))
    : t('receiptLines', { n: lines.length });
  $('p-lines-list').innerHTML = lines.map((l, idx) => {
    if (d.editingLine === idx) {
      return `<li class="line-edit">
        <input type="text" data-line-name aria-label="${t('productName')}" placeholder="${t('productName')}" value="${esc(l.name)}" enterkeyhint="done">
        ${l.price == null ? `<input type="text" inputmode="numeric" data-line-qty aria-label="${t('quantity')}" value="${l.quantity || 1}" enterkeyhint="done">` : ''}
        <button type="button" class="icon-btn" data-line-done aria-label="${t('finishEditing')}">${icon('check')}</button>
      </li>`;
    }
    const qty = l.quantity > 1 ? ` <span class="qty num">×${l.quantity}</span>` : '';
    return `<li>
      <span class="line-name">${esc(l.name)}${qty}</span>
      ${l.price != null ? `<span class="num">${money.format(l.price)}</span>` : ''}
      <button type="button" class="icon-btn" data-line-edit="${idx}" aria-label="${esc(t('fixAria', { name: l.name }))}">${icon('pen')}</button>
      <button type="button" class="icon-btn" data-line-remove="${idx}" aria-label="${esc(t('removeAria', { name: l.name }))}">${icon('x')}</button>
    </li>`;
  }).join('');
  if (d.editingLine != null) {
    const input = $('p-lines-list').querySelector('[data-line-name]');
    input?.focus();
    input?.select();
  }
}

// A product typed or corrected by hand ticks the list item with the same name
function linkLineToList(line) {
  const d = state.draft;
  if (line.item_id) return;
  const taken = new Set(d.lines.map((l) => l.item_id).filter(Boolean));
  const hit = state.items.find((i) => itemKey(i.name) === itemKey(line.name) && !taken.has(i.id));
  if (!hit) return;
  line.item_id = hit.id;
  d.aiMatched.set(hit.id, { line: line.name, price: line.price ?? null });
  d.checked.add(hit.id);
}

function commitLineEdit({ cancel = false } = {}) {
  const d = state.draft;
  if (d?.editingLine == null) return;
  const row = $('p-lines-list').querySelector('.line-edit');
  const line = d.lines[d.editingLine];
  if (row && line && !cancel) {
    const name = row.querySelector('[data-line-name]').value.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name) line.name = name;
    const qtyInput = row.querySelector('[data-line-qty]');
    if (qtyInput) {
      const q = parseInt(qtyInput.value.replace(/[^\d]/g, ''), 10);
      line.quantity = Number.isFinite(q) && q > 0 ? Math.min(q, 99) : 1;
    }
    if (line.item_id && d.aiMatched.has(line.item_id)) d.aiMatched.get(line.item_id).line = line.name;
    linkLineToList(line);
  }
  d.editingLine = null;
  renderLines();
  renderPickItems();
}

function removeLine(idx) {
  const d = state.draft;
  const [line] = d.lines.splice(idx, 1);
  if (line?.item_id) {
    d.aiMatched.delete(line.item_id);
    d.checked.delete(line.item_id);
  }
  renderLines();
  renderPickItems();
}

function addLine() {
  const d = state.draft;
  const input = $('p-line-add-name');
  const name = input.value.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!d || !name) return input.focus();
  commitLineEdit();
  if (!d.lines.length) d.linesKind = 'products';
  const line = { name, price: null, quantity: 1, item_id: null };
  d.lines.push(line);
  linkLineToList(line);
  input.value = '';
  renderLines();
  renderPickItems();
  input.focus();
}

$('p-lines-list').addEventListener('click', (e) => {
  const d = state.draft;
  if (!d) return;
  const edit = e.target.closest('[data-line-edit]');
  const remove = e.target.closest('[data-line-remove]');
  if (edit) {
    commitLineEdit();
    d.editingLine = Number(edit.dataset.lineEdit);
    renderLines();
  } else if (remove) {
    commitLineEdit();
    removeLine(Number(remove.dataset.lineRemove));
  } else if (e.target.closest('[data-line-done]')) {
    commitLineEdit();
  }
});
$('p-lines-list').addEventListener('keydown', (e) => {
  if (!e.target.closest('.line-edit')) return;
  if (e.key === 'Enter') { e.preventDefault(); commitLineEdit(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitLineEdit({ cancel: true }); }
});
$('p-line-add-go').addEventListener('click', addLine);
$('p-line-add-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addLine(); }
});
document.querySelectorAll('input[name=photo-kind]').forEach((r) => r.addEventListener('change', applyPhotoKind));

$('p-items').addEventListener('change', (e) => {
  if (!state.draft || !e.target.matches('input[type=checkbox]')) return;
  const id = Number(e.target.value);
  if (e.target.checked) {
    state.draft.checked.add(id);
    stamp(e.target);
  } else {
    state.draft.checked.delete(id);
  }
});

function setStatus(text, kind = '', id = 'receipt-status') {
  const el = $(id);
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = text;
}

// Shrink the photo before upload: faster on mobile data, and normalizes iPhone HEIC to JPEG.
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(t('cantOpenImage')));
      im.src = url;
    });
    const MAX = 2400;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const readStrong = (prefix) => document.querySelector(`input[name=${prefix}-model]:checked`).value === 'strong';

// While reading: the read button turns into a cancel button and the choice is locked
function readBusy(prefix, controller) {
  $(`${prefix}-go`).hidden = Boolean(controller);
  $(`${prefix}-cancel`).hidden = !controller;
  document.querySelectorAll(`input[name=${prefix}-model]`).forEach((r) => { r.disabled = Boolean(controller); });
}

// A new photo is only attached; reading it is a separate step, after choosing basic or careful
async function handlePhoto(file) {
  if (!file || !state.draft) return;
  const draft = state.draft;
  draft.reading?.abort();
  try {
    const blob = await prepareImage(file);
    if (state.draft !== draft) return;
    Object.assign(draft, { photoBlob: blob, receiptFile: null });
    const preview = $('receipt-preview');
    if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    $('photo-camera').classList.remove('primary');
    $('photo-camera-label').textContent = t('retake');
    $('receipt-read').hidden = !state.aiEnabled;
    setStatus(state.aiEnabled ? t(KIND_TEXT[photoKind()].ready) : t('photoStagedNoAi'));
  } catch (err) {
    setStatus(t('cantOpenImageMsg', { msg: err.message }), 'warn');
  }
}

async function readReceiptPhoto() {
  const draft = state.draft;
  if (!draft?.photoBlob || draft.reading) return;
  const strong = readStrong('receipt-read');
  const kind = photoKind();
  const products = kind === 'products';
  const controller = new AbortController();
  draft.reading = controller;
  readBusy('receipt-read', controller);
  document.querySelectorAll('input[name=photo-kind]').forEach((r) => { r.disabled = true; });
  $('p-save').disabled = true;
  if (products) setStatus(strong ? t('readingProductsStrong') : t('readingProducts'), 'loading');
  else setStatus(strong ? t('readingReceiptStrong') : t('readingReceipt'), 'loading');
  const tryStrong = strong ? '' : products ? t('tryStrongProducts') : t('tryStrong');
  try {
    if (!draft.receiptFile) {
      const fd = new FormData();
      fd.append('photo', draft.photoBlob, products ? 'products.jpg' : 'receipt.jpg');
      draft.receiptFile = (await api('/api/receipt', { method: 'POST', body: fd, signal: controller.signal })).file;
    }
    const res = await api('/api/receipt/scan', { json: { file: draft.receiptFile, strong, kind }, signal: controller.signal });
    if (state.draft !== draft) return;
    if (res.ai) {
      applyAiResult(res.ai, tryStrong);
    } else if (products) {
      const why = res.aiError === 'no_products' ? t('noProductsFound') : t('couldNotReadProducts');
      setStatus(t('addManually', { why, tip: tryStrong }), 'warn');
    } else {
      const why = res.aiError === 'not_a_receipt' ? t('notAReceiptProducts') : t('couldNotRead');
      setStatus(t('enterManually', { why, tip: tryStrong }), 'warn');
    }
  } catch (err) {
    if (state.draft !== draft) return;
    if (err.name === 'AbortError') setStatus(t(products ? 'productsCancelled' : 'readingCancelled'));
    else if (err instanceof OfflineError) setStatus(t(products ? 'offlineCantReadProducts' : 'offlineCantRead'), 'warn');
    else setStatus(t(products ? 'productsFailed' : 'readFailed', { msg: err.message }), 'warn');
  } finally {
    if (draft.reading === controller) draft.reading = null;
    if (state.draft === draft) {
      readBusy('receipt-read', null);
      document.querySelectorAll('input[name=photo-kind]').forEach((r) => { r.disabled = false; });
      $('p-save').disabled = false;
    }
  }
}

function applyAiResult(ai, tryStrong = '') {
  const d = state.draft;
  d.aiParsed = true;
  d.editingLine = null;
  if (ai.kind === 'products') {
    d.linesKind = 'products';
    // A new reading replaces the last one's ticks, but not ticks made by hand from the list
    for (const id of d.aiMatched.keys()) if (!d.cartIds.has(id)) d.checked.delete(id);
    const byLine = new Map(ai.matches.map((m) => [m.line_index, m.item_id]));
    d.lines = ai.items.map((it, idx) => ({ name: it.name, price: null, quantity: it.quantity || 1, item_id: byLine.get(idx) || null }));
    d.aiMatched = new Map(ai.matches.map((m) => [m.item_id, { line: m.receipt_line, price: null }]));
    for (const m of ai.matches) d.checked.add(m.item_id);
    renderPickItems();
    renderLines();
    const n = ai.items.length;
    const m = ai.matches.length;
    setStatus(t('productsFound', { found: t('productsFoundN', { n }), list: m ? t('fromListN', { n: m }) : '', tip: tryStrong }));
    $('p-lines').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  d.linesKind = 'receipt';
  if (ai.total != null) $('p-total').value = ai.total.toFixed(2);
  if (ai.store) $('p-store').value = ai.store;
  if (ai.date && /^\d{4}-\d{2}-\d{2}$/.test(ai.date)) $('p-date').value = ai.date;
  const byLine = new Map(ai.matches.map((m) => [m.line_index, m.item_id]));
  d.lines = ai.items.map((it, idx) => ({ name: it.name, price: it.price, item_id: byLine.get(idx) || null }));
  d.aiMatched = new Map(ai.matches.map((m) => [m.item_id, { line: m.receipt_line, price: ai.items[m.line_index]?.price ?? null }]));
  for (const m of ai.matches) d.checked.add(m.item_id);
  renderPickItems();
  renderLines();
  if (ai.total == null) setStatus(t('totalUnclear', { tip: tryStrong }), 'warn');
  else if (ai.problem) setStatus(t('sumsDontMatch', { tip: tryStrong }), 'warn');
  else setStatus(t('receiptRead'));
}

$('receipt-read-go').addEventListener('click', readReceiptPhoto);
$('receipt-read-cancel').addEventListener('click', () => state.draft?.reading?.abort());
$('photo-camera').addEventListener('click', () => camera.take().then(handlePhoto));
$('photo-gallery').addEventListener('change', (e) => { handlePhoto(e.target.files[0]); e.target.value = ''; });

$('purchase-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = state.draft;
  if (!d) return;
  commitLineEdit();
  const total = Number($('p-total').value.replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!Number.isFinite(total) || total < 0 || (total === 0 && !d.allowZero)) {
    toast(t('enterValidAmount'));
    return $('p-total').focus();
  }
  if (total === 0 && !d.editId && !d.checked.size && !d.lines.length) {
    toast(t('addSomething'));
    return $('p-line-add-name').focus();
  }
  const dateVal = $('p-date').value;
  const fields = {
    buyer_id: Number($('p-buyer').value),
    total,
    store: $('p-store').value,
    note: $('p-note').value,
    category: $('p-category').value,
    // Today keeps the exact time; another date is stored at local noon.
    purchased_at: !dateVal || dateVal === todayStr() ? undefined : new Date(`${dateVal}T12:00:00`).toISOString(),
  };

  if (d.editId) {
    $('p-save').disabled = true;
    try {
      await api(`/api/purchases/${d.editId}`, { method: 'PATCH', json: fields });
      closeModal($('purchase-modal'));
      toast(t('purchaseUpdated'));
      loadPurchases();
    } catch (err) {
      toast(err.message);
    } finally {
      $('p-save').disabled = false;
    }
    return;
  }

  const checked = [...d.checked];
  const op = {
    type: 'addPurchase',
    body: {
      ...fields,
      client_uid: uid(),
      receipt_file: d.receiptFile,
      ai_parsed: d.aiParsed,
      item_ids: checked,
      monster: $('p-monster').checked && (checked.length > 0 || d.lines.length > 0),
      theme: document.documentElement.dataset.theme,
      lines: d.lines.map((l) => ({
        name: l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name,
        price: l.price ?? null,
        item_id: l.item_id && d.checked.has(l.item_id) ? l.item_id : null,
      })),
    },
  };
  if (!d.receiptFile && d.photoBlob) {
    op.photoKey = op.body.client_uid;
    await photoStore.put(op.photoKey, d.photoBlob).catch(() => { op.photoKey = null; });
  }
  closeModal($('purchase-modal'));
  const queued = enqueue(op);
  const monster = op.body.monster ? t('monsterBuilding') : $('p-monster').checked ? t('monsterNothing') : '';
  toast(t('savedAmount', { amount: total === 0 ? t('noPayment') : money.format(total) }) + monster, { run: () => undoOp(queued) });
});

// ---------- Camera ----------
// Android Chrome opens the camera app from <input capture> only while Chrome itself holds the
// camera permission, and does nothing at all otherwise. The in-app camera asks for the permission
// and says how to fix it when blocked. iPhones keep the system camera, which works well there.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const camera = {
  stream: null,
  done: null,

  // Resolves with a photo, or null when closed without one
  take() {
    return new Promise((resolve) => {
      this.finish(null);
      this.done = resolve;
      if (isIOS || !navigator.mediaDevices?.getUserMedia) {
        $('camera-native').click();
        return;
      }
      openModal($('camera-modal'));
      this.start();
    });
  },

  async start() {
    $('camera-shoot').disabled = true;
    this.message(t('openingCamera'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      if ($('camera-modal').hidden) {
        stream.getTracks().forEach((t) => t.stop()); // closed while asking
        return;
      }
      this.stream = stream;
      $('camera-video').srcObject = stream;
      await $('camera-video').play().catch(() => {});
      this.message(null);
      $('camera-shoot').disabled = false;
    } catch (err) {
      this.fail(err);
    }
  },

  fail(err) {
    const text = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      ? t('cameraDenied')
      : err?.name === 'NotReadableError'
        ? t('cameraBusy')
        : t('cameraFailed');
    $('camera-msg').innerHTML = `<p>${esc(text)}</p>
      <div class="camera-msg-actions">
        <button type="button" class="btn" data-camera-retry>${icon('refresh')}${t('tryAgain')}</button>
        <button type="button" class="btn" data-camera-native>${icon('camera')}${t('cameraApp')}</button>
      </div>`;
    $('camera-msg').hidden = false;
  },

  message(text) {
    $('camera-msg').hidden = !text;
    if (text) $('camera-msg').innerHTML = `<p>${esc(text)}</p>`;
  },

  async shoot() {
    const video = $('camera-video');
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    $('camera-shoot').disabled = true;
    let photo = null;
    if ('ImageCapture' in window) {
      try { photo = await new ImageCapture(track).takePhoto(); } catch { /* use a video frame */ }
    }
    if (!photo) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    }
    this.finish(photo);
    closeModal($('camera-modal'));
  },

  finish(photo) {
    const done = this.done;
    this.done = null;
    if (done) done(photo);
  },

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    $('camera-video').srcObject = null;
    this.finish(null);
  },
};

$('camera-shoot').addEventListener('click', () => camera.shoot());
$('camera-msg').addEventListener('click', (e) => {
  if (e.target.closest('[data-camera-retry]')) camera.start();
  if (e.target.closest('[data-camera-native]')) $('camera-native').click();
});
function cameraFilePicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  camera.finish(file);
  if (!$('camera-modal').hidden) closeModal($('camera-modal'));
}
$('camera-native').addEventListener('change', cameraFilePicked);
$('camera-gallery').addEventListener('change', cameraFilePicked);

// ---------- Import a list: note photo, recipe link, or text ----------
const IMPORT_ERRORS = {
  not_configured: 'importErrNotConfigured',
  nothing_found: 'importErrNothing',
  bad_address: 'importErrBadAddress',
  page_unreachable: 'importErrUnreachable',
  page_blocked: 'importErrBlocked',
};

// Unticked by default: already on the list, or something most kitchens have
const importOn = (it) => it.checked ?? (!it.staple && !it.already);
const importDest = () => document.querySelector('input[name=import-dest]:checked').value;
const onListKeys = () => new Set(currentItems().map((i) => itemKey(i.name)));

// dest: 'list' or 'saved' (the Saved tab opens it straight on saving)
function openImport({ dest = 'list' } = {}) {
  if (!state.me) return openWhoModal();
  if (!requireOnline()) return;
  state.importDraft = { items: [], title: null, preset: dest, photo: null };
  $('import-text').value = '';
  setImportPhoto(null);
  readBusy('import-read', null);
  document.querySelector('input[name=import-read-model][value=basic]').checked = true;
  $('import-result').hidden = true;
  $('import-save').disabled = true;
  $('import-save').textContent = dest === 'saved' ? t('saveToSaved') : t('addToList');
  setStatus(null, '', 'import-status');
  openModal($('import-modal'));
}

async function runImport(source) {
  const draft = state.importDraft;
  if (!draft || draft.reading || (!source.photo && !source.text)) return;
  const controller = new AbortController();
  const busy = (on) => {
    draft.reading = on ? controller : null;
    if (state.importDraft !== draft) return;
    readBusy('import-read', on ? controller : null);
    $('import-camera').disabled = on;
    $('import-save').disabled = on || !draft.items.length;
  };
  const strong = readStrong('import-read');
  busy(true);
  setStatus(source.photo
    ? (strong ? t('readingNoteStrong') : t('readingNote'))
    : /https?:\/\//i.test(source.text) ? t('readingPage') : t('reading'), 'loading', 'import-status');
  try {
    let res;
    if (source.photo) {
      const fd = new FormData();
      fd.append('photo', await prepareImage(source.photo), 'note.jpg');
      if (strong) fd.append('strong', '1');
      res = await api('/api/import', { method: 'POST', body: fd, signal: controller.signal });
    } else {
      res = await api('/api/import', { json: { text: source.text, strong }, signal: controller.signal });
    }
    if (state.importDraft !== draft) return;
    showImport(res);
  } catch (err) {
    if (state.importDraft !== draft) return;
    if (err.name === 'AbortError') return setStatus(t('readCancelled'), '', 'import-status');
    let msg = IMPORT_ERRORS[err.message] ? t(IMPORT_ERRORS[err.message])
      : err instanceof OfflineError ? t('importOffline') : t('readFailed', { msg: err.message });
    if (err.message === 'nothing_found' && source.photo && !strong) msg += t('tryStrong');
    setStatus(msg, 'warn', 'import-status');
  } finally {
    busy(false);
  }
}

function showImport(res) {
  const d = state.importDraft;
  Object.assign(d, { title: res.title, servings: res.servings, source: res.source, url: res.source_url || null });
  d.items = res.items.map((it) => ({ ...it, checked: null }));
  d.editing = null;
  // A recipe is usually worth keeping; a note or text is usually for this shop
  const recipe = res.source === 'recipe' || res.source === 'page';
  const dest = d.preset === 'saved' || recipe ? 'saved' : 'list';
  document.querySelector(`input[name=import-dest][value=${dest}]`).checked = true;
  setStatus(t('foundN', { n: d.items.length, title: res.title ? ` · ${res.title}` : '' }), '', 'import-status');
  $('import-result').hidden = false;
  renderImport();
  $('import-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderImport() {
  const d = state.importDraft;
  const saving = importDest() === 'saved';
  const onList = onListKeys();
  for (const it of d.items) it.already = onList.has(itemKey(it.name));
  // Saving keeps every ingredient; the ticks matter when it is later added to the list
  $('import-items').innerHTML = d.items.map((it, idx) => {
    if (d.editing === idx) {
      return `<li class="ing-row import-edit">
        <input type="text" class="ing-name" data-edit-name aria-label="${t('productName')}" placeholder="${t('productName')}" value="${esc(it.name)}" enterkeyhint="done">
        <input type="text" class="ing-amount" data-edit-note aria-label="${t('note')}" placeholder="${t('note')}" value="${esc(it.note || '')}" enterkeyhint="done">
        <button type="button" class="icon-btn" data-edit-done aria-label="${t('finishEditing')}">${icon('check')}</button>
      </li>`;
    }
    const meta = [it.note, !saving && it.already && t('alreadyOnList'), it.staple && t('usuallyAtHome')].filter(Boolean).join(' · ');
    return `<li class="${!saving && it.already ? 'already' : ''}"><label>
      <input type="checkbox" class="tick" value="${idx}" ${saving || importOn(it) ? 'checked' : ''} ${saving ? 'disabled' : ''}>
      <span class="pick-text"><span>${esc(it.name)}${it.quantity > 1 ? ` <span class="qty num">×${it.quantity}</span>` : ''}</span>${meta ? `<span class="match-line">${esc(meta)}</span>` : ''}</span>
    </label><button type="button" class="icon-btn" data-edit-import="${idx}" aria-label="${esc(t('fixAria', { name: it.name }))}">${icon('pen')}</button></li>`;
  }).join('');
  renderImportCount();
  if (d.editing != null) {
    const input = $('import-items').querySelector('[data-edit-name]');
    input.focus();
    input.select();
  }
}

// Fix a misread name or note before adding; an empty name keeps the old one
function commitImportEdit({ cancel = false } = {}) {
  const d = state.importDraft;
  if (d?.editing == null) return;
  const row = $('import-items').querySelector('.import-edit');
  const it = d.items[d.editing];
  if (row && !cancel) {
    const name = row.querySelector('[data-edit-name]').value.trim().replace(/\s+/g, ' ');
    if (name) it.name = name.slice(0, 80);
    it.note = row.querySelector('[data-edit-note]').value.trim().slice(0, 120) || null;
  }
  d.editing = null;
  renderImport();
}

$('import-items').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit-import]');
  if (edit) {
    commitImportEdit();
    state.importDraft.editing = Number(edit.dataset.editImport);
    renderImport();
  } else if (e.target.closest('[data-edit-done]')) {
    commitImportEdit();
  }
});
$('import-items').addEventListener('keydown', (e) => {
  if (!e.target.closest('.import-edit')) return;
  if (e.key === 'Enter') { e.preventDefault(); commitImportEdit(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitImportEdit({ cancel: true }); }
});

function renderImportCount() {
  const d = state.importDraft;
  if (importDest() === 'saved') {
    $('import-count').textContent = t('itemsWillBeSaved', { n: d.items.length });
    $('import-hint').hidden = false;
    $('import-hint').textContent = t('pickLaterHint');
    $('import-save').textContent = t('continueSaving');
    $('import-save').disabled = !d.items.length;
    return;
  }
  const n = d.items.filter(importOn).length;
  const skipped = d.items.filter((it) => it.checked === null && (it.staple || it.already)).length;
  $('import-count').textContent = t('whatToAddN', { n, total: d.items.length });
  $('import-hint').hidden = !skipped;
  $('import-hint').textContent = t('skippedHint');
  $('import-save').textContent = n ? t('addToListN', { n }) : t('addToList');
  $('import-save').disabled = !n;
}

$('open-import').addEventListener('click', () => openImport());
// A photo is attached first; it is read only when "Read" is pressed, so the reading can be chosen
function setImportPhoto(file) {
  const d = state.importDraft;
  if (d) d.photo = file;
  const img = $('import-preview');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (file) img.src = URL.createObjectURL(file);
  else img.removeAttribute('src');
  $('import-photo').hidden = !file;
  $('import-text').hidden = Boolean(file);
  $('import-camera').classList.toggle('primary', !file);
  $('import-camera-label').textContent = file ? t('retake') : t('takeNote');
  updateImportReady();
}
function updateImportReady() {
  $('import-read-go').disabled = !state.importDraft?.photo && !$('import-text').value.trim();
}
function attachImportPhoto(file) {
  if (!file || !state.importDraft) return;
  state.importDraft.reading?.abort();
  setImportPhoto(file);
  setStatus(t('chooseReadingAndTap'), '', 'import-status');
}

$('import-camera').addEventListener('click', () => camera.take().then(attachImportPhoto));
$('import-gallery').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  attachImportPhoto(file);
});
$('import-photo-remove').addEventListener('click', () => {
  state.importDraft?.reading?.abort();
  setImportPhoto(null);
  setStatus(null, '', 'import-status');
});
$('import-text').addEventListener('input', updateImportReady);
$('import-read-go').addEventListener('click', () => {
  const d = state.importDraft;
  if (d?.photo) runImport({ photo: d.photo });
  else runImport({ text: $('import-text').value.trim() });
});
$('import-read-cancel').addEventListener('click', () => state.importDraft?.reading?.abort());
document.querySelectorAll('input[name=import-dest]').forEach((r) => r.addEventListener('change', () => (
  state.importDraft?.editing != null ? commitImportEdit() : renderImport())));
$('import-items').addEventListener('change', (e) => {
  if (!e.target.matches('input[type=checkbox]')) return;
  state.importDraft.items[Number(e.target.value)].checked = e.target.checked;
  if (e.target.checked) stamp(e.target);
  renderImportCount();
});

$('import-form').addEventListener('submit', (e) => {
  e.preventDefault();
  commitImportEdit();
  const d = state.importDraft;
  if (!d?.items.length) return;
  if (importDest() === 'saved') {
    const recipe = d.source === 'recipe' || d.source === 'page';
    closeModal($('import-modal'));
    openSavedEditor({
      kind: recipe || d.servings ? 'recipe' : 'batch',
      name: d.title || '',
      source_url: d.url,
      servings: d.servings,
      items: d.items.map((it) => ({ name: it.name, amount: it.note, quantity: it.quantity, staple: it.staple })),
    });
    return;
  }
  const picked = d.items.filter(importOn);
  if (!picked.length) return;
  const ops = picked.map((it) => queueItem({ name: it.name, quantity: it.quantity, note: it.note }));
  closeModal($('import-modal'));
  applyLocal();
  toast(t('addedNToList', { n: ops.length }), { run: () => ops.forEach(undoOp) });
});

// ---------- Saved recipes and recurring batches ----------

function sinceText(iso) {
  if (!iso) return t('neverAdded');
  const days = Math.round((new Date(iso) - Date.now()) / 86400000);
  return t('addedAgo', { when: relTime.format(days, 'day') });
}

// "2 cups" for 4 servings becomes "4 cups" for 8; fractions like 1/2 too
function scaleAmount(text, factor) {
  if (!text || factor === 1) return text;
  return text.replace(/(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?/g, (m, a, b) => {
    const v = (b ? Number(a) / Number(b) : Number(a.replace(',', '.'))) * factor;
    return String(v >= 10 ? Math.round(v) : Math.round(v * 4) / 4);
  });
}

async function loadSaved() {
  try {
    state.saved = await api('/api/saved');
    saveSnapshot();
  } catch (err) {
    if (!(err instanceof OfflineError)) console.error(err);
  }
  renderSaved();
}

function savedRow(s) {
  const meta = [
    t('nItems', { n: s.items.length }),
    s.kind === 'recipe' && s.servings && t('nServings', { n: s.servings }),
    sinceText(s.last_used),
  ].filter(Boolean).join(' · ');
  return `<li><button type="button" class="saved-row" data-saved="${s.id}">
    <span class="saved-row-text"><span class="saved-row-name">${esc(s.name)}</span><span class="item-meta">${esc(meta)}</span></span>
    <span class="flip-rtl">${icon('chev-r')}</span>
  </button></li>`;
}

function renderSaved() {
  const groups = [['recipe', t('recipes')], ['batch', t('regularShops')]]
    .map(([kind, title]) => ({ title, sets: state.saved.filter((s) => s.kind === kind) }))
    .filter((g) => g.sets.length);
  $('saved-list').innerHTML = groups.map((g) => `
    <section class="sec">
      <h3 class="sec-title">${g.title}</h3>
      <ul class="items saved-rows">${g.sets.map(savedRow).join('')}</ul>
    </section>`).join('');
  $('saved-empty').hidden = state.saved.length > 0;
}

const savedOn = (it) => it.checked ?? (!it.staple && !it.already);

function openSaved(set) {
  if (!set) return;
  const onList = onListKeys();
  state.savedOpen = {
    set,
    servings: set.servings || null,
    items: set.items.map((it) => ({ ...it, checked: null, already: onList.has(itemKey(it.name)) })),
  };
  $('saved-name').textContent = set.name;
  $('saved-source').hidden = !set.source_url;
  if (set.source_url) $('saved-source').href = set.source_url;
  $('saved-servings-field').hidden = !(set.kind === 'recipe' && set.servings);
  $('saved-notes').hidden = !set.notes;
  $('saved-notes').textContent = set.notes || '';
  renderSavedItems();
  openModal($('saved-modal'));
}

function renderSavedItems() {
  const d = state.savedOpen;
  const factor = d.set.servings && d.servings ? d.servings / d.set.servings : 1;
  $('saved-servings').textContent = d.servings || '';
  $('saved-items').innerHTML = d.items.map((it, idx) => {
    const meta = [scaleAmount(it.amount, factor), it.already && t('alreadyOnList'), it.staple && t('usuallyAtHome')].filter(Boolean).join(' · ');
    return `<li class="${it.already ? 'already' : ''}"><label>
      <input type="checkbox" class="tick" value="${idx}" ${savedOn(it) ? 'checked' : ''}>
      <span class="pick-text"><span>${esc(it.name)}${it.quantity > 1 ? ` <span class="qty num">×${it.quantity}</span>` : ''}</span>${meta ? `<span class="match-line">${esc(meta)}</span>` : ''}</span>
    </label></li>`;
  }).join('');
  renderSavedCount();
}

function renderSavedCount() {
  const d = state.savedOpen;
  const n = d.items.filter(savedOn).length;
  $('saved-count').textContent = t('whatToAddN', { n, total: d.items.length });
  const skipped = d.items.some((it) => it.checked === null && (it.staple || it.already));
  const nothingNeeded = !d.items.some((it) => !it.staple && !it.already);
  $('saved-hint').hidden = !skipped;
  $('saved-hint').textContent = nothingNeeded
    ? t('allAlreadyHint')
    : t('skippedHint');
  $('saved-merge').textContent = n ? t('addToListN', { n }) : t('addToList');
  $('saved-merge').disabled = !n;
}

$('saved-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-saved]');
  if (row) openSaved(state.saved.find((s) => s.id === Number(row.dataset.saved)));
});

$('saved-items').addEventListener('change', (e) => {
  if (!e.target.matches('input[type=checkbox]')) return;
  state.savedOpen.items[Number(e.target.value)].checked = e.target.checked;
  if (e.target.checked) stamp(e.target);
  renderSavedCount();
});

$('saved-form').addEventListener('click', (e) => {
  const step = e.target.closest('[data-serve]');
  if (!step || !state.savedOpen) return;
  const d = state.savedOpen;
  d.servings = Math.max(1, Math.min(99, d.servings + Number(step.dataset.serve)));
  renderSavedItems();
});

// Merge into the list: a recipe's items say what they are for; anything already there gets that note instead of a copy
$('saved-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = state.savedOpen;
  if (!d) return;
  const picked = d.items.filter(savedOn);
  if (!picked.length) return;
  const factor = d.set.servings && d.servings ? d.servings / d.set.servings : 1;
  const recipe = d.set.kind === 'recipe';
  const ops = [];
  for (const it of picked) {
    const amount = scaleAmount(it.amount, factor);
    const forNote = recipe ? `${t('forRecipe', { name: d.set.name })}${amount ? ` (${amount})` : ''}` : amount;
    const existing = currentItems().find((i) => itemKey(i.name) === itemKey(it.name));
    if (existing) {
      if (forNote && !(existing.note || '').includes(forNote)) {
        ops.push(enqueue({ type: 'patchItem', itemId: existing.id, body: { note: [existing.note, forNote].filter(Boolean).join(' · ') } }));
      }
    } else {
      ops.push(queueItem({ name: it.name, quantity: it.quantity, note: forNote || null }));
    }
  }
  api(`/api/saved/${d.set.id}/used`, { method: 'POST' }).catch(() => {});
  d.set.last_used = new Date().toISOString();
  closeModal($('saved-modal'));
  toast(t('setAdded', { name: d.set.name }), { run: () => ops.forEach(undoOp) });
});

$('saved-edit').addEventListener('click', () => {
  const set = state.savedOpen?.set;
  closeModal($('saved-modal'));
  if (set) openSavedEditor(set, set.id);
});

$('saved-delete').addEventListener('click', async () => {
  const set = state.savedOpen?.set;
  if (!set || !requireOnline()) return;
  try {
    const r = await api(`/api/saved/${set.id}`, { method: 'DELETE' });
    closeModal($('saved-modal'));
    await loadSaved();
    toast(t('setDeleted', { name: set.name }), { run: () => api('/api/undo', { json: r.undo }).then(loadSaved).catch((err) => toast(err.message)) });
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Saved editor ----------
function editRow(it = {}) {
  return `<li class="ing-row" data-quantity="${it.quantity || 1}" data-staple="${it.staple ? 1 : 0}">
    <input type="text" class="ing-name" placeholder="${t('ingredient')}" aria-label="${t('ingredient')}" value="${esc(it.name || '')}">
    <input type="text" class="ing-amount" placeholder="${t('amount')}" aria-label="${t('amount')}" value="${esc(it.amount || '')}">
    <button type="button" class="icon-btn" data-remove-row aria-label="${t('removeRow')}">${icon('x')}</button>
  </li>`;
}

function setEditKind(kind) {
  document.querySelector(`input[name=saved-kind][value=${kind}]`).checked = true;
  $('se-recipe-fields').hidden = kind !== 'recipe';
}

// preset: fields to start from (an import, a purchase, or the set being edited)
function openSavedEditor(preset = {}, editId = null) {
  if (!requireOnline()) return;
  state.savedEdit = { id: editId };
  $('saved-edit-title').textContent = editId ? t('edit') : t('saveTitle');
  setEditKind(preset.kind || 'recipe');
  $('se-name').value = preset.name || '';
  $('se-url').value = preset.source_url || '';
  $('se-servings').value = preset.servings || '';
  $('se-notes').value = preset.notes || '';
  const items = preset.items?.length ? preset.items : [{}, {}, {}];
  $('se-rows').innerHTML = items.map(editRow).join('');
  openModal($('saved-edit-modal'));
  if (!preset.name) $('se-name').focus();
}

document.querySelectorAll('input[name=saved-kind]').forEach((r) => r.addEventListener('change', () => setEditKind(r.value)));
$('se-add-row').addEventListener('click', () => {
  $('se-rows').insertAdjacentHTML('beforeend', editRow());
  $('se-rows').lastElementChild.querySelector('.ing-name').focus();
});
$('se-rows').addEventListener('click', (e) => {
  if (e.target.closest('[data-remove-row]')) e.target.closest('.ing-row').remove();
});

$('saved-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = document.querySelector('input[name=saved-kind]:checked').value;
  const items = [...$('se-rows').children].map((li) => ({
    name: li.querySelector('.ing-name').value.trim(),
    amount: li.querySelector('.ing-amount').value.trim(),
    quantity: Number(li.dataset.quantity) || 1,
    staple: li.dataset.staple === '1',
  })).filter((i) => i.name);
  if (!items.length) {
    toast(t('addAtLeastOne'));
    return;
  }
  const body = {
    kind,
    name: $('se-name').value.trim(),
    source_url: kind === 'recipe' ? $('se-url').value.trim() : null,
    servings: kind === 'recipe' ? Number($('se-servings').value) || null : null,
    notes: $('se-notes').value.trim(),
    items,
  };
  const id = state.savedEdit?.id;
  $('se-save').disabled = true;
  try {
    if (id) await api(`/api/saved/${id}`, { method: 'PUT', json: body });
    else await api('/api/saved', { json: body });
    closeModal($('saved-edit-modal'));
    await loadSaved();
    toast(id ? t('savedToast') : t('savedToSaved', { name: body.name }));
  } catch (err) {
    toast(err instanceof OfflineError ? t('offlineCantSave') : err.message);
  } finally {
    $('se-save').disabled = false;
  }
});

$('new-saved').addEventListener('click', () => openSavedEditor());
$('saved-empty-import').addEventListener('click', () => openImport({ dest: 'saved' }));

// ---------- Purchase history ----------
// A monster can be drawn from anything that names what was bought
const canMonster = (p) => state.aiEnabled && (p.items.length > 0 || p.lines?.length > 0);

function monsterBlock(p) {
  if (p.monster_status === 'pending') {
    return `<div class="monster-card pending" role="status"><span class="spinner"></span><span>${esc(t('monsterPending'))}</span></div>`;
  }
  if (p.monster_file) {
    return `<button type="button" class="monster-card" data-monster-open>
      <img src="/receipts/${esc(p.monster_file)}" alt="${esc(p.monster_name || t('monster'))}" loading="lazy">
      <span class="monster-text"><strong>${esc(p.monster_name || '')}</strong><span>${esc(p.monster_bio || '')}</span></span>
    </button>`;
  }
  if ((p.monster_status === 'no_access' || p.monster_status === 'error') && canMonster(p)) {
    const why = p.monster_status === 'no_access' ? t('monsterNoAccess') : t('monsterFailed');
    return `<div class="monster-card failed"><span>${esc(why)}</span><button type="button" class="link-btn" data-monster>${esc(t('tryAgain'))}</button></div>`;
  }
  return '';
}

async function makeMonster(p) {
  if (!requireOnline()) return;
  try {
    await api(`/api/purchases/${p.id}/monster`, { json: { theme: document.documentElement.dataset.theme } });
    p.monster_status = 'pending';
    renderPurchases();
  } catch (err) {
    toast(err.message);
  }
}

function openMonster(p) {
  state.monsterOpen = p;
  $('monster-img').src = `/receipts/${p.monster_file}`;
  $('monster-img').alt = p.monster_name || t('monster');
  $('monster-name').textContent = p.monster_name || '';
  $('monster-bio').textContent = p.monster_bio || '';
  $('monster-from').textContent = t(p.store ? 'monsterFromAt' : 'monsterFrom', {
    name: p.buyer_name, store: p.store, date: dateFmt.format(new Date(p.purchased_at)),
  });
  openModal($('monster-modal'));
}

// Share the picture itself (to a chat app, say); fall back to saving it
$('monster-share').addEventListener('click', async () => {
  const p = state.monsterOpen;
  if (!p) return;
  const url = `/receipts/${p.monster_file}`;
  try {
    const blob = await (await fetch(url)).blob();
    const shared = new File([blob], `${p.monster_name || 'monster'}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [shared] })) {
      await navigator.share({ files: [shared], title: p.monster_name || t('monster'), text: [p.monster_name, p.monster_bio].filter(Boolean).join(' – ') });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.monster_name || 'monster'}.jpg`;
  a.click();
});

$('monster-again').addEventListener('click', () => {
  const p = state.monsterOpen;
  if (!p) return;
  closeModal($('monster-modal'));
  makeMonster(p);
});

function renderPurchases() {
  $('purchases').innerHTML = state.purchases.map((p) => {
    // No prices on any line: the photo was of the products, not a receipt
    const products = p.lines?.length > 0 && p.lines.every((l) => l.price == null);
    return `
    <li class="purchase" data-id="${p.id}">
      ${p.receipt_file ? `<img class="thumb" src="/receipts/${esc(p.receipt_file)}" alt="${t(products ? 'productsAlt' : 'receiptAlt')}" loading="lazy" data-full>` : ''}
      <div class="p-body">
        <div class="p-top">
          <div><span class="who-dot" style="background:${personColor(p.buyer_id)}"></span><strong>${esc(p.buyer_name)}</strong>${p.store ? ` · ${esc(p.store)}` : ''}</div>
          <div class="p-total">${p.total === 0 ? t('noPaymentTotal') : money.format(p.total)}</div>
        </div>
        <div class="p-meta">${dateFmt.format(new Date(p.purchased_at))}${p.category && p.category !== 'groceries' ? ` · <span class="cat-tag">${esc(categoryName(p.category))}</span>` : ''}${p.ai_parsed ? ` · ${t(products ? 'fromPhoto' : 'readAutomatically')}` : ''}</div>
        ${p.items.length ? `<div class="p-items">${p.items.map((i) => `<span>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}<button type="button" class="chip-x" data-remove-item="${i.id}" aria-label="${esc(t('removeFromHistory', { name: i.name }))}">${icon('x')}</button></span>`).join('')}</div>` : ''}
        ${p.note ? `<div class="p-note">${esc(p.note)}</div>` : ''}
        ${p.lines?.length ? `<details class="lines"><summary>${t(products ? 'productsN' : 'receiptDetails', { n: p.lines.length })}</summary><ul class="line-list">${p.lines.map((l) => `<li><span class="line-name">${esc(l.name)}</span><span class="num">${l.price != null ? money.format(l.price) : ''}</span></li>`).join('')}</ul></details>` : ''}
        ${monsterBlock(p)}
        <div class="p-actions">
          ${canMonster(p) && !p.monster_file && !p.monster_status ? `<button type="button" class="btn ghost" data-monster>${icon('sparkle')}${esc(t('makeMonster'))}</button>` : ''}
          <button type="button" class="btn ghost" data-edit-purchase>${t('edit')}</button>
          ${p.items.length ? `<button type="button" class="btn ghost" data-save-batch>${t('saveAsRegular')}</button>` : ''}
          <button type="button" class="btn ghost danger" data-delete>${t('delete')}</button>
        </div>
      </div>
    </li>`;
  }).join('');
  const q = $('search').value.trim();
  $('purchases-empty').hidden = state.purchases.length > 0;
  $('purchases-empty-text').textContent = q ? t('noPurchasesFor', { q }) : t('purchasesEmpty');
}

async function loadPurchases() {
  const q = $('search').value.trim();
  try {
    state.purchases = await api(`/api/purchases${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!q) saveSnapshot();
  } catch (err) {
    if (!(err instanceof OfflineError)) return toast(err.message);
    // Offline: search what was last loaded
    const all = loadJSON('snapshot', {}).purchases || [];
    const k = q.toLowerCase();
    state.purchases = !k ? all : all.filter((p) => [p.store, p.note, ...p.items.map((i) => i.name), ...(p.lines || []).map((l) => l.name)]
      .some((s) => s && s.toLowerCase().includes(k)));
  }
  renderPurchases();
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadPurchases, 250);
});

$('purchases').addEventListener('click', async (e) => {
  const li = e.target.closest('.purchase');
  if (!li) return;
  const p = state.purchases.find((x) => x.id === Number(li.dataset.id));
  if (e.target.closest('[data-full]')) {
    $('image-full').src = e.target.src;
    $('image-modal').hidden = false;
    return;
  }
  if (e.target.closest('[data-monster-open]')) return openMonster(p);
  if (e.target.closest('[data-monster]')) return makeMonster(p);
  if (e.target.closest('[data-edit-purchase]')) return openEditPurchase(p);
  if (e.target.closest('[data-save-batch]')) {
    return openSavedEditor({
      kind: 'batch',
      name: p.store ? t('regularShopAt', { store: p.store }) : t('regularShop'),
      items: p.items.map((i) => ({ name: i.name, quantity: i.quantity })),
    });
  }
  const rm = e.target.closest('[data-remove-item]');
  if (rm) {
    if (!requireOnline()) return;
    const item = p.items.find((i) => i.id === Number(rm.dataset.removeItem));
    try {
      const r = await api(`/api/purchases/${p.id}/items/${item.id}`, { method: 'DELETE' });
      await loadPurchases();
      toast(t('removedFromPurchase', { name: item.name }), { run: () => api('/api/undo', { json: r.undo }).then(loadPurchases).catch((err) => toast(err.message)) });
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (e.target.closest('[data-delete]')) {
    if (!requireOnline()) return;
    try {
      const r = await api(`/api/purchases/${p.id}`, { method: 'DELETE' });
      await refreshAll();
      await loadPurchases();
      const back = p.items.length ? t('itemsBackOnList') : '';
      toast(t('purchaseDeleted', { back }), {
        run: () => api('/api/undo', { json: r.undo }).then(() => Promise.all([refreshAll(), loadPurchases()])).catch((err) => toast(err.message)),
      });
    } catch (err) {
      toast(err.message);
    }
  }
});

// ---------- Summary and insights ----------
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- Balance and settling up ----------
// Who is ahead after purchases and manual settlements; with two people, how much evens it out
function balanceGap(rows) {
  if (rows.length !== 2) return null;
  const [a, b] = rows;
  const diff = Math.round(Math.abs(a.total - b.total) * 100) / 100;
  const ahead = a.total >= b.total ? a : b;
  const behind = ahead === a ? b : a;
  return { diff, ahead, behind, half: Math.round(diff * 50) / 100 };
}

function renderBalance(rows, settlements) {
  state.balance = rows;
  const gap = balanceGap(rows);
  let html = rows.map((r) => `
    <div class="sum-card">
      <div class="sum-row">
        <span class="sum-name"><span class="who-dot" style="background:${personColor(r.id)}"></span>${esc(r.name)}</span>
        <span class="sum-total">${money.format(r.total)}</span>
      </div>
      <div class="sum-count">${esc(t('balancePurchases', { amount: money.format(r.purchases) }))}${r.settled
        ? esc(t('balanceSettled', { sign: r.settled > 0 ? '+' : '−', amount: money.format(Math.abs(r.settled)) })) : ''}</div>
    </div>`).join('');
  if (gap && rows.some((r) => r.total > 0)) {
    html += `<div class="sum-diff">${gap.diff < 0.01 ? esc(t('balanceEven'))
      : t('balanceGap', {
        ahead: esc(gap.ahead.name), behind: esc(gap.behind.name),
        diff: `<strong>${money.format(gap.diff)}</strong>`, half: `<strong>${money.format(gap.half)}</strong>`,
      })}</div>`;
  }
  $('balance').innerHTML = rows.length ? html : `<p class="hint">${t('noData')}</p>`;

  // Every settlement made by hand stays visible, with what it was for
  $('settlements').hidden = settlements.length === 0;
  $('settlements-summary').textContent = t('settlementsN', { n: settlements.length });
  $('settlements-list').innerHTML = settlements.map((s) => `
    <li>
      <span class="line-name">${esc(s.kind === 'transfer'
        ? t('settleTransferLine', { payer: s.payer_name, receiver: s.receiver_name })
        : t('settleExpenseLine', { payer: s.payer_name }))}${s.note ? ` · ${esc(s.note)}` : ''}<span class="settle-date">${shortDate.format(new Date(s.settled_at))}</span></span>
      <span class="num">${money.format(s.amount)}</span>
      <button type="button" class="icon-btn" data-settle-delete="${s.id}" aria-label="${esc(t('deleteSettlement'))}">${icon('x')}</button>
    </li>`).join('');
}

const settleKind = () => document.querySelector('input[name=settle-kind]:checked').value;

function renderSettleForm({ suggest = false } = {}) {
  const transfer = settleKind() === 'transfer';
  const payer = Number($('settle-payer').value);
  $('settle-receiver-field').hidden = !transfer;
  $('settle-payer-label').textContent = transfer ? t('settleWhoSent') : t('settleWhoPaid');
  $('settle-kind-hint').textContent = transfer ? t('settleTransferHint') : t('settleExpenseHint');
  $('settle-note').placeholder = transfer ? t('settleTransferNote') : t('settleExpenseNote');
  // Only someone else can receive a transfer
  const others = state.people.filter((p) => p.id !== payer);
  const keep = Number($('settle-receiver').value);
  $('settle-receiver').innerHTML = others.map((p) => `<option value="${p.id}" ${p.id === keep ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  // Suggest the amount that evens things out when the payer is the one behind
  const gap = balanceGap(state.balance || []);
  if (suggest && transfer && gap && gap.diff >= 0.01 && gap.behind.id === payer) {
    $('settle-amount').value = gap.half.toFixed(2);
    $('settle-receiver').value = String(gap.ahead.id);
  }
  renderSettlePreview();
}

// What the balance will look like after saving
function renderSettlePreview() {
  const amount = Number($('settle-amount').value.replace(/[^\d.,]/g, '').replace(',', '.'));
  const rows = (state.balance || []).map((r) => ({ ...r }));
  if (rows.length !== 2 || !(amount > 0)) { $('settle-preview').hidden = true; return; }
  const payer = rows.find((r) => r.id === Number($('settle-payer').value));
  const receiver = rows.find((r) => r.id === Number($('settle-receiver').value));
  if (!payer) { $('settle-preview').hidden = true; return; }
  payer.total += amount;
  if (settleKind() === 'transfer' && receiver) receiver.total -= amount;
  const gap = balanceGap(rows);
  $('settle-preview').hidden = false;
  $('settle-preview').textContent = gap.diff < 0.01
    ? t('settleAfterEven')
    : t('settleAfter', { name: gap.ahead.name, amount: money.format(gap.diff) });
}

$('open-settle').addEventListener('click', () => {
  if (!state.me) return openWhoModal();
  if (!requireOnline()) return;
  if (state.people.length < 2) return toast(t('settleNeedsTwo'));
  $('settle-form').reset();
  $('settle-amount-label').textContent = t('settleAmount', { symbol: currencySymbol });
  $('settle-payer').innerHTML = state.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  // Start from whoever is behind, since they're usually the one settling
  const gap = balanceGap(state.balance || []);
  $('settle-payer').value = String(gap && gap.diff >= 0.01 ? gap.behind.id : state.me.id);
  $('settle-date').value = todayStr();
  renderSettleForm({ suggest: true });
  openModal($('settle-modal'));
});
document.querySelectorAll('input[name=settle-kind]').forEach((r) => r.addEventListener('change', () => {
  $('settle-amount').value = '';
  renderSettleForm({ suggest: true });
}));
$('settle-payer').addEventListener('change', () => renderSettleForm({ suggest: true }));
$('settle-receiver').addEventListener('change', renderSettlePreview);
$('settle-amount').addEventListener('input', renderSettlePreview);

$('settle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number($('settle-amount').value.replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!(amount > 0)) {
    toast(t('enterValidAmount'));
    return $('settle-amount').focus();
  }
  const dateVal = $('settle-date').value;
  const transfer = settleKind() === 'transfer';
  $('settle-save').disabled = true;
  try {
    await api('/api/settlements', {
      json: {
        kind: transfer ? 'transfer' : 'expense',
        payer_id: Number($('settle-payer').value),
        receiver_id: transfer ? Number($('settle-receiver').value) : null,
        amount,
        note: $('settle-note').value,
        settled_at: !dateVal || dateVal === todayStr() ? undefined : new Date(`${dateVal}T12:00:00`).toISOString(),
      },
    });
    closeModal($('settle-modal'));
    toast(t('settleSaved', { amount: money.format(amount) }));
    loadSummary();
  } catch (err) {
    toast(err instanceof OfflineError ? t('offlineCantSave') : err.message);
  } finally {
    $('settle-save').disabled = false;
  }
});

$('settlements-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-settle-delete]');
  if (!del || !requireOnline()) return;
  try {
    const r = await api(`/api/settlements/${del.dataset.settleDelete}`, { method: 'DELETE' });
    loadSummary();
    toast(t('settlementDeleted'), { run: () => api('/api/undo', { json: r.undo }).then(loadSummary).catch((err) => toast(err.message)) });
  } catch (err) {
    toast(err.message);
  }
});

function renderTotals(el, rows, { diff: showDiff = true } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  let html = rows.map((r) => `
    <div class="sum-card">
      <div class="sum-row">
        <span class="sum-name"><span class="who-dot" style="background:${personColor(r.id)}"></span>${esc(r.name)}</span>
        <span class="sum-total">${money.format(r.total)}</span>
      </div>
      <div class="sum-count">${t('nPurchases', { n: r.count })}</div>
      <div class="bar"><div style="width:${(r.total / max) * 100}%;background:${personColor(r.id)}"></div></div>
    </div>`).join('');

  if (showDiff && rows.length === 2) {
    const [a, b] = rows;
    const diff = Math.abs(a.total - b.total);
    const sum = a.total + b.total;
    if (sum > 0) {
      const more = a.total >= b.total ? a : b;
      html += `<div class="sum-diff">${t('total', { amount: money.format(sum) })}<br>${
        diff < 0.01 ? t('evenSplit') : t('spentMore', { name: esc(more.name), amount: money.format(diff) })
      }</div>`;
    }
  }
  el.innerHTML = rows.length ? html : `<p class="hint">${t('noData')}</p>`;
}

// Six months, one thin bar per person, legend + table for screen readers
function renderTrend(trend) {
  const people = state.people;
  const max = Math.max(1, ...trend.flatMap((m) => m.people.map((p) => p.total)));
  const label = (m) => monthShort.format(new Date(`${m}-01T12:00:00`));
  const total = (m) => m.people.reduce((s, p) => s + p.total, 0);
  const any = trend.some((m) => total(m) > 0);
  if (!any) {
    $('trend').innerHTML = `<p class="hint">${t('noPurchasesSixMonths')}</p>`;
    return;
  }
  $('trend').innerHTML = `
    <div class="legend">${people.map((p) => `<span><i style="background:${personColor(p.id)}"></i>${esc(p.name)}</span>`).join('')}</div>
    <div class="trend" role="img" aria-label="${t('sixMonthSpending')}">
      ${trend.map((m) => {
        // The month total sits right on top of the tallest bar: over the bar itself when only
        // one person spent that month, centred over the pair when both did.
        const spent = m.people.filter((p) => p.total > 0);
        const top = Math.max(0, ...m.people.map((p) => p.total)) / max * 100;
        const sum = total(m) ? `<span class="trend-sum num">${numFmt.format(Math.round(total(m)))}</span>` : '';
        return `
        <div class="trend-col">
          <div class="trend-bars">
            ${m.people.map((p) => `<div class="trend-bar" style="height:${(p.total / max) * 100}%;background:${personColor(p.id)}"
              title="${esc(people.find((x) => x.id === p.id)?.name)} · ${label(m.month)}: ${money.format(p.total)}">${
                spent.length === 1 && spent[0] === p ? sum : ''}</div>`).join('')}
            ${spent.length > 1 ? sum.replace('class="trend-sum', `style="bottom:${top}%" class="trend-sum pair`) : ''}
          </div>
          <div class="trend-label">${label(m.month)}</div>
        </div>`;
      }).join('')}
    </div>
    <table class="sr-only"><tr><th>${t('month')}</th>${people.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr>
      ${trend.map((m) => `<tr><td>${label(m.month)}</td>${m.people.map((p) => `<td>${money.format(p.total)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function renderBars(el, rows, labelOf, empty) {
  if (!rows.length) {
    el.innerHTML = `<p class="hint">${empty}</p>`;
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.total));
  el.innerHTML = `<ul class="hbars">${rows.map((r) => `
    <li title="${esc(labelOf(r))}: ${money.format(r.total)} · ${t('nPurchases', { n: r.count })}">
      <span class="hbar-label">${esc(labelOf(r))}</span>
      <span class="hbar-track"><span class="hbar" style="width:${(r.total / max) * 100}%"></span></span>
      <span class="hbar-value num">${money.format(r.total)}</span>
    </li>`).join('')}</ul>`;
}

async function loadSummary() {
  $('month-label').textContent = monthFmt.format(state.month);
  $('month-next').disabled = monthKey(state.month) === monthKey(new Date());
  try {
    const s = await api(`/api/summary?month=${monthKey(state.month)}`);
    renderBalance(s.balance || [], s.settlements || []);
    renderTotals($('month-summary'), s.monthTotals);
    // All-time purchases only; who is ahead overall is in the balance at the top
    renderTotals($('all-summary'), s.allTotals, { diff: false });
    renderTrend(s.trend);
    renderBars($('by-category'), s.byCategory, (r) => categoryName(r.category), t('noPurchasesThisMonth'));
    renderBars($('by-store'), s.byStore, (r) => r.store, t('noPurchasesThisMonth'));
  } catch (err) {
    if (err instanceof OfflineError) $('month-summary').innerHTML = `<p class="hint">${t('summaryOffline')}</p>`;
    else toast(err.message);
  }
}

$('month-prev').addEventListener('click', () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  loadSummary();
});
$('month-next').addEventListener('click', () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
  loadSummary();
});

// ---------- Household settings ----------
const CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'INR', 'SGD', 'HKD', 'KRW',
  'BRL', 'MXN', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'AED'];

function currencyOptions(selected) {
  let names;
  try { names = new Intl.DisplayNames([LANGS[LANG].locale], { type: 'currency' }); } catch { names = null; }
  const codes = CURRENCIES.includes(selected) ? CURRENCIES : [selected, ...CURRENCIES];
  return codes.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${esc(names ? `${names.of(c)} (${c})` : c)}</option>`).join('');
}

// Everything on screen again, after the language or currency changed
function renderAll() {
  applyI18n();
  applyMode(currentMode());
  renderWho();
  applyLocal();
  renderSaved();
  renderNet();
  if (state.view === 'history') renderPurchases();
  if (state.view === 'summary') loadSummary();
  if (!$('settings-modal').hidden) renderSettings();
}

function applyConfig(cfg) {
  if (!cfg) return;
  const before = state.config;
  state.config = cfg;
  Object.assign(state, { aiEnabled: cfg.aiEnabled, sections: cfg.sections, categories: cfg.categories });
  // During first-run setup the language picked on this screen wins over the server's default
  if (cfg.setupDone && (!before || !before.setupDone || before.language !== cfg.language || before.currency !== cfg.currency)) {
    setLanguage(cfg.language);
    setupFormats(cfg.currency);
    $('p-total-label').textContent = t('amountPaid', { symbol: currencySymbol });
    renderAll();
  }
}

// ---------- Settings sheet ----------
function renderSettings() {
  const cfg = state.config;
  renderThemeOptions();
  $('set-language').innerHTML = Object.entries(LANGS)
    .map(([code, l]) => `<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
  $('set-currency').innerHTML = currencyOptions(cfg?.currency || 'USD');
  $('set-people').innerHTML = state.people.map((p) => `
    <li class="ing-row"><input type="text" value="${esc(p.name)}" data-person-id="${p.id}" aria-label="${esc(t('rename'))}" enterkeyhint="done"></li>`).join('');
  const ai = cfg?.ai || {};
  $('set-key-status').textContent = ai.keySource === 'env' ? t('keyFromEnv')
    : ai.keySource === 'settings' ? t('keySaved', { hint: ai.keyHint }) : t('noKey');
  $('set-key-edit').hidden = ai.keySource === 'env';
  $('set-key-remove').hidden = ai.keySource !== 'settings';
  $('set-key').value = '';
  $('set-model').value = ai.model || '';
  $('set-model').disabled = Boolean(ai.modelFromEnv);
  $('set-model-strong').value = ai.modelStrong || '';
  $('set-model-strong').disabled = Boolean(ai.modelStrongFromEnv);
}

function openSettings() {
  $('set-key-msg').hidden = true;
  renderSettings();
  openModal($('settings-modal'));
}

async function saveSettings(body, { quiet = false } = {}) {
  if (!requireOnline()) return null;
  try {
    const cfg = await api('/api/settings', { method: 'PUT', json: body });
    applyConfig(cfg);
    renderSettings();
    if (!quiet) toast(t('settingsSaved'));
    return cfg;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

function keyMessage(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

async function testKey(inputId, msgId) {
  if (!requireOnline()) return;
  const apiKey = $(inputId).value.trim();
  keyMessage(msgId, t('testingKey'), 'loading');
  try {
    const r = await api('/api/settings/test-key', { json: { apiKey } });
    keyMessage(msgId, r.ok ? t('keyWorks') : t('keyFailed', { msg: r.error }), r.ok ? '' : 'warn');
  } catch (err) {
    keyMessage(msgId, t('keyFailed', { msg: err.message }), 'warn');
  }
}

$('settings-open').addEventListener('click', openSettings);
$('set-language').addEventListener('change', (e) => saveSettings({ language: e.target.value }, { quiet: true }));
$('set-currency').addEventListener('change', (e) => saveSettings({ currency: e.target.value }, { quiet: true }));
$('set-model').addEventListener('change', (e) => saveSettings({ model: e.target.value }));
$('set-model-strong').addEventListener('change', (e) => saveSettings({ modelStrong: e.target.value }));
$('set-key-test').addEventListener('click', () => testKey('set-key', 'set-key-msg'));
$('set-key-save').addEventListener('click', async () => {
  const apiKey = $('set-key').value.trim();
  if (!apiKey) return $('set-key').focus();
  if (await saveSettings({ apiKey })) keyMessage('set-key-msg', '');
});
$('set-key-remove').addEventListener('click', () => saveSettings({ apiKey: '' }));
$('set-people').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-person-id]');
  const name = input?.value.trim();
  const person = input && state.people.find((p) => p.id === Number(input.dataset.personId));
  if (!person || !name || name === person.name || !requireOnline()) {
    if (person) input.value = person.name;
    return;
  }
  try {
    await api(`/api/people/${person.id}`, { method: 'PATCH', json: { name } });
    await refreshAll();
    toast(t('settingsSaved'));
  } catch (err) {
    input.value = person.name;
    toast(err.message);
  }
});
$('set-people').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-person-id]')) { e.preventDefault(); e.target.blur(); }
});
$('set-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('set-person-name').value.trim();
  if (!name || !requireOnline()) return;
  try {
    await api('/api/people', { json: { name } });
    $('set-person-name').value = '';
    await refreshAll();
    renderSettings();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- First-run setup ----------
const setup = { step: 1 };

function setupPersonRow(name = '') {
  return `<li class="ing-row"><input type="text" value="${esc(name)}" placeholder="${esc(t('personName'))}" aria-label="${esc(t('personName'))}" maxlength="40">
    <button type="button" class="icon-btn" data-remove-row aria-label="${esc(t('removeRow'))}">${icon('x')}</button></li>`;
}

function renderSetup() {
  const titles = ['setupLanguageTitle', 'setupPeopleTitle', 'setupAiTitle'];
  $('setup-step-label').textContent = `${t('setupWelcome')} · ${t('setupStepOf', { n: setup.step })}`;
  $('setup-title').textContent = t(titles[setup.step - 1]);
  document.querySelectorAll('.setup-step').forEach((el) => { el.hidden = Number(el.dataset.step) !== setup.step; });
  $('setup-back').hidden = setup.step === 1;
  $('setup-next').textContent = setup.step === 3 ? t('finish') : t('next');
  $('setup-error').hidden = true;
  const fromEnv = state.config?.ai?.keySource === 'env';
  $('setup-key-wrap').hidden = fromEnv;
  $('setup-key-env').hidden = !fromEnv;
}

function openSetup() {
  setup.step = 1;
  document.querySelector(`input[name=setup-lang][value=${LANG}]`).checked = true;
  $('setup-currency').innerHTML = currencyOptions(LANG === 'he' ? 'ILS' : 'USD');
  $('setup-people').innerHTML = setupPersonRow() + setupPersonRow();
  $('setup-key').value = '';
  keyMessage('setup-key-msg', '');
  renderSetup();
  openModal($('setup-modal'));
}

// Picking a language switches the whole screen straight away, and suggests that language's usual currency
document.querySelectorAll('input[name=setup-lang]').forEach((r) => r.addEventListener('change', () => {
  const lang = r.value;
  setLanguage(lang);
  renderAll();
  const typed = [...$('setup-people').querySelectorAll('input')].map((i) => i.value);
  $('setup-currency').innerHTML = currencyOptions(lang === 'he' ? 'ILS' : $('setup-currency').value === 'ILS' ? 'USD' : $('setup-currency').value);
  $('setup-people').innerHTML = typed.map(setupPersonRow).join('');
  renderSetup();
}));
$('setup-add-person').addEventListener('click', () => {
  $('setup-people').insertAdjacentHTML('beforeend', setupPersonRow());
  $('setup-people').lastElementChild.querySelector('input').focus();
});
$('setup-people').addEventListener('click', (e) => {
  if (e.target.closest('[data-remove-row]')) e.target.closest('.ing-row').remove();
});
$('setup-key-test').addEventListener('click', () => testKey('setup-key', 'setup-key-msg'));
$('setup-back').addEventListener('click', () => {
  setup.step = Math.max(1, setup.step - 1);
  renderSetup();
});
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const names = [...$('setup-people').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  if (setup.step === 2 && !names.length) {
    keyMessage('setup-error', t('addAtLeastOnePerson'), 'warn');
    return;
  }
  if (setup.step < 3) {
    setup.step += 1;
    renderSetup();
    return;
  }
  if (!requireOnline()) return;
  $('setup-next').disabled = true;
  try {
    const cfg = await api('/api/setup', { json: {
      language: LANG,
      currency: $('setup-currency').value,
      people: names,
      apiKey: $('setup-key').value.trim(),
    } });
    closeModal($('setup-modal'));
    applyConfig(cfg);
    await refreshAll();
    openWhoModal();
  } catch (err) {
    keyMessage('setup-error', err.message, 'warn');
  } finally {
    $('setup-next').disabled = false;
  }
});

// ---------- Sync with the server ----------
async function loadPeople() {
  state.people = await api('/api/people');
  pickMe();
}

function pickMe() {
  const savedId = Number(storageGet('personId'));
  state.me = state.people.find((p) => p.id === savedId) || null;
  renderWho();
}

async function loadLists() {
  state.lists = await api('/api/lists');
  applyLocal();
}

async function refreshAll() {
  try {
    const [config, people, lists, items, catalog, saved] = await Promise.all([
      api('/api/config'), api('/api/people'), api('/api/lists'), api('/api/items'), api('/api/catalog'), api('/api/saved'),
    ]);
    Object.assign(state, { people, lists, serverItems: items, catalog, saved });
    applyConfig(config);
    if (!$('settings-modal').hidden) renderSettings();
    pickMe();
    saveSnapshot();
    applyLocal();
    if (state.view === 'saved') renderSaved();
    if (state.view === 'history') loadPurchases();
    if (state.view === 'summary') loadSummary();
  } catch (err) {
    if (!(err instanceof OfflineError)) console.error(err);
  }
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    // Don't overwrite local state while changes are still being sent
    if (state.outbox.length) flush();
    else refreshAll();
  }, 150);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = scheduleRefresh;
  es.onopen = () => {
    setOnline(true);
    scheduleRefresh();
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleRefresh();
});
window.addEventListener('online', () => {
  state.online = true;
  flush();
  scheduleRefresh();
});
window.addEventListener('offline', () => setOnline(false));
setInterval(() => { if (state.outbox.length) flush(); }, 15000);

(async function init() {
  setLanguage(storageGet('lang') || (/^he\b/i.test(navigator.language) ? 'he' : 'en'));
  setupFormats('USD');
  applyTheme(storageGet('theme'));
  applyMode(storageGet('mode'));
  restoreStoreMode();
  // Start from the last snapshot so the app opens instantly, even with no signal
  const snap = loadJSON('snapshot', null);
  state.outbox = loadJSON('outbox', []);
  state.listId = Number(storageGet('listId')) || null;
  if (snap) {
    Object.assign(state, {
      people: snap.people || [],
      lists: snap.lists || [],
      serverItems: snap.items || [],
      catalog: snap.catalog || [],
      purchases: snap.purchases || [],
      saved: snap.saved || [],
      sections: snap.sections || [],
      categories: snap.categories || [],
      aiEnabled: Boolean(snap.aiEnabled),
    });
    applyConfig(snap.config);
    pickMe();
    applyLocal();
  }
  try {
    applyConfig(await api('/api/config'));
    if (state.config.setupDone) {
      await refreshAll();
      flush();
    }
  } catch (err) {
    if (!(err instanceof OfflineError)) toast(t('serverUnreachable'));
  }
  if (state.config && !state.config.setupDone) openSetup();
  else if (!state.me && state.online) openWhoModal();
  connectEvents();
  renderNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}());
