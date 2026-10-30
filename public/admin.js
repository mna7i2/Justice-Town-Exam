/* =====================================================================
   Admin dashboard — password sign-in, attempts list, stats, and
   accept / reject / reset actions recorded under the admin's name.
   ===================================================================== */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}د ${s % 60}ث` : `${s}ث`);
  // time left on a timeout, e.g. "71 ساعة 20 دقيقة"
  const fmtLeft = (until) => {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    const h = Math.floor(mins / 60);
    return h ? `${h} ساعة${mins % 60 ? ` ${mins % 60} دقيقة` : ''}` : `${mins} دقيقة`;
  };
  const PLAYER_LABEL = { accept: 'المتفعل', reject: 'المرفوض', fail: 'المرفوض', reset: 'اللاعب', cancel: 'اللاعب' };
  const isDiscordId = (v) => /^\d{17,20}$/.test(v);
  const idTag = (id) => (id ? ` <code dir="ltr">${esc(id)}</code>` : '');

  let data = null;
  let filter = 'all';
  let query = '';

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || 'request_failed'), { status: res.status, data: json });
    return json;
  }

  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ---------------- Sign in ----------------
  const LOGIN_ERRORS = {
    no_role: 'ما عندك رتبة قسم التفعيل في السيرفر.',
    not_admin: 'حسابك مو من حسابات الإدارة.',
    cancelled: 'لغيت الدخول.',
    expired: 'انتهت مهلة الدخول، جرّب مرة ثانية.',
    discord: 'الدسكورد ما رد، جرّب مرة ثانية.',
  };
  const loginError = new URLSearchParams(location.search).get('login_error');
  if (loginError) history.replaceState(null, '', location.pathname + location.hash);

  async function showLogin() {
    $('#content').hidden = true;
    $('#admin-chip').hidden = true;
    const me = await api('/api/me').catch(() => ({}));
    const discord = me.loginMode === 'discord';
    $('#login-form').hidden = discord;
    $('#discord-login').hidden = !discord;
    $('#login-text').textContent = discord
      ? 'ادخل بحسابك في الدسكورد — ما يدخل إلا اللي عنده رتبة قسم التفعيل.'
      : 'اكتب اسمك وآيديك في الدسكورد — ينسجلون عند كل قرار.';
    const err = $('#discord-error');
    err.textContent = loginError ? LOGIN_ERRORS[loginError] || LOGIN_ERRORS.discord : '';
    err.hidden = !loginError;
    $('#login').hidden = false;
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    const btn = e.submitter || $('#login-form button');
    btn.disabled = true;
    try {
      await api('/api/admin/login', {
        name: $('#admin-name').value.trim(),
        discordId: $('#admin-discord-id').value.trim(),
      });
      await load();
    } catch (ex) {
      err.textContent = {
        not_admin: 'الآيدي هذا مو من آيديات الإدارة.',
        name_required: 'اكتب اسمك.',
        bad_discord_id: 'الـ ID غلط — لازم يكون أرقام بس (17 إلى 20 رقم).',
        rate_limited: 'محاولات كثيرة، انتظر دقيقة.',
      }[ex.message] || 'ما قدرنا ندخلك.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('#admin-logout').addEventListener('click', async () => {
    await api('/api/admin/logout', {}).catch(() => {});
    showLogin(false);
  });

  // ---------------- Data ----------------
  async function load() {
    try {
      data = await api('/api/admin/attempts');
    } catch (e) {
      if (e.status === 401) return showLogin();
      toast('ما قدرنا نجيب النتائج.', true);
      return;
    }
    $('#login').hidden = true;
    $('#content').hidden = false;
    $('#admin-chip').hidden = false;
    $('#admin-who').textContent = data.admin;
    renderStats();
    renderRows();
    renderHardest();
    renderAdminLog();
    const hash = location.hash.slice(1);
    if (hash) openAttempt(hash);
  }

  const isPending = (a) => a.passed && a.decision === 'pending';

  function renderStats() {
    const s = data.stats;
    const cards = [
      ['إجمالي المحاولات', s.total, ''],
      ['ناجح', s.passed, 'ok'],
      ['راسب', s.failed, 'bad'],
      ['نسبة النجاح', `${s.passRate}<small>%</small>`, ''],
      ['بانتظار الرتبة', data.attempts.filter(isPending).length, 'warn'],
      ['يختبرون الحين', s.inProgress, ''],
    ];
    $('#stats').innerHTML = cards.map(([k, v, c]) => `<div class="glass stat"><span class="stat-k">${k}</span><span class="stat-v ${c}">${v}</span></div>`).join('');
  }

  function visibleAttempts() {
    const q = query.trim().toLowerCase();
    return data.attempts.filter((a) => {
      if (filter === 'pass' && !a.passed) return false;
      if (filter === 'fail' && a.passed) return false;
      if (filter === 'pending' && !isPending(a)) return false;
      if (q && !`${a.username} ${a.decidedBy?.name || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // Who decided: the admin who marked it in this dashboard
  function badge(a) {
    if (!a.passed) return `<span class="badge bad">❌ مرفوض${a.timedOut ? ' · انتهى الوقت' : ''}</span>`;
    if (isPending(a)) return '<span class="badge warn">⏳ بانتظار الرتبة</span>';
    if (a.decision === 'rejected') return `<span class="badge bad">❌ رفضه: ${esc(a.decidedBy?.name || 'إداري')}</span>`;
    return `<span class="badge staff">✅ فعّله: ${esc(a.decidedBy?.name || 'إداري')}</span>`;
  }

  const ACTIONS = { accept: '✅ تفعيل', reject: '❌ رفض', fail: '❌ رسب — تايم أوت', reset: '🔁 فتح محاولات جديدة', cancel: '⏹ إلغاء اختبار' };

  function renderAdminLog() {
    const log = data.adminLog.slice(0, 12);
    $('#admin-log').innerHTML = log.length
      ? log.map((l) => `
        <div class="log-item">
          <p class="log-act">${ACTIONS[l.action] || l.action}</p>
          <p>الإداري: <b>${esc(l.by.name)}</b>${idTag(l.by.discordId)}</p>
          <p>${PLAYER_LABEL[l.action] || 'اللاعب'}: <b dir="ltr">${esc(l.username || l.userId)}</b>${idTag(l.playerDiscordId)}</p>
          <small><bdi>${fmtDate(l.at)}</bdi></small>
        </div>`).join('')
      : '<p class="muted">ما فيه إجراءات لين الحين.</p>';
  }

  function renderRows() {
    const list = visibleAttempts();
    $('#rows').innerHTML = list.length
      ? list.map((a, i) => `
        <button class="row" data-id="${esc(a.id)}" style="--i:${Math.min(i, 20)}">
          <img src="${esc(a.avatar)}" alt="" loading="lazy">
          <span class="row-name"><b dir="ltr">${esc(a.username)}</b><span><bdi>${fmtDate(a.submittedAt)}</bdi> · محاولة ${a.attemptNo}${a.timeoutUntil ? ` · <em class="timeout">⏳ تايم أوت: باقي ${fmtLeft(a.timeoutUntil)}</em>` : ''}</span></span>
          ${badge(a)}
          <span class="row-score" style="color:${a.passed ? 'var(--ok)' : 'var(--bad)'}">${a.percent}%</span>
        </button>`).join('')
      : '<div class="empty">ما فيه نتائج لين الحين.</div>';
  }

  function renderHardest() {
    $('#hardest').innerHTML = data.hardest.length
      ? data.hardest.map((q) => `
        <div class="hq">
          <p>${esc(q.question)}</p>
          <div class="bar"><i style="width:${q.rate}%"></i></div>
          <small>${q.rate}% · ${q.correct}/${q.asked}</small>
        </div>`).join('')
      : '<p class="muted">يظهر هنا بعد أول محاولات.</p>';
  }

  function openAttempt(id) {
    const a = data.attempts.find((x) => x.id === id);
    if (!a) return;
    history.replaceState(null, '', `#${id}`);
    const questions = a.answers.map((q, i) => `
      <div class="d-q ${q.isCorrect ? 'ok' : 'bad'}">
        <h4>${i + 1}. ${esc(q.question)}</h4>
        <p class="${q.isCorrect ? 'ok' : 'bad'}">${q.isCorrect ? '✔' : '✖'} جاوب: ${q.chosen === null ? '— لم يجاوب —' : esc(q.options[q.chosen])}</p>
        ${q.isCorrect ? '' : `<p class="ok">الصحيح: ${esc(q.options[q.correct])}</p>`}
      </div>`).join('');
    const actionHistory = data.adminLog
      .filter((l) => l.userId === a.userId)
      .map((l) => `<p>${ACTIONS[l.action] || l.action} — بواسطة <b>${esc(l.by.name)}</b> · <bdi>${fmtDate(l.at)}</bdi></p>`)
      .join('');

    // accepting is locked until the admin types the player's Discord ID
    const decideButtons = isPending(a)
      ? `<div class="player-id">
           <label for="player-id">آيدي المتفعل في الدسكورد <small>(لازم قبل التفعيل)</small></label>
           <input id="player-id" dir="ltr" inputmode="numeric" maxlength="20" placeholder="123456789012345678" autocomplete="off">
           <p class="id-help">اضغط على اسم اللاعب في الدسكورد يمين ← <b>Copy User ID</b></p>
         </div>
         <button class="btn btn-ok" data-act="accept" data-id="${esc(a.id)}" disabled>✅ أعطيته الرتبة في الدسكورد</button>
         <button class="btn btn-ghost" data-act="reject" data-id="${esc(a.id)}">❌ رفض</button>`
      : '';

    $('#drawer-body').innerHTML = `
      <div class="d-head">
        <img src="${esc(a.avatar)}" alt="">
        <div><h3 dir="ltr">${esc(a.username)}</h3><p>يوزر الدسكورد — انسخه ودوّره في السيرفر</p></div>
      </div>
      <div class="d-meta">
        ${badge(a)}
        <span class="chip">الدرجة: <b>${a.score}/${a.total}</b> (${a.percent}%)</span>
        <span class="chip">المدة: ${fmtDur(a.durationSec)}</span>
        <span class="chip">المحاولة رقم ${a.attemptNo}</span>
        ${a.focusLost == null ? '' : `<span class="chip ${a.focusLost >= 3 ? 'bad' : ''}">طلع من الصفحة: ${a.focusLost} مرة</span>`}
        <span class="chip">${fmtDate(a.submittedAt)}</span>
      </div>
      ${a.decidedBy ? `<div class="d-granted ${a.decision === 'rejected' ? 'is-rejected' : ''}">
        <p>${a.decision === 'rejected' ? '❌ تم الرفض' : '✅ تم التفعيل'} · <bdi>${fmtDate(a.decidedBy.at)}</bdi></p>
        <p>الإداري: <b>${esc(a.decidedBy.name)}</b>${idTag(a.decidedBy.discordId)}</p>
        <p>${a.decision === 'rejected' ? 'المرفوض' : 'المتفعل'}: <b dir="ltr">${esc(a.username)}</b>${idTag(a.discordId)}</p>
      </div>` : ''}
      ${!a.passed && a.conductedBy ? `<div class="d-granted is-rejected">
        <p>❌ رسب · <bdi>${fmtDate(a.submittedAt)}</bdi></p>
        <p>الإداري: <b>${esc(a.conductedBy.name)}</b>${idTag(a.conductedBy.discordId)}</p>
        <p>المرفوض: <b dir="ltr">${esc(a.username)}</b>${idTag(a.discordId)}</p>
      </div>` : ''}
      ${a.timeoutUntil ? `<p class="d-granted is-rejected">❌ مرفوض — عليه تايم أوت، يقدر يعيد بعد <b>${fmtLeft(a.timeoutUntil)}</b> (<bdi>${fmtDate(a.timeoutUntil)}</bdi>)</p>` : ''}
      ${isPending(a) ? '<p class="d-granted is-pending">⏳ نجح — أعطه الرتبة في الدسكورد بيدك، وبعدها اضغط الزر الأخضر تحت عشان ينسجل باسمك.</p>' : ''}
      ${actionHistory ? `<div class="d-history"><h4>إجراءات الإدارة على هذا اللاعب</h4>${actionHistory}</div>` : ''}
      ${questions}
      <div class="d-actions">
        ${decideButtons}
        <button class="btn btn-ghost" data-act="reset" data-user="${esc(a.userId)}">🔁 فتح محاولات جديدة</button>
      </div>`;
    $('#drawer').hidden = false;
    const idInput = $('#player-id');
    if (idInput) {
      idInput.addEventListener('input', () => {
        idInput.value = idInput.value.replace(/\D/g, '');
        $('#drawer [data-act="accept"]').disabled = !isDiscordId(idInput.value);
      });
      idInput.focus();
    }
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    history.replaceState(null, '', location.pathname);
  }

  document.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if (row) return openAttempt(row.dataset.id);
    if (e.target.closest('#drawer [data-close]')) return closeDrawer();

    const seg = e.target.closest('#filter button');
    if (seg) {
      filter = seg.dataset.f;
      document.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('is-on', b === seg));
      return renderRows();
    }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    act.disabled = true;
    try {
      if (act.dataset.act === 'reset') {
        await api('/api/admin/reset', { userId: act.dataset.user });
        toast('تم تصفير محاولات اللاعب — يقدر يختبر من جديد.');
      } else {
        const playerDiscordId = ($('#player-id')?.value || '').trim();
        if (act.dataset.act === 'accept' && !isDiscordId(playerDiscordId)) {
          toast('اكتب الـ ID حق المتفعل أول.', true);
          act.disabled = false;
          return;
        }
        await api('/api/admin/decide', { attemptId: act.dataset.id, action: act.dataset.act, playerDiscordId: playerDiscordId || undefined });
        toast(act.dataset.act === 'accept' ? 'انسجل التفعيل باسمك ✔' : 'تم الرفض.');
      }
      closeDrawer();
      load();
    } catch (err) {
      if (err.message === 'already_decided') toast(`قرر فيه ${err.data.by || 'إداري ثاني'} قبلك.`, true);
      else if (err.message === 'player_id_required' || err.message === 'bad_discord_id') toast('الـ ID غلط — لازم يكون أرقام بس (17 إلى 20 رقم).', true);
      else if (err.status === 401) { closeDrawer(); showLogin(false); toast('سجّل دخول مرة ثانية واكتب الـ ID حقك.', true); return; }
      else toast('العملية فشلت', true);
      act.disabled = false;
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderRows(); });
  $('#reload').addEventListener('click', () => { load(); toast('تم التحديث'); });

  load();
  setInterval(() => { if ($('#drawer').hidden && !$('#content').hidden) load(); }, 30000);
})();
