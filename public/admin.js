// Justice Town showroom — admin page
(() => {
  const $ = (s, root = document) => root.querySelector(s);

  const state = { cars: [], q: '', editing: null, image: null, deleting: null };
  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

  const ERRORS = {
    wrong_password: 'كلمة السر غلط.',
    bad_name: 'اكتب اسم صحيح (حرفين على الأقل).',
    admin_disabled: 'صفحة الإدارة مقفلة — لازم تحط ADMIN_PASSWORD في إعدادات الموقع.',
    rate_limited: 'محاولات كثيرة — انتظر دقيقة وجرب مرة ثانية.',
    bad_price: 'السعر لازم يكون رقم صحيح بدون فواصل.',
    bad_quantity: 'الكمية لازم تكون رقم من 0 إلى 9999.',
    bad_class: 'اختر الفئة (A أو B أو C أو D).',
    bad_image: 'الصورة ما تنفع — جرب صورة JPG أو PNG أو WebP ثانية.',
    image_required: 'لازم تحط صورة للسيارة.',
    too_large: 'الصورة كبيرة مرة — جرب صورة أصغر.',
    not_found: 'السيارة هذي انحذفت — حدّث الصفحة.',
    unauthorized: 'انتهت جلستك — سجّل دخول مرة ثانية.',
  };
  const errorText = (code) => ERRORS[code] || 'صار خطأ — جرب مرة ثانية.';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(msg, kind = 'ok') {
    const t = el('div', `toast ${kind}`, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3200);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/admin/login') showLogin();
    if (!res.ok) throw new Error(data.error || 'server_error');
    return data;
  }

  // ---------------- Sign in ----------------
  function showLogin() {
    $('#dash').hidden = true;
    $('#login').hidden = false;
    $('#admin-name').focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const err = $('#login-error');
    err.hidden = true;
    btn.disabled = true;
    try {
      await api('POST', '/api/admin/login', { name: $('#admin-name').value, password: $('#admin-pass').value });
      $('#admin-pass').value = '';
      await boot();
    } catch (ex) {
      err.textContent = errorText(ex.message);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout', {}).catch(() => {});
    showLogin();
  });

  // ---------------- List ----------------
  function render() {
    const q = state.q.trim().toLowerCase();
    const list = state.cars.filter((c) => !q || c.name.toLowerCase().includes(q));
    const frag = document.createDocumentFragment();
    list.forEach((c) => frag.append(row(c)));
    $('#a-list').replaceChildren(frag);
    $('#a-empty').hidden = list.length > 0;
    $('#a-empty').textContent = state.cars.length ? 'ما فيه نتائج.' : 'ما فيه سيارات للحين — اضغط "إضافة سيارة".';

    const avail = state.cars.filter((c) => c.quantity > 0).length;
    $('#a-total').textContent = state.cars.length;
    $('#a-avail').textContent = avail;
    $('#a-out').textContent = state.cars.length - avail;
  }

  function row(car) {
    const r = el('div', 'a-row');

    const thumb = el('div', 'a-thumb');
    if (car.image) {
      const img = el('img');
      img.src = car.image;
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    }

    const info = el('div', 'a-info');
    const meta = el('div', 'a-meta');
    const ok = car.quantity > 0;
    meta.append(el('span', `pill ${ok ? 'ok' : 'bad'}`, ok ? 'متوفر' : 'غير متوفر'));
    meta.append(document.createTextNode(`أضافها ${car.addedBy}${car.updatedBy ? ` · آخر تعديل: ${car.updatedBy}` : ''}`));
    info.append(el('small', 'cls', `CLASS ${car.class}`), el('h3', '', car.name), el('b', 'price-num', money(car.price)), meta);

    const stepper = el('div', 'stepper');
    const minus = el('button', '', '−');
    const plus = el('button', '', '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'إنقاص الكمية');
    plus.setAttribute('aria-label', 'زيادة الكمية');
    minus.disabled = car.quantity <= 0;
    minus.addEventListener('click', () => changeStock(car, -1));
    plus.addEventListener('click', () => changeStock(car, 1));
    stepper.append(minus, el('b', '', String(car.quantity)), plus);

    const actions = el('div', 'a-actions');
    const edit = el('button', 'btn ghost sm', 'تعديل');
    const del = el('button', 'btn danger sm', 'حذف');
    edit.type = del.type = 'button';
    edit.addEventListener('click', () => openEditor(car));
    del.addEventListener('click', () => askDelete(car));
    actions.append(edit, del);

    r.append(thumb, info, stepper, actions);
    return r;
  }

  function replaceCar(car) {
    const i = state.cars.findIndex((c) => c.id === car.id);
    if (i >= 0) state.cars[i] = car; else state.cars.unshift(car);
    render();
  }

  async function changeStock(car, delta) {
    try {
      const { car: updated } = await api('POST', `/api/admin/cars/${encodeURIComponent(car.id)}/stock`, { delta });
      replaceCar(updated);
    } catch (ex) {
      toast(errorText(ex.message), 'bad');
    }
  }

  $('#a-q').addEventListener('input', (e) => { state.q = e.target.value; render(); });

  // ---------------- Modals ----------------
  function openModal(m) {
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal(m) {
    m.hidden = true;
    document.body.style.overflow = '';
  }
  ['#editor', '#confirm'].forEach((sel) => {
    const m = $(sel);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['#editor', '#confirm'].forEach((sel) => { if (!$(sel).hidden) closeModal($(sel)); });
  });

  // ---------------- Editor ----------------
  function setPreview(src) {
    const img = $('#f-preview');
    img.hidden = !src;
    if (src) img.src = src; else img.removeAttribute('src');
    $('#drop').classList.toggle('has-image', Boolean(src));
    $('#drop-hint b').textContent = src ? 'تغيير الصورة' : 'اضغط أو اسحب صورة السيارة هنا';
  }

  function openEditor(car = null) {
    state.editing = car;
    state.image = null;
    $('#editor-title').textContent = car ? `تعديل: ${car.name}` : 'إضافة سيارة';
    $('#f-name').value = car ? car.name : '';
    $('#f-price').value = car ? car.price : '';
    $('#f-qty').value = car ? car.quantity : 1;
    $('#f-note').value = car ? car.note : '';
    const cls = car ? car.class : 'C';
    document.querySelectorAll('input[name="f-class"]').forEach((r) => { r.checked = r.value === cls; });
    $('#f-image').value = '';
    $('#form-error').hidden = true;
    setPreview(car ? car.image : '');
    openModal($('#editor'));
    $('#f-name').focus();
  }
  $('#add-btn').addEventListener('click', () => openEditor());

  // Shrinks big screenshots to at most 1600×1200 so saves stay fast and small
  async function processImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('bad_image');
    if (file.size > 25 * 1024 * 1024) throw new Error('too_large');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('bad_image'));
        i.src = url;
      });
      const scale = Math.min(1, 1600 / img.naturalWidth, 1200 / img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.6]) {
        let data = canvas.toDataURL('image/webp', quality);
        if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', quality);
        if (data.length * 0.75 < 2.3 * 1024 * 1024) return data;
      }
      throw new Error('too_large');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function takeFile(file) {
    if (!file) return;
    $('#form-error').hidden = true;
    try {
      state.image = await processImage(file);
      setPreview(state.image);
    } catch (ex) {
      $('#form-error').textContent = errorText(ex.message);
      $('#form-error').hidden = false;
    }
  }
  $('#f-image').addEventListener('change', (e) => takeFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    takeFile(e.dataTransfer.files[0]);
  });

  $('#car-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;
    const body = {
      name: $('#f-name').value,
      price: Number($('#f-price').value),
      quantity: Number($('#f-qty').value),
      note: $('#f-note').value,
      class: ($('input[name="f-class"]:checked') || {}).value,
    };
    if (state.image) body.image = state.image;
    if (body.name.trim().length < 2) { err.textContent = errorText('bad_name'); err.hidden = false; return; }
    if ($('#f-price').value === '' || !Number.isInteger(body.price) || body.price < 0) { err.textContent = errorText('bad_price'); err.hidden = false; return; }
    if (!Number.isInteger(body.quantity) || body.quantity < 0 || body.quantity > 9999) { err.textContent = errorText('bad_quantity'); err.hidden = false; return; }
    if (!state.editing && !state.image) { err.textContent = errorText('image_required'); err.hidden = false; return; }

    const btn = $('#save-btn');
    btn.disabled = true;
    btn.textContent = 'جاري الحفظ...';
    try {
      const { car } = state.editing
        ? await api('PUT', `/api/admin/cars/${encodeURIComponent(state.editing.id)}`, body)
        : await api('POST', '/api/admin/cars', body);
      replaceCar(car);
      closeModal($('#editor'));
      toast(state.editing ? `تم تعديل ${car.name} ✔` : `تمت إضافة ${car.name} ✔`);
    } catch (ex) {
      err.textContent = errorText(ex.message);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'حفظ';
    }
  });

  // ---------------- Delete ----------------
  function askDelete(car) {
    state.deleting = car;
    $('#confirm-text').textContent = `متأكد تبي تحذف "${car.name}" من المعرض؟ ما تقدر ترجعها.`;
    openModal($('#confirm'));
  }
  $('#confirm-yes').addEventListener('click', async () => {
    const car = state.deleting;
    if (!car) return;
    try {
      await api('DELETE', `/api/admin/cars/${encodeURIComponent(car.id)}`, {});
      state.cars = state.cars.filter((c) => c.id !== car.id);
      render();
      toast(`تم حذف ${car.name}`);
    } catch (ex) {
      toast(errorText(ex.message), 'bad');
    }
    closeModal($('#confirm'));
  });

  // ---------------- Start ----------------
  async function boot() {
    let me;
    try {
      me = await api('GET', '/api/admin/me');
    } catch (ex) {
      showLogin();
      if (ex.message === 'admin_disabled') {
        $('#login-error').textContent = errorText('admin_disabled');
        $('#login-error').hidden = false;
      }
      return;
    }
    const who = $('#admin-who');
    who.replaceChildren(document.createTextNode('مسجل باسم '), el('b', '', me.name));
    $('#storage-warn').hidden = me.persistent;
    $('#login').hidden = true;
    $('#dash').hidden = false;
    state.cars = (await api('GET', '/api/admin/cars')).cars;
    render();
  }

  boot();
})();
