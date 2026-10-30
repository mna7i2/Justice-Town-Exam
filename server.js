// =====================================================================
//  Justice Town — Car Showroom
//  Public catalog of Class A–D cars + a hidden admin page where staff
//  sign in with a password and add/edit/remove cars, prices, stock and
//  pictures. Everything an admin changes is checked on the server.
// =====================================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const crypto = require('crypto');
const { openStorage } = require('./storage');

const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim();

const PORT = Number(env('PORT', '3000')) || 3000;
// Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL can be left empty there
const BASE_URL = (env('BASE_URL') || env('RENDER_EXTERNAL_URL') || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE_COOKIES = BASE_URL.startsWith('https://');

const ADMIN_PASSWORD = env('ADMIN_PASSWORD');
const MONGODB_URI = env('MONGODB_URI');
const DATA_DIR = env('DATA_DIR') ? path.resolve(env('DATA_DIR')) : path.join(__dirname, 'data');

// The admin page lives at this path and is never linked from the public site
const ADMIN_PATH = `/${env('ADMIN_PATH', 'admin').replace(/^\/+|\/+$/g, '')}`;
if (!/^\/[A-Za-z0-9_-]{3,64}$/.test(ADMIN_PATH)) {
  console.error('✖ ADMIN_PATH غلط — استخدم حروف إنجليزية وأرقام و - بس (مثال: staff-garage)');
  process.exit(1);
}

const SITE = {
  serverName: env('SERVER_NAME', 'Justice Town'),
  discordUrl: safeUrl(env('DISCORD_INVITE_URL')),
  serverUrl: safeUrl(env('SERVER_URL')),
};

if (!ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD فاضي — صفحة الإدارة مقفلة لين تحطه');
else if (ADMIN_PASSWORD.length < 8) {
  console.error('✖ ADMIN_PASSWORD قصير — لازم 8 أحرف على الأقل');
  process.exit(1);
}
if (!MONGODB_URI) console.warn('⚠ MONGODB_URI فاضي — السيارات تنحفظ في ملف، وعلى Render تنمسح كل ما يعيد التشغيل');

// Without a fixed secret, admin logins reset whenever the site restarts
const SESSION_SECRET = env('SESSION_SECRET') || crypto.randomBytes(32).toString('hex');
if (!env('SESSION_SECRET')) console.warn('⚠ SESSION_SECRET فاضي — الإداريين بيطلعون من اللوحة كل ما يعيد الموقع تشغيله');

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------
const now = () => Date.now();
const randomId = () => crypto.randomBytes(9).toString('base64url');

function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function unsign(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.exp && data.exp < now() ? null : data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`
  );
}

// Constant-time password check
function passwordOk(input) {
  if (!ADMIN_PASSWORD || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Plain text only: trims, drops control characters and caps the length
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanInt(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Pictures arrive as data URLs; only real JPEG / PNG / WebP bytes are accepted
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
function decodeImage(dataUrl) {
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const type = imageType(buf);
  return type ? { buf, type } : null;
}
function imageType(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  return null;
}

const CLASSES = ['A', 'B', 'C', 'D'];
// cars saved before classes existed were all Class C
const classOf = (c) => (CLASSES.includes(c.class) ? c.class : 'C');

// What visitors see — no staff names
function publicCar(c) {
  return {
    id: c.id,
    name: c.name,
    price: c.price,
    quantity: c.quantity,
    note: c.note || '',
    class: classOf(c),
    image: c.imageType ? `/img/${c.id}/${c.imageVersion}` : '',
    createdAt: c.createdAt,
  };
}
function adminCar(c) {
  return { ...publicCar(c), addedBy: c.addedBy, updatedBy: c.updatedBy || null, updatedAt: c.updatedAt || c.createdAt };
}
const newestFirst = (a, b) => b.createdAt - a.createdAt;

// ---------------------------------------------------------------------
//  App
// ---------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (SECURE_COOKIES) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
});

// CSRF guard: state-changing requests must come from our own pages, as JSON
const ALLOWED_ORIGIN = new URL(BASE_URL).origin;
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  let origin = req.get('origin') || '';
  if (!origin && req.get('referer')) {
    try { origin = new URL(req.get('referer')).origin; } catch { origin = ''; }
  }
  if (origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: 'bad_origin' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'json_only' });
  next();
});

// Pictures make car saves big; everything else stays tiny
app.use('/api/admin/cars', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '16kb' }));

// Per-IP rate limits: general traffic, admin writes, and a strict one for the password
const hits = new Map();
function rateLimit(bucket, limit) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const t = now();
    const entry = hits.get(key) || { count: 0, reset: t + 60_000 };
    if (t > entry.reset) { entry.count = 0; entry.reset = t + 60_000; }
    entry.count++;
    hits.set(key, entry);
    if (entry.count > limit) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}
app.use('/api', rateLimit('all', 120));
app.use('/api/admin/cars', (req, res, next) => (req.method === 'GET' ? next() : rateLimit('write', 40)(req, res, next)));
app.use('/api/admin/login', rateLimit('admin-login', 5));
setInterval(() => { const t = now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 120_000).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

let db; // set in start()

// ---------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------
app.get('/api/site', (req, res) => res.json(SITE));

app.get('/api/cars', wrap(async (req, res) => {
  const cars = (await db.list()).sort(newestFirst).map(publicCar);
  res.json({ cars });
}));

app.get('/img/:id/:v', wrap(async (req, res) => {
  const car = await db.get(String(req.params.id));
  if (!car || !car.imageType) return res.status(404).end();
  const buf = await db.getImage(car.id);
  if (!buf) return res.status(404).end();
  // the version in the URL changes whenever the picture changes, so it can be cached for good
  res.set({ 'Content-Type': car.imageType, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(buf);
}));

// ---------------------------------------------------------------------
//  Admin
// ---------------------------------------------------------------------
const ADMIN_COOKIE = 'jt_cars_admin';
const ADMIN_TTL_SEC = 12 * 60 * 60;

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_disabled' });
  const s = unsign(parseCookies(req)[ADMIN_COOKIE]);
  if (!s || s.role !== 'admin' || !s.name) return res.status(401).json({ error: 'unauthorized' });
  req.admin = s.name;
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_disabled' });
  const name = cleanText(req.body?.name, 24);
  if (name.length < 2) return res.status(400).json({ error: 'bad_name' });
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: 'wrong_password' });
  setCookie(res, ADMIN_COOKIE, sign({ role: 'admin', name, exp: now() + ADMIN_TTL_SEC * 1000 }), ADMIN_TTL_SEC);
  console.log(`🔑 دخل الإداري: ${name}`);
  res.json({ ok: true, name });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(res, ADMIN_COOKIE, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ name: req.admin, storage: db.kind, persistent: db.persistent });
});

app.get('/api/admin/cars', requireAdmin, wrap(async (req, res) => {
  const cars = (await db.list()).sort(newestFirst).map(adminCar);
  res.json({ cars });
}));

// Shared validation for add + edit; returns { fields } or { error }
function readCarFields(body, { requireImage }) {
  const name = cleanText(body?.name, 40);
  if (name.length < 2) return { error: 'bad_name' };
  const price = cleanInt(body?.price, 0, 1_000_000_000);
  if (price === null) return { error: 'bad_price' };
  const quantity = cleanInt(body?.quantity, 0, 9999);
  if (quantity === null) return { error: 'bad_quantity' };
  const note = cleanText(body?.note, 200);
  const carClass = String(body?.class || '').toUpperCase();
  if (!CLASSES.includes(carClass)) return { error: 'bad_class' };
  let image = null;
  if (body?.image) {
    image = decodeImage(body.image);
    if (!image) return { error: 'bad_image' };
  } else if (requireImage) {
    return { error: 'image_required' };
  }
  return { fields: { name, price, quantity, note, class: carClass }, image };
}

app.post('/api/admin/cars', requireAdmin, wrap(async (req, res) => {
  const { fields, image, error } = readCarFields(req.body, { requireImage: true });
  if (error) return res.status(400).json({ error });
  const id = randomId();
  await db.putImage(id, image.buf);
  const car = await db.insert({
    id, ...fields, imageType: image.type, imageVersion: randomId(), createdAt: now(), addedBy: req.admin,
  });
  console.log(`🚗 ${req.admin} أضاف: ${car.name}`);
  res.json({ car: adminCar(car) });
}));

app.put('/api/admin/cars/:id', requireAdmin, wrap(async (req, res) => {
  const existing = await db.get(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { fields, image, error } = readCarFields(req.body, { requireImage: false });
  if (error) return res.status(400).json({ error });
  const patch = { ...fields, updatedAt: now(), updatedBy: req.admin };
  if (image) {
    await db.putImage(existing.id, image.buf);
    patch.imageType = image.type;
    patch.imageVersion = randomId();
  }
  const car = await db.update(existing.id, patch);
  console.log(`✏ ${req.admin} عدّل: ${car.name}`);
  res.json({ car: adminCar(car) });
}));

// Quick +/- on the stock without opening the editor
app.post('/api/admin/cars/:id/stock', requireAdmin, wrap(async (req, res) => {
  const existing = await db.get(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const delta = cleanInt(req.body?.delta, -9999, 9999);
  if (delta === null) return res.status(400).json({ error: 'bad_quantity' });
  const quantity = Math.min(9999, Math.max(0, existing.quantity + delta));
  const car = await db.update(existing.id, { quantity, updatedAt: now(), updatedBy: req.admin });
  res.json({ car: adminCar(car) });
}));

app.delete('/api/admin/cars/:id', requireAdmin, wrap(async (req, res) => {
  const existing = await db.get(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await db.remove(existing.id);
  console.log(`🗑 ${req.admin} حذف: ${existing.name}`);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------
//  Pages
// ---------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get(ADMIN_PATH, (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' });
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /api/\n'));

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res, file) => res.set('Cache-Control', /\.(webp|png|jpe?g|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache'),
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => res.redirect('/'));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error('✖', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error' });
});

async function start() {
  db = await openStorage({ mongoUri: MONGODB_URI, dataDir: DATA_DIR });
  console.log(db.persistent ? '✔ متصل بـ MongoDB — السيارات محفوظة دائماً' : `✔ التخزين في ملف: ${DATA_DIR}`);
  app.listen(PORT, () => {
    console.log(`✔ معرض السيارات شغّال: ${BASE_URL}`);
    console.log(`  صفحة الإدارة: ${BASE_URL}${ADMIN_PATH}`);
  });
}
start().catch((err) => {
  console.error(`✖ ما قدر يشغّل الموقع: ${err.message}`);
  if (MONGODB_URI) console.error('  تأكد من MONGODB_URI ومن إن Network Access في MongoDB Atlas فيه 0.0.0.0/0');
  process.exit(1);
});
