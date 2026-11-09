import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(DATA_DIR, 'receipts');
const BACKUP_DIR = process.env.BACKUP_DIR || '';
const BACKUP_KEEP = 14;
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
const LOG_KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS || 90);
const DEFAULT_MODEL = 'gpt-4.1-mini';
// Careful reading (handwriting, faded or crumpled receipts), used only when the person picks it
const DEFAULT_MODEL_STRONG = 'gpt-6.1-terra';
const env = (name) => (process.env[name] || '').trim();

// One structured-output call; returns the parsed JSON
async function askOpenAI({ model, content, name, schema, timeout = 90000, key = apiKey() }) {
  const payload = {
    model,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  };
  if (/^(gpt-5|o\d)/.test(model)) payload.reasoning_effort = 'low';
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.error?.message || `OpenAI HTTP ${resp.status}`);
  const out = body?.choices?.[0]?.message?.content;
  if (!out) throw new Error('Empty response from OpenAI');
  return JSON.parse(out);
}

// Pictures of the "monster made of what we bought"
// gpt-image-2 at medium quality is about $0.05 a picture; gpt-image-1-mini is about $0.01 and simpler
const imageModel = () => env('OPENAI_IMAGE_MODEL') || 'gpt-image-2';
const imageQuality = () => env('OPENAI_IMAGE_QUALITY') || 'medium';

// One picture; returns the image bytes
async function drawImage(prompt, timeout = 180000) {
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: imageModel(), prompt, n: 1, size: '1024x1024', quality: imageQuality(),
      output_format: 'jpeg', output_compression: 85,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.error?.message || `OpenAI HTTP ${resp.status}`);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image in the response');
  return Buffer.from(b64, 'base64');
}
const UNDO_KEEP_MS = 2 * 24 * 60 * 60 * 1000; // soft-deleted rows are purged after 2 days

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// Languages the app speaks. The AI writes list items in the household's language.
// Add one: a block here, plus the UI strings in public/i18n.js.
const LANGUAGES = {
  en: {
    name: 'English',
    examples: '("onion", "heavy cream", "parsley")',
    recipeNote: '"3 eggs"',
    amounts: '("2 cups", "500 g")',
    counts: '("eggs x2", "2 milk", "milk 2")',
    // Reading a photo of the groceries themselves
    products: '("tomatoes", "milk", "bread", "olive oil", "toilet paper")',
    noSizes: '("milk", not "milk 3% 1 liter"; "eggs", not "eggs 12 pack")',
    variants: '("spaghetti", "cheddar", "soy milk")',
    defaultList: 'Groceries',
    csv: ['Date', 'Paid by', 'Amount', 'Store', 'Category', 'Items from the list', 'Receipt lines', 'Notes', 'Receipt file'],
  },
  he: {
    name: 'Hebrew',
    examples: '("בצל", "שמנת מתוקה", "פטרוזיליה")',
    recipeNote: '"3 ביצים"',
    amounts: '("2 כוסות", "500 גרם")',
    counts: '("ביצים x2", "2 חלב", "חלב 2")',
    products: '("עגבניות", "חלב", "לחם", "שמן זית", "נייר טואלט")',
    noSizes: '("חלב", not "חלב 3% 1 ליטר"; "ביצים", not "ביצים 12 יחידות")',
    variants: '("ספגטי", "גבינה צהובה", "חלב סויה")',
    defaultList: 'סופר',
    csv: ['תאריך', 'מי שילם', 'סכום', 'חנות', 'קטגוריה', 'פריטים מהרשימה', 'שורות קבלה', 'הערות', 'קובץ קבלה'],
  },
};

// Store-layout order for the shopping list
const SECTIONS = [
  ['produce', { en: 'Fruit & vegetables', he: 'פירות וירקות' }],
  ['bakery', { en: 'Bread & bakery', he: 'לחם ומאפים' }],
  ['dairy', { en: 'Dairy & eggs', he: 'חלב, ביצים וגבינות' }],
  ['meat', { en: 'Meat & fish', he: 'בשר ודגים' }],
  ['frozen', { en: 'Frozen', he: 'קפואים' }],
  ['pantry', { en: 'Pantry & cans', he: 'מזווה ושימורים' }],
  ['snacks', { en: 'Snacks & sweets', he: 'חטיפים ומתוקים' }],
  ['drinks', { en: 'Drinks', he: 'משקאות' }],
  ['cleaning', { en: 'Cleaning & laundry', he: 'ניקיון וכביסה' }],
  ['pharm', { en: 'Health & beauty', he: 'פארם וטיפוח' }],
  ['baby', { en: 'Baby', he: 'תינוקות' }],
  ['home', { en: 'Household', he: 'בית וכלי בית' }],
  ['other', { en: 'Other', he: 'אחר' }],
];
const SECTION_KEYS = SECTIONS.map(([k]) => k);

// What a purchase was for; everything counts toward who spent what
const CATEGORIES = [
  ['groceries', { en: 'Groceries', he: 'מכולת' }],
  ['home', { en: 'Home', he: 'בית' }],
  ['electronics', { en: 'Electronics', he: 'אלקטרוניקה' }],
  ['clothing', { en: 'Clothing', he: 'ביגוד' }],
  ['health', { en: 'Health & pharmacy', he: 'בריאות ופארם' }],
  ['other', { en: 'Other', he: 'אחר' }],
];
const CATEGORY_KEYS = CATEGORIES.map(([k]) => k);
const labelled = (rows, lang) => rows.map(([k, names]) => [k, names[lang] || names.en]);

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'shopping.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL REFERENCES people(id),
    total REAL NOT NULL,
    store TEXT,
    note TEXT,
    receipt_file TEXT,
    ai_parsed INTEGER NOT NULL DEFAULT 0,
    purchased_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT,
    added_by INTEGER REFERENCES people(id),
    created_at TEXT NOT NULL,
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  -- Every name ever added: powers suggestions, remembers sections
  CREATE TABLE IF NOT EXISTS catalog (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    section TEXT,
    list_id INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used TEXT
  );

  -- Receipt lines saved as data: powers price memory and search
  CREATE TABLE IF NOT EXISTS receipt_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL,
    item_key TEXT
  );
  CREATE INDEX IF NOT EXISTS receipt_lines_key ON receipt_lines(item_key);

  -- Saved recipes and recurring batches, merged into the list when needed
  CREATE TABLE IF NOT EXISTS saved_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'recipe',
    name TEXT NOT NULL,
    source_url TEXT,
    servings INTEGER,
    notes TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS saved_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL REFERENCES saved_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    amount TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    staple INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
