// Swipe compare: one raster on the workbench against the map beneath it.
//
// MapLibre cannot clip a single layer, so this is the two-map technique (as in
// maplibre-gl-compare, implemented here): a second, non-interactive map sits
// over the main map in #map-compare, clipped with clip-path to the RIGHT of the
// divider. It holds the same basemap and every bench entry EXCEPT the swiped
// one, built with the very same buildEntry/applySettings code. Left of the
// divider you see the main map (with the layer), right of it the compare map
// (without it). All input goes to the main map (the compare container has
// pointer-events: none, only the handle takes pointers); the compare map
// follows the main map's camera on every 'move'.
//
// Mirrored entries are "shadows": Object.create(mainEntry) with their own
// layerIds/srcId/icon/threeDOn (and their own yearUI view), so settings,
// visibility, colour-by classes and year range are read live from the main
// entry and never copied. The compare map only exists while swiping.
import { buildEntry, applySettings, removeEntry } from './layers.js';
import { setBasemap } from './basemaps.js';
import { syncYearLayer } from './yearslider.js';
import { phone } from './mobile.js';

const STEP = 0.05;   // keyboard ←/→ move
const EDGE = 24;     // keep the handle this far inside the visible map

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
};

export function initSwipe({ map, state, mapPadding, onChange, escBlocked }) {
  const mapEl = map.getContainer();
  let active = null;          // the swiped bench entry
  let cmp = null, cmpReady = false, cmpEl = null;
  let ui = null, pill = null, handle = null;
  let frac = 0.5, x = 0, redraw = false, dragging = false;
  let cmpBasemap = null, order = '';
  const shadows = new Map();  // main entry -> shadow entry on the compare map

  const is = (entry) => !!entry && entry === active;
  const valid = () => active && state.bench.includes(active) && active.visible && !state.preview;

  // ------------------------------------------------------------ camera sync
  const onMove = () => {
    if (!cmp) return;
    cmp.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() });
    redraw = true;
  };
  // draw the compare map in the same frame as the main map, so the two halves
  // never drift apart by a frame during animations
  const onRender = () => { if (redraw && cmp && cmpReady) { redraw = false; cmp.redraw(); } };

  // ------------------------------------------------------------ layer mirror
  function shadowOf(entry) {
    const sh = Object.create(entry);
    sh.layerIds = []; sh.srcId = null; sh.icon = null; sh.threeDOn = false; sh.el = null; sh.pending = false;
    return sh;
  }

  async function build(sh) {
    const m = cmp;
    sh.pending = true;
    try { await buildEntry(m, sh, state.catalog); }
    catch (err) { console.warn('swipe: layer failed', sh.meta.id, err); try { removeEntry(m, sh); } catch { /* ignore */ } }
    sh.pending = false;
    if (m === cmp) reconcile();
  }

  // Bring the compare map in line with the bench: basemap, entries (all but the
  // swiped one), their settings and their order. Cheap when nothing changed
  // (MapLibre skips unchanged paint/layout values; order only moves on change).
  function reconcile() {
    if (!cmp || !cmpReady) return;
    if (!valid()) { stop(); return; }
    try {
      if (cmpBasemap !== state.basemap) { setBasemap(cmp, state.basemap); cmpBasemap = state.basemap; }
      const want = state.bench.filter((e) => e !== active && (e.layerIds || []).length);
      for (const [e, sh] of shadows) {
        if (want.includes(e) || sh.pending) continue;
        try { removeEntry(cmp, sh); } catch (err) { console.warn(err); }
        shadows.delete(e);
      }
      for (const e of want) {
        let sh = shadows.get(e);
        if (!sh) { sh = shadowOf(e); shadows.set(e, sh); build(sh); continue; }
        if (sh.pending) continue;
        // the year range reads lo/hi/palette from the main entry; only the
        // current tile URL of the compare source is the shadow's own
        if (e.yearUI && !Object.prototype.hasOwnProperty.call(sh, 'yearUI')) sh.yearUI = Object.create(e.yearUI);
        applySettings(cmp, sh);
        syncYearLayer(cmp, sh);
      }
      // bench[0] draws on top, as in main.js applyOrder
      const ids = [];
      for (let i = state.bench.length - 1; i >= 0; i--) {
        const sh = shadows.get(state.bench[i]);
        if (sh && !sh.pending) ids.push(...sh.layerIds.filter((id) => cmp.getLayer(id)));
      }
      const sig = ids.join('|');
      if (sig !== order) { ids.forEach((id) => cmp.moveLayer(id)); order = sig; }
    } catch (err) { console.warn('swipe', err); }
  }

  // Called by main.js wherever the main map is re-applied (settings, order,
  // add/remove, basemap, year range): the compare map follows at once. Leaves
  // swipe when its layer is gone, hidden, or a preview started.
  function refresh() {
    if (!active) return;
    if (!valid()) { stop(); return; }
    reconcile();
  }

  // ------------------------------------------------------------ divider
  function layout() {
    if (!ui) return;
    const box = mapEl.getBoundingClientRect();
    const W = box.width, H = box.height;
    if (!W) return;
    const pad = mapPadding();
    const lo = pad.left ? Math.max(0, pad.left - 16) : 0;   // the columns' right edge
    x = Math.round(Math.min(W - EDGE, Math.max(lo + EDGE, frac * W)));
    frac = x / W;
    // vertical: the middle of the map band that is not under a phone sheet
    let bottom = H;
    if (phone()) {
      const b = document.getElementById('bench');
      if (b && !b.classList.contains('rail')) bottom = Math.max(80, Math.min(H, b.getBoundingClientRect().top - box.top));
    }
    ui.style.setProperty('--x', x + 'px');
    ui.style.setProperty('--hy', Math.round(bottom / 2) + 'px');
    cmpEl.style.clipPath = `inset(0 0 0 ${x}px)`;
    // the name pill sits left of the line (the layer's side); flip it to the
    // right when the columns leave no room for it
    ui.classList.toggle('pill-right', x - lo - 12 < pill.offsetWidth);
    const p = Math.round(frac * 100);
    handle.setAttribute('aria-valuenow', String(p));
    handle.setAttribute('aria-valuetext', `Divider at ${p}%: left shows ${active ? active.meta.title || active.meta.id : 'the layer'}, right the map beneath`);
  }

  function setFrac(f) { frac = f; layout(); }

  function buildUi() {
    cmpEl = el('div', { id: 'map-compare', 'aria-hidden': 'true' });
    mapEl.after(cmpEl);
    pill = el('div', { class: 'swipe-pill' });
    handle = el('div', { class: 'swipe-handle', role: 'slider', tabindex: '0', 'aria-label': 'Swipe divider',
      'aria-orientation': 'horizontal', 'aria-valuemin': '0', 'aria-valuemax': '100', title: 'Drag to compare (← → keys)' }, '⟷');
    ui = el('div', { id: 'swipe', class: 'swipe' }, el('div', { class: 'swipe-line' }), pill, handle);
    cmpEl.after(ui);
    const box = () => mapEl.getBoundingClientRect();
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      dragging = true; ui.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const b = box();
      setFrac((e.clientX - b.left) / b.width);
    });
    const end = () => { dragging = false; if (ui) ui.classList.remove('dragging'); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -STEP, ArrowRight: STEP, ArrowDown: -STEP, ArrowUp: STEP }[e.key];
      if (d != null) { e.preventDefault(); setFrac(frac + d); }
      else if (e.key === 'Home') { e.preventDefault(); setFrac(0); }
      else if (e.key === 'End') { e.preventDefault(); setFrac(1); }
    });
  }

  // Esc leaves swipe, unless it is busy closing something else first (measure,
  // year play, the legend lightbox, the tour): capture phase runs before those
  const onKey = (e) => {
    if (e.key !== 'Escape' || !active) return;
    if (document.querySelector('.legend-lightbox, .tour-mask') || (escBlocked && escBlocked())) return;
    stop();
  };

  // ------------------------------------------------------------ start / stop
  function start(entry) {
    if (!entry || state.preview || !entry.visible) return;
    if (active) {             // switch the swiped layer, keep the compare map
      active = entry;
      pill.textContent = '◀ ' + (entry.meta.title || entry.meta.id);
      reconcile(); layout(); onChange();
      return;
    }
    active = entry;
    const pad = mapPadding();
    const W = mapEl.getBoundingClientRect().width || 1;
    frac = (pad.left + (W - pad.left) / 2) / W;   // centre of the visible map
    buildUi();
    pill.textContent = '◀ ' + (entry.meta.title || entry.meta.id);
    const style = map.getStyle();
    const paper = (style.layers || []).find((l) => l.type === 'background');
    cmp = new maplibregl.Map({
      container: cmpEl,
      style: { version: 8, glyphs: style.glyphs, sources: {}, layers: paper ? [paper] : [] },
      center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
      // no bounds/zoom limits of its own: the main map already constrains the
      // camera, and a second constraint could only make the halves disagree
      minZoom: 0, maxZoom: 24,
      interactive: false, attributionControl: false,
      pixelRatio: map.getPixelRatio(), fadeDuration: 150,
    });
    cmp.setPadding(map.getPadding());
    const m = cmp;
    m.once('load', () => { if (m !== cmp) return; cmpReady = true; onMove(); reconcile(); });
    map.on('move', onMove);
    map.on('render', onRender);
    map.on('resize', layout);
    window.addEventListener('keydown', onKey, true);
    layout();
    onChange();
    handle.focus({ preventScroll: true });
  }

  function stop() {
    if (!active && !cmp) return;
    active = null;
    map.off('move', onMove);
    map.off('render', onRender);
    map.off('resize', layout);
    window.removeEventListener('keydown', onKey, true);
    const m = cmp;
    cmp = null; cmpReady = false; cmpBasemap = null; order = ''; redraw = false; dragging = false;
    shadows.clear();
    try { if (m) m.remove(); } catch (err) { console.warn(err); }
    if (cmpEl) cmpEl.remove();
    if (ui) ui.remove();
    cmpEl = ui = pill = handle = null;
    onChange();
  }

  const toggle = (entry) => (is(entry) ? stop() : start(entry));

  const api = { is, start, stop, toggle, refresh, layout };
  // for the headless check and debugging
  window.__swipe = { map: () => cmp, active: () => (active ? active.key : null), x: () => x, frac: () => frac };
  return api;
}
