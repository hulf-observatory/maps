// Guided walkthrough. Self-contained: no libraries, same design tokens (styles in
// css/style.css under "tour"). A dim mask with a soft-edged rounded cut-out sits
// over everything except the highlighted element; a white card beside it carries
// the step. Esc or clicking the dim closes. Lazy-loaded from main.js: on a first
// load (and from the ? top-bar button); closing it lasts for that page view only.
import { phone } from './mobile.js';

const $ = (s) => document.querySelector(s);

// Desktop steps. target() returns the element to highlight (null = skip step).
// setup()/teardown() put the app into / out of the state the step talks about.
function desktopSteps(deps) {
  const { state, startPreview, endPreview, renderBench } = deps;
  return [
    { title: 'Library', text: 'Every layer we publish, grouped by theme. Click one to preview it on the map.',
      target: () => $('#library') },
    { title: 'Preview', text: 'See a layer on its own before adding it. Details and Edit style live here.',
      setup: async () => { if (state.byId.has('corporations_2026')) { await startPreview('corporations_2026'); await new Promise((r) => setTimeout(r, 300)); } },
      target: () => (state.preview ? $('#preview-view') : null) },
    { title: 'Add to workbench', text: 'Adds the layer to your map, with the settings you chose.',
      target: () => (state.preview ? $('#pv-add') : null),
      teardown: () => { if (state.preview) endPreview(); } },
    { title: 'Workbench', text: 'The layers on your map, drawn top to bottom. Drag to reorder, the eye to hide, × to remove.',
      target: () => $('#bench-view') },
    { title: 'Edit style', text: 'Colours, opacity, colour-by and labels, when you want them.',
      setup: () => { const e = state.bench[0]; if (e) { e.open = true; renderBench(); } },
      target: () => (state.bench.length ? $('#bench-list .card .btn-edit') || $('#bench-list .card') : null),
      teardown: () => { const e = state.bench[0]; if (e) { e.open = false; renderBench(); } } },
    { title: 'Where you are', text: 'The breadcrumb follows the map centre. Click a name to zoom there, the arrow for that level’s list.',
      target: () => $('#crumb') },
    { title: 'Toolbar', text: 'Basemaps, measuring and zoom.',
      target: () => $('#toolbar') },
    { title: 'Sources', text: 'Sources and attribution for everything on the map.',
      target: () => $('#sources-btn') },
  ];
}

// Simplified 4-step phone tour: the sheets make mid-tour state juggling fragile,
// so it highlights the pills and map controls only.
function phoneSteps(deps) {
  const { setCol } = deps;
  return [
    { title: 'Library', text: 'Every layer we publish. Tap the pill, then tap a layer to preview it.',
      setup: () => { setCol('library', true); setCol('bench', true); },
      target: () => $('#library .rail-label') },
    { title: 'Workbench', text: 'The layers on your map. Drag the sheet up for their cards and styles.',
      target: () => $('#bench .rail-label') },
    { title: 'Toolbar', text: 'Basemaps, measuring and zoom.',
      target: () => $('#toolbar') },
    { title: 'Sources', text: 'Sources and attribution for everything on the map.',
      target: () => $('#sources-btn') },
  ];
}

let active = null;

export async function startTour(deps, { auto = false } = {}) {
  if (active) return;
  void auto; // auto and button starts currently behave the same
  const steps = phone() ? phoneSteps(deps) : desktopSteps(deps);

  const mask = document.createElement('div');
  mask.className = 'tour-mask';
  const hole = document.createElement('div');
  hole.className = 'tour-hole';
  const card = document.createElement('div');
  card.className = 'tour-card mapcard';
  mask.append(hole, card);
  document.body.append(mask);
  window.__tourActive = true;

  let i = 0, closed = false;
  const cleanupStep = async () => { const st = steps[i]; if (st && st.teardown) { try { await st.teardown(); } catch { /* */ } } };
  async function close() {
    if (closed) return;
    closed = true;
    await cleanupStep();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    mask.remove();
    active = null;
    window.__tourActive = false;
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => { if (e.target === mask || e.target === hole) close(); });

  let target = null;
  function place() {
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(hole.style, {
      left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + 2 * pad) + 'px', height: (r.height + 2 * pad) + 'px',
    });
    // card beside the hole: pick the side with the most room, clamp on screen
    const W = window.innerWidth, H = window.innerHeight;
    const cw = Math.min(300, W - 24), ch = card.offsetHeight || 160;
    let x, y;
    const room = { right: W - r.right, left: r.left, below: H - r.bottom, above: r.top };
    const side = Object.entries(room).sort((a, b) => b[1] - a[1])[0][0];
    if (side === 'right') { x = r.right + 20; y = r.top; }
    else if (side === 'left') { x = r.left - cw - 20; y = r.top; }
    else if (side === 'below') { x = r.left; y = r.bottom + 20; }
    else { x = r.left; y = r.top - ch - 20; }
    x = Math.max(12, Math.min(x, W - cw - 12));
    y = Math.max(12, Math.min(y, H - ch - 12));
    Object.assign(card.style, { left: x + 'px', top: y + 'px', width: cw + 'px' });
  }
  window.addEventListener('resize', place);

  async function show(n, dir = 1) {
    // find the next step whose target exists, skipping missing ones gracefully
    while (n >= 0 && n < steps.length) {
      const st = steps[n];
      if (st.setup) { try { await st.setup(); } catch { /* */ } }
      target = st.target();
      if (target) break;
      if (st.teardown) { try { await st.teardown(); } catch { /* */ } }
      n += dir;
    }
    if (n < 0) n = 0;
    if (n >= steps.length) { close(); return; }
    i = n;
    const st = steps[n];
    card.innerHTML = '';
    const eyebrow = document.createElement('div'); eyebrow.className = 'eyebrow'; eyebrow.textContent = st.title;
    const p = document.createElement('p'); p.textContent = st.text;
    const dots = document.createElement('div'); dots.className = 'tour-dots';
    steps.forEach((_, k) => { const d = document.createElement('i'); if (k === n) d.className = 'on'; dots.append(d); });
    const acts = document.createElement('div'); acts.className = 'tour-acts';
    const mk = (cls, label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.addEventListener('click', fn); return b; };
    acts.append(
      mk('txtbtn tour-skip', 'Skip tour', close),
      mk('btn-edit tour-back', 'Back', async () => { await cleanupStep(); show(i - 1, -1); }),
      mk('btn-edit done tour-next', i === steps.length - 1 ? 'Done' : 'Next', async () => { await cleanupStep(); if (i === steps.length - 1) close(); else show(i + 1, 1); }),
    );
    if (n === 0) acts.querySelector('.tour-back').disabled = true;
    card.append(eyebrow, p, dots, acts);
    place();
    requestAnimationFrame(place); // once more after layout settles
  }

  active = { close };
  await show(0, 1);
  if (!closed && !target) close(); // nothing to show at all
}