function setSetting(key, value) {
  if (value === null || value === undefined || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
// Environment variables win over what the setup screen stored
const lang = () => (LANGUAGES[getSetting('language')] ? getSetting('language') : 'en');
const currency = () => getSetting('currency') || 'USD';
const apiKey = () => env('OPENAI_API_KEY') || getSetting('openai_api_key') || '';
const model = () => env('OPENAI_MODEL') || getSetting('openai_model') || DEFAULT_MODEL;
const modelStrong = () => env('OPENAI_MODEL_STRONG') || getSetting('openai_model_strong') || DEFAULT_MODEL_STRONG;
// A database from before the setup screen already has its people: treat it as set up
if (!getSetting('setup_done') && db.prepare('SELECT 1 FROM people LIMIT 1').get()) setSetting('setup_done', '1');
const setupDone = () => getSetting('setup_done') === '1';

function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('items', 'list_id', 'INTEGER NOT NULL DEFAULT 1');
addColumn('items', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
addColumn('items', 'section', 'TEXT');
addColumn('items', 'deleted_at', 'TEXT');
addColumn('items', 'client_uid', 'TEXT');
addColumn('purchases', 'category', "TEXT NOT NULL DEFAULT 'groceries'");
addColumn('purchases', 'deleted_at', 'TEXT');
addColumn('purchases', 'client_uid', 'TEXT');
// A monster drawn from what was bought (optional, on request)
addColumn('purchases', 'monster_file', 'TEXT');
addColumn('purchases', 'monster_name', 'TEXT');
addColumn('purchases', 'monster_bio', 'TEXT');
addColumn('purchases', 'monster_status', 'TEXT'); // null, 'pending', 'error' or 'no_access'
// A restart mid-drawing leaves nothing running: let the phones offer a retry
db.prepare("UPDATE purchases SET monster_status = 'error' WHERE monster_status = 'pending'").run();
// Evening things out by hand, outside the app.
// transfer: payer gave receiver money (counts for the payer, against the receiver).
// expense: payer covered a shared cost outside the app, like bills (counts for the payer only).
db.exec(`
  CREATE TABLE IF NOT EXISTS settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payer_id INTEGER NOT NULL REFERENCES people(id),
    receiver_id INTEGER REFERENCES people(id),
    amount REAL NOT NULL,
    note TEXT,
    settled_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS items_client_uid ON items(client_uid) WHERE client_uid IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS purchases_client_uid ON purchases(client_uid) WHERE client_uid IS NOT NULL;
`);

const now = () => new Date().toISOString();

if (!db.prepare('SELECT 1 FROM lists LIMIT 1').get()) {
  db.prepare('INSERT INTO lists (id, name, position, created_at) VALUES (1, ?, 0, ?)').run(LANGUAGES.en.defaultList, now());
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// "  Milk ×2 " -> "milk"
const itemKey = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');

// ---------- Sections: rules first, ChatGPT for the rest ----------
const SECTION_RULES = [
  ['produce', /עגבני|מלפפו|בצל|שום|תפוח|בננ|תפוז|לימון|אבוקדו|גזר|חסה|פלפל|קישוא|חציל|ענב|תות|אבטיח|מלון|ירק|פטרוזיל|כוסבר|שמיר|נענע|פטריות|תפו"א|בטטה|כרוב|ברוקולי|tomato|cucumber|onion|garlic|apple|banana|orange|lemon|avocado|carrot|lettuce|pepper|potato|fruit|veg|herb|mushroom/i],
  ['bakery', /לחם|פית|לחמני|בגט|חלה|מאפ|עוג|קרואסו|bread|pita|bagel|bun|baguette|cake|croissant/i],
  ['dairy', /חלב|ביצ|גבינ|יוגורט|שמנת|חמאה|קוטג|לבנה|מעדן|milk|egg|cheese|yogurt|yoghurt|cream|butter|cottage/i],
  ['meat', /בשר|עוף|חזה|שניצל|טחון|דג|סלמון|טונה טרי|נקניק|כבד|הודו|chicken|beef|meat|fish|salmon|sausage|turkey/i],
  ['frozen', /קפוא|גלידה|שלגון|frozen|ice cream/i],
  ['pantry', /אורז|פסטה|קמח|סוכר|מלח|שמן|רוטב|שימור|טונה|קטניות|עדשים|חומוס|תבלין|קפה|תה|דגני|קורנפלקס|ממרח|ריבה|דבש|טחינה|rice|pasta|flour|sugar|salt|oil|sauce|canned|tuna|beans|lentil|spice|coffee|tea|cereal|jam|honey|nuts|אגוז|שקדים/i],
  ['snacks', /חטיף|במבה|ביסלי|שוקולד|ממתק|עוגיות|קרקר|צ'יפס|snack|chocolate|candy|cookie|cracker|chips/i],
  ['drinks', /מים|מיץ|קולה|סודה|בירה|יין|משקה|water|juice|cola|soda|beer|wine|drink/i],
  ['cleaning', /נייר טואלט|מגבו|אקונומיקה|סבון כלים|ניקוי|כביסה|מרכך|שקיות זבל|ספוג|toilet paper|paper towel|bleach|detergent|dish soap|laundry|cleaner|trash bag|sponge/i],
  ['pharm', /שמפו|מרכך שיער|משחת שיניים|מברשת שיניים|דאודורנט|סבון גוף|קרם|תרופ|ויטמין|אקמול|פלסטר|shampoo|toothpaste|toothbrush|deodorant|body wash|vitamin|medicine|pharm/i],
  ['baby', /חיתול|מגבונים|תמ"ל|מטרנה|diaper|wipes|formula/i],
  ['home', /סוללות|נורה|batter|bulb/i],
];

function ruleSection(name) {
  for (const [section, re] of SECTION_RULES) if (re.test(name)) return section;
  return null;
}

async function aiSection(name) {
  if (!apiKey()) return null;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: model(),
      messages: [{
        role: 'user',
        content: `Which supermarket section does this shopping-list item belong to? Item: "${name}". `
          + `Sections: ${SECTIONS.map(([k, names]) => `${k} (${names.en})`).join(', ')}.`,
      }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'section',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['section'],
            properties: { section: { type: 'string', enum: SECTION_KEYS } },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  return JSON.parse(body.choices[0].message.content).section;
}

// Fill in a section for an item in the background, then tell the phones
function classifyLater(itemId, name) {
  aiSection(name)
    .then((section) => {
      if (!section) return;
      db.prepare('UPDATE items SET section = ? WHERE id = ? AND section IS NULL').run(section, itemId);
      db.prepare('UPDATE catalog SET section = COALESCE(section, ?) WHERE key = ?').run(section, itemKey(name));
      broadcast('items');
    })
    .catch((e) => console.error('Section AI failed:', e.message));
}

function touchCatalog(name, listId, section) {
  db.prepare(`
    INSERT INTO catalog (key, name, section, list_id, uses, last_used) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, list_id = excluded.list_id,
      section = COALESCE(excluded.section, catalog.section), uses = catalog.uses + 1, last_used = excluded.last_used
  `).run(itemKey(name), name.trim(), section, listId, now());
}

// ---------- Daily database backup ----------
// The live DB stays in a Docker volume (SQLite doesn't like Windows bind mounts);
// a consistent copy is written to the PC once a day.
function backupDb() {
  if (!BACKUP_DIR) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `shopping-${localDay()}.db`);
    fs.rmSync(file, { force: true });
    db.prepare('VACUUM INTO ?').run(file);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^shopping-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of old.slice(0, -BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    console.log(`Database backed up to ${file}`);
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

// Soft-deleted rows stay for undo, then go for good
function purgeDeleted() {
  const cutoff = new Date(Date.now() - UNDO_KEEP_MS).toISOString();
  const files = db.prepare('SELECT receipt_file, monster_file FROM purchases WHERE deleted_at < ?').all(cutoff)
    .flatMap((r) => [r.receipt_file, r.monster_file]).filter(Boolean);
  tx(() => {
    db.prepare('DELETE FROM items WHERE deleted_at < ?').run(cutoff);
    db.prepare('UPDATE items SET purchase_id = NULL WHERE purchase_id IN (SELECT id FROM purchases WHERE deleted_at < ?)').run(cutoff);
    db.prepare('DELETE FROM purchases WHERE deleted_at < ?').run(cutoff);
    db.prepare('DELETE FROM lists WHERE deleted_at < ?').run(cutoff);
    db.prepare('DELETE FROM saved_sets WHERE deleted_at < ?').run(cutoff);
    db.prepare('DELETE FROM settlements WHERE deleted_at < ?').run(cutoff);
  });
  for (const f of files) fs.rm(path.join(RECEIPTS_DIR, f), { force: true }, () => {});
}

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(what) {
  const msg = `data: ${JSON.stringify({ what, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- Access log ----------
// One JSON object per line, one file per day: logs/access-YYYY-MM-DD.log
fs.mkdirSync(LOG_DIR, { recursive: true });
let logDay = '';
let logStream = null;

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeAccessLog(entry) {
  const day = localDay();
  if (day !== logDay) {
    logStream?.end();
    logDay = day;
    logStream = fs.createWriteStream(path.join(LOG_DIR, `access-${day}.log`), { flags: 'a' });
    const cutoff = localDay(new Date(Date.now() - LOG_KEEP_DAYS * 86400000));
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
    }
  }
  logStream.write(`${JSON.stringify(entry)}\n`);
}

const personName = (id) => (id ? db.prepare('SELECT name FROM people WHERE id = ?').get(id)?.name ?? null : null);

function accessLog(req, res, next) {
  const start = process.hrtime.bigint();
  const startedAt = new Date();
  const remoteIp = req.socket.remoteAddress; // gone by the time a long request closes
  let logged = false;

  const done = () => {
    if (logged) return;
    logged = true;
    const h = req.headers;
    const personId = Number(h['x-person-id']) || null;
    const entry = {
      time: startedAt.toISOString(),
      local_time: startedAt.toLocaleString('sv-SE'),
      remote_ip: remoteIp,
      forwarded_for: h['x-forwarded-for'] || null,
      forwarded_proto: h['x-forwarded-proto'] || null,
      // Set by `tailscale serve`: which Tailscale account made the request
      tailscale_user: h['tailscale-user-login'] || null,
      tailscale_name: h['tailscale-user-name'] || null,
      app_person_id: personId,
      app_person: personName(personId),
      method: req.method,
      url: req.originalUrl,
      http_version: req.httpVersion,
      host: h.host || null,
      status: res.statusCode,
      completed: res.writableFinished,
      duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
      request_bytes: Number(h['content-length']) || 0,
      response_bytes: Number(res.getHeader('content-length')) || null,
      content_type: h['content-type'] || null,
      user_agent: h['user-agent'] || null,
      referer: h.referer || null,
      accept_language: h['accept-language'] || null,
    };
    if (req.file) entry.upload = { field: req.file.fieldname, mimetype: req.file.mimetype, size: req.file.size };
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.body && Object.keys(req.body).length) {
      // Never write an API key to the log
      const safe = 'apiKey' in req.body ? { ...req.body, apiKey: req.body.apiKey ? '[redacted]' : '' } : req.body;
      const body = JSON.stringify(safe);
      entry.body = body.length > 4000 ? `${body.slice(0, 4000)}…` : safe;
    }
    if (res.locals.error) entry.error = res.locals.error;
    try {
      writeAccessLog(entry);
    } catch (e) {
      console.error('Access log write failed:', e.message);
    }
  };

  res.on('finish', done);
  res.on('close', done); // aborted requests and closed live-update streams
  next();
}

backupDb();
purgeDeleted();
setInterval(backupDb, 24 * 60 * 60 * 1000);
setInterval(purgeDeleted, 60 * 60 * 1000);

// ---------- App ----------
const app = express();
app.use(accessLog);
app.use(express.json({ limit: '1mb' }));
// The service worker and page must always be revalidated so updates reach the phones
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// Self-hosted web fonts (npm @fontsource packages)
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource'), { maxAge: '30d' }));
app.use('/receipts', express.static(RECEIPTS_DIR, { maxAge: '30d', immutable: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out instanceof Promise) out.catch((e) => fail(res, e));
  } catch (e) {
    fail(res, e);
  }
};
function fail(res, e) {
  console.error(e);
  res.locals.error = e.message;
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
}
function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}
const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Boolean) : []);
const placeholders = (arr) => arr.map(() => '?').join(',');

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

function configJson() {
  const stored = getSetting('openai_api_key');
  return {
    setupDone: setupDone(),
    language: lang(),
    currency: currency(),
    aiEnabled: Boolean(apiKey()),
    sections: labelled(SECTIONS, lang()),
    categories: labelled(CATEGORIES, lang()),
    ai: {
      // The key itself never leaves the server
      keySource: env('OPENAI_API_KEY') ? 'env' : stored ? 'settings' : null,
      keyHint: stored ? `…${stored.slice(-4)}` : null,
      model: model(),
      modelStrong: modelStrong(),
      modelFromEnv: Boolean(env('OPENAI_MODEL')),
      modelStrongFromEnv: Boolean(env('OPENAI_MODEL_STRONG')),
    },
  };
}

app.get('/api/config', (req, res) => res.json(configJson()));

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const cleanModel = (v) => String(v || '').trim().slice(0, 80);
function checkLanguage(v) {
  if (!LANGUAGES[v]) throw bad('Unknown language');
  return v;
}
function checkCurrency(v) {
  const c = String(v || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a 3-letter code like USD');
  return c;
}

// First run: language, currency, the household's people and (optionally) an OpenAI key.
// Only works once; afterwards the same things change through /api/settings and /api/people.
app.post('/api/setup', wrap((req, res) => {
  if (setupDone()) throw Object.assign(new Error('Already set up'), { status: 409 });
  const language = checkLanguage(req.body?.language);
  const cur = checkCurrency(req.body?.currency);
  const names = [...new Set((Array.isArray(req.body?.people) ? req.body.people : []).map(cleanName).filter(Boolean))];
  if (!names.length) throw bad('Add at least one person');
  const key = String(req.body?.apiKey || '').trim();
  tx(() => {
    setSetting('language', language);
    setSetting('currency', cur);
    if (key) setSetting('openai_api_key', key);
    for (const name of names) {
      if (!db.prepare('SELECT 1 FROM people WHERE name = ?').get(name)) {
        db.prepare('INSERT INTO people (name, created_at) VALUES (?, ?)').run(name, now());
      }
    }
    db.prepare('UPDATE lists SET name = ? WHERE id = 1').run(LANGUAGES[language].defaultList);
    setSetting('setup_done', '1');
  });
  broadcast('people');
  res.json(configJson());
}));

// Settings screen. There are no accounts: anyone who can open the app can change these,
// which is why the app belongs on a home or private network (see README).
app.put('/api/settings', wrap((req, res) => {
  const b = req.body || {};
  tx(() => {
    if (b.language !== undefined) setSetting('language', checkLanguage(b.language));
    if (b.currency !== undefined) setSetting('currency', checkCurrency(b.currency));
    if (b.apiKey !== undefined) setSetting('openai_api_key', String(b.apiKey || '').trim());
    if (b.model !== undefined) setSetting('openai_model', cleanModel(b.model));
    if (b.modelStrong !== undefined) setSetting('openai_model_strong', cleanModel(b.modelStrong));
  });
  broadcast('config');
  res.json(configJson());
}));

// Checks a key (the one typed, or the saved one) with a tiny request
app.post('/api/settings/test-key', wrap(async (req, res) => {
  const key = String(req.body?.apiKey || '').trim() || apiKey();
  if (!key) throw bad('No key to test');
  try {
    await askOpenAI({
      key,
      model: model(),
      content: 'Reply with ok set to true.',
      name: 'ping',
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      timeout: 30000,
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
}));

// People
app.get('/api/people', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM people ORDER BY id').all());
});

app.post('/api/people', wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw bad('Name is required');
  const existing = db.prepare('SELECT id, name FROM people WHERE name = ?').get(name);
  if (existing) return res.json(existing);
  const r = db.prepare('INSERT INTO people (name, created_at) VALUES (?, ?)').run(name, now());
  broadcast('people');
  res.json({ id: Number(r.lastInsertRowid), name });
}));

app.patch('/api/people/:id', wrap((req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) throw bad('Name is required');
  const id = Number(req.params.id);
  const other = db.prepare('SELECT id FROM people WHERE name = ? AND id != ?').get(name, id);
  if (other) throw bad('Someone already has that name');
  db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, id);
  broadcast('people');
  res.json({ id, name });
}));

// Lists
app.get('/api/lists', (req, res) => {
  res.json(db.prepare('SELECT id, name, position FROM lists WHERE deleted_at IS NULL ORDER BY position, id').all());
});

app.post('/api/lists', wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw bad('List name is required');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lists').get().p;
  const r = db.prepare('INSERT INTO lists (name, position, created_at) VALUES (?, ?, ?)').run(name, pos, now());
  broadcast('lists');
  res.json({ id: Number(r.lastInsertRowid), name });
}));

app.patch('/api/lists/:id', wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw bad('List name is required');
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  broadcast('lists');
  res.json({ ok: true });
}));

app.delete('/api/lists/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const live = db.prepare('SELECT COUNT(*) AS n FROM lists WHERE deleted_at IS NULL').get().n;
  if (live <= 1) throw bad('Cannot delete the last list');
  const at = now();
  const itemIds = db.prepare('SELECT id FROM items WHERE list_id = ? AND purchase_id IS NULL AND deleted_at IS NULL').all(id).map((r) => r.id);
  tx(() => {
    db.prepare('UPDATE lists SET deleted_at = ? WHERE id = ?').run(at, id);
    db.prepare('UPDATE items SET deleted_at = ? WHERE list_id = ? AND purchase_id IS NULL AND deleted_at IS NULL').run(at, id);
  });
  broadcast('lists');
  res.json({ undo: { type: 'list', id, itemIds } });
}));

// Shopping list items (all lists; the phones filter)
const openItems = () => db.prepare(`
  SELECT i.id, i.name, i.note, i.quantity, i.section, i.list_id, i.created_at, i.added_by,
    p.name AS added_by_name,
    (SELECT rl.price FROM receipt_lines rl JOIN purchases pu ON pu.id = rl.purchase_id
       WHERE rl.item_key = lower(trim(i.name)) AND rl.price IS NOT NULL AND pu.deleted_at IS NULL
       ORDER BY pu.purchased_at DESC LIMIT 1) AS last_price
  FROM items i LEFT JOIN people p ON p.id = i.added_by
  WHERE i.purchase_id IS NULL AND i.deleted_at IS NULL
  ORDER BY i.id
`).all();

app.get('/api/items', (req, res) => res.json(openItems()));

app.post('/api/items', wrap((req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw bad('Item name is required');
  const qty = Math.max(1, Math.min(99, Number(b.quantity) || 1));
  const listId = Number(b.list_id) || 1;
  const uid = b.client_uid ? String(b.client_uid) : null;

  // Offline retries send the same uid: answer with what was already created
  if (uid) {
    const seen = db.prepare('SELECT id, quantity FROM items WHERE client_uid = ?').get(uid);
    if (seen) return res.json({ id: seen.id, quantity: seen.quantity, replay: true });
  }

  // Same thing already on this list: bump its quantity instead of adding a copy
  const dup = db.prepare(`
    SELECT id, quantity FROM items
    WHERE list_id = ? AND purchase_id IS NULL AND deleted_at IS NULL AND lower(trim(name)) = ?
  `).get(listId, itemKey(name));
  if (dup) {
    const quantity = Math.min(99, dup.quantity + qty);
    db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(quantity, dup.id);
    touchCatalog(name, listId, null);
    broadcast('items');
    return res.json({ id: dup.id, merged: true, quantity });
  }

  const known = db.prepare('SELECT section FROM catalog WHERE key = ?').get(itemKey(name));
  const section = SECTION_KEYS.includes(b.section) ? b.section : (known?.section || ruleSection(name));
  const r = db.prepare(`
    INSERT INTO items (name, note, quantity, section, list_id, added_by, created_at, client_uid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, String(b.note || '').trim() || null, qty, section, listId, Number(b.added_by) || null, now(), uid);
  const id = Number(r.lastInsertRowid);
  touchCatalog(name, listId, section);
  if (!section) classifyLater(id, name);
  broadcast('items');
  res.json({ id, quantity: qty });
}));

app.patch('/api/items/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!cur) throw bad('Item not found');
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : cur.name;
  if (!name) throw bad('Item name is required');
  const note = b.note !== undefined ? (String(b.note || '').trim() || null) : cur.note;
  const quantity = b.quantity !== undefined ? Math.max(1, Math.min(99, Number(b.quantity) || 1)) : cur.quantity;
  const section = b.section !== undefined && SECTION_KEYS.includes(b.section) ? b.section : cur.section;
  const listId = b.list_id !== undefined ? Number(b.list_id) || cur.list_id : cur.list_id;
  db.prepare('UPDATE items SET name = ?, note = ?, quantity = ?, section = ?, list_id = ? WHERE id = ?')
    .run(name, note, quantity, section, listId, id);
  // A section picked by hand is remembered for next time
  if (b.section !== undefined && section) {
    db.prepare('UPDATE catalog SET section = ? WHERE key = ?').run(section, itemKey(name));
  }
  if (name !== cur.name) touchCatalog(name, listId, section);
  broadcast('items');
  res.json({ ok: true });
}));

function softDeleteItems(itemIds) {
  const at = now();
  const stmt = db.prepare('UPDATE items SET deleted_at = ? WHERE id = ? AND purchase_id IS NULL AND deleted_at IS NULL');
  const done = [];
  tx(() => {
    for (const id of itemIds) if (Number(stmt.run(at, id).changes)) done.push(id);
  });
  return done;
}

app.delete('/api/items/:id', wrap((req, res) => {
  const done = softDeleteItems([Number(req.params.id)]);
  broadcast('items');
  res.json({ undo: { type: 'items', ids: done } });
}));

// Delete several list items at once (only items still on the list)
app.post('/api/items/delete', wrap((req, res) => {
  const list = ids(req.body?.ids);
  if (!list.length) throw bad('No items selected');
  const done = softDeleteItems(list);
  broadcast('items');
  res.json({ deleted: done.length, undo: { type: 'items', ids: done } });
}));

// Everything ever added, for suggestions while typing
app.get('/api/catalog', (req, res) => {
  res.json(db.prepare('SELECT key, name, section, list_id, uses, last_used FROM catalog ORDER BY uses DESC, last_used DESC LIMIT 1000').all());
});

app.delete('/api/catalog/:key', wrap((req, res) => {
  db.prepare('DELETE FROM catalog WHERE key = ?').run(String(req.params.key));
  res.json({ ok: true });
}));

// Price history for one item name
app.get('/api/prices', wrap((req, res) => {
  const key = itemKey(req.query.name || '');
  res.json(db.prepare(`
    SELECT rl.name, rl.price, pu.store, pu.purchased_at
    FROM receipt_lines rl JOIN purchases pu ON pu.id = rl.purchase_id
    WHERE rl.item_key = ? AND rl.price IS NOT NULL AND pu.deleted_at IS NULL
    ORDER BY pu.purchased_at DESC LIMIT 20
  `).all(key));
}));

// Receipt upload (+ optional AI reading)
app.post('/api/receipt', upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) throw bad('No photo uploaded');
  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const file = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(RECEIPTS_DIR, file), req.file.buffer);

  const result = { file, ai: null, aiError: null };
  if (req.query.scan === '1') {
    if (!apiKey()) {
      result.aiError = 'not_configured';
    } else {
      try {
        result.ai = await readReceipt(req.file.buffer, req.file.mimetype, openItems(), req.query.strong === '1');
      } catch (e) {
        console.error('Receipt AI failed:', e.message);
        result.aiError = e.message;
      }
    }
  }
  res.json(result);
}));

// Read a receipt photo that was already uploaded (the phone reads after choosing basic or careful)
app.post('/api/receipt/scan', wrap(async (req, res) => {
  const file = String(req.body?.file || '');
  if (!/^[0-9a-f-]{36}\.(jpg|png)$/.test(file)) throw bad('Bad file');
  const full = path.join(RECEIPTS_DIR, file);
  if (!fs.existsSync(full)) throw bad('Bad file');
  if (!apiKey()) return res.json({ file, ai: null, aiError: 'not_configured' });
  // kind 'products': a photo of the groceries themselves instead of a receipt
  const products = req.body?.kind === 'products';
  try {
    const read = products ? readProducts : readReceipt;
    const ai = await read(fs.readFileSync(full), file.endsWith('.png') ? 'image/png' : 'image/jpeg', openItems(), req.body?.strong === true);
    res.json({ file, ai, aiError: null });
  } catch (e) {
    console.error(products ? 'Products AI failed:' : 'Receipt AI failed:', e.message);
    res.json({ file, ai: null, aiError: e.message });
  }
}));

// Why a receipt reading looks wrong, or null when it adds up
function receiptProblem(r) {
  if (!r.is_receipt) return 'not_receipt';
  if (r.total == null) return 'no_total';
  if (!r.items.length) return 'no_items';
  if (r.items.some((i) => i.price == null)) return 'missing_price';
  const sum = r.items.reduce((a, i) => a + i.price, 0);
  const slack = Math.max(1, r.total * 0.01);
  if (Math.abs(sum - r.total) <= slack || Math.abs(sum - (r.discount || 0) - r.total) <= slack) return null;
  return 'sum_mismatch';
}

async function readReceipt(buffer, mimetype, listItems, strong = false) {
  const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const listText = listItems.length
    ? listItems.map((i) => `${i.id}: ${i.name}${i.note ? ` (${i.note})` : ''}`).join('\n')
    : '(empty)';

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['is_receipt', 'store', 'total', 'discount', 'date', 'items', 'matches'],
    properties: {
      is_receipt: { type: 'boolean' },
      store: { type: ['string', 'null'] },
      total: { type: ['number', 'null'] },
      discount: { type: ['number', 'null'] },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'price'],
          properties: { name: { type: 'string' }, price: { type: ['number', 'null'] } },
        },
      },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item_id', 'line_index'],
          properties: { item_id: { type: 'integer' }, line_index: { type: 'integer' } },
        },
      },
    },
  };

  const prompt = `You read records of shopping purchases. Amounts are in ${currency()} unless the image clearly shows another currency.
The image can be a paper receipt, or a screenshot or photo of an online or delivery order
(order summary, order items list, cart, confirmation, invoice or email from a delivery app or a store's website).
Treat all of these the same way. Extract from the image:
- is_receipt: true if the image lists bought items with prices, in any of the forms above.
  false only if it is not a purchase record at all (e.g. a photo of the products themselves, or an unrelated picture).
- store: store / chain / restaurant name, or null.
- total: the final amount paid (after discounts) as printed in the image, or null if no total is shown or it is unreadable. Do not add it up yourself.
- discount: the sum of whole-receipt discounts and rounding NOT already in the line prices, as a positive number, or null if none.
- date: purchase date as YYYY-MM-DD, or null if no date is shown. Do not guess.
- items: each purchased line item with its final price for the quantity bought (after line discounts).
  Include delivery and service fees as their own lines when they are shown. Keep item names in the image's language.
- matches: for each item on the shopping list below that was bought on this receipt,
  its id and line_index = the 0-based index in your items array of the line that matched it.
  Match by meaning, not spelling: the list uses short generic names, the receipt uses brand/size/variant names
  (e.g. "milk" matches "Whole Milk 3% 1L", "eggs" matches "organic eggs L", "nuts" matches "mixed nuts 100g").
  Only include confident matches; each list item at most once.

Shopping list (id: name):
${listText}`;

  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
  ];
  const usedModel = strong ? modelStrong() : model();
  const parsed = await askOpenAI({ model: usedModel, content, name: 'receipt', schema });
  if (!parsed.is_receipt) throw new Error('not_a_receipt');
  const validIds = new Set(listItems.map((i) => i.id));
  const seen = new Set();
  parsed.matches = parsed.matches
    .filter((m) => validIds.has(m.item_id) && parsed.items[m.line_index] && !seen.has(m.item_id) && seen.add(m.item_id))
    .map((m) => ({ ...m, receipt_line: parsed.items[m.line_index].name }));
  // Order screenshots often show only line prices: the total is then their sum
  if (parsed.total == null && parsed.items.length && parsed.items.every((i) => i.price != null)) {
    const sum = parsed.items.reduce((a, i) => a + i.price, 0) - (parsed.discount || 0);
    parsed.total = Math.round(sum * 100) / 100;
    parsed.total_summed = true;
  }
  // Lets the phone suggest the stronger model when the numbers don't add up
  return { ...parsed, model: usedModel, problem: receiptProblem(parsed) };
}

