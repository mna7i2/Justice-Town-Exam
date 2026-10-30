/* =====================================================================
   Exam client (admins only) — sign in, look up a citizen, run the exam
   on a shared screen, hand it in with the citizen's Discord ID.
   ===================================================================== */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  };
  const CITIZEN_KEY = 'jt_citizen';

  let info = null;         // /api/me payload
  let citizen = null;      // looked-up citizen { username, status, activatedBy }
  let exam = null;         // active exam
  let answers = {};        // qid -> option index
  let current = 0;
  let timerId = null;
  let cooldownId = null;
  let clockSkew = 0;
  let submitting = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const isDiscordId = (v) => /^\d{17,20}$/.test(v);
  const fmtDate = (t) => new Date(t).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  const remember = (name) => { try { name ? sessionStorage.setItem(CITIZEN_KEY, name) : sessionStorage.removeItem(CITIZEN_KEY); } catch {} };
  const remembered = () => { try { return sessionStorage.getItem(CITIZEN_KEY); } catch { return null; } };

  // ---------------- API ----------------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/admin/login') {
      exam = null;
      boot();
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data });
    return data;
  }

  // ---------------- UI helpers ----------------
  function show(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3800);
  }

  function confirmModal(title, text, okLabel = 'تأكيد') {
    return new Promise((resolve) => {
      const modal = $('#modal');
      $('#modal-title').textContent = title;
      $('#modal-text').textContent = text;
      $('#modal-ok').textContent = okLabel;
      modal.hidden = false;
      const done = (v) => {
        modal.hidden = true;
        modal.removeEventListener('click', onClick);
        resolve(v);
      };
      const onClick = (e) => {
        if (e.target.closest('[data-close]')) done(false);
        else if (e.target.closest('#modal-ok')) done(true);
      };
      modal.addEventListener('click', onClick);
      $('#modal-ok').focus();
    });
  }

  function fmtMinutes(m) {
    if (!m) return 'مفتوح';
    return `${m}<small>دقيقة</small>`;
  }

  // ---------------- Boot ----------------
  async function boot() {
    try {
      info = await api('/api/me');
    } catch {
      show('landing');
      toast('ما قدرنا نتصل بالسيرفر، حدّث الصفحة.', true);
      return;
    }
    if (!info.admin) {
      $('#user-chip').hidden = true;
      $('#admin-link').hidden = true;
      $('#login-form').hidden = info.loginMode === 'discord';
      $('#discord-login').hidden = info.loginMode !== 'discord';
      return show('landing');
    }

    $('#user-chip').hidden = false;
    $('#admin-link').hidden = false;
    $('#user-name').textContent = info.admin.name;
    $('#st-count').textContent = info.exam.questionCount;
    $('#st-time').innerHTML = fmtMinutes(info.exam.timeLimitMinutes);
    $('#st-pass').innerHTML = `${info.exam.passScore}<small>من ${info.exam.questionCount}</small>`;
    show('dash');

    // after a refresh, pick up the citizen the admin was testing
    const name = remembered();
    if (name) {
      $('#citizen-username').value = name;
      await checkCitizen(name, true);
    }
  }

  function showLoginError(msg) {
    const err = $('#login-error');
    err.textContent = msg;
    err.hidden = !msg;
  }

  // the Discord sign-in comes back as /?login_error=… when it's refused
  const LOGIN_ERRORS = {
    no_role: 'ما عندك رتبة قسم التفعيل في السيرفر.',
    not_admin: 'حسابك مو من حسابات الإدارة.',
    cancelled: 'لغيت الدخول.',
    expired: 'انتهت مهلة الدخول، جرّب مرة ثانية.',
    discord: 'الدسكورد ما رد، جرّب مرة ثانية.',
  };
  const loginError = new URLSearchParams(location.search).get('login_error');
  if (loginError) {
    showLoginError(LOGIN_ERRORS[loginError] || LOGIN_ERRORS.discord);
    history.replaceState(null, '', location.pathname);
  }

  // ---------------- Citizen lookup ----------------
  async function checkCitizen(username, resume = false) {
    const err = $('#citizen-error');
    err.hidden = true;
    try {
      citizen = await api('/api/citizen/check', { username });
    } catch (e) {
      citizen = null;
      remember(null);
      $('#state-panel').hidden = true;
      err.textContent = e.message === 'bad_username' ? 'اليوزر غلط — حروف إنجليزية وأرقام و _ و . بس (بدون مسافات).' : 'ما قدرنا نتحقق، جرّب مرة ثانية.';
      err.hidden = false;
      return;
    }
    remember(citizen.username);
    if (resume && citizen.status.state === 'in_progress') return startExam(true);
    renderCitizen();
  }

  function renderCitizen() {
    const { exam: e } = info;
    const { status } = citizen;
    const panel = $('#state-panel');
    const name = `<b dir="ltr">${esc(citizen.username)}</b>`;
    clearInterval(cooldownId);
    panel.hidden = false;

    switch (status.state) {
      case 'ready': {
        const rules = e.rules.length ? `<ul class="rules">${e.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
        panel.innerHTML = `
          <div class="panel-icon">${ICONS.play}</div>
          <h3>${name} جاهز للاختبار</h3>
          <p>شارك شاشتك معه في الدسكورد واقرأ عليه التعليمات قبل لا تبدأ — أول ما تضغط "ابدأ" يشتغل العداد.</p>
          ${rules}
          <label class="agree"><input type="checkbox" id="agree"><span class="box">${ICONS.check}</span><span>شاركت الشاشة مع المواطن وقرأت عليه التعليمات</span></label>
          <div class="panel-actions"><button class="btn btn-primary" id="start-btn" disabled>ابدأ الاختبار</button></div>`;
        $('#agree').addEventListener('change', (ev) => { $('#start-btn').disabled = !ev.target.checked; });
        $('#start-btn').addEventListener('click', async () => {
          const ok = await confirmModal('جاهز؟', `${e.questionCount} سؤال${e.timeLimitMinutes ? ` و ${e.timeLimitMinutes} دقيقة` : ''}. ما تقدر توقف العداد بعد ما تبدأ.`, 'ابدأ');
          if (ok) startExam(false);
        });
        break;
      }
      case 'accepted':
        panel.innerHTML = `
          <div class="panel-icon ok">${ICONS.ok}</div>
          <h3>✅ ${name} متفعل من قبل</h3>
          <p>${citizen.activatedBy ? `فعّله الإداري <b>${esc(citizen.activatedBy.name)}</b> · <bdi>${fmtDate(citizen.activatedBy.at)}</bdi>` : 'نجح في الاختبار من قبل.'}</p>`;
        break;
      case 'pending_review':
        panel.innerHTML = `
          <div class="panel-icon warn">${ICONS.clock}</div>
          <h3>${name} نجح ومعلّق</h3>
          <p>عنده نتيجة ناجحة قديمة ما انقرر فيها. افتحها من <a href="/admin">لوحة النتائج</a> وقرر فيها.</p>`;
        break;
      case 'in_progress':
        panel.innerHTML = `
          <div class="panel-icon warn">${ICONS.clock}</div>
          <h3>${name} عنده اختبار شغّال</h3>
          <p>كمّل الاختبار من حيث وقف، أو ألغه لو انقطع المواطن.</p>
          <div class="panel-actions">
            <button class="btn btn-primary" id="resume-btn">كمّل الاختبار</button>
            <button class="btn btn-ghost" id="cancel-btn">إلغاء الاختبار</button>
          </div>`;
        $('#resume-btn').addEventListener('click', () => startExam(true));
        $('#cancel-btn').addEventListener('click', cancelExam);
        break;
      case 'cooldown': {
        const last = status.lastAttempt;
        panel.innerHTML = `
          <div class="panel-icon bad">${ICONS.lock}</div>
          <h3>❌ ${name} مرفوض</h3>
          <p>${last?.rejected ? 'رفضته الإدارة' : `رسب في آخر اختبار — نتيجته كانت <b>${last?.percent ?? 0}%</b>${last?.timedOut ? ' (انتهى الوقت)' : ''}`}. عليه تايم أوت، يقدر يعيد بعد:</p>
          <div class="countdown" id="countdown"></div>`;
        const tick = () => {
          const left = Math.max(0, status.cooldownUntil - Date.now());
          if (!left) { clearInterval(cooldownId); checkCitizen(citizen.username); return; }
          const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000), s = Math.floor((left % 60000) / 1000);
          $('#countdown').innerHTML = `<div><b>${pad(h)}</b><span>ساعة</span></div><div><b>${pad(m)}</b><span>دقيقة</span></div><div><b>${pad(s)}</b><span>ثانية</span></div>`;
        };
        tick();
        cooldownId = setInterval(tick, 1000);
        break;
      }
      case 'no_attempts':
        panel.innerHTML = `
          <div class="panel-icon bad">${ICONS.lock}</div>
          <h3>❌ ${name} خلصت محاولاته</h3>
          <p>تقدر تفتح له محاولات جديدة من <a href="/admin">لوحة النتائج</a>.</p>`;
        break;
      default:
        panel.innerHTML = '<h3>صار خطأ</h3><p>حدّث الصفحة.</p>';
    }
  }

  function backToDash() {
    exam = null;
    clearInterval(timerId);
    show('dash');
    if (citizen) checkCitizen(citizen.username);
  }

  function newCitizen() {
    citizen = null;
    remember(null);
    clearInterval(cooldownId);
    $('#state-panel').hidden = true;
    $('#citizen-username').value = '';
    show('dash');
    $('#citizen-username').focus();
  }

  // ---------------- Exam ----------------
  const storeKey = () => `jt_answers_${exam.examId}`;
  const saveAnswers = () => { try { sessionStorage.setItem(storeKey(), JSON.stringify({ answers, current })); } catch {} };

  async function startExam(resume) {
    try {
      exam = await api('/api/exam/start', { username: citizen.username });
    } catch (e) {
      if (e.status !== 401) toast(e.message === 'cooldown' ? 'المواطن مرفوض وعليه تايم أوت.' : 'ما قدرنا نبدأ الاختبار.', true);
      exam = null;
      return citizen && checkCitizen(citizen.username);
    }
    clockSkew = exam.serverNow - Date.now();
    answers = {};
    current = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storeKey()) || 'null');
      if (saved) { answers = saved.answers || {}; current = Math.min(saved.current || 0, exam.questions.length - 1); }
    } catch {}
    if (resume) toast('رجعناك للاختبار من حيث وقف.');

    $('#exam-citizen').textContent = citizen.username;
    $('#q-total').textContent = exam.questions.length;
    $('#dots').innerHTML = exam.questions.map((_, i) => `<button class="dot" data-i="${i}" aria-label="السؤال ${i + 1}">${i + 1}</button>`).join('');
    show('exam');
    renderQuestion(null);
    startTimer();
  }

  async function cancelExam() {
    const ok = await confirmModal('إلغاء الاختبار؟', `بينحذف اختبار ${citizen.username} وما ينحسب له ولا عليه. تقدر تبدأ له اختبار جديد بعدها.`, 'إلغاء الاختبار');
    if (!ok) return;
    try {
      await api('/api/exam/cancel', { username: citizen.username });
      try { if (exam) sessionStorage.removeItem(storeKey()); } catch {}
      toast('تم إلغاء الاختبار.');
    } catch {
      toast('ما قدرنا نلغي الاختبار.', true);
    }
    backToDash();
  }

  function renderQuestion(direction) {
    const q = exam.questions[current];
    const card = $('#question-card');
    const paint = () => {
      $('#q-index').textContent = pad(current + 1);
      $('#q-text').textContent = q.question;
      $('#options').innerHTML = q.options.map((o, i) => `
        <button class="option${answers[q.qid] === i ? ' is-selected' : ''}" role="radio" aria-checked="${answers[q.qid] === i}" data-i="${i}" style="--i:${i}">
          <span class="opt-key">${LETTERS[i] || i + 1}</span>
          <span class="opt-text">${esc(o)}</span>
          <span class="opt-check">${ICONS.check}</span>
        </button>`).join('');
      card.classList.remove('swap-out', 'swap-in-next', 'swap-in-prev');
      if (direction) { void card.offsetWidth; card.classList.add(direction === 'next' ? 'swap-in-next' : 'swap-in-prev'); }
      updateChrome();
    };
    if (direction) {
      card.classList.remove('swap-in-next', 'swap-in-prev');
      card.classList.add('swap-out');
      setTimeout(paint, 260);
    } else paint();
  }

  function updateChrome() {
    const total = exam.questions.length;
    const answered = exam.questions.filter((q) => answers[q.qid] !== undefined).length;
    $('#q-now').textContent = current + 1;
    $('#q-answered').textContent = `جاوب ${answered} من ${total}`;
    $('#q-bar').style.width = `${(answered / total) * 100}%`;
    $('#prev-btn').disabled = current === 0;
    const last = current === total - 1;
    $('#next-label').textContent = last ? 'إنهاء الاختبار' : 'التالي';
    $('#next-btn').classList.toggle('btn-ok', last);
    $('#next-btn').classList.toggle('btn-primary', !last);
    document.querySelectorAll('.dot').forEach((d, i) => {
      d.classList.toggle('is-current', i === current);
      d.classList.toggle('is-done', answers[exam.questions[i].qid] !== undefined);
    });
  }

  function choose(i) {
    const q = exam.questions[current];
    if (!q || i < 0 || i >= q.options.length) return;
    answers[q.qid] = i;
    saveAnswers();
    document.querySelectorAll('.option').forEach((o, j) => {
      o.classList.toggle('is-selected', j === i);
      o.setAttribute('aria-checked', j === i);
    });
    updateChrome();
  }

  function go(delta) {
    const next = current + delta;
    if (next < 0 || next >= exam.questions.length) return;
    current = next;
    saveAnswers();
    renderQuestion(delta > 0 ? 'next' : 'prev');
  }

  // Handing in always goes through this modal: no citizen ID, no hand-in
  function openSubmit(timeUp = false) {
    if (submitting || !exam) return;
    const missing = exam.questions.filter((q) => answers[q.qid] === undefined).length;
    $('#submit-title').textContent = timeUp ? '⏰ انتهى الوقت' : 'تسليم الاختبار';
    $('#submit-text').textContent = timeUp
      ? 'انتهى وقت الاختبار. اكتب آيدي المواطن وسلّم خلال 5 دقايق وإلا تنحذف إجاباته.'
      : missing ? `باقي ${missing} سؤال ما جاوب عليه، وبينحسب غلط.` : 'جاوب على كل الأسئلة. ما تقدر تغيّر الإجابات بعد التسليم.';
    $('#submit-back').hidden = timeUp;
    $('#submit-modal').dataset.locked = timeUp ? '1' : '';
    $('#submit-ok').disabled = !isDiscordId($('#citizen-id').value);
    $('#submit-modal').hidden = false;
    $('#citizen-id').focus();
  }
  function closeSubmit() {
    if ($('#submit-modal').dataset.locked) return;
    $('#submit-modal').hidden = true;
  }

  $('#citizen-id').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
    $('#submit-ok').disabled = !isDiscordId(e.target.value);
  });
  $('#submit-modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSubmit(); });

  $('#submit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerDiscordId = $('#citizen-id').value.trim();
    if (!isDiscordId(playerDiscordId) || submitting || !exam) return;
    submitting = true;
    $('#submit-ok').disabled = true;
    try {
      const result = await api('/api/exam/submit', { username: citizen.username, examId: exam.examId, answers, playerDiscordId });
      try { sessionStorage.removeItem(storeKey()); } catch {}
      clearInterval(timerId);
      $('#submit-modal').dataset.locked = '';
      $('#submit-modal').hidden = true;
      $('#citizen-id').value = '';
      citizen = result.citizen;
      showResult(result);
    } catch (err) {
      if (err.message === 'player_id_required') toast('الآيدي غلط — لازم يكون أرقام بس (17 إلى 20 رقم).', true);
      else if (err.status === 409) { toast('الاختبار هذا انتهى أو انلغى.', true); $('#submit-modal').dataset.locked = ''; $('#submit-modal').hidden = true; backToDash(); }
      else if (err.status !== 401) toast('صار خطأ أثناء التسليم، جرّب مرة ثانية.', true);
      $('#submit-ok').disabled = !isDiscordId($('#citizen-id').value);
    } finally {
      submitting = false;
    }
  });

  function startTimer() {
    const t = $('#timer');
    clearInterval(timerId);
    if (!exam.deadline) { t.hidden = true; return; }
    t.hidden = false;
    const total = exam.deadline - exam.startedAt;
    const ringEl = $('#timer-ring');
    const C = 119.4;
    const tick = () => {
      const left = Math.max(0, exam.deadline - (Date.now() + clockSkew));
      const s = Math.ceil(left / 1000);
      $('#timer-text').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
      ringEl.style.strokeDashoffset = String(C * (1 - left / total));
      t.classList.toggle('is-low', left < 60000);
      if (left <= 0) {
        clearInterval(timerId);
        openSubmit(true);
      }
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  // ---------------- Result ----------------
  function showResult(r) {
    exam = null;
    const view = $('.view-result');
    view.classList.toggle('is-pass', r.passed);
    view.classList.toggle('is-fail', !r.passed);
    $('#score-pct').textContent = '0';
    $('#score-arc').style.strokeDashoffset = '540.35';

    const name = r.citizen.username;
    const until = r.citizen.status.cooldownUntil;
    $('#result-title').textContent = r.passed ? `✅ نجح — تم تفعيل ${name}` : `❌ ${name} مرفوض`;
    $('#result-sub').textContent = r.passed
      ? 'انسجل التفعيل باسمك، ووصلت النتيجة للروم بمنشن لك وله. أعطه الرتبة في الدسكورد.'
      : `${r.timedOut ? 'انتهى الوقت قبل ما يخلص.' : `يحتاج ${r.passScore} إجابة صحيحة من ${r.total} عشان ينجح.`}${until ? ` عليه تايم أوت ${Math.round((until - Date.now()) / 3600000)} ساعة قبل ما يقدر يعيد.` : ''}`;

    $('#result-meta').innerHTML = [
      `<span class="chip">الإجابات الصحيحة: <b>${r.score}/${r.total}</b></span>`,
      `<span class="chip">المطلوب: <b>${r.passScore}/${r.total}</b></span>`,
    ].join('');
    $('#result-actions').innerHTML = '<button class="btn btn-primary" data-act="new">اختبار مواطن جديد</button>';

    const review = $('#review');
    if (r.review) {
      review.hidden = false;
      review.innerHTML = r.review.map((q, i) => {
        const right = q.chosen === q.correct;
        return `<div class="glass review-item">
          <h4>${i + 1}. ${esc(q.question)}</h4>
          <p class="${right ? 'ok' : 'bad'}">${right ? '✔' : '✖'} جوابه: ${q.chosen === null ? 'لم يجاوب' : esc(q.options[q.chosen])}</p>
          ${right ? '' : `<p class="ok">الإجابة الصحيحة: ${esc(q.options[q.correct])}</p>`}
        </div>`;
      }).join('');
    } else {
      review.hidden = true;
      review.innerHTML = '';
    }

    show('result');
    requestAnimationFrame(() => {
      setTimeout(() => {
        $('#score-arc').style.strokeDashoffset = String(540.35 * (1 - r.percent / 100));
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / 1800);
          const eased = 1 - Math.pow(1 - k, 3);
          $('#score-pct').textContent = Math.round(r.percent * eased);
          if (k < 1) requestAnimationFrame(step);
          else if (r.passed) window.FX?.confetti();
        };
        requestAnimationFrame(step);
      }, 250);
    });
  }

  // ---------------- Events ----------------
  document.addEventListener('click', (e) => {
    const opt = e.target.closest('.option');
    if (opt && exam) return choose(Number(opt.dataset.i));
    const dot = e.target.closest('.dot');
    if (dot && exam) {
      const i = Number(dot.dataset.i);
      if (i !== current) { const dir = i > current ? 'next' : 'prev'; current = i; saveAnswers(); renderQuestion(dir); }
      return;
    }
    if (e.target.closest('[data-act="new"]')) newCitizen();
  });

  $('#prev-btn').addEventListener('click', () => go(-1));
  $('#next-btn').addEventListener('click', () => {
    if (!exam) return;
    if (current === exam.questions.length - 1) openSubmit(false);
    else go(1);
  });
  $('#cancel-exam').addEventListener('click', cancelExam);

  const modalOpen = () => !$('#modal').hidden || !$('#submit-modal').hidden;
  document.addEventListener('keydown', (e) => {
    if (!exam || modalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^[1-8]$/.test(e.key)) choose(Number(e.key) - 1);
    // RTL: the right arrow goes back, the left arrow goes forward
    else if (e.key === 'ArrowLeft') { e.preventDefault(); current === exam.questions.length - 1 ? openSubmit(false) : go(1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(-1); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) $('#modal [data-close].btn').click();
    else if (!$('#submit-modal').hidden) closeSubmit();
  });

  window.addEventListener('beforeunload', (e) => {
    if (exam && !submitting) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#logout-btn').addEventListener('click', async () => {
    if (exam && !(await confirmModal('تسجيل الخروج؟', 'فيه اختبار شغّال والعداد بيكمل حتى لو طلعت.', 'خروج'))) return;
    await api('/api/admin/logout', {}).catch(() => {});
    exam = null;
    remember(null);
    location.href = '/';
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#admin-name').value.trim();
    const discordId = $('#admin-discord-id').value.trim();
    if (!name) return showLoginError('اكتب اسمك.');
    if (!isDiscordId(discordId)) return showLoginError('الآيدي غلط — لازم يكون أرقام بس (17 إلى 20 رقم).');
    showLoginError('');
    $('#login-btn').disabled = true;
    try {
      await api('/api/admin/login', { name, discordId });
      await boot();
    } catch (ex) {
      showLoginError({
        not_admin: 'الآيدي هذا مو من آيديات الإدارة.',
        rate_limited: 'محاولات كثيرة، انتظر دقيقة.',
      }[ex.message] || 'ما قدرنا ندخلك، جرّب مرة ثانية.');
    } finally {
      $('#login-btn').disabled = false;
    }
  });

  $('#admin-discord-id').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });

  $('#citizen-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#citizen-username').value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_.]{2,32}(#\d{4})?$/.test(username)) {
      $('#citizen-error').textContent = 'اليوزر غلط — حروف إنجليزية وأرقام و _ و . بس (بدون مسافات).';
      $('#citizen-error').hidden = false;
      return;
    }
    $('#citizen-btn').disabled = true;
    await checkCitizen(username);
    $('#citizen-btn').disabled = false;
  });

  boot();
})();
