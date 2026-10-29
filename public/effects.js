/* =====================================================================
   Lightweight visuals: a static background (stars + perspective grid)
   drawn once per resize, the split headline, and a confetti burst that
   only animates while it is on screen. Nothing follows the mouse.
   ===================================================================== */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------- Static background ----------------
  const bg = document.getElementById('bg-canvas');
  const bctx = bg.getContext('2d');
  let W = 0, H = 0;

  function drawBackground() {
    W = innerWidth;
    H = innerHeight;
    bg.width = W;
    bg.height = H;

    const horizon = H * 0.68;
    const depth = H - horizon;

    const glow = bctx.createLinearGradient(0, horizon, 0, H);
    glow.addColorStop(0, 'rgba(91,138,230,0)');
    glow.addColorStop(1, 'rgba(91,138,230,0.3)');
    bctx.strokeStyle = glow;
    bctx.lineWidth = 1;
    bctx.beginPath();
    for (let i = -16; i <= 16; i++) {
      bctx.moveTo(W / 2 + i * 6, horizon);
      bctx.lineTo(W / 2 + i * (W / 16) * 1.9, H + 40);
    }
    bctx.stroke();

    for (let k = 1; k <= 12; k++) {
      const d = k / 12;
      bctx.strokeStyle = `rgba(91,138,230,${(0.04 + d * 0.3).toFixed(2)})`;
      bctx.beginPath();
      const y = horizon + depth * d * d * Math.sqrt(d);
      bctx.moveTo(0, y);
      bctx.lineTo(W, y);
      bctx.stroke();
    }

    const haze = bctx.createLinearGradient(0, horizon - 70, 0, horizon + 30);
    haze.addColorStop(0, 'rgba(3,5,11,0)');
    haze.addColorStop(0.7, 'rgba(60,110,230,0.12)');
    haze.addColorStop(1, 'rgba(3,5,11,0)');
    bctx.fillStyle = haze;
    bctx.fillRect(0, horizon - 70, W, 100);

    const count = Math.min(70, Math.floor((W * H) / 20000));
    bctx.fillStyle = '#c8d7ff';
    for (let i = 0; i < count; i++) {
      const r = rand(0.6, 1.6);
      bctx.globalAlpha = rand(0.25, 0.8);
      bctx.fillRect(rand(0, W), rand(0, horizon), r * 2, r * 2);
    }
    bctx.globalAlpha = 1;
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawBackground, 150);
  });
  drawBackground();

  // ---------------- Split headline letters ----------------
  let idx = 0;
  document.querySelectorAll('.split').forEach((el) => {
    el.textContent = '';
    for (const ch of el.dataset.text || '') {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = ch;
      s.style.setProperty('--i', idx++);
      el.appendChild(s);
    }
    el.setAttribute('aria-label', el.dataset.text);
  });

  // ---------------- Confetti (runs only while pieces are alive) ----------------
  const fx = document.getElementById('fx-canvas');
  const fctx = fx.getContext('2d');
  let pieces = [];
  let running = false;

  function confetti(colors = ['#3ee0a1', '#59e1ff', '#9dbbff', '#ffffff', '#ffc25c', '#8b6bff']) {
    if (reduced) return;
    fx.width = innerWidth;
    fx.height = innerHeight;
    for (const side of [0.15, 0.85]) {
      for (let i = 0; i < 60; i++) {
        const a = -Math.PI / 2 + rand(-0.75, 0.75);
        const v = rand(7, 15);
        pieces.push({
          x: innerWidth * side, y: innerHeight + 10,
          vx: Math.cos(a) * v + (side < 0.5 ? 2 : -2), vy: Math.sin(a) * v,
          size: rand(4, 8), rot: rand(0, 6.28), vr: rand(-0.2, 0.2),
          life: 0, max: rand(100, 150), color: colors[(Math.random() * colors.length) | 0],
        });
      }
    }
    if (!running) { running = true; requestAnimationFrame(tick); }
  }

  function tick() {
    fctx.clearRect(0, 0, fx.width, fx.height);
    pieces = pieces.filter((p) => ++p.life < p.max);
    for (const p of pieces) {
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.22;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      fctx.globalAlpha = Math.min(1, (1 - p.life / p.max) * 1.4);
      fctx.fillStyle = p.color;
      fctx.save();
      fctx.translate(p.x, p.y);
      fctx.rotate(p.rot);
      fctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      fctx.restore();
    }
    fctx.globalAlpha = 1;
    if (pieces.length) requestAnimationFrame(tick);
    else { running = false; fctx.clearRect(0, 0, fx.width, fx.height); }
  }

  window.FX = { confetti };
})();