// A photo of the groceries themselves (no receipt): name what is in it and tick what was on the list
async function readProducts(buffer, mimetype, listItems, strong = false) {
  const L = LANGUAGES[lang()];
  const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const listText = listItems.length
    ? listItems.map((i) => `${i.id}: ${i.name}${i.note ? ` (${i.note})` : ''}`).join('\n')
    : '(empty)';

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['has_products', 'items', 'matches'],
    properties: {
      has_products: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'quantity'],
          properties: { name: { type: 'string' }, quantity: { type: 'integer' } },
        },
      },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item_id', 'line_index'],
          properties: { item_id: { type: 'integer' }, line_index: { type: 'integer' } },
        },
      },
    },
  };

  const prompt = `You look at a photo of groceries or household products that someone just brought home.
Write product names in ${L.name}.
- has_products: false if the photo shows no groceries or household products.
- items: each distinct product you can see, once. Name it the way it would be written on a shopping list:
  short and generic ${L.products}, usually one to three words.
  Never put sizes, weights, volumes, fat percentages or unit counts in the name ${L.noSizes}.
  Add a variant only when it is a different product on a shopping list ${L.variants}. Read the labels on packages.
  quantity: how many units of that product are visible (packages, bottles, or loose fruit/vegetables); 1 if unsure.
  Skip bags, boxes and other packaging that are not products, and anything you cannot identify.
- matches: for each item on the shopping list below that you can see in the photo,
  its id and line_index = the 0-based index in your items array of the product that matched it.
  Match by meaning, not spelling ("tomatoes" matches "cherry tomatoes", "eggs" matches a carton of eggs).
  Only include confident matches; each list item at most once.

Shopping list (id: name):
${listText}`;

  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
  ];
  const usedModel = strong ? modelStrong() : model();
  const parsed = await askOpenAI({ model: usedModel, content, name: 'products', schema });
  // Drop unnamed entries, keeping each match pointed at the same product
  const items = [];
  const newIndex = new Map();
  parsed.items.forEach((it, idx) => {
    const name = String(it.name || '').trim().slice(0, 80);
    if (!name) return;
    newIndex.set(idx, items.length);
    items.push({ name, quantity: Math.min(99, Math.max(1, it.quantity || 1)) });
  });
  if (!parsed.has_products || !items.length) throw new Error('no_products');
  const validIds = new Set(listItems.map((i) => i.id));
  const seen = new Set();
  const matches = parsed.matches
    .filter((m) => validIds.has(m.item_id) && newIndex.has(m.line_index) && !seen.has(m.item_id) && seen.add(m.item_id))
    .map((m) => ({ item_id: m.item_id, line_index: newIndex.get(m.line_index), receipt_line: items[newIndex.get(m.line_index)].name }));
  return { kind: 'products', store: null, total: null, date: null, items: items.map((it) => ({ ...it, price: null })), matches, model: usedModel, problem: null };
}

