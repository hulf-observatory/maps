// Year range filter + play for the built-up layer. One control above Edit style
// on the workbench card and preview: the ramp gradient IS the legend, with two
// handles on it (lo and hi, 1985-2023) — cells with lo <= first-built-year <= hi
// show. It drives a second raster layer fed by the "yearfilter" protocol (see
// js/encoded.js): tiles are decoded once and only re-coloured on range or
// palette changes. At the full range (the default) the original display layer
// shows, for full fidelity.
import { ensureProtocol, registerYearLayer, yearColor, rampGradient } from './encoded.js';

const MIN_YEAR = 1985, MAX_YEAR = 2023, TICK_MS = 350, DEBOUNCE_MS = 80;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

function yearState(entry) {
  if (!entry.yearUI) entry.yearUI = { lo: MIN_YEAR, hi: MAX_YEAR, playing: false, timer: 0 };
  return entry.yearUI;
}

const srcId = (entry) => entry.srcId + '-year';
const layerId = (entry) => entry.key + ':year';
const protoUrl = (companion, ys, palette) => `yearfilter://${companion.id}/${ys.lo}-${ys.hi}/${palette || 'viridis'}/{z}/{x}/{y}`;
const fullRange = (ys) => ys.lo === MIN_YEAR && ys.hi === MAX_YEAR;
export const rangeLabel = (ys) => (fullRange(ys) ? 'Built by 2023' : ys.lo === MIN_YEAR ? 'Built by ' + ys.hi : `Built ${ys.lo}–${ys.hi}`);

function ensureYearLayer(map, entry, companion) {
  const id = layerId(entry), sid = srcId(entry);
  if (map.getLayer(id)) return;
  const ys = yearState(entry);
  if (!map.getSource(sid)) {
    map.addSource(sid, {
      type: 'raster', tileSize: Number(companion.tile_size) || 512,
      tiles: [protoUrl(companion, ys, entry.settings.palette)],
      minzoom: Number(companion.minzoom) || 8, maxzoom: Number(companion.maxzoom) || 13,
      bounds: companion.bounds,
    });
    ys.url = protoUrl(companion, ys, entry.settings.palette);
  }
  map.addLayer({ id, type: 'raster', source: sid, metadata: { entry: entry.key },
    paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });
  if (!entry.layerIds.includes(id)) entry.layerIds.push(id); // ordered + removed with the entry
}

// Keep the pair consistent with the entry's settings: away from the full range
// the recoloured layer replaces the display layer, and range/palette changes
// swap the protocol URL (recolour from the LRU, no refetch). Called after every
// applySettings (from main.js safeApply) and on handle moves.
export function syncYearLayer(map, entry) {
  const ys = entry.yearUI;
  if (!ys) return;
  const companion = ys.companion;
  const active = !fullRange(ys) && entry.visible && !entry.suspended;
  if (active && companion) ensureYearLayer(map, entry, companion);
  const id = layerId(entry);
  if (map.getLayer(id)) {
    if (companion) {
      const url = protoUrl(companion, ys, entry.settings.palette);
      const src = map.getSource(srcId(entry));
      if (src && src.setTiles && ys.url !== url) { src.setTiles([url]); ys.url = url; }
    }
    map.setLayoutProperty(id, 'visibility', active ? 'visible' : 'none');
    map.setPaintProperty(id, 'raster-opacity', entry.settings.opacity);
    map.setPaintProperty(id, 'raster-brightness-min', Math.max(0, entry.settings.brightness || 0));
    map.setPaintProperty(id, 'raster-brightness-max', Math.min(1, 1 + (entry.settings.brightness || 0)));
    map.setPaintProperty(id, 'raster-contrast', entry.settings.contrast || 0);
  }
  const rid = entry.key + ':raster';
  if (map.getLayer(rid)) map.setLayoutProperty(rid, 'visibility', active ? 'none' : (entry.visible && !entry.suspended ? 'visible' : 'none'));
}

export function stopYearPlay(entry) {
  const ys = entry.yearUI;
  if (!ys) return;
  ys.playing = false;
  if (ys.timer) { clearTimeout(ys.timer); ys.timer = 0; }
  if (ys.onStop) { const f = ys.onStop; ys.onStop = null; f(); }
}

