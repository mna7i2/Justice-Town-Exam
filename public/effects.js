/* =====================================================================
   Interactive effects: custom cursor, particle field + perspective grid,
   mouse sparks, click bursts, confetti, 3D tilt, magnetic buttons, parallax.
   ===================================================================== */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const root = document.documentElement;
  const rand = (a, b) => a + Math.random() * (b - a);

  const mouse = { x: innerWidth / 2, y: innerHeight * 0.4, sx: innerWidth / 2, sy: innerHeight * 0.4, inside: false, lastX: 0, lastY: 0 };

  // ---------------- Canvases ----------------
  const bg = document.getElementById('bg-canvas');
  const fx = document.getElementById('fx-canvas');
  const bctx = bg.getContext('2d');
  const fctx = fx.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  let stars = [];
  const sparks = [];

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    for (const [c, ctx] of [[bg, bctx], [fx, fctx]]) {
      c.width = W * DPR;
      c.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    const count = Math.min(fine ? 110 : 55, Math.floor((W * H) / 15000));
    stars = Array.from({ length: count }, () => ({
      x: rand(0, W), y: rand(0, H * 0.75),
      vx: rand(-0.18, 0.18), vy: rand(-0.12, 0.12),
      r: rand(0.5, 1.8), a: rand(0.25, 0.85), tw: rand(0, Math.PI * 2),
    }));
  }

  function drawGrid(t) {
    const horizon = H * 0.68;
    const depth = H - horizon;
    const vpX = W / 2 + (mouse.sx - W / 2) * 0.35;
    const glow = bctx.createLinearGradient(0, horizon, 0, H);
    glow.addColorStop(0, 'rgba(91,138,230,0)');
    glow.addColorStop(1, 'rgba(91,138,230,0.32)');
    bctx.lineWidth = 1;
    bctx.strokeStyle = glow;

    // converging lines
    bctx.beginPath();
    const cols = 22;
    for (let i = -cols; i <= cols; i++) {
      bctx.moveTo(vpX + i * 6, horizon);
      bctx.lineTo(W / 2 + i * (W / cols) * 1.9, H + 40);
    }
    bctx.stroke();

    // rows moving toward the viewer
    const rows = 16;
    const phase = reduced ? 0 : (t * 0.00012) % 1;
    for (let k = 0; k < rows; k++) {
      const d = (k + phase) / rows;
      const y = horizon + depth * Math.pow(d, 2.4);
      bctx.strokeStyle = `rgba(91,138,230,${(0.04 + d * 0.32).toFixed(3)})`;
      bctx.beginPath();
      bctx.moveTo(0, y);
      bctx.lineTo(W, y);
      bctx.stroke();
    }

    // horizon haze + light pool under the cursor
    const haze = bctx.createLinearGradient(0, horizon - 70, 0, horizon + 30);
    haze.addColorStop(0, 'rgba(3,5,11,0)');
    haze.addColorStop(0.7, 'rgba(60,110,230,0.12)');
    haze.addColorStop(1, 'rgba(3,5,11,0)');
    bctx.fillStyle = haze;
    bctx.fillRect(0, horizon - 70, W, 100);

    if (mouse.inside && mouse.sy > horizon - 60) {
      const pool = bctx.createRadialGradient(mouse.sx, mouse.sy, 0, mouse.sx, mouse.sy, 220);
      pool.addColorStop(0, 'rgba(89,225,255,0.16)');
      pool.addColorStop(1, 'rgba(89,225,255,0)');
      bctx.fillStyle = pool;
      bctx.fillRect(mouse.sx - 220, mouse.sy - 220, 440, 440);
    }
  }

  function drawStars(t) {
    const linkDist = 115;
    const mouseDist = 170;
    for (const s of stars) {
      if (!reduced) {
        const dx = s.x - mouse.sx;
        const dy = s.y - mouse.sy;
        const dist = Math.hypot(dx, dy);
        if (mouse.inside && dist < 120 && dist > 0.1) {
          const f = (120 - dist) / 120;
          s.x += (dx / dist) * f * 2.2;
          s.y += (dy / dist) * f * 2.2;
        }
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < -20) s.x = W + 20; else if (s.x > W + 20) s.x = -20;
        if (s.y < -20) s.y = H * 0.75; else if (s.y > H * 0.8) s.y = -10;
      }
    }
    // links
    bctx.lineWidth = 0.7;
    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < linkDist * linkDist) {
          const o = (1 - Math.sqrt(d2) / linkDist) * 0.22;
          bctx.strokeStyle = `rgba(130,165,255,${o.toFixed(3)})`;
          bctx.beginPath();
          bctx.moveTo(a.x, a.y);
          bctx.lineTo(b.x, b.y);
          bctx.stroke();
        }
      }
      if (mouse.inside) {
        const d = Math.hypot(a.x - mouse.sx, a.y - mouse.sy);
        if (d < mouseDist) {
          bctx.strokeStyle = `rgba(89,225,255,${((1 - d / mouseDist) * 0.5).toFixed(3)})`;
          bctx.beginPath();
          bctx.moveTo(a.x, a.y);
          bctx.lineTo(mouse.sx, mouse.sy);
          bctx.stroke();
        }
      }
    }
    // dots
    for (const s of stars) {
      const tw = reduced ? 1 : 0.65 + Math.sin(t * 0.002 + s.tw) * 0.35;
      bctx.fillStyle = `rgba(200,215,255,${(s.a * tw).toFixed(3)})`;
      bctx.beginPath();
      bctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  // ---------------- Spark / confetti particles ----------------
  const COLORS = ['#9dbbff', '#5b8ae6', '#59e1ff', '#ffffff', '#8b6bff'];
  function spawnSpark(x, y, o = {}) {
    sparks.push({
      x, y,
      vx: o.vx ?? rand(-0.6, 0.6), vy: o.vy ?? rand(-0.6, 0.6),
      life: 0, max: o.max ?? rand(28, 50),
      size: o.size ?? rand(1, 2.6),
      color: o.color ?? COLORS[(Math.random() * COLORS.length) | 0],
      g: o.g ?? 0, drag: o.drag ?? 0.96,
      kind: o.kind || 'dot', rot: rand(0, 6.28), vr: rand(-0.2, 0.2),
    });
    if (sparks.length > 700) sparks.splice(0, sparks.length - 700);
  }

  function burst(x, y, { count = 18, speed = 4.2, colors } = {}) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + rand(-0.2, 0.2);
      const v = rand(speed * 0.5, speed);
      spawnSpark(x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rand(30, 55), size: rand(1.4, 3), drag: 0.92, color: colors ? colors[i % colors.length] : undefined });
    }
  }

  function confetti(colors = ['#3ee0a1', '#59e1ff', '#9dbbff', '#ffffff', '#ffc25c', '#8b6bff']) {
    if (reduced) return;
    for (const side of [0.15, 0.85]) {
      for (let i = 0; i < 110; i++) {
        const a = -Math.PI / 2 + rand(-0.75, 0.75);
        const v = rand(7, 15);
        spawnSpark(W * side, H + 10, {
          vx: Math.cos(a) * v + (side < 0.5 ? 2 : -2), vy: Math.sin(a) * v,
          g: 0.22, drag: 0.985, max: rand(110, 170), size: rand(4, 8), kind: 'paper',
          color: colors[(Math.random() * colors.length) | 0],
        });
      }
    }
  }

  function drawSparks() {
    fctx.clearRect(0, 0, W, H);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life++;
      if (p.life > p.max) { sparks.splice(i, 1); continue; }
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      const k = 1 - p.life / p.max;
      fctx.globalAlpha = Math.min(1, k * 1.4);
      fctx.fillStyle = p.color;
      if (p.kind === 'paper') {
        fctx.save();
        fctx.translate(p.x, p.y);
        fctx.rotate(p.rot);
        fctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.sin(p.life * 0.15))));
        fctx.restore();
      } else {
        fctx.shadowBlur = 10;
        fctx.shadowColor = p.color;
        fctx.beginPath();
        fctx.arc(p.x, p.y, p.size * k + 0.3, 0, Math.PI * 2);
        fctx.fill();
        fctx.shadowBlur = 0;
      }
    }
    fctx.globalAlpha = 1;
  }

  // ---------------- Cursor ----------------
  const dot = document.querySelector('.cursor-dot');
  const ring = document.querySelector('.cursor-ring');
  const ringPos = { x: mouse.x, y: mouse.y };
  const HOVERABLE = 'a, button, label, input, select, [data-hover], .option, .dot';
  if (fine && !reduced) root.classList.add('has-cursor');

  // ---------------- Pointer tracking ----------------
  let litEl = null;
  let magEl = null;

  function onMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    root.style.setProperty('--mx', `${e.clientX}px`);
    root.style.setProperty('--my', `${e.clientY}px`);

    // sparks trail
    if (fine && !reduced) {
      const dist = Math.hypot(e.clientX - mouse.lastX, e.clientY - mouse.lastY);
      if (dist > 8) {
        const n = Math.min(3, Math.floor(dist / 12) + 1);
        for (let i = 0; i < n; i++) spawnSpark(e.clientX + rand(-3, 3), e.clientY + rand(-3, 3), { vy: rand(-0.8, 0.2), max: rand(22, 40) });
        mouse.lastX = e.clientX;
        mouse.lastY = e.clientY;
      }
    }

    // glass light + tilt
    const card = e.target.closest?.('.glass');
    if (card !== litEl) {
      if (litEl) resetCard(litEl);
      litEl = card;
      if (card) card.classList.add('is-lit');
    }
    if (card) {
      const r = card.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      card.style.setProperty('--x', `${px}px`);
      card.style.setProperty('--y', `${py}px`);
      if (fine && !reduced && card.hasAttribute('data-tilt')) {
        const max = Number(card.dataset.tiltMax || 7);
        card.classList.add('is-tilting');
        card.style.setProperty('--ry', `${((px / r.width) - 0.5) * max * 2}deg`);
        card.style.setProperty('--rx', `${(0.5 - (py / r.height)) * max * 2}deg`);
      }
    }

    // option inner light
    const opt = e.target.closest?.('.option');
    if (opt) {
      const r = opt.getBoundingClientRect();
      opt.style.setProperty('--ox', `${e.clientX - r.left}px`);
      opt.style.setProperty('--oy', `${e.clientY - r.top}px`);
    }

    // magnetic
    const mag = fine && !reduced ? e.target.closest?.('[data-magnetic]') : null;
    if (mag !== magEl) {
      if (magEl) magEl.style.translate = '';
      magEl = mag;
    }
    if (mag) {
      const r = mag.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      mag.style.translate = `${dx * 0.22}px ${dy * 0.3}px`;
    }

    // cursor hover state
    if (ring) ring.classList.toggle('is-hover', Boolean(e.target.closest?.(HOVERABLE)));
  }

  function resetCard(el) {
    el.classList.remove('is-lit', 'is-tilting');
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  }

  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', () => {
    mouse.inside = false;
    if (litEl) { resetCard(litEl); litEl = null; }
  });
  window.addEventListener('pointerdown', (e) => {
    ring?.classList.add('is-down');
    burst(e.clientX, e.clientY, { count: 14, speed: 3.6 });
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

  // ---------------- Main loop ----------------
  const parallaxEls = () => document.querySelectorAll('.view.is-active [data-parallax]');
  function frame(t) {
    if (!document.hidden) {
      mouse.sx += (mouse.x - mouse.sx) * 0.08;
      mouse.sy += (mouse.y - mouse.sy) * 0.08;

      bctx.clearRect(0, 0, W, H);
      drawGrid(t);
      drawStars(t);
      drawSparks();

      if (ring && dot) {
        ringPos.x += (mouse.x - ringPos.x) * 0.18;
        ringPos.y += (mouse.y - ringPos.y) * 0.18;
        dot.style.transform = `translate3d(${mouse.x}px, ${mouse.y}px, 0)`;
        ring.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0)`;
      }

      if (fine && !reduced) {
        const nx = (mouse.sx / W - 0.5) * 2;
        const ny = (mouse.sy / H - 0.5) * 2;
        parallaxEls().forEach((el) => {
          const d = Number(el.dataset.parallax) || 10;
          el.style.translate = `${(-nx * d).toFixed(2)}px ${(-ny * d).toFixed(2)}px`;
        });
      }
    }
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  window.FX = { burst, confetti, spawnSpark };
})();