// ---------- Import a shopping list: note photo, recipe link, or pasted text ----------
// The server fetches links for the phone, so it must not be pointed at the home network
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); // last: Tailscale
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const PAGE_MAX_BYTES = 3 * 1024 * 1024;

async function fetchPage(link) {
  let url;
  try { url = new URL(link); } catch { throw bad('bad_address'); }
  for (let hop = 0; hop < 5; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw bad('bad_address');
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw bad('page_unreachable');
    if (addrs.some((a) => privateAddress(a.address))) throw bad('bad_address');
    let resp;
    try {
      resp = await fetch(url, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'he,en;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw bad('page_unreachable');
    }
    const next = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    if (resp.status === 401 || resp.status === 403 || resp.status === 429) throw bad('page_blocked');
    if (!resp.ok) throw bad('page_unreachable');

    const chunks = [];
    let size = 0;
    for await (const chunk of resp.body) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > PAGE_MAX_BYTES) break;
    }
    const charset = /charset=([\w-]+)/i.exec(resp.headers.get('content-type') || '')?.[1] || 'utf-8';
    let decoder;
    try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
    return decoder.decode(Buffer.concat(chunks));
  }
  throw bad('page_unreachable');
}

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

// Most recipe sites publish schema.org Recipe data: exact ingredients, no ads or comments
function recipeFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const find = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean) || null;
    const type = [].concat(node['@type'] || []);
    if (type.includes('Recipe') && Array.isArray(node.recipeIngredient) && node.recipeIngredient.length) return node;
    return find(node['@graph']) || find(node.mainEntity);
  };
  for (const [, json] of html.matchAll(re)) {
    try {
      const r = find(JSON.parse(json.trim()));
      if (r) {
        return {
          title: decodeEntities(String(r.name || '')),
          servings: [].concat(r.recipeYield || []).map(String).join(' '),
          ingredients: r.recipeIngredient.map((x) => decodeEntities(String(x))),
        };
      }
    } catch { /* not valid JSON, try the next block */ }
  }
  return null;
}

