// =====================================================================
//  Justice Town — Roleplay Activation Exam
//  Admins only: an admin signs in with their Discord account, types a
//  citizen's Discord username, shares their screen in Discord and runs the
//  timed exam with them. Handing it in needs the citizen's Discord ID; the
//  server grades it, a pass is an activation under that admin, a fail is a
//  72h timeout, and the webhook mentions the admin and the citizen.
// =====================================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim();

const PORT = Number(env('PORT', '3000')) || 3000;
// Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL can be left empty there
const BASE_URL = (env('BASE_URL') || env('RENDER_EXTERNAL_URL') || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE_COOKIES = BASE_URL.startsWith('https://');

const INVITE_URL = env('DISCORD_INVITE_URL');
const WEBHOOK_URL = env('DISCORD_WEBHOOK_URL');
// Admins sign in with their Discord account (OAuth2, no bot needed) once DISCORD_CLIENT_ID +
// DISCORD_CLIENT_SECRET are set. Only members holding ADMIN_ROLE_ID in DISCORD_GUILD_ID
// (read from their own account) or listed in ADMIN_IDS may get in then.
// Without them the old name + Discord ID form is used (ADMIN_IDS optional there).
const list = (key) => env(key).split(/[\s,]+/).filter(Boolean);
const ADMIN_IDS = list('ADMIN_IDS');
const CLIENT_ID = env('DISCORD_CLIENT_ID');
const CLIENT_SECRET = env('DISCORD_CLIENT_SECRET');
const DISCORD_LOGIN = Boolean(CLIENT_ID && CLIENT_SECRET);
const GUILD_ID = env('DISCORD_GUILD_ID');
const ADMIN_ROLE_IDS = list('ADMIN_ROLE_ID');
const ROLE_LOGIN = Boolean(DISCORD_LOGIN && GUILD_ID && ADMIN_ROLE_IDS.length);

if (WEBHOOK_URL && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(WEBHOOK_URL)) {
  console.error('✖ DISCORD_WEBHOOK_URL غلط — انسخه من إعدادات الروم ← Integrations ← Webhooks ← Copy Webhook URL');
  process.exit(1);
}
if (ADMIN_IDS.some((id) => !/^\d{17,20}$/.test(id))) {
  console.error('✖ ADMIN_IDS غلط — حط آيديات الإداريين أرقام بس، بينها فاصلة');
  process.exit(1);
}
if ((CLIENT_ID || CLIENT_SECRET) && !DISCORD_LOGIN) {
  console.error('✖ لازم تحط DISCORD_CLIENT_ID و DISCORD_CLIENT_SECRET الاثنين');
  process.exit(1);
}
if (DISCORD_LOGIN && !/^\d{17,20}$/.test(CLIENT_ID)) {
  console.error('✖ DISCORD_CLIENT_ID غلط — انسخه من Discord Developer Portal ← OAuth2 ← Client ID');
  process.exit(1);
}
if (Boolean(GUILD_ID) !== Boolean(ADMIN_ROLE_IDS.length)) {
  console.error('✖ لازم تحط DISCORD_GUILD_ID و ADMIN_ROLE_ID الاثنين');
  process.exit(1);
}
if ([GUILD_ID, ...ADMIN_ROLE_IDS].filter(Boolean).some((id) => !/^\d{17,20}$/.test(id))) {
  console.error('✖ DISCORD_GUILD_ID أو ADMIN_ROLE_ID غلط — أرقام بس (Copy Server ID / Copy Role ID)');
  process.exit(1);
}
if (GUILD_ID && !DISCORD_LOGIN) console.warn('⚠ ADMIN_ROLE_ID ما يشتغل بدون DISCORD_CLIENT_ID و DISCORD_CLIENT_SECRET');
if (DISCORD_LOGIN && !ROLE_LOGIN && !ADMIN_IDS.length) console.error('✖ ما أحد بيقدر يدخل — حط DISCORD_GUILD_ID و ADMIN_ROLE_ID (أو ADMIN_IDS)');
else if (!DISCORD_LOGIN) console.warn('⚠ دخول الدسكورد مو مفعّل — الإداري يدخل باسم + آيدي بس (حط DISCORD_CLIENT_ID و DISCORD_CLIENT_SECRET)');
if (!DISCORD_LOGIN && !ADMIN_IDS.length) console.warn('⚠ ADMIN_IDS فاضي — أي أحد يفتح الموقع يقدر يدخل كإداري');
if (!WEBHOOK_URL) console.warn('⚠ DISCORD_WEBHOOK_URL فاضي — النتائج بتظهر في لوحة النتائج بس، ما توصل الدسكورد');

// Without a fixed secret, logins reset whenever the site restarts (works, but set one)
const SESSION_SECRET = env('SESSION_SECRET') || crypto.randomBytes(32).toString('hex');
if (!env('SESSION_SECRET')) console.warn('⚠ SESSION_SECRET فاضي — الجلسات بتنمسح كل ما يعيد الموقع تشغيله');

// ---------------------------------------------------------------------
//  Exam config (config/questions.json) — re-read whenever the file changes
// ---------------------------------------------------------------------
const QUESTIONS_FILE = path.join(__dirname, 'config', 'questions.json');
const DEFAULT_SETTINGS = {
  title: 'اختبار تفعيل الرول بلاي',
  passPercent: 80,
  // when set, passing needs this many correct answers (takes priority over passPercent)
  passScore: 0,
  questionCount: 10,
  timeLimitMinutes: 10,
  cooldownMinutes: 60,
  maxAttempts: 0,
  shuffleQuestions: true,
  shuffleOptions: true,
  showReview: false,
};
let configCache = { mtime: 0, data: null };

function normalizeConfig(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  const questions = [];
  (raw.questions || []).forEach((q, i) => {
    const where = `السؤال رقم ${i + 1}`;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) return console.warn(`⚠ ${where}: نص السؤال فاضي — تم تجاهله`);
    if (!Array.isArray(q.options) || q.options.length < 2) return console.warn(`⚠ ${where}: لازم خيارين على الأقل — تم تجاهله`);
    const options = q.options.map((o) => String(o));
    // "answer" is either the 1-based option number or the exact option text
    let correct = -1;
    if (typeof q.answer === 'number') correct = q.answer - 1;
    else if (typeof q.answer === 'string') correct = options.indexOf(q.answer);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      return console.warn(`⚠ ${where}: الإجابة الصحيحة "${q.answer}" غير موجودة بين الخيارات — تم تجاهله`);
    }
    questions.push({ id: String(q.id || `q${i + 1}`), question: q.question.trim(), options, correct });
  });
  if (!questions.length) throw new Error('ما فيه ولا سؤال صالح في config/questions.json');
  return { settings, rules: Array.isArray(raw.rules) ? raw.rules.map(String) : [], questions };
}

