# ⚖ Justice Town — موقع اختبار التفعيل

اللاعب يدخل الموقع ← يربط حسابه في Discord ← يحل الاختبار ← الموقع يصحح تلقائياً ← إذا نجح تنعطى له الرتبة في السيرفر فوراً، والنتيجة توصلك في روم بالدسكورد + لوحة نتائج خاصة فيك على `/admin`.

---

## 📁 الملفات المهمة

| الملف | وش فيه |
|---|---|
| `config/questions.json` | **الأسئلة والأجوبة والإعدادات** — هذا الملف اللي بتعدل عليه |
| `.env` | مفاتيح Discord والإعدادات السرية (تسويه من `.env.example`) |
| `data/store.json` | النتائج (ينشأ تلقائياً — لا تحذفه) |
| `server.js` | السيرفر |
| `public/` | تصميم الموقع |

---

## ✏ تعديل الأسئلة

افتح `config/questions.json`. كل سؤال كذا:

```json
{
  "question": "وش معنى RDM؟",
  "options": ["قتل بدون سبب", "صدم بالسيارة", "ميتا قيمنق"],
  "answer": 1
}
```

- `answer` = **رقم** الخيار الصحيح (1 = الأول، 2 = الثاني…) أو نص الخيار الصحيح بالضبط.
- تقدر تحط خيارين (صح/خطأ) أو أكثر لين 8.
- التعديل يشتغل **فوراً** بدون ما تعيد تشغيل الموقع.
- الأجوبة الصحيحة ما توصل للمتصفح أبداً — التصحيح كله في السيرفر، فما أحد يقدر يغش من الكود.

**الإعدادات (`settings`):**

| الإعداد | المعنى |
|---|---|
| `passPercent` | نسبة النجاح (مثلاً 80) |
| `questionCount` | كم سؤال يطلع لكل لاعب (ينسحبون عشوائياً من كل الأسئلة). `0` = كلهم |
| `timeLimitMinutes` | وقت الاختبار بالدقايق. `0` = بدون وقت |
| `cooldownMinutes` | كم ينتظر الراسب قبل يعيد |
| `maxAttempts` | أقصى عدد محاولات. `0` = مفتوح |
| `shuffleQuestions` / `shuffleOptions` | خلط ترتيب الأسئلة والخيارات |
| `showReview` | `true` = بعد الاختبار يشوف اللاعب الصح والغلط (ما أنصح فيه، يسهل تسريب الأجوبة) |

---

## 🤖 الخطوة 1: تجهيز Discord

1. ادخل https://discord.com/developers/applications ← **New Application** ← سمّه `Justice Town`.
2. **OAuth2**:
   - انسخ **Client ID** و **Client Secret** (اضغط Reset Secret).
   - في **Redirects** أضف: `https://موقعك.com/auth/callback`
     (ولو بتجرب على جهازك أضف كمان: `http://localhost:3000/auth/callback`)
3. **Bot** ← **Reset Token** ← انسخ التوكن. (لا تعطيه أحد!)
4. دخّل البوت سيرفرك: **OAuth2 → URL Generator** ← علّم `bot` ← من الصلاحيات علّم **Manage Roles** و **Send Messages** و **Embed Links** ← افتح الرابط واختر سيرفرك.
5. ⚠ **مهم جداً:** في إعدادات السيرفر ← Roles ← اسحب رتبة البوت **فوق** رتبة التفعيل، وإلا ما يقدر يعطيها.
6. في دسكورد: الإعدادات ← Advanced ← فعّل **Developer Mode**. بعدها كليك يمين وانسخ الآيدي لـ: السيرفر، رتبة التفعيل، روم النتائج، وحسابك.

## ⚙ الخطوة 2: ملف `.env`

انسخ `.env.example` باسم `.env` وعبّيه:

```
BASE_URL=https://موقعك.com
SESSION_SECRET=اكتب-هنا-كلام-عشوائي-طويل-جدا-40-حرف-أو-أكثر
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_ROLE_ID=...
DISCORD_REMOVE_ROLE_ID=        ← اختياري: رتبة "غير مفعّل" تنشال إذا نجح
DISCORD_LOG_CHANNEL_ID=...
DISCORD_INVITE_URL=https://discord.gg/...
ADMIN_IDS=آيدي_حسابك,آيدي_إداري_ثاني
DEV_MODE=false
```

