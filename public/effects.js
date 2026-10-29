/* =====================================================================
   Interactive effects: cursor glow ring, particle field + perspective grid,
   mouse sparks, click bursts, confetti, 3D tilt, magnetic buttons, parallax.

   Performance notes:
   - the real system cursor is always visible, so the mouse never "sticks"
     even if the page itself renders slowly
   - pointer work is batched into one requestAnimationFrame
   - the background canvas renders at reduced resolution and also draws the
     mouse spotlight (no extra full-screen layers)
   - after a short measurement, slow machines switch to a light mode
     (root class "fx-low"): background at 15fps, no links, no trail, no tilt
   ===================================================================== */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const root = document.documentElement;
  const rand = (a, b) => a + Math.random() * (b - a);

  const mouse = { x: innerWidth / 2, y: innerHeight * 0.4, sx: innerWidth / 2, sy: innerHeight * 0.4, inside: false, lastX: 0, lastY: 0 };
  let pending = null; // last pointer event, handled once per frame
  let low = reduced;  // light mode

  // ---------------- Canvases ----------------
  const bg = document.getElementById('bg-canvas');
  const fx = document.getElementById('fx-canvas');
  const bctx = bg.getContext('2d');
  const fctx = fx.getContext('2d');
  let W = 0, H = 0, scale = 1;
  let stars = [];
  const sparks = [];
  let gridGlow = null, horizonHaze = null, horizon = 0;

  function resize() {
    W = innerWidth;
    H = innerHeight;
    // the background is soft by design, so it renders below screen resolution
    scale = low ? 0.5 : 0.75;
    bg.width = Math.ceil(W * scale);
    bg.height = Math.ceil(H * scale);
    bctx.setTransform(scale, 0, 0, scale, 0, 0);
    const fd = Math.min(window.devicePixelRatio || 1, 1.25);
    fx.width = Math.ceil(W * fd);
    fx.height = Math.ceil(H * fd);
    fctx.setTransform(fd, 0, 0, fd, 0, 0);

    horizon = H * 0.68;
    gridGlow = bctx.createLinearGradient(0, horizon, 0, H);
    gridGlow.addColorStop(0, 'rgba(91,138,230,0)');
    gridGlow.addColorStop(1, 'rgba(91,138,230,0.32)');
    horizonHaze = bctx.createLinearGradient(0, horizon - 70, 0, horizon + 30);
    horizonHaze.addColorStop(0, 'rgba(3,5,11,0)');
    horizonHaze.addColorStop(0.7, 'rgba(60,110,230,0.12)');
    horizonHaze.addColorStop(1, 'rgba(3,5,11,0)');

    const max = fine ? (low ? 30 : 60) : 28;
    const count = Math.min(max, Math.floor((W * H) / 22000));
    stars = Array.from({ length: count }, () => ({
      x: rand(0, W), y: rand(0, H * 0.75),
      vx: rand(-0.18, 0.18), vy: rand(-0.12, 0.12),
      r: rand(0.7, 1.8), a: rand(0.3, 0.85), tw: rand(0, Math.PI * 2),
    }));
  }

  function drawSpotlight() {
    if (!mouse.inside) return;
    const g = bctx.createRadialGradient(mouse.sx, mouse.sy, 0, mouse.sx, mouse.sy, 420);
    g.addColorStop(0, 'rgba(91,138,230,0.16)');
    g.addColorStop(1, 'rgba(91,138,230,0)');
    bctx.fillStyle = g;
    bctx.fillRect(mouse.sx - 420, mouse.sy - 420, 840, 840);
  }

  function drawGrid(t) {
    const depth = H - horizon;
    const vpX = W / 2 + (mouse.sx - W / 2) * 0.35;
    bctx.lineWidth = 1 / scale;
    bctx.strokeStyle = gridGlow;
    bctx.beginPath();
    const cols = 16;
    for (let i = -cols; i <= cols; i++) {
      bctx.moveTo(vpX + i * 6, horizon);
      bctx.lineTo(W / 2 + i * (W / cols) * 1.9, H + 40);
    }
    bctx.stroke();

    const rows = 12;
    const phase = reduced ? 0 : (t * 0.00012) % 1;
    for (let k = 0; k < rows; k++) {
      const d = (k + phase) / rows;
      const y = horizon + depth * d * d * Math.sqrt(d);
      bctx.strokeStyle = `rgba(91,138,230,${(0.04 + d * 0.32).toFixed(2)})`;
      bctx.beginPath();
      bctx.moveTo(0, y);
      bctx.lineTo(W, y);
      bctx.stroke();
    }
    bctx.fillStyle = horizonHaze;
    bctx.fillRect(0, horizon - 70, W, 100);
  }

  function drawStars(t, step) {
    if (!reduced) {
      for (const s of stars) {
        const dx = s.x - mouse.sx;
        const dy = s.y - mouse.sy;
        const d2 = dx * dx + dy * dy;
        if (mouse.inside && d2 < 14400 && d2 > 1) {
          const dist = Math.sqrt(d2);
          const f = ((120 - dist) / 120) * 2 * step;
          s.x += (dx / dist) * f;
          s.y += (dy / dist) * f;
        }
        s.x += s.vx * step;
        s.y += s.vy * step;
        if (s.x < -20) s.x = W + 20; else if (s.x > W + 20) s.x = -20;
        if (s.y < -20) s.y = H * 0.75; else if (s.y > H * 0.8) s.y = -10;
      }
    }

    bctx.lineWidth = 0.8 / scale;
    if (!low) {
      const linkDist2 = 110 * 110;
      bctx.strokeStyle = 'rgba(130,165,255,0.14)';
      bctx.beginPath();
      for (let i = 0; i < stars.length; i++) {
        const a = stars[i];
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy < linkDist2) {
            bctx.moveTo(a.x, a.y);
            bctx.lineTo(b.x, b.y);
          }
        }
      }
      bctx.stroke();
    }
    if (mouse.inside) {
      bctx.strokeStyle = 'rgba(89,225,255,0.3)';
      bctx.beginPath();
      for (const a of stars) {
        const dx = a.x - mouse.sx;
        const dy = a.y - mouse.sy;
        if (dx * dx + dy * dy < 25600) {
          bctx.moveTo(a.x, a.y);
          bctx.lineTo(mouse.sx, mouse.sy);
        }
      }
      bctx.stroke();
    }

    bctx.fillStyle = '#c8d7ff';
    for (const s of stars) {
      bctx.globalAlpha = reduced ? s.a : s.a * (0.65 + Math.sin(t * 0.002 + s.tw) * 0.35);
      bctx.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    }
    bctx.globalAlpha = 1;
  }

  // ---------------- Spark / confetti particles ----------------
  const COLORS = ['#9dbbff', '#5b8ae6', '#59e1ff', '#ffffff', '#8b6bff'];
  function spawnSpark(x, y, o = {}) {
    if (sparks.length > (low ? 120 : 350)) return;
    sparks.push({
      x, y,
      vx: o.vx ?? rand(-0.6, 0.6), vy: o.vy ?? rand(-0.6, 0.6),
      life: 0, max: o.max ?? rand(24, 42),
      size: o.size ?? rand(1, 2.4),
      color: o.color ?? COLORS[(Math.random() * COLORS.length) | 0],
      g: o.g ?? 0, drag: o.drag ?? 0.96,
      kind: o.kind || 'dot', rot: rand(0, 6.28), vr: rand(-0.2, 0.2),
    });
  }

  function burst(x, y, { count = 12, speed = 4, colors } = {}) {
    if (reduced) return;
    if (low) count = Math.ceil(count / 2);
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + rand(-0.2, 0.2);
      const v = rand(speed * 0.5, speed);
      spawnSpark(x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rand(26, 46), size: rand(1.4, 2.8), drag: 0.92, color: colors ? colors[i % colors.length] : undefined });
    }
  }

  function confetti(colors = ['#3ee0a1', '#59e1ff', '#9dbbff', '#ffffff', '#ffc25c', '#8b6bff']) {
    if (reduced) return;
    const per = low ? 40 : 80;
    for (const side of [0.15, 0.85]) {
      for (let i = 0; i < per; i++) {
        const a = -Math.PI / 2 + rand(-0.75, 0.75);
        const v = rand(7, 15);
        spawnSpark(W * side, H + 10, {
          vx: Math.cos(a) * v + (side < 0.5 ? 2 : -2), vy: Math.sin(a) * v,
          g: 0.22, drag: 0.985, max: rand(110, 160), size: rand(4, 8), kind: 'paper',
          color: colors[(Math.random() * colors.length) | 0],
        });
      }
    }
  }

  let fxDirty = false;
  function drawSparks(step) {
    if (!sparks.length) {
      if (fxDirty) { fctx.clearRect(0, 0, W, H); fxDirty = false; }
      return;
    }
    fxDirty = true;
    fctx.clearRect(0, 0, W, H);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life += step;
      if (p.life > p.max) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
      const drag = Math.pow(p.drag, step);
      p.vx *= drag;
      p.vy = p.vy * drag + p.g * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      const k = 1 - p.life / p.max;
      fctx.fillStyle = p.color;
      if (p.kind === 'paper') {
        fctx.globalAlpha = Math.min(1, k * 1.4);
        p.rot += p.vr * step;
        fctx.save();
        fctx.translate(p.x, p.y);
        fctx.rotate(p.rot);
        fctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * (0.4 + Math.abs(Math.sin(p.life * 0.15))));
        fctx.restore();
      } else {
        const r = p.size * k + 0.5;
        fctx.globalAlpha = k * 0.22;
        fctx.fillRect(p.x - r * 2.5, p.y - r * 2.5, r * 5, r * 5);
        fctx.globalAlpha = Math.min(1, k * 1.3);
        fctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
    }
    fctx.globalAlpha = 1;
  }

  // ---------------- Cursor ring (follows the real cursor) ----------------
  const ring = document.querySelector('.cursor-ring');
  const ringPos = { x: mouse.x, y: mouse.y };
  const HOVERABLE = 'a, button, label, input, select, [data-hover], .option, .dot';
  if (fine && !reduced) root.classList.add('has-cursor');

  // ---------------- Pointer-driven UI (once per frame) ----------------
  let litEl = null;
  let magEl = null;
  let hoverState = false;

  function resetCard(el) {
    el.classList.remove('is-lit', 'is-tilting');
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
  }

  function handlePointer(e) {
    const target = e.target instanceof Element ? e.target : null;

    if (fine && !low) {
      const dist = Math.hypot(e.clientX - mouse.lastX, e.clientY - mouse.lastY);
      if (dist > 14) {
        spawnSpark(e.clientX + rand(-3, 3), e.clientY + rand(-3, 3), { vy: rand(-0.8, 0.2) });
        mouse.lastX = e.clientX;
        mouse.lastY = e.clientY;
      }
    }

    const card = target?.closest('.glass') || null;
    if (card !== litEl) {
      if (litEl) resetCard(litEl);
      litEl = card;
      if (card) card.classList.add('is-lit');
    }
    if (card) {
      const r = card.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      card.style.setProperty('--x', `${px | 0}px`);
      card.style.setProperty('--y', `${py | 0}px`);
      if (fine && !low && card.hasAttribute('data-tilt')) {
        const max = Number(card.dataset.tiltMax || 6);
        card.classList.add('is-tilting');
        card.style.setProperty('--ry', `${(((px / r.width) - 0.5) * max * 2).toFixed(2)}deg`);
        card.style.setProperty('--rx', `${((0.5 - (py / r.height)) * max * 2).toFixed(2)}deg`);
      }
    }

    const opt = target?.closest('.option');
    if (opt) {
      const r = opt.getBoundingClientRect();
      opt.style.setProperty('--ox', `${(e.clientX - r.left) | 0}px`);
      opt.style.setProperty('--oy', `${(e.clientY - r.top) | 0}px`);
    }

    const mag = fine && !low ? target?.closest('[data-magnetic]') : null;
    if (mag !== magEl) {
      if (magEl) magEl.style.translate = '';
      magEl = mag;
    }
    if (mag) {
      const r = mag.getBoundingClientRect();
      mag.style.translate = `${((e.clientX - (r.left + r.width / 2)) * 0.2).toFixed(1)}px ${((e.clientY - (r.top + r.height / 2)) * 0.28).toFixed(1)}px`;
    }

    const hov = Boolean(target?.closest(HOVERABLE));
    if (ring && hov !== hoverState) { hoverState = hov; ring.classList.toggle('is-hover', hov); }
  }

  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    pending = e;
  }, { passive: true });
  document.addEventListener('pointerleave', () => {
    mouse.inside = false;
    if (litEl) { resetCard(litEl); litEl = null; }
  });
  window.addEventListener('pointerdown', (e) => {
    ring?.classList.add('is-down');
    burst(e.clientX, e.clientY, { count: 12, speed: 3.4 });
  });
  window.addEventListener('pointerup', () => ring?.classList.remove('is-down'));
  window.addEventListener('resize', resize);

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

  // ---------------- Light mode ----------------
  function goLow() {
    if (low) return;
    low = true;
    root.classList.add('fx-low');
    if (litEl) { resetCard(litEl); litEl = null; }
    if (magEl) { magEl.style.translate = ''; magEl = null; }
    resize();
  }
  if (reduced) root.classList.add('fx-low');

  // Measure ~1.2s of real frames (skipping the first busy moments after load);
  // if the average frame takes longer than ~28ms, switch to light mode for good.
  const perf = { start: 0, frames: 0, done: false };
  function measure(t) {
    if (perf.done || document.hidden) return;
    if (!perf.start) { perf.start = t + 600; return; }
    if (t < perf.start) return;
    perf.frames++;
    const span = t - perf.start;
    if (span > 1200) {
      perf.done = true;
      if (span / perf.frames > 28) goLow();
    }
  }

  // ---------------- Main loop ----------------
  let parallaxCache = [];
  let parallaxView = null;
  function parallaxEls() {
    const view = document.querySelector('.view.is-active');
    if (view !== parallaxView) {
      parallaxView = view;
      parallaxCache = view ? [...view.querySelectorAll('[data-parallax]')] : [];
    }
    return parallaxCache;
  }

  let lastFrame = 0;
  let lastBg = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) { lastFrame = t; return; }
    measure(t);
    // step = how many 60fps frames passed, so motion speed is frame-rate independent
    const step = lastFrame ? Math.min((t - lastFrame) / 16.7, 4) : 1;
    lastFrame = t;

    if (pending) { handlePointer(pending); pending = null; }

    const ease = 1 - Math.pow(0.9, step);
    mouse.sx += (mouse.x - mouse.sx) * ease;
    mouse.sy += (mouse.y - mouse.sy) * ease;

    // light mode repaints the background at ~15fps
    if (!low || t - lastBg > 66) {
      const bgStep = lastBg ? Math.min((t - lastBg) / 16.7, 4) : 1;
      lastBg = t;
      bctx.clearRect(0, 0, W, H);
      drawSpotlight();
      drawGrid(t);
      drawStars(t, bgStep);
    }
    drawSparks(step);

    if (ring) {
      const k = 1 - Math.pow(0.6, step);
      ringPos.x += (mouse.x - ringPos.x) * k;
      ringPos.y += (mouse.y - ringPos.y) * k;
      ring.style.transform = `translate3d(${ringPos.x.toFixed(1)}px, ${ringPos.y.toFixed(1)}px, 0)`;
    }

    if (fine && !low) {
      const nx = (mouse.sx / W - 0.5) * 2;
      const ny = (mouse.sy / H - 0.5) * 2;
      for (const el of parallaxEls()) {
        const d = Number(el.dataset.parallax) || 10;
        el.style.translate = `${(-nx * d).toFixed(1)}px ${(-ny * d).toFixed(1)}px`;
      }
    }
  }

  resize();
  requestAnimationFrame(frame);

  window.FX = { burst, confetti, spawnSpark, goLow };
})();