function pageText(html) {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  const body = decodeEntities(html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|li|h\d|br|tr|ul|ol|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title, text: body.slice(0, 40000) };
}

// recipe: a recipe link, so pantry staples start unticked; otherwise someone's own list
async function extractList({ text, image, recipe = false, strong = false }) {
  const known = db.prepare('SELECT name FROM catalog ORDER BY uses DESC LIMIT 300').all().map((r) => r.name);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['is_list', 'title', 'servings', 'items'],
    properties: {
      is_list: { type: 'boolean' },
      title: { type: ['string', 'null'] },
      servings: { type: ['integer', 'null'] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'quantity', 'note', 'staple'],
          properties: {
            name: { type: 'string' },
            quantity: { type: 'integer' },
            note: { type: ['string', 'null'] },
            staple: { type: 'boolean' },
          },
        },
      },
    },
  };

  const L = LANGUAGES[lang()];
  const prompt = `You turn a source into a shopping list for a household whose list is written in ${L.name}.
The source is a photo of a handwritten or printed note, a recipe from a web page, or pasted text.
- is_list: false if there is nothing to buy in it.
- title: a short ${L.name} name for this list (for a recipe, the dish), or null.
- servings: for a recipe, how many portions it makes (from its yield), else null.
- items: one entry per thing to buy.
  - name: a short, generic ${L.name} name as people write on a shopping list ${L.examples}.
    Translate if the source is in another language. Merge repeats (onion used in two steps = one item).
    Read handwriting carefully; keep the writer's words when they are already a shopping-list name.
  - quantity: how many packages to buy, an integer.
    Recipe: always 1; the amount the recipe uses goes in note (3 eggs = quantity 1, note ${L.recipeNote}).
    Written list: a count written by the item is the quantity (${L.counts} = quantity 2); else 1.
  - note: recipe: the amount it needs in ${L.name} ${L.amounts}. Written list: any other detail written by the item. null if none.
  - staple: recipe only, and only for: salt, black pepper, cooking oil, olive oil, sugar, flour, baking powder,
    baking soda, vinegar, dried spices. Everything else is false (eggs, milk, butter, garlic, onion, produce are not staples).
    Always false for a written list: whoever wrote it needs it.
  Leave out tap water and kitchen equipment.
When the household already uses a name for the same thing, use that exact name. Names they use:
${known.length ? known.join(', ') : '(none yet)'}`;

  const content = [{ type: 'text', text: prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: image, detail: 'high' } });
  else content.push({ type: 'text', text: `Source:\n${text}` });

  const parsed = await askOpenAI({
    model: strong ? modelStrong() : model(),
    content, name: 'shopping_list', schema,
  });
  const items = (parsed.items || [])
    .map((i) => ({
      ...i,
      name: String(i.name).trim(),
      quantity: Math.max(1, Math.min(99, i.quantity || 1)),
      staple: recipe && i.staple,
    }))
    .filter((i) => i.name);
  if (!parsed.is_list || !items.length) throw bad('nothing_found');
  const servings = recipe && parsed.servings > 0 ? Math.min(99, parsed.servings) : null;
  return { title: parsed.title, servings, items };
}

