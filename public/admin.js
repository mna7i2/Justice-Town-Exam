/* =====================================================================
   Admin dashboard — attempts list, stats, reset / grant actions.
   ===================================================================== */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}د ${s % 60}ث` : `${s}ث`);

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

  async function load() {
    try {
      data = await api('/api/admin/attempts');
    } catch (e) {
      $('#content').hidden = true;
      $('#denied').hidden = false;
      if (e.status === 401) {
        $('#denied-text').textContent = 'سجّل دخولك بحساب Discord اللي آيديه موجود في ADMIN_IDS.';
        $('#denied-actions').innerHTML = '<a class="btn btn-primary" href="/auth/login">تسجيل الدخول</a>';
      } else {
        $('#denied-text').textContent = 'حسابك مو مضاف كإداري. أضف آيدي حسابك في ADMIN_IDS داخل ملف .env وأعد تشغيل الموقع.';
        $('#denied-actions').innerHTML = '';
      }
      return;
    }
    $('#denied').hidden = true;
    $('#content').hidden = false;
    renderStats();
    renderRows();
    renderHardest();
    const hash = location.hash.slice(1);
    if (hash) openAttempt(hash);
  }

  function renderStats() {
    const s = data.stats;
    const cards = [
      ['إجمالي المحاولات', s.total, ''],
      ['ناجح', s.passed, 'ok'],
      ['راسب', s.failed, 'bad'],
      ['نسبة النجاح', `${s.passRate}<small>%</small>`, ''],
      ['متوسط الدرجات', `${s.avgPercent}<small>%</small>`, ''],
      ['يختبرون الحين', s.inProgress, ''],
    ];
    $('#stats').innerHTML = cards.map(([k, v, c]) => `<div class="glass stat"><span class="stat-k">${k}</span><span class="stat-v ${c}">${v}</span></div>`).join('');
  }

  function visibleAttempts() {
    const q = query.trim().toLowerCase();
    return data.attempts.filter((a) => {
      if (filter === 'pass' && !a.passed) return false;
      if (filter === 'fail' && a.passed) return false;
      if (filter === 'role' && !(a.passed && !a.roleGranted)) return false;
      if (q && !`${a.name} ${a.username} ${a.userId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function badge(a) {
    if (!a.passed) return `<span class="badge bad">${a.timedOut ? 'انتهى الوقت' : 'راسب'}</span>`;
    return a.roleGranted ? '<span class="badge ok">ناجح · الرتبة وصلت</span>' : '<span class="badge warn">ناجح · الرتبة فشلت</span>';
  }

  function renderRows() {
    const list = visibleAttempts();
    $('#rows').innerHTML = list.length
      ? list.map((a, i) => `
        <button class="row" data-id="${esc(a.id)}" style="--i:${Math.min(i, 20)}">
          <img src="${esc(a.avatar)}" alt="" loading="lazy">
          <span class="row-name"><b>${esc(a.name)}</b><span><bdi>@${esc(a.username)}</bdi> · <bdi>${fmtDate(a.submittedAt)}</bdi> · محاولة ${a.attemptNo}</span></span>
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

    $('#drawer-body').innerHTML = `
      <div class="d-head">
        <img src="${esc(a.avatar)}" alt="">
        <div><h3>${esc(a.name)}</h3><p>@${esc(a.username)} · ${esc(a.userId)}</p></div>
      </div>
      <div class="d-meta">
        ${badge(a)}
        <span class="chip">الدرجة: <b>${a.score}/${a.total}</b> (${a.percent}%)</span>
        <span class="chip">المدة: ${fmtDur(a.durationSec)}</span>
        <span class="chip">المحاولة رقم ${a.attemptNo}</span>
        ${a.focusLost == null ? '' : `<span class="chip ${a.focusLost >= 3 ? 'bad' : ''}">طلع من الصفحة: ${a.focusLost} مرة</span>`}
        <span class="chip">${fmtDate(a.submittedAt)}</span>
      </div>
      ${a.roleError ? `<p class="bad" style="color:var(--bad);margin:0 0 14px">سبب فشل الرتبة: ${esc(a.roleError)}</p>` : ''}
      ${questions}
      <div class="d-actions">
        <button class="btn btn-ghost" data-act="reset" data-user="${esc(a.userId)}">فتح محاولات جديدة لهذا اللاعب</button>
        <button class="btn btn-ok" data-act="grant" data-user="${esc(a.userId)}">إعطاء الرتبة يدوياً</button>
      </div>`;
    $('#drawer').hidden = false;
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
    if (act) {
      act.disabled = true;
      try {
        if (act.dataset.act === 'reset') {
          await api('/api/admin/reset', { userId: act.dataset.user });
          toast('تم تصفير محاولات اللاعب — يقدر يختبر من جديد.');
        } else {
          await api('/api/admin/grant', { userId: act.dataset.user });
          toast('تم إعطاء الرتبة ✔');
          window.FX?.confetti();
        }
        closeDrawer();
        load();
      } catch (err) {
        toast(err.data?.error || 'العملية فشلت', true);
        act.disabled = false;
      }
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderRows(); });
  $('#reload').addEventListener('click', () => { load(); toast('تم التحديث'); });

  load();
  setInterval(() => { if ($('#drawer').hidden) load(); }, 30000);
})();