function loadConfig() {
  const { mtimeMs } = fs.statSync(QUESTIONS_FILE);
  if (mtimeMs !== configCache.mtime) {
    try {
      const data = normalizeConfig(JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')));
      configCache = { mtime: mtimeMs, data };
      console.log(`✔ تم تحميل ${data.questions.length} سؤال من questions.json`);
    } catch (err) {
      console.error(`✖ خطأ في config/questions.json: ${err.message}`);
      if (!configCache.data) throw err;
      configCache.mtime = mtimeMs; // keep serving the last good version
    }
  }
  return configCache.data;
}

// ---------------------------------------------------------------------
//  Storage (data/store.json)
// ---------------------------------------------------------------------
const DATA_DIR = env('DATA_DIR') ? path.resolve(env('DATA_DIR')) : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
// adminLog: who did what from the dashboard ({ action: 'accept' | 'reject' | 'reset', userId, by, at })
let store = { attempts: [], active: {}, resets: {}, adminLog: [] };

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STORE_FILE)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  }
}
function saveStore() {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

// ---------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------
const now = () => Date.now();
const randomId = () => crypto.randomBytes(12).toString('hex');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`
  );
}

// Discord usernames: 2–32 of a-z 0-9 _ . (old-style "name#1234" also accepted)
function cleanUsername(input) {
  const u = String(input || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.]{2,32}(#\d{4})?$/.test(u) ? u : null;
}
const userIdFor = (username) => `u_${username}`;

// Discord's default avatars, picked from the username so it stays the same
function avatarUrl(username) {
  const n = crypto.createHash('md5').update(username).digest()[0] % 6;
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} د ${s} ث` : `${s} ث`;
}