app.post('/api/import', upload.single('photo'), wrap(async (req, res) => {
  if (!apiKey()) throw bad('not_configured');
  const strong = req.body?.strong === '1' || req.body?.strong === true;
  if (req.file) {
    const image = `data:${req.file.mimetype || 'image/jpeg'};base64,${req.file.buffer.toString('base64')}`;
    return res.json({ ...(await extractList({ image, strong })), source: 'photo' });
  }
  const input = String(req.body?.text || '').trim();
  if (!input) throw bad('nothing_found');
  // A shared link often arrives as "Recipe name https://…": short text with one link = the link
  const links = input.match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (links.length === 1 && input.length < 400) {
    const html = await fetchPage(links[0]);
    const recipe = recipeFromJsonLd(html);
    const page = recipe ? null : pageText(html);
    const text = recipe
      ? `Recipe: ${recipe.title}\nYield: ${recipe.servings || 'unknown'}\nIngredients:\n${recipe.ingredients.join('\n')}`
      : `Web page: ${page.title}\n\n${page.text}`;
    return res.json({
      ...(await extractList({ text, recipe: true, strong })),
      source: recipe ? 'recipe' : 'page',
      source_url: links[0],
    });
  }
  res.json({ ...(await extractList({ text: input.slice(0, 20000), strong })), source: 'text' });
}));

// ---------- Saved recipes and recurring batches ----------
const SAVED_KINDS = ['recipe', 'batch'];

// Last used first, so the regulars sit at the top
function savedSets() {
  const sets = db.prepare(`
    SELECT id, kind, name, source_url, servings, notes, uses, last_used, created_at
    FROM saved_sets WHERE deleted_at IS NULL
    ORDER BY last_used IS NULL, last_used DESC, created_at DESC
  `).all();
  const byId = new Map(sets.map((s) => [s.id, Object.assign(s, { items: [] })]));
  for (const i of db.prepare('SELECT set_id, name, amount, quantity, staple FROM saved_items ORDER BY set_id, position').all()) {
    byId.get(i.set_id)?.items.push({ name: i.name, amount: i.amount, quantity: i.quantity, staple: Boolean(i.staple) });
  }
  return sets;
}

function savedFields(b) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('Name is required');
  const items = (Array.isArray(b.items) ? b.items : [])
    .map((i) => ({
      name: String(i?.name || '').trim(),
      amount: String(i?.amount || '').trim() || null,
      quantity: Math.max(1, Math.min(99, Number(i?.quantity) || 1)),
      staple: i?.staple ? 1 : 0,
    }))
    .filter((i) => i.name);
  if (!items.length) throw bad('Add at least one item');
  const url = String(b.source_url || '').trim();
  return {
    kind: SAVED_KINDS.includes(b.kind) ? b.kind : 'recipe',
    name,
    source_url: /^https?:\/\//i.test(url) ? url : null,
    servings: Number(b.servings) > 0 ? Math.min(99, Math.round(Number(b.servings))) : null,
    notes: String(b.notes || '').trim() || null,
    items,
  };
}

function writeSavedItems(setId, items) {
  db.prepare('DELETE FROM saved_items WHERE set_id = ?').run(setId);
  const ins = db.prepare('INSERT INTO saved_items (set_id, position, name, amount, quantity, staple) VALUES (?, ?, ?, ?, ?, ?)');
  items.forEach((i, pos) => ins.run(setId, pos, i.name, i.amount, i.quantity, i.staple));
}

app.get('/api/saved', (req, res) => res.json(savedSets()));

app.post('/api/saved', wrap((req, res) => {
  const f = savedFields(req.body || {});
  const id = tx(() => {
    const r = db.prepare('INSERT INTO saved_sets (kind, name, source_url, servings, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.kind, f.name, f.source_url, f.servings, f.notes, now());
    const newId = Number(r.lastInsertRowid);
    writeSavedItems(newId, f.items);
    return newId;
  });
  broadcast('saved');
  res.json({ id });
}));

app.put('/api/saved/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM saved_sets WHERE id = ? AND deleted_at IS NULL').get(id)) throw bad('Not found');
  const f = savedFields(req.body || {});
  tx(() => {
    db.prepare('UPDATE saved_sets SET kind = ?, name = ?, source_url = ?, servings = ?, notes = ? WHERE id = ?')
      .run(f.kind, f.name, f.source_url, f.servings, f.notes, id);
    writeSavedItems(id, f.items);
  });
  broadcast('saved');
  res.json({ ok: true });
}));

// Merged into the list
app.post('/api/saved/:id/used', wrap((req, res) => {
  db.prepare('UPDATE saved_sets SET uses = uses + 1, last_used = ? WHERE id = ?').run(now(), Number(req.params.id));
  broadcast('saved');
  res.json({ ok: true });
}));

app.delete('/api/saved/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE saved_sets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
  broadcast('saved');
  res.json({ undo: { type: 'saved', id } });
}));

// Purchases
const purchaseDetails = (purchases) => {
  const itemsStmt = db.prepare('SELECT id, name, quantity FROM items WHERE purchase_id = ? AND deleted_at IS NULL ORDER BY id');
  const linesStmt = db.prepare('SELECT name, price FROM receipt_lines WHERE purchase_id = ? ORDER BY id');
  for (const pu of purchases) {
    pu.items = itemsStmt.all(pu.id);
    pu.lines = linesStmt.all(pu.id);
  }
  return purchases;
};

app.get('/api/purchases', wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const q = String(req.query.q || '').trim();
  const where = ['pu.deleted_at IS NULL'];
  const params = [];
  if (q) {
    const like = `%${q}%`;
    where.push(`(pu.store LIKE ? OR pu.note LIKE ?
      OR EXISTS (SELECT 1 FROM items i WHERE i.purchase_id = pu.id AND i.deleted_at IS NULL AND i.name LIKE ?)
      OR EXISTS (SELECT 1 FROM receipt_lines rl WHERE rl.purchase_id = pu.id AND rl.name LIKE ?))`);
    params.push(like, like, like, like);
  }
  const purchases = db.prepare(`
    SELECT pu.*, p.name AS buyer_name
    FROM purchases pu JOIN people p ON p.id = pu.buyer_id
    WHERE ${where.join(' AND ')}
    ORDER BY pu.purchased_at DESC, pu.id DESC
    LIMIT ?
  `).all(...params, limit);
  res.json(purchaseDetails(purchases));
}));

// Store names that differ only in case, spaces or punctuation ("Freshmart", "FRESH MART", "Fresh-Mart") are one store
const storeKey = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Stores already used, most used first, then most recent; one spelling per store
function knownStores() {
  const rows = db.prepare(`
    SELECT TRIM(store) AS name, COUNT(*) AS n, MAX(purchased_at) AS last FROM purchases
    WHERE deleted_at IS NULL AND store IS NOT NULL AND TRIM(store) != ''
    GROUP BY TRIM(store) ORDER BY n DESC, last DESC
  `).all();
  const seen = new Set();
  return rows.filter((r) => { const k = storeKey(r.name) || r.name; return !seen.has(k) && seen.add(k); }).map((r) => r.name);
}

