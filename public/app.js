// Justice Town showroom — public catalog
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const state = { cars: [], filter: 'all', cls: 'all', sort: 'new', q: '' };
  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusPill(car) {
    const ok = car.quantity > 0;
    return el('span', `pill ${ok ? 'ok' : 'bad'}`, ok ? 'متوفر' : 'غير متوفر');
  }

  // Built with textContent only — names typed by admins never become HTML
  function carCard(car) {
    const card = el('article', 'car');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', car.name);

    const media = el('div', 'car-media');
    if (car.image) {
      const img = el('img');
      img.src = car.image;
      img.alt = car.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      media.append(img);
    }
    media.append(statusPill(car));

    const body = el('div', 'car-body');
    const row = el('div', 'car-row');
    const title = el('div');
    title.append(el('small', 'cls', `CLASS ${car.class}`), el('h3', '', car.name));
    const price = el('div', 'price');
    price.append(el('small', '', 'السعر'), el('b', 'price-num', money(car.price)));
    row.append(title, price);

    const foot = el('div', 'car-foot');
    const qty = el('span', '', 'الكمية ');
    qty.append(el('b', '', String(car.quantity)));
    foot.append(qty, el('span', 'mark', 'JUSTICE TOWN ←'));
    body.append(row, foot);

    card.append(media, body);
    const open = () => openDetail(car);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return card;
  }

  function fill(grid, cars) {
    const frag = document.createDocumentFragment();
    cars.forEach((c) => frag.append(carCard(c)));
    grid.replaceChildren(frag);
  }

  function visibleCars() {
    const q = state.q.trim().toLowerCase();
    let list = state.cars.filter((c) =>
      (state.filter === 'avail' ? c.quantity > 0 : true)
      && (state.cls === 'all' || c.class === state.cls)
      && (!q || c.name.toLowerCase().includes(q)));
    const by = {
      new: (a, b) => b.createdAt - a.createdAt,
      'price-asc': (a, b) => a.price - b.price,
      'price-desc': (a, b) => b.price - a.price,
      name: (a, b) => a.name.localeCompare(b.name, 'en'),
    }[state.sort];
    return list.slice().sort(by);
  }

  function renderCatalog() {
    const list = visibleCars();
    fill($('#cars-grid'), list);
    $('#count').textContent = list.length;
    $('#cars-empty').hidden = list.length > 0;
    $('#cars-empty').textContent = state.cars.length ? 'ما فيه سيارات تطابق بحثك.' : 'ما فيه سيارات في المعرض للحين — ترقبوا.';
  }

  function renderHome() {
    const latest = state.cars.slice(0, 3);
    fill($('#latest-grid'), latest);
    $('#latest-empty').hidden = latest.length > 0;
  }

  function renderStats() {
    const total = state.cars.length;
    const avail = state.cars.filter((c) => c.quantity > 0).length;
    const min = total ? Math.min(...state.cars.map((c) => c.price)) : null;
    const values = { total, avail, out: total - avail, from: min === null ? '—' : money(min) };
    $$('[data-stat]').forEach((n) => { n.textContent = values[n.dataset.stat]; });
  }

  // ---------------- Detail modal ----------------
  const modal = $('#car-modal');
  let lastFocus = null;
  function openDetail(car) {
    lastFocus = document.activeElement;
    $('#d-img').src = car.image || '';
    $('#d-img').alt = car.name;
    $('#d-class').textContent = `CLASS ${car.class}`;
    $('#d-name').textContent = car.name;
    $('#d-note').textContent = car.note;
    $('#d-note').hidden = !car.note;
    $('#d-price').textContent = money(car.price);
    $('#d-qty').textContent = car.quantity;
    const pill = statusPill(car);
    $('#d-status').className = pill.className;
    $('#d-status').textContent = pill.textContent;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    $('.modal-x', modal).focus();
  }
  function closeDetail() {
    modal.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
  }
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDetail(); });

  // ---------------- Views (#home / #cars) ----------------
  function route() {
    const view = location.hash === '#cars' ? 'cars' : 'home';
    $('#view-home').hidden = view !== 'home';
    $('#view-cars').hidden = view !== 'cars';
    $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------------- Controls ----------------
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderCatalog(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderCatalog(); });
  $('#cls').addEventListener('change', (e) => { state.cls = e.target.value; renderCatalog(); });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.filter = b.dataset.filter;
    renderCatalog();
  }));

  async function loadSite() {
    try {
      const site = await (await fetch('/api/site')).json();
      [['#top-discord', site.discordUrl], ['#hero-discord', site.discordUrl], ['#foot-discord', site.discordUrl], ['#foot-server', site.serverUrl]]
        .forEach(([sel, url]) => { if (url) { $(sel).href = url; $(sel).hidden = false; } });
    } catch { /* links just stay hidden */ }
  }

  async function loadCars() {
    try {
      const res = await fetch('/api/cars');
      if (!res.ok) throw new Error(res.status);
      state.cars = (await res.json()).cars;
    } catch {
      state.cars = [];
      $('#latest-empty').textContent = 'تعذر تحميل السيارات — حدّث الصفحة.';
    }
    renderStats();
    renderHome();
    renderCatalog();
  }

  route();
  loadSite();
  loadCars();
})();