// The single control: readout ("Built 1992-2015" / "Built by 2015"), the ramp
// gradient with two keyboard-accessible handles on it, and the play button
// (hi sweeps from lo to 2023).
// onChange (optional) runs after every range move, e.g. so the swipe compare
// map can follow the year filter.
export function yearControl(map, entry, companion, legendPromise, onChange) {
  ensureProtocol();
  const ys = yearState(entry);
  ys.companion = companion;
  // register the companion synchronously so the protocol can serve tiles at
  // once (built-in viridis), then upgrade the LUT when the baked legend lands
  registerYearLayer(companion, null);
  const legendReady = legendPromise.then((def) => registerYearLayer(companion, def)).catch(() => { /* built-in viridis */ });

  const pal = () => entry.settings.palette || 'viridis';
  const readout = h('span', { class: 'v' }, rangeLabel(ys));
  const grad = h('i', { class: 'yr-grad' });
  const paint = () => { grad.style.background = rampGradient(companion.id, pal()); };
  paint();
  legendReady.then(paint);

  const mkHandle = (label) => h('input', { type: 'range', min: MIN_YEAR, max: MAX_YEAR, step: 1, 'aria-label': label });
  const loInp = mkHandle('First built-up year (from)');
  const hiInp = mkHandle('First built-up year (to)');
  loInp.value = String(ys.lo); hiInp.value = String(ys.hi);

  let deb = 0;
  const apply = () => { syncYearLayer(map, entry); if (onChange) onChange(); };
  const setRange = (lo, hi, immediate) => {
    ys.lo = Math.max(MIN_YEAR, Math.min(MAX_YEAR, lo));
    ys.hi = Math.max(ys.lo, Math.min(MAX_YEAR, hi));
    loInp.value = String(ys.lo); hiInp.value = String(ys.hi);
    readout.textContent = rangeLabel(ys);
    clearTimeout(deb);
    if (immediate) apply();
    else deb = setTimeout(apply, DEBOUNCE_MS);
  };
  loInp.addEventListener('input', () => { if (ys.playing) stop(); setRange(Math.min(Number(loInp.value), ys.hi), ys.hi); });
  hiInp.addEventListener('input', () => { if (ys.playing) stop(); setRange(ys.lo, Math.max(Number(hiInp.value), ys.lo)); });

  const range = h('div', { class: 'yr-range', 'data-year-slider': '1' }, grad, loInp, hiInp);

  const btn = h('button', { type: 'button', class: 'yr-play', 'aria-label': 'Play years', title: 'Sweep from the first year to 2023' }, ys.playing ? '⏸' : '▶');
  const onKey = (e) => { if (e.key === 'Escape') stop(); };
  function stop() {
    stopYearPlay(entry);
    btn.textContent = '▶';
    document.removeEventListener('keydown', onKey);
  }
  function tick() {
    // stop quietly if the layer left the map (removed, preview ended, page moved on)
    if (!map.getLayer(entry.key + ':raster') || !entry.yearUI) { stop(); return; }
    if (ys.hi >= MAX_YEAR) { stop(); return; }
    setRange(ys.lo, ys.hi + 1, true);
    if (ys.hi >= MAX_YEAR) { stop(); return; }
    ys.timer = setTimeout(tick, TICK_MS);
  }
  btn.addEventListener('click', () => {
    if (ys.playing) { stop(); return; }
    ys.playing = true;
    btn.textContent = '⏸';
    document.addEventListener('keydown', onKey);
    ys.onStop = null;
    if (ys.hi >= MAX_YEAR) setRange(ys.lo, ys.lo, true); // restart the sweep at hi = lo
    ys.timer = setTimeout(tick, TICK_MS);
  });

  // when the card re-renders while playing, the fresh button reads ⏸ from the
  // shared state; retire the old Esc hook with the old DOM
  if (ys.playing) { document.addEventListener('keydown', onKey); ys.onStop = () => document.removeEventListener('keydown', onKey); }

  if (!fullRange(ys)) apply(); // rebuild after a re-render mid-slide

  return h('div', { class: 'yr-ctl' },
    h('span', { class: 'ctl-row' },
      h('span', { class: 'yr-ends' }, String(MIN_YEAR) + '–' + String(MAX_YEAR)), readout),
    h('div', { class: 'yr-row' }, btn, range));
}