// A typed or read store name, spelled the way that store was saved before
function canonicalStore(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  const k = storeKey(s);
  return (k && knownStores().find((n) => storeKey(n) === k)) || s;
}

app.get('/api/stores', wrap((req, res) => res.json(knownStores())));

// matchStore: new purchases take the known spelling; an edit keeps exactly what was typed, so a spelling can be corrected
function purchaseFields(b, { matchStore = true } = {}) {
  const buyerId = Number(b.buyer_id);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(buyerId)) throw bad('Unknown buyer');
  const total = Number(b.total);
  if (!Number.isFinite(total) || total < 0) throw bad('Invalid total');
  return {
    buyerId,
    total: Math.round(total * 100) / 100,
    store: matchStore ? canonicalStore(b.store) : String(b.store || '').trim() || null,
    note: String(b.note || '').trim() || null,
    category: CATEGORY_KEYS.includes(b.category) ? b.category : 'groceries',
    purchasedAt: b.purchased_at && !Number.isNaN(Date.parse(b.purchased_at)) ? new Date(b.purchased_at).toISOString() : null,
  };
}

app.post('/api/purchases', wrap((req, res) => {
  const b = req.body || {};
  const f = purchaseFields(b);
  const uid = b.client_uid ? String(b.client_uid) : null;
  if (uid) {
    const seen = db.prepare('SELECT id FROM purchases WHERE client_uid = ?').get(uid);
    if (seen) return res.json({ id: seen.id, replay: true });
  }
  const receiptFile = b.receipt_file && /^[\w-]+\.(jpg|png)$/.test(b.receipt_file) ? b.receipt_file : null;
  const itemIds = ids(b.item_ids);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 300) : [];

  const purchaseId = tx(() => {
    const r = db.prepare(`
      INSERT INTO purchases (buyer_id, total, store, note, category, receipt_file, ai_parsed, purchased_at, created_at, client_uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(f.buyerId, f.total, f.store, f.note, f.category, receiptFile, b.ai_parsed ? 1 : 0, f.purchasedAt || now(), now(), uid);
    const pid = Number(r.lastInsertRowid);
    const mark = db.prepare('UPDATE items SET purchase_id = ? WHERE id = ? AND purchase_id IS NULL AND deleted_at IS NULL');
    for (const id of itemIds) mark.run(pid, id);
    // Receipt lines matched to a list item remember that item's name, for price memory
    const nameOf = db.prepare('SELECT name FROM items WHERE id = ?');
    const addLine = db.prepare('INSERT INTO receipt_lines (purchase_id, name, price, item_key) VALUES (?, ?, ?, ?)');
    for (const l of lines) {
      const lineName = String(l?.name || '').trim();
      if (!lineName) continue;
      const price = Number.isFinite(Number(l.price)) && l.price !== null ? Number(l.price) : null;
      const matched = l.item_id ? nameOf.get(Number(l.item_id)) : null;
      addLine.run(pid, lineName, price, matched ? itemKey(matched.name) : null);
    }
    return pid;
  });
  broadcast('purchases');
  // Asked for while recording: draw it now, in the background
  if (b.monster && apiKey() && monsterIngredients(purchaseId).length) startMonster(purchaseId, b.theme);
  res.json({ id: purchaseId });
}));

// ---------- A monster made of what we bought (on request only) ----------
// One art style per theme
const MONSTER_STYLES = {
  washi: 'a Japanese ukiyo-e woodblock print: flat muted colors, fine black outlines, washi paper texture',
  shire: 'a cozy storybook watercolor with ink linework and warm earthy colors, like an old children\'s fairy-tale book',
};
const monstersRunning = new Set();

// What the monster is built from: the receipt or photo lines, otherwise the list items that were bought
function monsterIngredients(id) {
  const clean = (n) => String(n).replace(/\s*×\d+$/, '').trim();
  const lines = db.prepare('SELECT name FROM receipt_lines WHERE purchase_id = ? ORDER BY id').all(id).map((r) => clean(r.name));
  const items = db.prepare('SELECT name FROM items WHERE purchase_id = ? AND deleted_at IS NULL ORDER BY id').all(id).map((r) => clean(r.name));
  const seen = new Set();
  return (lines.length ? lines : items).filter((n) => n && !seen.has(n) && seen.add(n)).slice(0, 25);
}

function startMonster(id, theme) {
  if (monstersRunning.has(id)) return;
  monstersRunning.add(id);
  db.prepare("UPDATE purchases SET monster_status = 'pending' WHERE id = ?").run(id);
  broadcast('purchases');
  makeMonster(id, MONSTER_STYLES[theme] ? theme : 'shire')
    .catch((e) => {
      console.error('Monster failed:', e.message);
      // A key limited to text can't draw: say so, instead of a generic failure
      const status = /api\.model\.images|insufficient permissions/i.test(e.message) ? 'no_access' : 'error';
      db.prepare('UPDATE purchases SET monster_status = ? WHERE id = ?').run(status, id);
    })
    .finally(() => {
      monstersRunning.delete(id);
      broadcast('purchases');
    });
}

async function makeMonster(id, theme) {
  const ingredients = monsterIngredients(id);
  if (!ingredients.length) throw new Error('Nothing to build a monster from');
  const L = LANGUAGES[lang()];
  // Receipt lines are often brand names or cut short: the list's own names and the store say what the products really are
  const store = db.prepare('SELECT store FROM purchases WHERE id = ?').get(id)?.store;
  const listNames = db.prepare('SELECT name FROM items WHERE purchase_id = ? AND deleted_at IS NULL ORDER BY id').all(id)
    .map((r) => r.name).filter((n) => !ingredients.includes(n)).slice(0, 25);
  const context = [
    store && `Bought at: ${store}`,
    listNames.length && `The same purchase as written on our shopping list: ${listNames.join(', ')}`,
  ].filter(Boolean).join('\n');
  // A cheap text call invents the character; the picture follows its description
  const idea = await askOpenAI({
    model: model(),
    name: 'monster',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['products', 'name', 'bio', 'look'],
      properties: {
        products: { type: 'string', description: 'What each product really is, in plain English' },
        name: { type: 'string' },
        bio: { type: 'string' },
        look: { type: 'string' },
      },
    },
    content: [{ type: 'text', text: `Invent a funny, friendly monster built entirely out of the things bought on one shopping trip:
${ingredients.join(', ')}
${context}

They are not necessarily food: a trip can be to a pharmacy, a hardware store or anywhere else.
- products: first work out what each product really is, in plain English (e.g. "cotton ear swabs", "dish soap", "tomatoes").
  Receipt names are often brand names, abbreviations or cut short, so use the store and the shopping-list names to tell.
  Never turn a non-food product into food, or food into something else.
- name: a playful ${L.name} name, at most 3 words, ideally a pun blending one or two of the products.
- bio: one short funny sentence in natural, everyday ${L.name} (the way a native speaker would joke,
  not a translation), at most 16 words, family friendly. One clear joke about its habits or personality that fits
  what it is made of, for example where in the home it lives or what it's afraid of.
- look: an English description for an illustrator, at most 70 words: which product forms the head, body, arms, legs and eyes,
  and its goofy expression. Use as many of the products as fit, each as the recognizable real thing it is
  (say what it is, e.g. "white cotton swabs", not a brand name).
  Never ask for any text, letters, labels or logos in the picture.` }],
  });
  const picture = await drawImage(`A single goofy, friendly monster made entirely of these real products: ${idea.products}. ${idea.look}
Style: ${MONSTER_STYLES[theme]}. Full body, centered, one character only. No text, no letters, no logos anywhere in the image.`);
  const file = `monster-${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(RECEIPTS_DIR, file), picture);
  const old = db.prepare('SELECT monster_file FROM purchases WHERE id = ?').get(id)?.monster_file;
  db.prepare('UPDATE purchases SET monster_file = ?, monster_name = ?, monster_bio = ?, monster_status = NULL WHERE id = ?')
    .run(file, String(idea.name).slice(0, 60), String(idea.bio).slice(0, 200), id);
  if (old && /^monster-[\w-]+\.jpg$/.test(old)) fs.rm(path.join(RECEIPTS_DIR, old), { force: true }, () => {});
}

// Make (or remake) the monster of a purchase that's already recorded
app.post('/api/purchases/:id/monster', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id)) throw bad('Purchase not found');
  if (!apiKey()) throw bad('AI is not set up');
  if (!monsterIngredients(id).length) throw bad('Nothing in this purchase to build a monster from');
  startMonster(id, req.body?.theme);
  res.json({ ok: true });
}));

