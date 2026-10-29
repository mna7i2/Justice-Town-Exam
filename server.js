// =====================================================================
//  Justice Town — Roleplay Activation Exam
//  Discord OAuth2 login → timed exam → server-side grading →
//  result posted to a Discord channel with Accept / Reject buttons →
//  the admin who clicks decides, the role is granted, and the dashboard
//  records who decided.
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

const CLIENT_ID = env('DISCORD_CLIENT_ID');
const CLIENT_SECRET = env('DISCORD_CLIENT_SECRET');
const BOT_TOKEN = env('DISCORD_BOT_TOKEN');
const GUILD_ID = env('DISCORD_GUILD_ID');
const ROLE_ID = env('DISCORD_ROLE_ID');
const REMOVE_ROLE_ID = env('DISCORD_REMOVE_ROLE_ID');
const LOG_CHANNEL_ID = env('DISCORD_LOG_CHANNEL_ID');
const INVITE_URL = env('DISCORD_INVITE_URL');
const PUBLIC_KEY = env('DISCORD_PUBLIC_KEY');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const ADMIN_IDS = new Set(env('ADMIN_IDS').split(',').map((s) => s.trim()).filter(Boolean));

const missing = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  'DISCORD_GUILD_ID', 'DISCORD_ROLE_ID', 'DISCORD_LOG_CHANNEL_ID', 'SESSION_SECRET',
].filter((k) => !env(k));
if (missing.length) {
  console.error(`✖ إعدادات ناقصة: ${missing.join(', ')}`);
  console.error('  أضفها في Environment (على Render) أو في ملف .env');
  process.exit(1);
}
const SESSION_SECRET = env('SESSION_SECRET');
if (SESSION_SECRET.length < 24) {
  console.error('✖ SESSION_SECRET قصير جداً (لازم 24 حرف على الأقل)');
  process.exit(1);
}
if (!ADMIN_IDS.size) console.warn('⚠ ADMIN_IDS فاضي — ما أحد يقدر يدخل لوحة النتائج /admin');
const isAdmin = (id) => ADMIN_IDS.has(id);

// Ed25519 key Discord signs button clicks with (General Information → Public Key)
let interactionKey;
try {
  const raw = Buffer.from(PUBLIC_KEY, 'hex');
  if (raw.length !== 32) throw new Error('length');
  interactionKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
} catch {
  console.error('✖ DISCORD_PUBLIC_KEY غلط — انسخه من General Information في Discord Developer Portal');
  process.exit(1);
}

