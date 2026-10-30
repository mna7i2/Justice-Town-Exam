// =====================================================================
//  Justice Town — Roleplay Activation Exam
//  The player types their Discord username → timed exam → server-side
//  grading → result in the admin dashboard (and optionally a Discord
//  channel via webhook). Admins sign in with a password, give the role
//  by hand in Discord, and mark it accepted/rejected here under their name.
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
const ADMIN_PASSWORD = env('ADMIN_PASSWORD');

if (WEBHOOK_URL && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(WEBHOOK_URL)) {
  console.error('✖ DISCORD_WEBHOOK_URL غلط — انسخه من إعدادات الروم ← Integrations ← Webhooks ← Copy Webhook URL');
  process.exit(1);
}
if (!ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD فاضي — لوحة النتائج /admin مقفلة لين تحطه');
else if (ADMIN_PASSWORD.length < 8) {
  console.error('✖ ADMIN_PASSWORD قصير — لازم 8 أحرف على الأقل');
  process.exit(1);
}
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

// Constant-time password check
function passwordOk(input) {
  if (!ADMIN_PASSWORD || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

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

function sendResultLog(attempt) {
  const wrong = attempt.answers.filter((a) => !a.isCorrect);
  const until = timeoutUntil(attempt, loadConfig().settings);
  let details = wrong
    .map((a) => `• **${a.question}**\n  ↳ جاوب: ${a.chosen === null ? '— لم يجاوب —' : a.options[a.chosen]}`)
    .join('\n');
  if (details.length > 3000) details = `${details.slice(0, 3000)}\n…`;
  return postWebhook({
    title: attempt.passed ? '📝 نجح — بانتظار إعطاء الرتبة' : '❌ مرفوض — رسب في اختبار التفعيل',
    color: attempt.passed ? 0xffc25c : 0xff5d6c,
    description: [
      wrong.length ? `**الأخطاء (${wrong.length}):**\n${details}` : '**جاوب على كل الأسئلة صح** 🎯',
      attempt.passed ? `\nأعطه الرتبة في الدسكورد، وبعدها اضغط "تم" في [لوحة النتائج](${BASE_URL}/admin#${attempt.id})` : '',
    ].join('\n'),
    fields: [
      { name: 'يوزر الدسكورد', value: `\`${attempt.username}\``, inline: true },
      { name: 'النتيجة', value: `**${attempt.score}/${attempt.total}** (${attempt.percent}%)`, inline: true },
      { name: 'المدة', value: formatDuration(attempt.durationSec) + (attempt.timedOut ? ' ⏰' : ''), inline: true },
      { name: 'رقم المحاولة', value: String(attempt.attemptNo), inline: true },
      { name: 'طلع من الصفحة', value: attempt.focusLost == null ? '—' : `${attempt.focusLost} مرة${attempt.focusLost >= 3 ? ' ⚠' : ''}`, inline: true },
      ...(until ? [{ name: 'تايم أوت', value: `يقدر يعيد <t:${Math.floor(until / 1000)}:R>`, inline: true }] : []),
    ],
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date(attempt.submittedAt).toISOString(),
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
const SUBMIT_GRACE_MS = 60_000;

// Correct answers needed to pass an exam of `total` questions
function requiredScore(settings, total) {
  if (settings.passScore > 0) return Math.min(settings.passScore, total);
  return Math.ceil((settings.passPercent / 100) * total);
}

const PLAYER_LABEL = { accept: 'المتفعل', reject: 'المرفوض', reset: 'اللاعب' };

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

function gradeAndRecord(user, active, answers, { timedOut = false } = {}) {
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
    // a pass waits for an admin to give the role in Discord and mark it here
    decision: passed ? 'pending' : null,
    decidedBy: null,
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
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) res.set('Cache-Control', 'no-store');
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
app.use(['/api', '/auth'], rateLimit('all', 90));
app.use(['/api/exam', '/api/admin/decide', '/api/admin/reset', '/auth/login'], rateLimit('action', 20));
app.use('/api/admin/login', rateLimit('admin-login', 5));
setInterval(() => { const t = now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 120_000).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function currentUser(req) {
  return unsign(parseCookies(req).jt_session);
}
function currentAdmin(req) {
  const admin = ADMIN_PASSWORD ? unsign(parseCookies(req).jt_admin) : null;
  // sessions from before admin Discord IDs existed must sign in again
  return admin && admin.discordId ? admin : null;
}
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_logged_in' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: ADMIN_PASSWORD ? 'not_logged_in' : 'admin_disabled' });
  req.admin = admin;
  next();
}

// ----- Player login (Discord username, no linking) -----
app.post('/auth/login', (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'bad_username' });
  const session = { id: userIdFor(username), username, exp: now() + 7 * 86400_000 };
  setCookie(res, 'jt_session', sign(session), 7 * 86400);
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  setCookie(res, 'jt_session', '', 0);
  res.json({ ok: true });
});

// ----- Player API -----
app.get('/api/me', (req, res) => {
  const { settings, rules, questions } = loadConfig();
  const questionCount = settings.questionCount > 0 ? Math.min(settings.questionCount, questions.length) : questions.length;
  const info = {
    exam: {
      title: settings.title,
      passPercent: settings.passPercent,
      passScore: requiredScore(settings, questionCount),
      questionCount,
      timeLimitMinutes: settings.timeLimitMinutes,
      maxAttempts: settings.maxAttempts,
      cooldownMinutes: settings.cooldownMinutes,
      rules,
    },
    inviteUrl: INVITE_URL || null,
  };
  const user = currentUser(req);
  if (!user) return res.json({ ...info, user: null });
  res.json({
    ...info,
    user: { id: user.id, username: user.username, name: user.username, avatar: avatarUrl(user.username) },
    status: userStatus(user),
  });
});

app.post('/api/exam/start', requireUser, (req, res) => {
  const status = userStatus(req.user);
  const existing = store.active[req.user.id];
  if (existing) return res.json(examPayload(existing));
  if (status.state !== 'ready') return res.status(403).json({ error: status.state });

  const { settings, questions } = loadConfig();
  let picked = settings.shuffleQuestions ? shuffle(questions) : questions.slice();
  if (settings.questionCount > 0) picked = picked.slice(0, settings.questionCount);

  const t = now();
  const active = {
    examId: randomId(),
    startedAt: t,
    deadline: settings.timeLimitMinutes > 0 ? t + settings.timeLimitMinutes * 60_000 : null,
    // Snapshot the questions so editing questions.json mid-exam can't break grading
    items: picked.map((q) => {
      const order = settings.shuffleOptions ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i);
      return { qid: q.id, question: q.question, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct) };
    }),
  };
  store.active[req.user.id] = active;
  saveStore();
  res.json(examPayload(active));
});

app.post('/api/exam/submit', requireUser, (req, res) => {
  const active = store.active[req.user.id];
  const { examId, answers, focusLost } = req.body || {};
  if (typeof examId !== 'string' || !active || active.examId !== examId) return res.status(409).json({ error: 'no_active_exam' });
  const cleanAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};

  const late = active.deadline && now() > active.deadline + SUBMIT_GRACE_MS;
  const timedOut = Boolean(active.deadline && now() > active.deadline);
  const attempt = gradeAndRecord(req.user, active, late ? null : cleanAnswers, { timedOut });
  // Client-reported count of times the player left the exam tab (anti-cheat hint for admins)
  attempt.focusLost = Number.isInteger(focusLost) ? Math.min(Math.max(focusLost, 0), 999) : null;

  store.attempts.push(attempt);
  saveStore();
  sendResultLog(attempt).catch((e) => console.error(e));

  const { settings } = loadConfig();
  res.json({
    passed: attempt.passed,
    pending: attempt.decision === 'pending',
    score: attempt.score,
    total: attempt.total,
    percent: attempt.percent,
    passPercent: attempt.passPercent,
    passScore: attempt.passScore,
    timedOut: attempt.timedOut,
    review: settings.showReview ? attempt.answers.map(({ question, options, chosen, correct }) => ({ question, options, chosen, correct })) : null,
    status: userStatus(req.user),
  });
});

// ----- Admin API -----
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: 'admin_disabled' });
  const name = String(req.body?.name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const discordId = cleanDiscordId(req.body?.discordId);
  if (!discordId) return res.status(400).json({ error: 'bad_discord_id' });
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: 'wrong_password' });
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