// the manual form lets anyone in when ADMIN_IDS is empty
const adminAllowed = (discordId) => !ADMIN_IDS.length || ADMIN_IDS.includes(discordId);
// Discord sessions: the role was checked at sign-in, a listed ID always counts
const discordAdminAllowed = (admin) => ADMIN_IDS.includes(admin.discordId) || (ROLE_LOGIN && admin.byRole === true);
const cleanName = (value) => String(value || '').replace(/[<>@\u0000-\u001f]/g, '').trim().slice(0, 32);

// ---------------------------------------------------------------------
//  Discord webhook (optional — just posts messages to one channel)
// ---------------------------------------------------------------------
// Discord user IDs are 17–20 digit numbers; a mention is <@id>
function cleanDiscordId(value) {
  const id = String(value ?? '').trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}
const mention = (id) => (id ? `<@${id}>` : '');

// `content` sits above the embed; only the IDs in `ping` actually get notified
async function postWebhook(embed, { content = '', ping = [] } = {}) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(`${WEBHOOK_URL}?wait=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Justice Town',
      content,
      embeds: [embed],
      allowed_mentions: { parse: [], users: [...new Set(ping.filter(Boolean))] },
    }),
  });
  if (!res.ok) console.error('✖ إرسال الرسالة للدسكورد فشل:', res.status, await res.text().catch(() => ''));
}

// One message per finished exam: the admin who ran it, the citizen under it, and the result
function sendResultLog(attempt) {
  const wrong = attempt.answers.filter((a) => !a.isCorrect);
  const until = timeoutUntil(attempt, loadConfig().settings);
  const admin = attempt.conductedBy || {};
  const label = attempt.passed ? 'المتفعل' : 'المرفوض';
  const who = (id, text) => (id ? `${mention(id)} (${text})` : text);
  let details = wrong
    .map((a) => `• **${a.question}**\n  ↳ جاوب: ${a.chosen === null ? '— لم يجاوب —' : a.options[a.chosen]}`)
    .join('\n');
  if (details.length > 3000) details = `${details.slice(0, 3000)}\n…`;
  return postWebhook({
    title: attempt.passed ? '✅ نجح في اختبار التفعيل — تم تفعيله' : '❌ مرفوض — رسب في اختبار التفعيل',
    color: attempt.passed ? 0x3ecf8e : 0xff5d6c,
    description: wrong.length ? `**الأخطاء (${wrong.length}):**\n${details}` : '**جاوب على كل الأسئلة صح** 🎯',
    fields: [
      { name: 'الإداري', value: who(admin.discordId, admin.name || '—'), inline: false },
      { name: label, value: who(attempt.discordId, `\`${attempt.username}\``), inline: false },
      { name: 'النتيجة', value: `**${attempt.score}/${attempt.total}** (${attempt.percent}%) — المطلوب ${attempt.passScore}`, inline: true },
      { name: 'المدة', value: formatDuration(attempt.durationSec) + (attempt.timedOut ? ' ⏰' : ''), inline: true },
      { name: 'رقم المحاولة', value: String(attempt.attemptNo), inline: true },
      ...(until ? [{ name: 'تايم أوت', value: `يقدر يعيد <t:${Math.floor(until / 1000)}:R>`, inline: false }] : []),
    ],
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date(attempt.submittedAt).toISOString(),
  }, {
    content: [`الإداري: ${mention(admin.discordId) || admin.name || '—'}`, `${label}: ${mention(attempt.discordId) || `\`${attempt.username}\``}`].join('\n'),
    ping: [admin.discordId, attempt.discordId],
  });
}

// Mentions the admin first and the player under it, then the exam result
function sendAdminLog(action, player, admin, until = 0) {
  const titles = { accept: '✅ تم إعطاء الرتبة', reject: '❌ تم الرفض', reset: '🔁 فتح محاولات جديدة' };
  const colors = { accept: 0x3ecf8e, reject: 0xff5d6c, reset: 0x5b8ae6 };
  const label = PLAYER_LABEL[action];
  const who = (id, text) => (id ? `${mention(id)} (${text})` : text);
  const a = player.attempt;
  return postWebhook({
    title: titles[action],
    color: colors[action],
    fields: [
      { name: 'الإداري', value: who(admin.discordId, admin.name), inline: false },
      { name: label, value: who(player.discordId, `\`${player.username}\``), inline: false },
      ...(a ? [
        { name: 'النتيجة', value: `**${a.score}/${a.total}** (${a.percent}%) — المطلوب ${a.passScore}`, inline: true },
        { name: 'المدة', value: formatDuration(a.durationSec) + (a.timedOut ? ' ⏰' : ''), inline: true },
        { name: 'رقم المحاولة', value: String(a.attemptNo), inline: true },
        { name: 'طلع من الصفحة', value: a.focusLost == null ? '—' : `${a.focusLost} مرة${a.focusLost >= 3 ? ' ⚠' : ''}`, inline: true },
        { name: 'وقت الاختبار', value: `<t:${Math.floor(a.submittedAt / 1000)}:f>`, inline: true },
      ] : []),
      ...(until ? [{ name: 'تايم أوت', value: `يقدر يعيد <t:${Math.floor(until / 1000)}:R>`, inline: false }] : []),
    ],
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date().toISOString(),
  }, {
    content: [`الإداري: ${mention(admin.discordId) || admin.name}`, `${label}: ${mention(player.discordId) || `\`${player.username}\``}`].join('\n'),
    ping: [admin.discordId, player.discordId],
  });
}

// ---------------------------------------------------------------------
//  Exam logic
// ---------------------------------------------------------------------
// time after the deadline to type the citizen's ID and hand in before the answers are dropped
const SUBMIT_GRACE_MS = 5 * 60_000;

// Correct answers needed to pass an exam of `total` questions
function requiredScore(settings, total) {
  if (settings.passScore > 0) return Math.min(settings.passScore, total);
  return Math.ceil((settings.passPercent / 100) * total);
}

const PLAYER_LABEL = { accept: 'المتفعل', reject: 'المرفوض', fail: 'المرفوض', reset: 'اللاعب', cancel: 'اللاعب' };

// A failed or rejected attempt locks the player out for cooldownMinutes (72 hours),
// counted from the rejection itself when an admin rejected a pass
function timeoutUntil(attempt, settings) {
  const failed = !attempt.passed || attempt.decision === 'rejected';
  if (!failed || settings.cooldownMinutes <= 0) return 0;
  const from = attempt.decision === 'rejected' ? attempt.decidedBy?.at || attempt.submittedAt : attempt.submittedAt;
  return from + settings.cooldownMinutes * 60_000;
}

function userAttempts(userId) {
  const resetAt = store.resets[userId] || 0;
  return store.attempts.filter((a) => a.userId === userId && a.submittedAt > resetAt);
}

// The admin runs the exam, so a pass is an activation by that admin right away
function gradeAndRecord(user, active, answers, { timedOut = false, discordId = null } = {}) {
  const graded = active.items.map((item) => {
    const raw = answers ? answers[item.qid] : undefined;
    const chosen = Number.isInteger(raw) && raw >= 0 && raw < item.options.length ? raw : null;
    return { qid: item.qid, question: item.question, options: item.options, chosen, correct: item.correct, isCorrect: chosen === item.correct };
  });
  const { settings } = loadConfig();
  const score = graded.filter((g) => g.isCorrect).length;
  const total = graded.length;
  const percent = total ? Math.round((score / total) * 100) : 0;
  const submittedAt = now();
  const passScore = requiredScore(settings, total);
  const passed = score >= passScore;
  const attempt = {
    id: randomId(),
    userId: user.id,
    username: user.username,
    name: user.username,
    avatar: avatarUrl(user.username),
    startedAt: active.startedAt,
    submittedAt,
    durationSec: Math.max(0, Math.round((submittedAt - active.startedAt) / 1000)),
    score,
    total,
    percent,
    passPercent: settings.passPercent,
    passScore,
    passed,
    discordId,
    conductedBy: active.conductedBy || null,
    decision: passed ? 'accepted' : null,
    decidedBy: passed && active.conductedBy ? { ...active.conductedBy, at: submittedAt } : null,
    timedOut,
    attemptNo: userAttempts(user.id).length + 1,
    answers: graded,
  };
  delete store.active[user.id];
  return attempt;
}

// An exam left open past its deadline counts as a failed (timed-out) attempt.
function expireActive(user) {
  const active = store.active[user.id];
  if (active && active.deadline && now() > active.deadline + SUBMIT_GRACE_MS) {
    const attempt = gradeAndRecord(user, active, null, { timedOut: true });
    store.attempts.push(attempt);
    store.adminLog.push({ action: 'fail', userId: user.id, username: user.username, by: attempt.conductedBy || { name: '—' }, at: now() });
    saveStore();
    sendResultLog(attempt).catch((e) => console.error(e));
  }
}

function userStatus(user) {
  const { settings } = loadConfig();
  expireActive(user);
  const attempts = userAttempts(user.id);
  const last = attempts[attempts.length - 1] || null;
  // a rejected pass counts like a failed attempt
  const failed = (a) => !a.passed || a.decision === 'rejected';
  const passedAttempt = attempts.find((a) => !failed(a)) || null;
  const attemptsLeft = settings.maxAttempts > 0 ? Math.max(0, settings.maxAttempts - attempts.length) : null;
  let cooldownUntil = last ? timeoutUntil(last, settings) : 0;
  if (cooldownUntil <= now()) cooldownUntil = 0;

  let state = 'ready';
  if (passedAttempt && passedAttempt.decision === 'accepted') state = 'accepted';
  else if (passedAttempt) state = 'pending_review';
  else if (store.active[user.id]) state = 'in_progress';
  else if (attemptsLeft === 0) state = 'no_attempts';
  else if (cooldownUntil) state = 'cooldown';

  return {
    state,
    attemptsUsed: attempts.length,
    attemptsLeft,
    cooldownUntil,
    lastAttempt: last && {
      percent: last.percent,
      passed: last.passed,
      rejected: last.decision === 'rejected',
      submittedAt: last.submittedAt,
      timedOut: last.timedOut,
    },
  };
}

function examPayload(active) {
  return {
    examId: active.examId,
    startedAt: active.startedAt,
    deadline: active.deadline,
    serverNow: now(),
    questions: active.items.map((i) => ({ qid: i.qid, question: i.question, options: i.options })),
  };
}

// ---------------------------------------------------------------------
//  App
// ---------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

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
      "img-src 'self' data: https://cdn.discordapp.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
});

// CSRF guard: state-changing requests must come from our own pages
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

// Per-IP rate limits: general traffic, actions, and a strict one for the admin password
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
app.use(['/api/exam', '/api/citizen', '/api/admin/decide', '/api/admin/reset'], rateLimit('action', 40));
app.use('/api/admin/login', rateLimit('admin-login', 5));
app.use('/auth', rateLimit('auth', 20));
setInterval(() => { const t = now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 120_000).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function currentAdmin(req) {
  const admin = unsign(parseCookies(req).jt_admin);
  // sessions from before admin Discord IDs existed (or IDs since removed from ADMIN_IDS) must sign in again,
  // and once Discord login is on, so must every session made with the typed-in form
  if (!admin || !admin.discordId) return null;
  if (DISCORD_LOGIN) return admin.via === 'discord' && discordAdminAllowed(admin) ? admin : null;
  return adminAllowed(admin.discordId) ? admin : null;
}
function requireAdmin(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'not_logged_in' });
  req.admin = admin;
  next();
}

// The citizen never signs in: the admin types their Discord username and runs the exam
// on their own screen (shared in Discord), so every exam route needs an admin
function requireCitizen(req, res, next) {
  const username = cleanUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'bad_username' });
  req.citizen = { id: userIdFor(username), username };
  next();
}

function citizenInfo(citizen) {
  const attempts = userAttempts(citizen.id);
  const accepted = attempts.find((a) => a.decision === 'accepted');
  return {
    username: citizen.username,
    avatar: avatarUrl(citizen.username),
    status: userStatus(citizen),
    activatedBy: accepted?.decidedBy ? { name: accepted.decidedBy.name, at: accepted.decidedBy.at } : null,
  };
}

app.get('/api/me', (req, res) => {
  const { settings, rules, questions } = loadConfig();
  const questionCount = settings.questionCount > 0 ? Math.min(settings.questionCount, questions.length) : questions.length;
  const admin = currentAdmin(req);
  res.json({
    exam: {
      title: settings.title,
      passPercent: settings.passPercent,
      passScore: requiredScore(settings, questionCount),
      questionCount,
      timeLimitMinutes: settings.timeLimitMinutes,
      cooldownMinutes: settings.cooldownMinutes,
      rules,
    },
    admin: admin ? { name: admin.name, discordId: admin.discordId } : null,
    loginMode: DISCORD_LOGIN ? 'discord' : 'manual',
  });
});

// Look up a citizen before starting: shows "مرفوض" with the time left if they're in a timeout
app.post('/api/citizen/check', requireAdmin, requireCitizen, (req, res) => {
  res.json(citizenInfo(req.citizen));
});

app.post('/api/exam/start', requireAdmin, requireCitizen, (req, res) => {
  const status = userStatus(req.citizen);
  const existing = store.active[req.citizen.id];
  if (existing) return res.json(examPayload(existing));
  if (status.state !== 'ready') return res.status(403).json({ error: status.state, ...citizenInfo(req.citizen) });

  const { settings, questions } = loadConfig();
  let picked = settings.shuffleQuestions ? shuffle(questions) : questions.slice();
  if (settings.questionCount > 0) picked = picked.slice(0, settings.questionCount);

  const t = now();
  const active = {
    examId: randomId(),
    startedAt: t,
    deadline: settings.timeLimitMinutes > 0 ? t + settings.timeLimitMinutes * 60_000 : null,
    conductedBy: { name: req.admin.name, discordId: req.admin.discordId },
    // Snapshot the questions so editing questions.json mid-exam can't break grading
    items: picked.map((q) => {
      const order = settings.shuffleOptions ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i);
      return { qid: q.id, question: q.question, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct) };
    }),
  };
  store.active[req.citizen.id] = active;
  saveStore();
  res.json(examPayload(active));
});

// Stops an exam without recording it (e.g. the citizen dropped from the call)
app.post('/api/exam/cancel', requireAdmin, requireCitizen, (req, res) => {
  if (!store.active[req.citizen.id]) return res.status(409).json({ error: 'no_active_exam' });
  delete store.active[req.citizen.id];
  store.adminLog.push({ action: 'cancel', userId: req.citizen.id, username: req.citizen.username, by: { name: req.admin.name, discordId: req.admin.discordId }, at: now() });
  saveStore();
  res.json({ ok: true });
});

app.post('/api/exam/submit', requireAdmin, requireCitizen, (req, res) => {
  const active = store.active[req.citizen.id];
  const { examId, answers } = req.body || {};
  if (typeof examId !== 'string' || !active || active.examId !== examId) return res.status(409).json({ error: 'no_active_exam' });
  // the exam can't be handed in until the admin types the citizen's Discord ID
  const discordId = cleanDiscordId(req.body?.playerDiscordId);
  if (!discordId) return res.status(400).json({ error: 'player_id_required' });
  const cleanAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};

  const late = active.deadline && now() > active.deadline + SUBMIT_GRACE_MS;
  const timedOut = Boolean(active.deadline && now() > active.deadline);
  // whoever hands it in is the admin on record
  active.conductedBy = { name: req.admin.name, discordId: req.admin.discordId };
  const attempt = gradeAndRecord(req.citizen, active, late ? null : cleanAnswers, { timedOut, discordId });

  store.attempts.push(attempt);
  store.adminLog.push({
    action: attempt.passed ? 'accept' : 'fail',
    userId: attempt.userId,
    username: attempt.username,
    playerDiscordId: discordId,
    by: attempt.conductedBy,
    at: now(),
  });
  saveStore();
  sendResultLog(attempt).catch((e) => console.error(e));

  const { settings } = loadConfig();
  res.json({
    passed: attempt.passed,
    score: attempt.score,
    total: attempt.total,
    percent: attempt.percent,
    passPercent: attempt.passPercent,
    passScore: attempt.passScore,
    timedOut: attempt.timedOut,
    review: settings.showReview ? attempt.answers.map(({ question, options, chosen, correct }) => ({ question, options, chosen, correct })) : null,
    citizen: citizenInfo(req.citizen),
  });
});

// ----- Admin API -----
app.post('/api/admin/login', (req, res) => {
  // a typed-in ID proves nothing, so the form is off once Discord login is set up
  if (DISCORD_LOGIN) return res.status(403).json({ error: 'discord_login_required' });
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const discordId = cleanDiscordId(req.body?.discordId);
  if (!discordId) return res.status(400).json({ error: 'bad_discord_id' });
  if (!adminAllowed(discordId)) return res.status(403).json({ error: 'not_admin' });
  setCookie(res, 'jt_admin', sign({ name, discordId, exp: now() + 12 * 3600_000 }), 12 * 3600);
  res.json({ ok: true, name });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(res, 'jt_admin', '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/attempts', requireAdmin, (req, res) => {
  const { settings } = loadConfig();
  // only a player's latest attempt (since their last reset) carries the timeout
  const latest = new Map();
  for (const a of store.attempts) if (a.submittedAt > (store.resets[a.userId] || 0)) latest.set(a.userId, a.id);
  const attempts = store.attempts.slice().reverse().map((a) => {
    const until = latest.get(a.userId) === a.id ? timeoutUntil(a, settings) : 0;
    return { ...a, timeoutUntil: until > now() ? until : 0 };
  });
  const passed = attempts.filter((a) => a.passed).length;
  const perQuestion = {};
  for (const a of attempts) {
    for (const ans of a.answers) {
      const q = (perQuestion[ans.question] ||= { question: ans.question, asked: 0, correct: 0 });
      q.asked++;
      if (ans.isCorrect) q.correct++;
    }
  }
  res.json({
    admin: req.admin.name,
    stats: {
      total: attempts.length,
      passed,
      failed: attempts.length - passed,
      passRate: attempts.length ? Math.round((passed / attempts.length) * 100) : 0,
      avgPercent: attempts.length ? Math.round(attempts.reduce((s, a) => s + a.percent, 0) / attempts.length) : 0,
      players: new Set(attempts.map((a) => a.userId)).size,
      inProgress: Object.keys(store.active).length,
    },
    hardest: Object.values(perQuestion)
      .map((q) => ({ ...q, rate: Math.round((q.correct / q.asked) * 100) }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 5),
    adminLog: store.adminLog.slice().reverse(),
    attempts,
  });
});

// Accept (= "I gave the role in Discord") or reject a passed attempt, under the admin's name
app.post('/api/admin/decide', requireAdmin, (req, res) => {
  const { attemptId, action } = req.body || {};
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'bad_action' });
  const attempt = store.attempts.find((a) => a.id === attemptId);
  if (!attempt || !attempt.passed) return res.status(404).json({ error: 'not_found' });
  if (attempt.decision !== 'pending') return res.status(409).json({ error: 'already_decided', by: attempt.decidedBy?.name });

  // the admin must type the player's Discord ID before accepting (optional when rejecting)
  const playerId = cleanDiscordId(req.body?.playerDiscordId);
  if (action === 'accept' && !playerId) return res.status(400).json({ error: 'player_id_required' });
  if (req.body?.playerDiscordId && !playerId) return res.status(400).json({ error: 'bad_discord_id' });

  const by = { name: req.admin.name, discordId: req.admin.discordId };
  attempt.decision = action === 'accept' ? 'accepted' : 'rejected';
  attempt.decidedBy = { ...by, at: now() };
  if (playerId) attempt.discordId = playerId;
  store.adminLog.push({ action, userId: attempt.userId, username: attempt.username, playerDiscordId: playerId, by, at: now() });
  saveStore();
  sendAdminLog(action, { username: attempt.username, discordId: playerId, attempt }, by, timeoutUntil(attempt, loadConfig().settings))
    .catch((e) => console.error(e));
  res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || '');
  if (!/^u_[a-z0-9_.#]{2,40}$/.test(userId)) return res.status(400).json({ error: 'bad_user' });
  const username = userId.slice(2);
  store.resets[userId] = now();
  delete store.active[userId];
  const by = { name: req.admin.name, discordId: req.admin.discordId };
  store.adminLog.push({ action: 'reset', userId, username, by, at: now() });
  saveStore();
  sendAdminLog('reset', { username }, by).catch((e) => console.error(e));
  res.json({ ok: true });
});

// ----- Discord sign-in (OAuth2 — no bot) -----
// "guilds.members.read" lets us read the member's own roles in our server
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = ROLE_LOGIN ? 'identify guilds.members.read' : 'identify';
// role sessions are shorter, so taking the role away locks the admin out soon after
const SESSION_HOURS = ROLE_LOGIN ? 6 : 12;
const LOGIN_TARGETS = { admin: '/admin', home: '/' };

app.get('/auth/discord', (req, res) => {
  if (!DISCORD_LOGIN) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  const next = LOGIN_TARGETS[req.query.next] || '/';
  // the state cookie ties the callback to this browser, so nobody can log someone else in
  setCookie(res, 'jt_oauth', sign({ state, next, exp: now() + 10 * 60_000 }), 600);
  const params = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES, state, prompt: 'none' });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', wrap(async (req, res) => {
  const saved = unsign(parseCookies(req).jt_oauth);
  setCookie(res, 'jt_oauth', '', 0);
  const back = saved?.next || '/';
  const fail = (code) => res.redirect(`${back}?login_error=${code}`);
  if (!DISCORD_LOGIN) return res.redirect('/');

  const { state, code, error } = req.query;
  if (!saved || typeof state !== 'string' || state.length !== saved.state.length
    || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) return fail('expired');
  if (error) return fail('cancelled');
  if (typeof code !== 'string' || !code || code.length > 100) return fail('expired');

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) {
    console.error('✖ دخول الدسكورد فشل:', tokenRes.status, await tokenRes.text().catch(() => ''));
    return fail('discord');
  }
  const { access_token: token } = await tokenRes.json();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const meRes = await fetch('https://discord.com/api/users/@me', auth);
  const me = meRes.ok ? await meRes.json() : {};
  // 404 = not in the server; otherwise the member's role IDs
  let roles = [];
  if (ROLE_LOGIN) {
    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, auth);
    if (memberRes.ok) roles = (await memberRes.json()).roles || [];
    else if (memberRes.status !== 404) console.error('✖ ما قدرنا نقرأ رتب الإداري:', memberRes.status);
  }
  // the token was only needed to read who this is
  fetch('https://discord.com/api/oauth2/token/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token }),
  }).catch(() => {});

  const discordId = cleanDiscordId(me.id);
  if (!discordId) return fail('discord');
  const byRole = ROLE_LOGIN && roles.some((r) => ADMIN_ROLE_IDS.includes(r));
  const session = { discordId, via: 'discord', byRole };
  if (!discordAdminAllowed(session)) {
    console.warn(`⚠ محاولة دخول من حساب ما عنده رتبة قسم التفعيل: ${cleanName(me.username)} (${discordId})`);
    return fail(ROLE_LOGIN ? 'no_role' : 'not_admin');
  }
  const name = cleanName(me.global_name) || cleanName(me.username) || 'إداري';
  setCookie(res, 'jt_admin', sign({ ...session, name, exp: now() + SESSION_HOURS * 3600_000 }), SESSION_HOURS * 3600);
  res.redirect(back);
}));

// ----- Pages -----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
// Pages and scripts revalidate every load (so edits show up at once); images cache for a day
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, file) => res.set('Cache-Control', /\.(webp|png|jpe?g|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache'),
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => res.redirect('/'));

app.use((err, req, res, next) => {
  console.error('✖', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error' });
});

loadStore();
loadConfig();
app.listen(PORT, () => {
  console.log(`\n  ⚖  Justice Town Exam شغّال على ${BASE_URL}\n`);
});