// ---------------------------------------------------------------------
//  Exam config (config/questions.json) — re-read whenever the file changes
// ---------------------------------------------------------------------
const QUESTIONS_FILE = path.join(__dirname, 'config', 'questions.json');
const DEFAULT_SETTINGS = {
  title: 'اختبار تفعيل الرول بلاي',
  passPercent: 80,
  questionCount: 10,
  timeLimitMinutes: 10,
  cooldownMinutes: 60,
  maxAttempts: 3,
  shuffleQuestions: true,
  shuffleOptions: true,
  showReview: false,
  // false = an admin accepts/rejects from Discord; true = passing grants the role at once
  autoGrant: false,
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
// adminLog: who did what from the dashboard ({ action: 'grant' | 'reset', userId, by, at })
let store = { attempts: [], active: {}, resets: {}, adminLog: [] };

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STORE_FILE)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
    // a decision cut off by a restart goes back to waiting for an admin
    for (const a of store.attempts) if (a.decision === 'processing') a.decision = 'pending';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  const idx = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} د ${s} ث` : `${s} ث`;
}

// ---------------------------------------------------------------------
//  Discord API
// ---------------------------------------------------------------------
const API = 'https://discord.com/api/v10';

async function discord(method, route, { body, auth = `Bot ${BOT_TOKEN}`, reason } = {}) {
  const headers = { Authorization: auth, 'User-Agent': `DiscordBot (${BASE_URL}, 1.0)` };
  if (body) headers['Content-Type'] = 'application/json';
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      await sleep((info.retry_after || 1) * 1000 + 150);
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  }
  return { ok: false, status: 429, data: null };
}

async function getMember(userId) {
  const r = await discord('GET', `/guilds/${GUILD_ID}/members/${userId}`);
  if (r.status === 404) return { inGuild: false, roles: [] };
  if (!r.ok) throw new Error(`Discord member lookup failed (${r.status})`);
  return { inGuild: true, roles: r.data.roles || [] };
}

// `by` is the admin who granted it by hand; omitted for the automatic grant on passing
async function grantRole(userId, by = null) {
  const reason = by ? `Justice Town — تفعيل يدوي بواسطة ${by.username} (${by.id})` : 'Justice Town — نجح في اختبار التفعيل';
  const r = await discord('PUT', `/guilds/${GUILD_ID}/members/${userId}/roles/${ROLE_ID}`, { reason });
  if (!r.ok) {
    const error =
      r.status === 403
        ? 'البوت ما عنده صلاحية Manage Roles أو رتبته أقل من رتبة التفعيل'
        : r.status === 404
          ? 'اللاعب طلع من السيرفر أو الرتبة غير موجودة'
          : `خطأ من Discord (${r.status})`;
    console.error(`✖ منح الرتبة فشل للاعب ${userId}:`, r.status, r.data);
    return { ok: false, error };
  }
  if (REMOVE_ROLE_ID) {
    const d = await discord('DELETE', `/guilds/${GUILD_ID}/members/${userId}/roles/${REMOVE_ROLE_ID}`, { reason });
    if (!d.ok) console.warn(`⚠ ما قدرت أشيل الرتبة القديمة من ${userId} (${d.status})`);
  }
  return { ok: true };
}

async function postLog(embed, components = []) {
  const r = await discord('POST', `/channels/${LOG_CHANNEL_ID}/messages`, {
    body: { embeds: [embed], components, allowed_mentions: { parse: [] } },
  });
  if (!r.ok) console.error('✖ إرسال الرسالة لروم اللوق فشل:', r.status, r.data);
}

// Reopening attempts from the dashboard is also put on record in Discord
function sendResetLog(userId, admin) {
  return postLog({
    title: '🔁 فتح محاولات جديدة',
    color: 0xffc25c,
    fields: [
      { name: 'اللاعب', value: `<@${userId}>`, inline: true },
      { name: 'الإداري', value: `<@${admin.id}>\n\`${admin.username}\``, inline: true },
    ],
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date().toISOString(),
  });
}

const DECISION_TEXT = {
  pending: '⏳ بانتظار قرار الإدارة',
  auto: '✔ انعطت تلقائياً',
};

// Accept / Reject buttons; the custom_id carries the player id so a click still works
// even if the stored attempt is gone (e.g. the free host wiped its disk)
function decisionButtons(attempt) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: 'قبول وإعطاء الرتبة', emoji: { name: '✅' }, custom_id: `jt:accept:${attempt.id}:${attempt.userId}` },
      { type: 2, style: 4, label: 'رفض', emoji: { name: '✖️' }, custom_id: `jt:reject:${attempt.id}:${attempt.userId}` },
    ],
  }];
}

async function sendLog(attempt) {
  const wrong = attempt.answers.filter((a) => !a.isCorrect);
  let details = wrong
    .map((a) => `• **${a.question}**\n  ↳ جاوب: ${a.chosen === null ? '— لم يجاوب —' : a.options[a.chosen]}`)
    .join('\n');
  if (details.length > 3000) details = `${details.slice(0, 3000)}\n…`;
  const embed = {
    title: !attempt.passed ? '❌ رسوب في اختبار التفعيل' : attempt.decision === 'pending' ? '📝 نجح — بانتظار قرار الإدارة' : '✅ نجاح في اختبار التفعيل',
    color: !attempt.passed ? 0xff5d6c : attempt.decision === 'pending' ? 0xffc25c : 0x3ecf8e,
    thumbnail: { url: attempt.avatar },
    description: [
      wrong.length ? `**الأخطاء (${wrong.length}):**\n${details}` : '**جاوب على كل الأسئلة صح** 🎯',
      `\n[عرض التفاصيل في لوحة النتائج](${BASE_URL}/admin#${attempt.id})`,
    ].join('\n'),
    fields: [
      { name: 'اللاعب', value: `<@${attempt.userId}>\n\`${attempt.username}\``, inline: true },
      { name: 'النتيجة', value: `**${attempt.score}/${attempt.total}** (${attempt.percent}%)`, inline: true },
      { name: 'المدة', value: formatDuration(attempt.durationSec) + (attempt.timedOut ? ' ⏰' : ''), inline: true },
      { name: 'رقم المحاولة', value: String(attempt.attemptNo), inline: true },
      { name: 'طلع من الصفحة', value: attempt.focusLost == null ? '—' : `${attempt.focusLost} مرة${attempt.focusLost >= 3 ? ' ⚠' : ''}`, inline: true },
      {
        name: 'الرتبة',
        value: !attempt.passed ? '—' : attempt.roleError ? `✖ فشل: ${attempt.roleError}` : DECISION_TEXT[attempt.decision] || '—',
        inline: true,
      },
    ],
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date(attempt.submittedAt).toISOString(),
  };
  await postLog(embed, attempt.decision === 'pending' ? decisionButtons(attempt) : []);
}