## ▶ الخطوة 3: التشغيل على جهازك (للتجربة)

تحتاج [Node.js](https://nodejs.org) نسخة 18 أو أحدث.

```bash
npm install
```

```bash
npm start
```

وافتح http://localhost:3000

> 💡 تبي تشوف التصميم وتجرب الاختبار **قبل** ما تجهز Discord؟ حط `DEV_MODE=true` في `.env` واترك مفاتيح Discord فاضية — الدخول والرتبة يصيرون وهميين، ولوحة النتائج تشتغل على `/admin`.

---

## 🌍 الخطوة 4: رفع الموقع على الإنترنت

الموقع يحتاج **سيرفر Node.js شغّال 24 ساعة** (مو استضافة صفحات ثابتة)، لأنه هو اللي يكلم البوت ويعطي الرتب ويحفظ النتائج.

### الخيار أ — Google Cloud (فيه سيرفر مجاني دائم)

1. ادخل https://console.cloud.google.com ← **Compute Engine** ← **Create Instance**.
2. اختر: النوع **e2-micro**، المنطقة **us-central1** أو **us-east1** أو **us-west1** (هذي اللي مجانية)، النظام **Ubuntu 24.04**، وعلّم **Allow HTTP** و **Allow HTTPS**.
3. افتح **SSH** من الصفحة واكتب:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

4. ارفع مجلد المشروع (زر **Upload file** في نافذة SSH، أو عن طريق GitHub)، ثم داخل المجلد:

```bash
npm install --omit=dev && sudo npm i -g pm2 && pm2 start server.js --name justice-exam && pm2 save && pm2 startup
```

5. اربط دومين واعمل HTTPS (أسهل طريقة: [Caddy](https://caddyserver.com) — سطر واحد يسوي لك شهادة SSL تلقائياً):
   ```
   exam.justicetown.com {
     reverse_proxy localhost:3000
   }
   ```

### الخيار ب — عندك VPS حق سيرفر FiveM؟

نفس خطوات 3 و 4 فوق بالضبط، وتشغله جنب السيرفر.

### الخيار ج — Railway (أسهل، بس مدفوع بعد الفترة المجانية)

ارفع المشروع على GitHub ← https://railway.app ← New Project ← Deploy from GitHub ← حط متغيرات `.env` في **Variables** ← أضف **Volume** على المسار `/app/data` عشان النتائج ما تنحذف.

> بعد ما ترفع، لا تنسى: غيّر `BASE_URL` للرابط الجديد، وأضف `https://رابطك/auth/callback` في Redirects حق Discord.

---

## 🛡 لوحة النتائج `/admin`

تدخلها بحسابك (لازم آيديك في `ADMIN_IDS`). فيها:
- إحصائيات: كم ناجح وراسب ونسبة النجاح ومين يختبر الحين.
- كل محاولة بالتفصيل: وش جاوب على كل سؤال وكم أخذ وقت.
- **فتح محاولات جديدة** للاعب خلّص محاولاته.
- **إعطاء الرتبة يدوياً** لو صار خطأ.
- أصعب الأسئلة (اللي أغلب الناس يغلطون فيها).

## ❓ مشاكل شائعة

| المشكلة | الحل |
|---|---|
| "Invalid OAuth2 redirect_uri" | الرابط في Redirects لازم يطابق `BASE_URL/auth/callback` حرف بحرف |
| نجح بس الرتبة ما وصلت | رتبة البوت لازم تكون **فوق** رتبة التفعيل، ومعه صلاحية Manage Roles |
| يقول "لازم تكون داخل السيرفر" | اللاعب مو داخل سيرفر الدسكورد، أو `DISCORD_GUILD_ID` غلط |
| النتائج ما توصل للروم | البوت يحتاج يشوف الروم ويرسل فيه (View Channel + Send Messages + Embed Links) |
