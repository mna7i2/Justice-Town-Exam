/* =====================================================================
   Exam client — views, exam flow, timer, result.
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

  let info = null;         // /api/me payload
  let exam = null;         // active exam
  let answers = {};        // qid -> option index
  let current = 0;
  let timerId = null;
  let cooldownId = null;
  let clockSkew = 0;
  let submitting = false;
  let focusLost = 0;       // times the player left the exam tab

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  // ---------------- API ----------------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
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
    if (!info.user) return show('landing');

    $('#user-chip').hidden = false;
    $('#user-avatar').src = info.user.avatar;
    $('#user-name').textContent = info.user.name;

    if (info.status.state === 'in_progress') return startExam(true);
    renderDash();
  }

  // ---------------- Dashboard ----------------
  function renderDash() {
    const { exam: e, status, user } = info;
    $('#dash-avatar').src = user.avatar;
    $('#dash-name').textContent = user.name;
    $('#st-count').textContent = e.questionCount;
    $('#st-time').innerHTML = fmtMinutes(e.timeLimitMinutes);
    $('#st-pass').innerHTML = `${e.passScore}<small>من ${e.questionCount}</small>`;
    const panel = $('#state-panel');
    clearInterval(cooldownId);
    const invite = info.inviteUrl ? `<a class="btn btn-primary" href="${esc(info.inviteUrl)}" target="_blank" rel="noopener">دخول سيرفر Discord</a>` : '';

    switch (status.state) {
      case 'ready': {
        const rules = e.rules.length ? `<ul class="rules">${e.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
        panel.innerHTML = `
          <div class="panel-icon">${ICONS.play}</div>
          <h3>${esc(e.title)}</h3>
          <p>اقرأ التعليمات زين قبل لا تبدأ — أول ما تضغط "ابدأ" يشتغل العداد.</p>
          ${rules}
          <label class="agree"><input type="checkbox" id="agree"><span class="box">${ICONS.check}</span><span>قرأت التعليمات وأتعهد إني أحل الاختبار بنفسي</span></label>
          <div class="panel-actions"><button class="btn btn-primary" id="start-btn" disabled>ابدأ الاختبار</button></div>`;
        $('#agree').addEventListener('change', (ev) => { $('#start-btn').disabled = !ev.target.checked; });
        $('#start-btn').addEventListener('click', async () => {
          const ok = await confirmModal('جاهز؟', `عندك ${e.questionCount} سؤال${e.timeLimitMinutes ? ` و ${e.timeLimitMinutes} دقيقة` : ''}. ما تقدر توقف العداد بعد ما تبدأ.`, 'ابدأ');
          if (ok) startExam(false);
        });
        break;
      }
      case 'accepted':
        panel.innerHTML = `
          <div class="panel-icon ok">${ICONS.ok}</div>
          <h3>تم تفعيلك ✔</h3>
          <p>الإدارة أعطتك الرتبة في Discord على يوزر <b dir="ltr">${esc(user.username)}</b>. نشوفك في المدينة!</p>
          <div class="panel-actions">${invite}</div>`;
        break;
      case 'pending_review':
        panel.innerHTML = `
          <div class="panel-icon warn">${ICONS.clock}</div>
          <h3>نجحت! 🎉 طلبك عند الإدارة</h3>
          <p>الإدارة بتعطيك الرتبة في Discord على يوزر <b dir="ltr">${esc(user.username)}</b>. تأكد إنك داخل السيرفر — ما تحتاج تسوي شي ثاني.</p>
          <div class="panel-actions">${invite}<button class="btn btn-ghost" id="recheck">تحديث الحالة</button></div>`;
        $('#recheck').addEventListener('click', refresh);
        break;
      case 'cooldown': {
        panel.innerHTML = `
          <div class="panel-icon bad">${ICONS.clock}</div>
          <h3>${status.lastAttempt?.rejected ? 'الإدارة رفضت طلبك' : 'انتظر قبل المحاولة الجاية'}</h3>
          <p>${status.lastAttempt?.rejected ? 'راجعت الإدارة نتيجتك وما تم قبولها هالمرة' : `آخر نتيجة لك كانت <b>${status.lastAttempt?.percent ?? 0}%</b>${status.lastAttempt?.timedOut ? ' (انتهى الوقت)' : ''}`}. راجع القوانين وارجع بعد:</p>
          <div class="countdown" id="countdown"></div>`;
        const tick = () => {
          const left = Math.max(0, status.cooldownUntil - Date.now());
          if (!left) { clearInterval(cooldownId); refresh(); return; }
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
          <h3>خلصت محاولاتك</h3>
          <p>استخدمت كل المحاولات المسموحة. تواصل مع الإدارة في Discord عشان يفتحون لك محاولة جديدة.</p>
          <div class="panel-actions">${invite}</div>`;
        break;
      default:
        panel.innerHTML = `<h3>صار خطأ</h3><p>حدّث الصفحة.</p>`;
    }
    show('dash');
  }

  async function refresh() {
    try {
      info = await api('/api/me');
      if (!info.user) return show('landing');
      renderDash();
    } catch {
      toast('ما قدرنا نحدّث، جرّب مرة ثانية.', true);
    }
  }

  // ---------------- Exam ----------------
  const storeKey = () => `jt_answers_${exam.examId}`;
  const saveAnswers = () => { try { sessionStorage.setItem(storeKey(), JSON.stringify({ answers, current, focusLost })); } catch {} };

  async function startExam(resume) {
    try {
      exam = await api('/api/exam/start', {});
    } catch (e) {
      toast(e.message === 'cooldown' ? 'لازم تنتظر قبل المحاولة الجاية.' : 'ما قدرنا نبدأ الاختبار.', true);
      return refresh();
    }
    clockSkew = exam.serverNow - Date.now();
    answers = {};
    current = 0;
    focusLost = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storeKey()) || 'null');
      if (saved) { answers = saved.answers || {}; current = Math.min(saved.current || 0, exam.questions.length - 1); focusLost = saved.focusLost || 0; }
    } catch {}
    if (resume) focusLost++;
    if (resume) toast('رجعناك لاختبارك اللي بديته.');

    $('#q-total').textContent = exam.questions.length;
    const dots = $('#dots');
    dots.innerHTML = exam.questions.map((_, i) => `<button class="dot" data-i="${i}" aria-label="السؤال ${i + 1}">${i + 1}</button>`).join('');
    show('exam');
    renderQuestion(null);
    startTimer();
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
    $('#q-answered').textContent = `جاوبت ${answered} من ${total}`;
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

  async function finish(auto = false) {
    if (submitting) return;
    if (!auto) {
      const missing = exam.questions.filter((q) => answers[q.qid] === undefined).length;
      const ok = await confirmModal(
        'تسليم الاختبار؟',
        missing ? `باقي ${missing} سؤال ما جاوبت عليه، وبينحسب غلط. متأكد تسلّم؟` : 'جاوبت على كل الأسئلة. ما تقدر تغيّر إجاباتك بعد التسليم.',
        'سلّم'
      );
      if (!ok) return;
    }
    submitting = true;
    clearInterval(timerId);
    $('#next-btn').disabled = true;
    try {
      const result = await api('/api/exam/submit', { examId: exam.examId, answers, focusLost });
      try { sessionStorage.removeItem(storeKey()); } catch {}
      info.status = result.status;
      showResult(result);
    } catch (e) {
      toast('صار خطأ أثناء التسليم، جرّب مرة ثانية.', true);
      $('#next-btn').disabled = false;
      if (e.status === 409) refresh();
    } finally {
      submitting = false;
    }
  }

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
        toast('انتهى الوقت! تم تسليم إجاباتك تلقائياً.');
        finish(true);
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

    $('#result-title').textContent = r.passed ? 'مبروك، نجحت! 🎉' : 'للأسف ما نجحت';
    $('#result-sub').textContent = !r.passed
      ? r.timedOut ? 'انتهى الوقت قبل ما تخلص.' : `تحتاج ${r.passScore} إجابة صحيحة من ${r.total} عشان تنجح. راجع القوانين وحاول مرة ثانية.`
      : 'نتيجتك وصلت للإدارة، وبيعطونك الرتبة في Discord على يوزرك. تأكد إنك داخل السيرفر.';

    $('#result-meta').innerHTML = [
      `<span class="chip">الإجابات الصحيحة: <b>${r.score}/${r.total}</b></span>`,
      `<span class="chip">المطلوب: <b>${r.passScore}/${r.total}</b></span>`,
      r.passed ? '<span class="chip">⏳ بانتظار الإدارة</span>' : '',
    ].join('');

    const invite = info.inviteUrl ? `<a class="btn btn-ok" href="${esc(info.inviteUrl)}" target="_blank" rel="noopener">افتح Discord</a>` : '';
    $('#result-actions').innerHTML = r.passed
      ? `${invite}<button class="btn btn-ghost" data-act="dash">الرجوع للرئيسية</button>`
      : `<button class="btn btn-primary" data-act="dash">الرجوع للرئيسية</button>`;

    const review = $('#review');
    if (r.review) {
      review.hidden = false;
      review.innerHTML = r.review.map((q, i) => {
        const right = q.chosen === q.correct;
        return `<div class="glass review-item">
          <h4>${i + 1}. ${esc(q.question)}</h4>
          <p class="${right ? 'ok' : 'bad'}">${right ? '✔' : '✖'} إجابتك: ${q.chosen === null ? 'لم تجاوب' : esc(q.options[q.chosen])}</p>
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
    if (e.target.closest('[data-act="dash"]')) refresh();
  });

  $('#prev-btn').addEventListener('click', () => go(-1));
  $('#next-btn').addEventListener('click', () => {
    if (!exam) return;
    if (current === exam.questions.length - 1) finish(false);
    else go(1);
  });

  document.addEventListener('keydown', (e) => {
    if (!exam || !$('#modal').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^[1-8]$/.test(e.key)) choose(Number(e.key) - 1);
    // RTL: the right arrow goes back, the left arrow goes forward
    else if (e.key === 'ArrowLeft') { e.preventDefault(); current === exam.questions.length - 1 ? finish(false) : go(1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(-1); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) $('#modal [data-close].btn').click();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && exam && !submitting) { focusLost++; saveAnswers(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (exam && !submitting) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#logout-btn').addEventListener('click', async () => {
    if (exam && !(await confirmModal('تسجيل الخروج؟', 'اختبارك شغّال والعداد بيكمل حتى لو طلعت.', 'خروج'))) return;
    await api('/auth/logout', {}).catch(() => {});
    exam = null;
    location.href = '/';
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    const username = $('#username').value.trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_.]{2,32}(#\d{4})?$/.test(username)) {
      err.textContent = 'اليوزر غلط — حروف إنجليزية وأرقام و _ و . بس (بدون مسافات).';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    $('#login-btn').disabled = true;
    try {
      await api('/auth/login', { username });
      await boot();
    } catch {
      err.textContent = 'ما قدرنا ندخلك، جرّب مرة ثانية.';
      err.hidden = false;
    } finally {
      $('#login-btn').disabled = false;
    }
  });

  boot();
})();