// ---------------------------------------------------------------------
//  Exam logic
// ---------------------------------------------------------------------
const SUBMIT_GRACE_MS = 60_000;

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
  const attempt = {
    id: randomId(),
    userId: user.id,
    username: user.username,
    name: user.name,
    avatar: avatarUrl(user),
    startedAt: active.startedAt,
    submittedAt,
    durationSec: Math.max(0, Math.round((submittedAt - active.startedAt) / 1000)),
    score,
    total,
    percent,
    passPercent: settings.passPercent,
    passed: percent >= settings.passPercent,
    timedOut,
    attemptNo: userAttempts(user.id).length + 1,
    roleGranted: false,
    roleError: null,
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
    sendLog(attempt).catch((e) => console.error(e));
  }
}

async function userStatus(user) {
  const { settings } = loadConfig();
  expireActive(user);
  const member = await getMember(user.id);
  const hasRole = member.inGuild && member.roles.includes(ROLE_ID);
  const attempts = userAttempts(user.id);
  const last = attempts[attempts.length - 1] || null;
  // a rejected pass counts like a failed attempt
  const failed = (a) => !a.passed || a.decision === 'rejected';
  const passedAttempt = attempts.find((a) => !failed(a)) || null;
  const attemptsLeft = settings.maxAttempts > 0 ? Math.max(0, settings.maxAttempts - attempts.length) : null;
  let cooldownUntil = last && failed(last) && settings.cooldownMinutes > 0 ? last.submittedAt + settings.cooldownMinutes * 60_000 : 0;
  if (cooldownUntil <= now()) cooldownUntil = 0;

  let state = 'ready';
  if (!member.inGuild) state = 'not_in_guild';
  else if (hasRole) state = 'has_role';
  else if (passedAttempt && ['pending', 'processing'].includes(passedAttempt.decision)) state = 'pending_review';
  else if (passedAttempt) state = 'role_pending';
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

// ----- Discord buttons (Interactions Endpoint URL) -----
// Registered before the JSON parser: the signature check needs the raw body.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_ROLES = 1n << 28n;
const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });

function verifyInteraction(req) {
  const sig = req.get('x-signature-ed25519');
  const ts = req.get('x-signature-timestamp');
  if (!sig || !ts || !Buffer.isBuffer(req.body)) return false;
  try {
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), req.body]), interactionKey, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

// Who may click Accept/Reject: anyone in ADMIN_IDS, or with Manage Roles / Administrator in the server
function canDecide(member) {
  if (!member?.user) return false;
  if (ADMIN_IDS.has(member.user.id)) return true;
  const perms = BigInt(member.permissions || '0');
  return (perms & (PERM_ADMINISTRATOR | PERM_MANAGE_ROLES)) !== 0n;
}

// Rebuild the embed with the decision (sending back Discord's own embed object can be rejected)
function decidedEmbed(old, accepted, by, error) {
  const value = error ? `✖ فشل إعطاء الرتبة: ${error}` : accepted ? `✅ قبله <@${by.id}>` : `❌ رفضه <@${by.id}>`;
  const fields = (old.fields || []).map((f) => (f.name === 'الرتبة' ? { name: f.name, value: accepted && !error ? '✔ انعطت' : '—', inline: true } : { name: f.name, value: f.value, inline: f.inline }));
  fields.push({ name: 'القرار', value, inline: false });
  return {
    title: error ? '⚠ قبول — بس الرتبة ما انعطت' : accepted ? '✅ تم القبول' : '❌ تم الرفض',
    color: error ? 0xffc25c : accepted ? 0x3ecf8e : 0xff5d6c,
    description: old.description,
    thumbnail: old.thumbnail?.url ? { url: old.thumbnail.url } : undefined,
    fields,
    footer: { text: 'Justice Town • نظام التفعيل' },
    timestamp: new Date().toISOString(),
  };
}