app.patch('/api/purchases/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!cur) throw bad('Purchase not found');
  const f = purchaseFields({ ...cur, ...req.body }, { matchStore: false });
  db.prepare('UPDATE purchases SET buyer_id = ?, total = ?, store = ?, note = ?, category = ?, purchased_at = ? WHERE id = ?')
    .run(f.buyerId, f.total, f.store, f.note, f.category, f.purchasedAt || cur.purchased_at, id);
  broadcast('purchases');
  res.json({ ok: true });
}));

app.delete('/api/purchases/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  // Items bought in this purchase go back onto the list (and back again on undo)
  const itemIds = db.prepare('SELECT id FROM items WHERE purchase_id = ? AND deleted_at IS NULL').all(id).map((r) => r.id);
  tx(() => {
    db.prepare('UPDATE purchases SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
    db.prepare('UPDATE items SET purchase_id = NULL WHERE purchase_id = ? AND deleted_at IS NULL').run(id);
  });
  broadcast('purchases');
  res.json({ undo: { type: 'purchase', id, itemIds } });
}));

// Remove one bought item from a purchase's history (the purchase and its total stay)
app.delete('/api/purchases/:pid/items/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE items SET deleted_at = ? WHERE id = ? AND purchase_id = ?').run(now(), id, Number(req.params.pid));
  broadcast('purchases');
  res.json({ undo: { type: 'items', ids: [id] } });
}));

// Undo a delete from the last two days
app.post('/api/undo', wrap((req, res) => {
  const u = req.body || {};
  tx(() => {
    if (u.type === 'items') {
      const list = ids(u.ids);
      if (list.length) db.prepare(`UPDATE items SET deleted_at = NULL WHERE id IN (${placeholders(list)})`).run(...list);
    } else if (u.type === 'purchase') {
      const id = Number(u.id);
      db.prepare('UPDATE purchases SET deleted_at = NULL WHERE id = ?').run(id);
      const list = ids(u.itemIds);
      if (list.length) {
        db.prepare(`UPDATE items SET purchase_id = ? WHERE id IN (${placeholders(list)}) AND purchase_id IS NULL AND deleted_at IS NULL`)
          .run(id, ...list);
      }
    } else if (u.type === 'list') {
      db.prepare('UPDATE lists SET deleted_at = NULL WHERE id = ?').run(Number(u.id));
      const list = ids(u.itemIds);
      if (list.length) db.prepare(`UPDATE items SET deleted_at = NULL WHERE id IN (${placeholders(list)})`).run(...list);
    } else if (u.type === 'saved') {
      db.prepare('UPDATE saved_sets SET deleted_at = NULL WHERE id = ?').run(Number(u.id));
    } else if (u.type === 'settlement') {
      db.prepare('UPDATE settlements SET deleted_at = NULL WHERE id = ?').run(Number(u.id));
    } else {
      throw bad('Unknown undo type');
    }
  });
  broadcast({ list: 'lists', saved: 'saved' }[u.type] || 'items');
  broadcast('purchases');
  res.json({ ok: true });
}));

// Spending summary and insights
app.get('/api/summary', wrap((req, res) => {
  const d = new Date();
  const [y, m] = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month.split('-').map(Number)
    : [d.getFullYear(), d.getMonth() + 1];
  const from = new Date(y, m - 1, 1).toISOString();
  const to = new Date(y, m, 1).toISOString();

  const totals = (where, ...params) => db.prepare(`
    SELECT p.id, p.name,
      COALESCE(SUM(pu.total), 0) AS total,
      COUNT(pu.id) AS count
    FROM people p
    LEFT JOIN purchases pu ON pu.buyer_id = p.id AND pu.deleted_at IS NULL ${where}
    GROUP BY p.id ORDER BY p.id
  `).all(...params);

  // Six months ending at the selected one, per person
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const start = new Date(y, m - 1 - i, 1);
    const end = new Date(y, m - i, 1);
    trend.push({
      month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      people: totals('AND pu.purchased_at >= ? AND pu.purchased_at < ?', start.toISOString(), end.toISOString())
        .map(({ id, total }) => ({ id, total })),
    });
  }

  const byStore = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(store), ''), '—') AS store, SUM(total) AS total, COUNT(*) AS count
    FROM purchases WHERE deleted_at IS NULL AND purchased_at >= ? AND purchased_at < ?
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8
  `).all(from, to);

  const byCategory = db.prepare(`
    SELECT category, SUM(total) AS total, COUNT(*) AS count
    FROM purchases WHERE deleted_at IS NULL AND purchased_at >= ? AND purchased_at < ?
    GROUP BY 1 ORDER BY 2 DESC
  `).all(from, to);

  const allTotals = totals('');
  res.json({
    month: `${y}-${String(m).padStart(2, '0')}`,
    monthTotals: totals('AND pu.purchased_at >= ? AND pu.purchased_at < ?', from, to),
    allTotals,
    ...balanceOf(allTotals),
    trend,
    byStore,
    byCategory,
  });
}));

// ---------- Settling up ----------
const settlementList = () => db.prepare(`
  SELECT s.id, s.kind, s.payer_id, s.receiver_id, s.amount, s.note, s.settled_at,
    p.name AS payer_name, r.name AS receiver_name
  FROM settlements s JOIN people p ON p.id = s.payer_id LEFT JOIN people r ON r.id = s.receiver_id
  WHERE s.deleted_at IS NULL ORDER BY s.settled_at DESC, s.id DESC
`).all();

// Everything each person put in: purchases, plus settlements (a transfer moves money from the receiver's side to the payer's)
function balanceOf(allTotals) {
  const settlements = settlementList();
  const balance = allTotals.map((p) => {
    let settled = 0;
    for (const s of settlements) {
      if (s.payer_id === p.id) settled += s.amount;
      if (s.kind === 'transfer' && s.receiver_id === p.id) settled -= s.amount;
    }
    settled = Math.round(settled * 100) / 100;
    return { id: p.id, name: p.name, purchases: p.total, settled, total: Math.round((p.total + settled) * 100) / 100 };
  });
  return { balance, settlements };
}

app.post('/api/settlements', wrap((req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'transfer' ? 'transfer' : 'expense';
  const payer = Number(b.payer_id);
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(payer)) throw bad('Unknown person');
  let receiver = null;
  if (kind === 'transfer') {
    receiver = Number(b.receiver_id);
    if (receiver === payer || !db.prepare('SELECT 1 FROM people WHERE id = ?').get(receiver)) throw bad('Unknown receiver');
  }
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw bad('Invalid amount');
  const at = b.settled_at && !Number.isNaN(Date.parse(b.settled_at)) ? new Date(b.settled_at).toISOString() : now();
  const r = db.prepare(`
    INSERT INTO settlements (kind, payer_id, receiver_id, amount, note, settled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(kind, payer, receiver, amount, String(b.note || '').trim().slice(0, 200) || null, at, now());
  broadcast('purchases');
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.delete('/api/settlements/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE settlements SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
  broadcast('purchases');
  res.json({ undo: { type: 'settlement', id } });
}));

// CSV export: one row per purchase, opens cleanly in Excel (UTF-8 BOM for Hebrew)
app.get('/api/export.csv', wrap((req, res) => {
  const catName = Object.fromEntries(labelled(CATEGORIES, lang()));
  const rows = purchaseDetails(db.prepare(`
    SELECT pu.*, p.name AS buyer_name FROM purchases pu JOIN people p ON p.id = pu.buyer_id
    WHERE pu.deleted_at IS NULL ORDER BY pu.purchased_at
  `).all());
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [LANGUAGES[lang()].csv];
  for (const r of rows) {
    out.push([
      new Date(r.purchased_at).toLocaleDateString('sv-SE'),
      r.buyer_name,
      r.total.toFixed(2),
      r.store,
      catName[r.category] || r.category,
      r.items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join('; '),
      r.lines.map((l) => (l.price !== null ? `${l.name} ${l.price}` : l.name)).join('; '),
      r.note,
      r.receipt_file,
    ]);
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="shopping-${localDay()}.csv"`,
  });
  res.send(`﻿${out.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shopping list running on http://0.0.0.0:${PORT} (AI: ${apiKey() ? `${model()}, careful ${modelStrong()}` : 'off'}${setupDone() ? '' : ', waiting for first-run setup'})`);
});