async function handleDecision(i, action, attemptId, userId, by) {
  const accepted = action === 'accept';
  const attempt = store.attempts.find((a) => a.id === attemptId);
  let error = null;
  if (accepted) {
    const r = await grantRole(userId, by).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) error = r.error;
  }
  if (attempt) {
    attempt.decision = error ? 'pending' : accepted ? 'accepted' : 'rejected';
    attempt.decidedBy = error ? null : { ...by, at: now() };
    attempt.roleGranted = accepted && !error;
    attempt.roleError = error;
  }
  if (!error) store.adminLog.push({ action, userId, by, at: now() });
  saveStore();

  const old = i.message?.embeds?.[0] || {};
  const edit = await discord('PATCH', `/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    body: {
      embeds: [decidedEmbed(old, accepted, by, error)],
      // keep the buttons if the grant failed so it can be retried
      components: error ? i.message.components : [],
      allowed_mentions: { parse: [] },
    },
  });
  if (!edit.ok) console.error('✖ تعديل رسالة القرار فشل:', edit.status, edit.data);
  if (error) {
    await discord('POST', `/webhooks/${i.application_id}/${i.token}`, {
      body: { content: `⚠ ما قدرت أعطي الرتبة: ${error}`, flags: 64 },
    });
  }
}

app.post(
  '/discord/interactions',
  express.raw({ type: '*/*', limit: '64kb' }),
  (req, res) => {
    if (!verifyInteraction(req)) return res.status(401).send('invalid request signature');
    let i;
    try { i = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
    if (i.type === 1) return res.json({ type: 1 }); // PING when you save the URL in the portal
    if (i.type !== 3) return res.status(400).end();

    const [ns, action, attemptId, userId] = String(i.data?.custom_id || '').split(':');
    if (ns !== 'jt' || !['accept', 'reject'].includes(action) || !/^\d{5,25}$/.test(userId || '')) {
      return res.json(ephemeral('زر غير معروف.'));
    }
    if (!canDecide(i.member)) return res.json(ephemeral('⛔ ما عندك صلاحية تقبل أو ترفض.'));

    const attempt = store.attempts.find((a) => a.id === attemptId);
    if (attempt && ['accepted', 'rejected', 'processing'].includes(attempt.decision)) {
      return res.json(ephemeral(attempt.decision === 'processing' ? 'جاري التنفيذ…' : `تم البت فيه من قبل بواسطة ${attempt.decidedBy?.name || 'إداري'}.`));
    }
    if (attempt) attempt.decision = 'processing'; // blocks a double click while we work

    const u = i.member.user;
    const by = { id: u.id, username: u.username, name: i.member.nick || u.global_name || u.username };
    // Acknowledge within Discord's 3 seconds, then do the work and edit the message
    res.json({ type: 6 });
    handleDecision(i, action, attemptId, userId, by).catch((e) => {
      console.error('✖ معالجة القرار فشلت:', e);
      if (attempt && attempt.decision === 'processing') attempt.decision = 'pending';
    });
  }
);

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

// Per-IP rate limits: general API traffic, and a tighter bucket for actions
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
app.use(['/api/exam', '/api/role', '/api/admin', '/auth/login', '/auth/callback'], (req, res, next) =>
  req.method === 'GET' && req.path.startsWith('/attempts') ? next() : rateLimit('action', 20)(req, res, next)
);
setInterval(() => { const t = now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 120_000).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function currentUser(req) {
  return unsign(parseCookies(req).jt_session);
}
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_logged_in' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_logged_in' });
  if (!isAdmin(user.id)) return res.status(403).json({ error: 'not_admin' });
  req.user = user;
  next();
}

function startSession(res, user) {
  const session = { id: user.id, username: user.username, name: user.name, avatar: user.avatar, exp: now() + 7 * 86400_000 };
  setCookie(res, 'jt_session', sign(session), 7 * 86400);
}

// ----- Auth -----
app.get('/auth/login', (req, res) => {
  const state = randomId();
  setCookie(res, 'jt_state', sign({ state, exp: now() + 10 * 60_000 }), 600);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'identify',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get(
  '/auth/callback',
  wrap(async (req, res) => {
    const saved = unsign(parseCookies(req).jt_state);
    setCookie(res, 'jt_state', '', 0);
    if (req.query.error) return res.redirect('/?error=denied');
    if (!saved || saved.state !== req.query.state || !req.query.code) return res.redirect('/?error=state');

    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      console.error('✖ OAuth token exchange failed:', tokenRes.status, await tokenRes.text());
      return res.redirect('/?error=oauth');
    }
    const { access_token, token_type } = await tokenRes.json();
    const me = await discord('GET', '/users/@me', { auth: `${token_type} ${access_token}` });
    if (!me.ok) return res.redirect('/?error=oauth');

    startSession(res, { id: me.data.id, username: me.data.username, name: me.data.global_name || me.data.username, avatar: me.data.avatar });
    res.redirect('/');
  })
);

app.post('/auth/logout', (req, res) => {
  setCookie(res, 'jt_session', '', 0);
  res.json({ ok: true });
});

// ----- Player API -----
app.get(
  '/api/me',
  wrap(async (req, res) => {
    const { settings, rules, questions } = loadConfig();
    const info = {
      exam: {
        title: settings.title,
        passPercent: settings.passPercent,
        questionCount: settings.questionCount > 0 ? Math.min(settings.questionCount, questions.length) : questions.length,
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
      user: { id: user.id, username: user.username, name: user.name, avatar: avatarUrl(user), isAdmin: isAdmin(user.id) },
      status: await userStatus(user),
    });
  })
);

app.post(
  '/api/exam/start',
  requireUser,
  wrap(async (req, res) => {
    const status = await userStatus(req.user);
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
  })
);

app.post(
  '/api/exam/submit',
  requireUser,
  wrap(async (req, res) => {
    const active = store.active[req.user.id];
    const { examId, answers, focusLost } = req.body || {};
    if (typeof examId !== 'string' || !active || active.examId !== examId) return res.status(409).json({ error: 'no_active_exam' });
    const cleanAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};

    const late = active.deadline && now() > active.deadline + SUBMIT_GRACE_MS;
    const timedOut = Boolean(active.deadline && now() > active.deadline);
    const attempt = gradeAndRecord(req.user, active, late ? null : cleanAnswers, { timedOut });
    // Client-reported count of times the player left the exam tab (anti-cheat hint for admins)
    attempt.focusLost = Number.isInteger(focusLost) ? Math.min(Math.max(focusLost, 0), 999) : null;

    const { settings } = loadConfig();
    if (attempt.passed && settings.autoGrant) {
      const r = await grantRole(req.user.id).catch((e) => ({ ok: false, error: e.message }));
      attempt.decision = 'auto';
      attempt.roleGranted = r.ok;
      attempt.roleError = r.ok ? null : r.error;
    } else if (attempt.passed) {
      attempt.decision = 'pending'; // an admin accepts or rejects from the Discord message
    }
    store.attempts.push(attempt);
    saveStore();
    sendLog(attempt).catch((e) => console.error(e));

    res.json({
      passed: attempt.passed,
      pending: attempt.decision === 'pending',
      score: attempt.score,
      total: attempt.total,
      percent: attempt.percent,
      passPercent: attempt.passPercent,
      timedOut: attempt.timedOut,
      roleGranted: attempt.roleGranted,
      review: settings.showReview ? attempt.answers.map(({ question, options, chosen, correct }) => ({ question, options, chosen, correct })) : null,
      status: await userStatus(req.user),
    });
  })
);

app.post(
  '/api/role/retry',
  requireUser,
  wrap(async (req, res) => {
    // only once an admin accepted (or auto mode granted) can the player re-request a failed role grant
    const attempt = userAttempts(req.user.id).find((a) => a.passed && ['accepted', 'auto', undefined].includes(a.decision));
    if (!attempt) return res.status(403).json({ error: 'not_passed' });
    const r = await grantRole(req.user.id);
    attempt.roleGranted = r.ok;
    attempt.roleError = r.ok ? null : r.error;
    saveStore();
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, error: r.ok ? undefined : 'role_failed' });
  })
);

// ----- Admin API -----
app.get('/api/admin/attempts', requireAdmin, (req, res) => {
  const attempts = store.attempts.slice().reverse();
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

const adminRef = (user) => ({ id: user.id, username: user.username, name: user.name });

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || '');
  if (!/^\d{5,25}$/.test(userId)) return res.status(400).json({ error: 'bad_user' });
  const by = adminRef(req.user);
  store.resets[userId] = now();
  delete store.active[userId];
  store.adminLog.push({ action: 'reset', userId, by, at: now() });
  saveStore();
  sendResetLog(userId, by).catch((e) => console.error(e));
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
  console.log(`\n  ⚖  Justice Town Exam شغّال على ${BASE_URL}`);
  console.log(`     رابط الرجوع اللي تحطه في Discord Redirects: ${REDIRECT_URI}\n`);
});
