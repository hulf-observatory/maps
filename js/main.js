// Spatial Data Repository viewer. layers.json drives everything.
import { buildEntry, removeEntry, applySettings, defaultSettings, computeClasses, geomKind, kindLabel,
  isNumericType, KIND_RANK, OTHER_COLOR } from './layers.js';
import { iconSvg } from './icons.js';
import { BASEMAPS, DEFAULT_BASEMAP, setBasemap } from './basemaps.js';
import { initMeasure } from './measure.js';
import { initMobile, phone, sheetBottomPad, makeRoomForSearch } from './mobile.js';
import { COMPANIONS, PALETTES } from './encoded.js';
import { yearControl, syncYearLayer } from './yearslider.js';
import { initHeightHover } from './hoverheight.js';
import { initSwipe } from './swipe.js';
import { createPlaceSearch } from './place-search.js';

let START = { center: [78.47, 17.40], zoom: 9.8 };
const LIMIT = [77.1, 15.7, 81.5, 20.05];
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
// set before the map is created: embed hides the top bar, and a map sized first would
// keep the old (shorter) canvas and leave a blank strip at the bottom of the frame
if (EMBED) document.body.classList.add('embed');
// ?view=lat,lng,zoom opens (and Home returns to) a given place — story pages embed the
// viewer this way, in the same lat,lng,zoom order Felt's loc= used. Ignored if malformed.
{
  const v = (params.get('view') || '').split(',').map(Number);
  if (v.length === 3 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180) {
    START = { center: [v[1], v[0]], zoom: Math.max(7, Math.min(19, v[2])) };
  }
}

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  catalog: { groups: [], layers: [] },
  byId: new Map(),
  bench: [],          // entries, index 0 = top of list = drawn on top
  preview: null,      // entry
  closedGroups: new Set(),
  closedSubgroups: new Set(), // "groupId/subgroupName"
  query: '',
  basemap: DEFAULT_BASEMAP,
};

// ------------------------------------------------------------------ map
const bl = LIMIT;
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: location.origin + '/vendor/glyphs/{fontstack}/{range}.pbf',
    sources: {},
    layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#F4F1E8' } }],
  },
  center: START.center, zoom: START.zoom,
  // minZoom 7, not the atlas's 9: this portal carries statewide layers (districts,
  // mandals, highways) whose fit needs the wider view; maxBounds still stops the map
  // drifting away from Telangana. Rasters only exist from z8 and fade in as you zoom.
  minZoom: 7, maxZoom: 19,
  maxBounds: [[bl[0], bl[1]], [bl[2], bl[3]]],
  attributionControl: false,
  dragRotate: true, pitchWithRotate: true,
  pixelRatio: window.devicePixelRatio || 1,
  fadeDuration: 150,
});
window.__map = map; // for the headless check and debugging
const mapLoaded = new Promise((res) => map.once('load', res));
map.touchZoomRotate.disableRotation();

// swipe compare (js/swipe.js): a second map without one raster, clipped right of
// a divider. Created only while swiping; main.js calls swipe.refresh() wherever
// it re-applies the main map. Esc belongs to measure / year play first.
const swipe = initSwipe({
  map, state, mapPadding, onChange: () => renderBench(),
  escBlocked: () => measure.active() || state.bench.some((e) => e.yearUI && e.yearUI.playing),
});

// ------------------------------------------------------------------ catalog
async function loadCatalog() {
  const r = await fetch('layers.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('layers.json ' + r.status);
  const c = await r.json();
  c.groups = Array.isArray(c.groups) ? c.groups : [];
  c.layers = (Array.isArray(c.layers) ? c.layers : []).filter((l) => l && l.id && (l.tile_url || l.kind));
  state.catalog = c;
  // byId keeps every layer (encoded data companions included, for the year slider
  // and hover readout); the library only ever lists display !== false layers.
  state.byId = new Map(c.layers.map((l) => [l.id, l]));
}
const displayable = () => state.catalog.layers.filter((l) => l.display !== false);

function groupsWithLayers() {
  const cat = state.catalog;
  const listable = displayable();
  const groups = [...cat.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const known = new Set(groups.map((g) => g.id));
  const extra = [...new Set(listable.map((l) => l.group || 'other').filter((g) => !known.has(g)))];
  for (const g of extra) groups.push({ id: g, title: g === 'other' ? 'Other' : g });
  return groups.map((g) => ({
    ...g,
    layers: listable.filter((l) => (l.group || 'other') === g.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.title).localeCompare(b.title)),
  })).filter((g) => g.layers.length);
}

function swatch(meta, settings) {
  const k = geomKind(meta);
  const st = meta.style || {};
  const c = (settings && settings.color) || st.color || st.fill || '#1F4E79';
  if (k === 'point' && st.icon && iconSvg(st.icon)) return h('i', { class: 'sw icon', style: `--c:${c}`, html: iconSvg(st.icon, '#fff') });
  return h('i', { class: 'sw ' + k, style: `--c:${c}` });
}

// ------------------------------------------------------------------ library
function renderLibrary() {
  const list = $('#lib-list');
  list.innerHTML = '';
  const q = state.query.trim().toLowerCase();
  const onBench = new Set(state.bench.map((e) => e.meta.id));
  let shown = 0;
  for (const g of groupsWithLayers()) {
    const layers = q ? g.layers.filter((l) => String(l.title || l.id).toLowerCase().includes(q)) : g.layers;
    if (!layers.length) continue;
    shown += layers.length;
    const closed = !q && state.closedGroups.has(g.id);
    const row = (l, showSub) => h('button', {
      type: 'button', class: 'lyr' + (state.preview && state.preview.meta.id === l.id ? ' active' : ''), 'data-id': l.id,
      title: l.title || l.id, onclick: () => startPreview(l.id),
    }, swatch(l), h('span', { class: 't' }, l.title || l.id),
    showSub && l.subgroup ? h('span', { class: 'sub' }, l.subgroup) : null,
    onBench.has(l.id) ? h('span', { class: 'tag' }, 'on bench') : null);
    let items;
    if (q) {
      // search shows matches flat, with the subgroup named on the row
      items = h('div', { class: 'grp-items' }, layers.map((l) => row(l, true)));
    } else {
      // one level of subgrouping: direct layers first, then each subgroup
      // under its own collapsible sub-header
      const subs = [...new Set(layers.filter((l) => l.subgroup).map((l) => l.subgroup))].sort();
      items = h('div', { class: 'grp-items' },
        layers.filter((l) => !l.subgroup).map((l) => row(l)),
        subs.map((name) => {
          const ls = layers.filter((l) => l.subgroup === name);
          const key = g.id + '/' + name;
          const sclosed = state.closedSubgroups.has(key);
          return h('div', { class: 'subgrp' + (sclosed ? ' closed' : '') },
            h('button', { type: 'button', class: 'subgrp-head', 'aria-expanded': String(!sclosed), onclick: () => {
              state.closedSubgroups.has(key) ? state.closedSubgroups.delete(key) : state.closedSubgroups.add(key);
              renderLibrary();
            } }, h('span', { class: 'caret' }, '▼'), name, h('span', { class: 'n' }, ls.length)),
            h('div', { class: 'subgrp-items' }, ls.map((l) => row(l))));
        }));
    }
    list.append(h('div', { class: 'grp' + (closed ? ' closed' : '') },
      h('button', { type: 'button', class: 'grp-head', 'aria-expanded': String(!closed), onclick: () => {
        state.closedGroups.has(g.id) ? state.closedGroups.delete(g.id) : state.closedGroups.add(g.id);
        renderLibrary();
      } }, h('span', { class: 'caret' }, '▼'), g.title || g.id, h('span', { class: 'n' }, layers.length)),
      items));
  }
  if (!shown) list.append(h('div', { class: 'lib-note' }, state.catalog.layers.length ? 'No layers match.' : 'No layers published yet. They appear here as the bake finishes them.'));
  const all = groupsWithLayers();
  $('#lib-collapse-all').textContent = all.every((g) => state.closedGroups.has(g.id)) ? 'Expand all' : 'Collapse all';
}

$('#lib-search').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });
$('#lib-collapse-all').addEventListener('click', () => {
  const all = groupsWithLayers();
  if (all.every((g) => state.closedGroups.has(g.id))) state.closedGroups.clear();
  else all.forEach((g) => state.closedGroups.add(g.id));
  renderLibrary();
});

// ------------------------------------------------------------------ entries
function makeEntry(meta, key, settings) {
  return { key, meta, settings: settings ? { ...settings } : defaultSettings(meta), defaults: defaultSettings(meta),
    visible: true, open: false, error: null, classes: null, layerIds: [] };
}

async function mount(entry) {
  try {
    // sources and layers can only be added once the style has fired 'load'; a preview
    // started straight after page load used to fail with "Style is not done loading".
    // (isStyleLoaded() is NOT the right gate: it reads false whenever a tile is loading.)
    await mapLoaded;
    await buildEntry(map, entry, state.catalog);
    // buildEntry applies the settings before any classes exist, so a layer whose
    // default is a palette ("colour by" preset from style.palette) would stay in
    // its single base colour: compute the classes, then apply again.
    if (entry.settings.colorBy) { refreshClasses(entry); safeApply(entry); }
  } catch (err) {
    console.warn('layer failed', entry.meta.id, err);
    entry.error = 'Could not draw this layer: ' + (err && err.message ? err.message : err);
    try { removeEntry(map, entry); } catch { /* ignore */ }
  }
}

function safeApply(entry) {
  try { applySettings(map, entry); entry.error = entry.error && entry.error.startsWith('Could not draw') ? entry.error : null; }
  catch (err) { entry.error = 'Style error: ' + err.message; console.warn(err); }
  // the year-slider layer (if any) mirrors visibility/opacity of its display layer
  try { syncYearLayer(map, entry); } catch (err) { console.warn(err); }
  swipe.refresh();
}

// The built-up layer gets a year slider when its encoded companion is published.
function yearCompanion(meta) {
  const cid = COMPANIONS[meta.id];
  const c = cid && state.byId.get(cid);
  return c && /year/i.test(c.decode || '') ? c : null;
}

function refreshClasses(entry) {
  if (!entry.settings.colorBy) { entry.classes = null; return; }
  try { entry.classes = computeClasses(map, entry); } catch (err) { entry.classes = null; console.warn(err); }
  if (entry.classes && entry.classes.empty) {
    // nothing loaded yet: try again once tiles arrive
    map.once('idle', () => { if (entry.settings.colorBy) { entry.classes = computeClasses(map, entry); safeApply(entry); rerenderEntry(entry); } });
  }
}

function rerenderEntry(entry) {
  if (state.preview === entry) renderPreview();
  else renderBench();
}

function changed(entry) {
  const a = entry.settings, b = entry.defaults;
  return Object.keys(b).some((k) => a[k] !== b[k]);
}

// ------------------------------------------------------------------ controls
function range(label, val, min, max, step, fmt, oninput) {
  const v = h('span', { class: 'v' }, fmt(val));
  const inp = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label });
  inp.addEventListener('input', () => { const x = Number(inp.value); v.textContent = fmt(x); oninput(x); });
  return h('label', { class: 'ctl' }, h('span', { class: 'ctl-row' }, label, v), inp);
}
const pct = (x) => Math.round(x * 100) + '%';

// second row of a raster card: opacity (while folded — Edit style has its own when open)
// and the Swipe toggle (js/swipe.js; not in ?embed=1)
function rasterRow(entry) {
  const swipeBtn = EMBED ? null : h('button', { type: 'button', class: 'txtbtn swipe-btn', 'aria-pressed': String(swipe.is(entry)),
    title: swipe.is(entry) ? 'Stop comparing' : 'Compare this layer with the map beneath it',
    onclick: () => {
      if (!entry.visible) { entry.visible = true; safeApply(entry); updateSources(); }
      swipe.toggle(entry);
    } }, swipe.is(entry) ? 'Swiping' : 'Swipe');
  if (!swipeBtn && entry.open) return null;
  return h('div', { class: 'card-row2' + (entry.open ? ' only-swipe' : '') },
    entry.open ? null : quickOpacity(entry), swipeBtn);
}

// compact opacity control for a folded raster card; shares state with the Edit style slider
function quickOpacity(entry) {
  const v = h('span', { class: 'v' }, pct(entry.settings.opacity));
  const inp = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: entry.settings.opacity, 'aria-label': 'Opacity' });
  inp.addEventListener('input', () => {
    entry.settings.opacity = Number(inp.value); v.textContent = pct(entry.settings.opacity);
    safeApply(entry); refreshHeadBits(entry);
  });
  return h('label', { class: 'ctl quick-op' }, h('span', { class: 'ctl-row' }, 'Opacity', v), inp);
}
const signed = (x) => (x > 0 ? '+' : '') + Math.round(x * 100);

// ---------------------------------------------------------------- baked legends
// Layers baked elsewhere (built-up, buildings, height) ship a legend JSON beside the
// tiles. Fetch it once per layer and show it on the card, so the default view of a card
// explains the colours instead of offering knobs.
const legendCache = new Map();
async function bakedLegend(meta) {
  if (!meta.legend) return null;
  if (legendCache.has(meta.id)) return legendCache.get(meta.id);
  // plain fetch: 'force-cache' would pin a stale 404 from a run where the file was missing
  const pr = fetch(meta.legend)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  legendCache.set(meta.id, pr);
  return pr;
}

function legendRows(def) {
  if (!def) return null;
  const stops = Array.isArray(def.stops) ? def.stops : [];
  const classes = Array.isArray(def.classes) ? def.classes : [];
  const rows = [];
  for (const c of classes) if (c && c.color) rows.push([c.color, c.label || String(c.code ?? '')]);
  if (stops.length) {
    const labelled = stops.filter((st) => st && st.label);
    if (labelled.length && labelled.length <= 12) {
      for (const st of labelled) rows.push([st.color, st.label]);
    } else if (stops.length) {
      // a continuous ramp (e.g. year): show it as a bar with its ends labelled
      const key = ['year', 'value', 'min_m', 'level'].find((k) => stops[0][k] != null);
      const grad = stops.map((st) => st.color).filter(Boolean);
      return h('div', { class: 'key-ramp' },
        h('i', { style: `background:linear-gradient(90deg,${grad.join(',')})` }),
        h('em', {}, String(stops[0][key] ?? '')), h('em', { class: 'hi' }, String(stops[stops.length - 1][key] ?? '')));
    }
  }
  if (!rows.length) return null;
  return h('div', { class: 'key' }, rows.map(([c, t]) => h('span', {}, h('i', { style: `--c:${c}` }), h('em', {}, t))));
}

// What a card shows before anyone asks to edit: the legend, a line of provenance,
// and the button that reveals the style controls.
// A small key for ordinary vector layers, which have no baked legend: the colour
// they are drawn in, named the way the layer is actually rendered.
function styleKey(entry) {
  const m = entry.meta, st = entry.settings, k = geomKind(m);
  if (k === 'raster' || k === 'terrain') return null;
  const rows = [];
  if (k === 'polygon') {
    rows.push([st.color, st.fillOn ? 'Outline and fill' : 'Outline']);
  } else if (k === 'line') {
    rows.push([st.color, 'Line']);
  } else {
    rows.push([st.color, entry.icon ? 'Symbol' : 'Point']);
  }
  return h('div', { class: 'key' }, rows.map(([c, t]) => h('span', {}, h('i', { style: `--c:${c}` }), h('em', {}, t))));
}

// Scanned plans (land use) carry their own printed legend, cropped from the sheet by the
// bake into legends/<series>.webp. Shown in place of a colour key; tap to enlarge.
function legendImage(m) {
  const img = h('img', { src: m.legend_image, alt: `Legend for ${m.title || m.id}`, loading: 'lazy', class: 'legend-img' });
  img.addEventListener('error', () => { fig.replaceWith(h('div', { class: 'note' }, 'Legend image unavailable.')); });
  const fig = h('button', { type: 'button', class: 'legend-thumb', title: 'Enlarge legend', 'aria-label': 'Enlarge legend',
    onclick: () => openLegendLightbox(m) }, img);
  return fig;
}

function openLegendLightbox(m) {
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const lb = h('div', { class: 'legend-lightbox', role: 'dialog', 'aria-label': `Legend: ${m.title || m.id}`,
    onclick: (e) => { if (e.target === lb) close(); } },
    h('figure', {},
      h('img', { src: m.legend_image, alt: `Legend for ${m.title || m.id}` }),
      h('figcaption', {}, m.title || m.id),
      h('button', { type: 'button', class: 'iconbtn lb-close', 'aria-label': 'Close', onclick: close }, '×')));
  document.body.append(lb);
  document.addEventListener('keydown', onKey);
}

function cardInfo(entry) {
  const m = entry.meta, st = entry.settings;
  const box = h('div', { class: 'card-info' });
  const yc = yearCompanion(m);
  if (yc) {
    // the year-range control's ramp IS this layer's legend
    box.append(yearControl(map, entry, yc, bakedLegend(m), swipe.refresh));
  } else if (m.legend_image) {
    box.append(legendImage(m));
  } else if (m.legend) {
    const slot = h('div', { class: 'legend-slot' }, h('div', { class: 'note' }, 'Loading key…'));
    box.append(slot);
    bakedLegend(m).then((def) => {
      const rows = legendRows(def);
      slot.replaceChildren(rows || '');
      if (def && def.note && rows) slot.append(h('div', { class: 'note' }, def.note));
    });
  } else if (st.colorBy) {
    box.append(legendKey(entry));
  } else {
    const k = styleKey(entry);
    if (k) box.append(k);
  }
  // description and provenance are read in the preview's Details before adding;
  // on the bench a card is just the key and the way into the controls
  box.append(h('button', {
    type: 'button', class: 'btn-edit',
    onclick: () => { entry.editing = true; entry.open = true; renderBench(); },
  }, 'Edit style'));
  return box;
}

// Fields worth offering in "Colour by" and "Label". Row ids, geometry bookkeeping,
// coordinates and internal codes are true attributes but useless for styling — they
// stay visible in popups and in the Details field list, just not in these dropdowns.
const BORING_FIELD = new RegExp([
  '^(fid|objectid([_ ]?\\d+)?|id|gid|uid|sno|s_no|sl_no|order|sort)$',
  '^(shape[_ ]?(len(g(th)?)?|area)|st[_ ]?area[_ ]?sh|st[_ ]?length[_ ]?s)$',
  '^(lat(itude)?|lon(g(itude)?)?|x|y|stop_lat|stop_lon)$',
  '^(felt:.*|.*[_ ]id|fnode.*|tnode.*|[lr]poly.*|aprail.*|next_(down|sink)|main_bas|dist_(sink|main)|pfaf.*|endo|coast|hybas.*)$',
  '^(remarks|comments?)$',
].join('|'), 'i');
const usefulFields = (m) => (m.fields || []).filter((f) => f && f.name && !BORING_FIELD.test(f.name.trim()));

function controls(entry) {
  const m = entry.meta, st = entry.settings, k = geomKind(m);
  const upd = (patch, rerender) => {
    Object.assign(st, patch);
    safeApply(entry);
    if (rerender) rerenderEntry(entry);
    else refreshHeadBits(entry);
  };
  const out = [];
  out.push(range('Opacity', st.opacity, 0, 1, 0.05, pct, (x) => upd({ opacity: x })));
  if (k === 'raster') {
    out.push(range('Brightness', st.brightness, -0.8, 0.8, 0.05, signed, (x) => upd({ brightness: x })));
    out.push(range('Contrast', st.contrast, -0.8, 0.8, 0.05, signed, (x) => upd({ contrast: x })));
    // Baked rasters are pictures: no honest repalette exists for them. Only
    // layers drawn through the encoded protocol (the built-up year filter)
    // can recolour, so only those get a Palette dropdown.
    if (yearCompanion(m)) {
      const sel = h('select', { 'aria-label': 'Palette' },
        Object.entries(PALETTES).map(([id, p]) => h('option', { value: id, selected: id === (st.palette || 'viridis') }, p.title)));
      sel.addEventListener('change', () => upd({ palette: sel.value === 'viridis' ? '' : sel.value }));
      out.push(h('label', { class: 'ctl' }, h('span', { class: 'ctl-row' }, 'Palette'), sel));
    }
  } else if (k === 'terrain') {
    out.push(range('Hillshade', st.intensity, 0, 1, 0.05, pct, (x) => upd({ intensity: x })));
    out.push(range('Exaggeration', st.exaggeration, 1, 5, 0.25, (x) => x.toFixed(2) + '×', (x) => upd({ exaggeration: x })));
    const cb = h('input', { type: 'checkbox', checked: st.threeD });
    cb.addEventListener('change', () => {
      upd({ threeD: cb.checked });
      if (cb.checked && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 600 });
      if (!cb.checked) map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
    });
    out.push(h('label', { class: 'ctl ctl-row' }, 'Show in 3D', cb));
  } else {
    const col = h('input', { type: 'color', value: st.color, 'aria-label': 'Colour' });
    col.addEventListener('input', () => upd({ color: col.value }));
    out.push(h('label', { class: 'ctl ctl-row' }, st.colorBy ? 'Outline colour' : 'Colour', col));
    out.push(range(k === 'point' && !entry.icon ? 'Point size' : 'Line width', st.lineWidth, 0.5, 8, 0.25, (x) => x.toFixed(2), (x) => upd({ lineWidth: x })));
    if (k === 'polygon') {
      const cb = h('input', { type: 'checkbox', checked: st.fillOn });
      cb.addEventListener('change', () => upd({ fillOn: cb.checked }, true));
      out.push(h('label', { class: 'ctl ctl-row' }, 'Fill', cb));
      if (st.fillOn) out.push(range('Fill opacity', st.fillOpacity, 0.05, 1, 0.05, pct, (x) => upd({ fillOpacity: x })));
    }
    const fields = usefulFields(m);
    if (fields.length) {
      const sel = h('select', { 'aria-label': 'Colour by' }, h('option', { value: '' }, 'Single colour'),
        fields.map((f) => h('option', { value: f.name, selected: f.name === st.colorBy }, f.name)));
      sel.addEventListener('change', () => { st.colorBy = sel.value; refreshClasses(entry); upd({}, true); });
      out.push(h('label', { class: 'ctl' }, h('span', { class: 'ctl-row' }, 'Colour by'), sel));
      if (st.colorBy) out.push(legendKey(entry));
      const lab = h('select', { 'aria-label': 'Label' }, h('option', { value: '' }, 'No labels'),
        fields.map((f) => h('option', { value: f.name, selected: f.name === st.labelField }, f.name)));
      lab.addEventListener('change', () => upd({ labelField: lab.value }, true));
      out.push(h('label', { class: 'ctl' }, h('span', { class: 'ctl-row' }, 'Label'), lab));
    }
  }
  out.push(h('button', {
    type: 'button', class: 'btn-edit done',
    onclick: () => { entry.editing = false; if (entry === state.preview) renderPreview(); else renderBench(); },
  }, 'Done'));
  return out;
}

function legendKey(entry) {
  const cs = entry.classes;
  if (!cs || cs.empty) return h('div', { class: 'note' }, 'Reading values from the map…');
  const fmt = (x) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-IN') : +Number(x).toPrecision(3));
  let rows = [];
  if (cs.type === 'cat') {
    rows = cs.items.map((it) => [it.color, it.value]);
    if (cs.other) rows.push([OTHER_COLOR, 'Other']);
  } else {
    const edges = [cs.min, ...cs.breaks, cs.max];
    rows = cs.colors.map((c, i) => [c, i === cs.colors.length - 1 ? `${fmt(edges[i])} and above` : `${fmt(edges[i])} to ${fmt(edges[i + 1])}`]);
  }
  return h('div', { class: 'key' }, rows.map(([c, t]) => h('span', {}, h('i', { style: `--c:${c}` }), h('em', {}, t))),
    cs.type === 'num' ? h('div', { class: 'note' }, 'Classes from features in view when chosen') : null);
}

function summary(entry) {
  const m = entry.meta, k = geomKind(m);
  const parts = [];
  if (m.feature_count != null && k !== 'raster' && k !== 'terrain') parts.push(Number(m.feature_count).toLocaleString('en-IN') + ' ' + kindLabel(m));
  else parts.push(kindLabel(m));
  if (m.date) parts.push(m.date);
  const f = usefulFields(m).map((x) => x.name);
  if (f.length) parts.push(f.slice(0, 3).join(', ') + (f.length > 3 ? '…' : ''));
  if (entry.settings.colorBy) parts.push('by ' + entry.settings.colorBy);
  return parts.join(' · ');
}

// small in-place refresh of swatch + reset button without re-rendering sliders
function refreshHeadBits(entry) {
  const el = entry.el;
  if (!el) return;
  const sw = el.querySelector('.sw');
  if (sw) sw.replaceWith(swatch(entry.meta, entry.settings));
  const r = el.querySelector('.reset');
  if (r) r.hidden = !changed(entry);
}

// ------------------------------------------------------------------ bench
function renderBench() {
  const list = $('#bench-list');
  list.innerHTML = '';
  $('#bench-empty').hidden = state.bench.length > 0;
  $('#bench-count').textContent = state.bench.length ? String(state.bench.length) : '';
  $('#rail-count').textContent = state.bench.length ? String(state.bench.length) : '';
  $('#bench-hide').textContent = state.bench.length && state.bench.every((e) => !e.visible) ? 'Show all' : 'Hide all';
  $('#bench-expand').textContent = state.bench.length && state.bench.every((e) => e.open) ? 'Collapse all' : 'Expand all';
  state.bench.forEach((entry, i) => list.append(card(entry, i)));
}

function card(entry, i) {
  const m = entry.meta;
  const eye = h('button', { type: 'button', class: 'iconbtn', title: entry.visible ? 'Hide' : 'Show', 'aria-label': entry.visible ? 'Hide' : 'Show',
    html: entry.visible
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M3 3l18 18"/></svg>',
    onclick: () => { entry.visible = !entry.visible; safeApply(entry); renderBench(); updateSources(); } });
  const reset = h('button', { type: 'button', class: 'iconbtn reset', title: 'Reset style', 'aria-label': 'Reset style', hidden: !changed(entry),
    onclick: () => { entry.settings = { ...entry.defaults }; entry.classes = null;
      if (entry.settings.colorBy) refreshClasses(entry); // restore a palette default
      safeApply(entry); renderBench(); } }, '↺');
  const move = h('span', { class: 'move' },
    h('button', { type: 'button', class: 'iconbtn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveEntry(i, i - 1) }, '▲'),
    h('button', { type: 'button', class: 'iconbtn', title: 'Move down', 'aria-label': 'Move down', disabled: i === state.bench.length - 1, onclick: () => moveEntry(i, i + 1) }, '▼'));
  // NOT draggable by default: a draggable ancestor hijacks range-input drags (the slider
  // only registered the first press). Only a press on the grip or the head arms reordering.
  const el = h('div', { class: 'card' + (entry.open ? ' open' : '') + (entry.visible ? '' : ' off'), 'data-id': m.id },
    h('div', { class: 'card-head' },
      h('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
      swatch(m, entry.settings),
      h('span', { class: 'card-name', onclick: () => { entry.open = !entry.open; if (!entry.open) entry.editing = false; renderBench(); } },
        h('span', { class: 't', title: m.title || m.id }, m.title || m.id), h('span', { class: 'kind' }, kindLabel(m))),
      reset, eye, move,
      h('button', { type: 'button', class: 'iconbtn', title: 'Remove', 'aria-label': 'Remove', onclick: () => removeFromBench(entry) }, '×'),
      // a plain word says what the button does; the chevron read as "expand", not "edit"
      h('button', { type: 'button', class: 'txtbtn fold', 'aria-expanded': String(!!entry.open),
        title: entry.open ? 'Close' : 'Show key and style options',
        onclick: () => { entry.open = !entry.open; if (!entry.open) entry.editing = false; renderBench(); } },
        entry.open ? 'Close' : 'Edit')),
    entry.error ? h('div', { class: 'card-err' }, entry.error) : null,
    h('div', { class: 'card-sum' }, summary(entry)),
    // images get a second row: opacity (the control people reach for when stacking a sheet
    // over the basemap) and Swipe — kept out of the head so the layer name has room
    geomKind(m) === 'raster' ? rasterRow(entry) : null,
    h('div', { class: 'card-body' }, entry.open ? (entry.editing ? controls(entry) : cardInfo(entry)) : null));
  entry.el = el;
  // drag to reorder
  // arm drag-to-reorder only from the card head (grip, name, empty space), never from controls
  el.addEventListener('pointerdown', (e) => {
    el.draggable = !!e.target.closest('.card-head') && !e.target.closest('button,input,select,a');
  });
  el.addEventListener('pointerup', () => { el.draggable = false; });
  el.addEventListener('dragstart', (e) => { if (e.target.closest('input,select')) { e.preventDefault(); return; } el.classList.add('dragging'); e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); el.draggable = false; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); const below = e.clientY > r.top + r.height / 2; el.classList.toggle('drop-below', below); el.classList.toggle('drop-above', !below); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const below = el.classList.contains('drop-below');
    el.classList.remove('drop-above', 'drop-below');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isInteger(from)) return;
    let to = i + (below ? 1 : 0);
    if (from < to) to -= 1;
    moveEntry(from, to);
  });
  return el;
}

function moveEntry(from, to) {
  if (to < 0 || to >= state.bench.length || from === to) return;
  const [e] = state.bench.splice(from, 1);
  state.bench.splice(to, 0, e);
  applyOrder();
  renderBench();
  syncUrl();
}

// bench[0] draws on top; preview and measure above everything
function applyOrder() {
  for (let i = state.bench.length - 1; i >= 0; i--) for (const id of state.bench[i].layerIds || []) if (map.getLayer(id)) map.moveLayer(id);
  if (state.preview) for (const id of state.preview.layerIds || []) if (map.getLayer(id)) map.moveLayer(id);
  for (const id of ['measure-line', 'measure-pts']) if (map.getLayer(id)) map.moveLayer(id);
  swipe.refresh();
}

// Where a new layer lands on the bench: within the points > lines > polygons >
// rasters banding, a polygon also slots among the other polygons by extent
// (bounds box area as a proxy) so smaller areas draw ABOVE larger ones — wards
// added after districts still land above them. Only applied at add time; manual
// drag reorder afterwards wins.
function bboxArea(meta) {
  const b = meta.bounds;
  return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)
    ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : null;
}
function insertIndex(meta) {
  const k = geomKind(meta), r = KIND_RANK[k];
  const a = k === 'polygon' ? bboxArea(meta) : null;
  for (let i = 0; i < state.bench.length; i++) {
    const em = state.bench[i].meta, er = KIND_RANK[geomKind(em)];
    if (er > r) return i;
    if (er === r && a != null) {
      const ea = bboxArea(em);
      if (ea != null && a <= ea) return i;
    }
  }
  return state.bench.length;
}

async function addToBench(id, settings, { quiet } = {}) {
  const meta = state.byId.get(id);
  if (!meta || state.bench.some((e) => e.meta.id === id)) return;
  const entry = makeEntry(meta, 'b:' + id, settings);
  entry.open = false; // bench cards start folded: title + one-line summary
  state.bench.splice(insertIndex(meta), 0, entry);
  if (state.preview) entry.suspended = true;
  await mount(entry);
  safeApply(entry);
  applyOrder();
  renderBench(); renderLibrary(); updateSources(); syncUrl();
}

function removeFromBench(entry) {
  try { removeEntry(map, entry); } catch (err) { console.warn(err); }
  state.bench = state.bench.filter((e) => e !== entry);
  swipe.refresh();
  renderBench(); renderLibrary(); updateSources(); syncUrl();
}

$('#bench-expand').addEventListener('click', () => { const all = state.bench.every((e) => e.open); state.bench.forEach((e) => { e.open = !all; }); renderBench(); });
$('#bench-hide').addEventListener('click', () => { const hidden = state.bench.every((e) => !e.visible); state.bench.forEach((e) => { e.visible = hidden; safeApply(e); }); renderBench(); updateSources(); });
$('#bench-clear').addEventListener('click', () => { [...state.bench].forEach((e) => { try { removeEntry(map, e); } catch { /* ignore */ } }); state.bench = []; swipe.refresh(); renderBench(); renderLibrary(); updateSources(); syncUrl(); });

// ------------------------------------------------------------------ preview
async function startPreview(id) {
  const meta = state.byId.get(id);
  if (!meta) return;
  if (state.preview && state.preview.meta.id === id) return;
  swipe.stop();
  endPreview(false);
  const onBench = state.bench.find((e) => e.meta.id === id);
  const entry = makeEntry(meta, 'p:' + id, onBench ? onBench.settings : null);
  entry.open = true;
  state.preview = entry;
  state.bench.forEach((e) => { e.suspended = true; safeApply(e); });
  setCol('bench', false);
  $('#bench-view').hidden = true;
  $('#preview-view').hidden = false;
  renderPreview(); renderLibrary();
  await mount(entry);
  if (state.preview !== entry) { try { removeEntry(map, entry); } catch { /* ignore */ } return; }
  applyOrder();
  renderPreview(); updateSources();
  fitTo(meta);
}

function fitTo(meta) {
  const b = meta.bounds;
  if (!(Array.isArray(b) && b.length === 4 && b.every(Number.isFinite))) return;
  const c = [Math.max(b[0], LIMIT[0]), Math.max(b[1], LIMIT[1]), Math.min(b[2], LIMIT[2]), Math.min(b[3], LIMIT[3])];
  if (c[0] >= c[2] || c[1] >= c[3]) return;
  // cameraForBounds ADDS the map's own padding (the open columns, kept in sync by
  // syncMapPadding) to whatever padding is passed here. So pass only small insets —
  // passing the column width again used to make padding exceed the canvas, and the
  // fit silently returned undefined, which is exactly "preview stopped zooming".
  const box = $('#map').getBoundingClientRect();
  const mp = map.getPadding ? map.getPadding() : { left: 0, right: 0, top: 0, bottom: 0 };
  const freeW = Math.max(1, box.width - (mp.left || 0) - (mp.right || 0));
  const freeH = Math.max(1, box.height - (mp.top || 0) - (mp.bottom || 0));
  const ins = {
    top: Math.min(40, freeH * 0.1), bottom: Math.min(40, freeH * 0.1),
    left: Math.min(40, freeW * 0.1), right: Math.min(40, freeW * 0.1),
  };
  const minz = Math.max(map.getMinZoom(), Number(meta.minzoom) || 0);
  // A state-wide layer cannot fit at our minimum zoom of 9. Asking MapLibre to fit it
  // anyway works but logs "Map cannot fit within canvas", so handle that case ourselves:
  // centre the bounds at the closest zoom we are allowed to use.
  const usableW = Math.max(1, freeW - ins.left - ins.right);
  const degPerPx = 360 / (512 * Math.pow(2, minz));
  if ((c[2] - c[0]) > usableW * degPerPx) {
    map.easeTo({ center: [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2], zoom: minz, bearing: 0, duration: 700 });
    return;
  }
  const cam = map.cameraForBounds([[c[0], c[1]], [c[2], c[3]]], { padding: ins, maxZoom: 16 });
  if (!cam) return;
  map.easeTo({ ...cam, zoom: Math.max(cam.zoom, minz), bearing: 0, duration: 700 });
}

function endPreview(rerender = true) {
  const pv = state.preview;
  if (pv) { try { removeEntry(map, pv); } catch (err) { console.warn(err); } }
  state.preview = null;
  state.bench.forEach((e) => { e.suspended = false; safeApply(e); });
  $('#bench-view').hidden = false;
  $('#preview-view').hidden = true;
  closePopup();
  if (rerender) { renderBench(); renderLibrary(); updateSources(); }
}

// The preview's default body: just the key for how the layer is drawn.
function previewFacts(pv) {
  const m = pv.meta, st = pv.settings;
  const box = h('div', { class: 'card-info' });
  const yc = yearCompanion(m);
  if (yc) {
    box.append(yearControl(map, pv, yc, bakedLegend(m), swipe.refresh));
  } else if (m.legend_image) {
    box.append(legendImage(m));
  } else if (m.legend) {
    const slot = h('div', { class: 'legend-slot' }, h('div', { class: 'note' }, 'Loading key…'));
    box.append(slot);
    bakedLegend(m).then((def) => {
      const rows = legendRows(def);
      slot.replaceChildren(rows || '');
      if (def && def.note && rows) slot.append(h('div', { class: 'note' }, def.note));
    });
  } else if (st.colorBy) {
    box.append(legendKey(pv));
  } else {
    const k = styleKey(pv);
    if (k) box.append(k);
  }
  return box;
}

function renderPreview() {
  const pv = state.preview;
  const body = $('#pv-body');
  body.innerHTML = '';
  if (!pv) return;
  const m = pv.meta;
  const group = (state.catalog.groups.find((g) => g.id === m.group) || {}).title || m.group || '';
  const tiles = [
    [m.feature_count != null && m.kind === 'vector' ? Number(m.feature_count).toLocaleString('en-IN') : '', kindLabel(m)],
    [m.date || '', 'date'], [group, 'group'],
  ].filter(([v]) => v !== '');
  const rows = [
    ['Source', m.source_name], ['Attribution', m.attribution],
    ['Zoom', m.minzoom != null ? `${m.minzoom} to ${m.maxzoom ?? ''}` : null],
  ].filter(([, v]) => v != null && v !== '');
  const dl = h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  if (m.source_url && /^https?:\/\//.test(m.source_url)) dl.append(h('dt', {}, 'Link'), h('dd', {}, h('a', { href: m.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Source page')));
  const fields = (m.fields || []).map((f) => f.name).filter(Boolean);
  if (fields.length) dl.append(h('dt', {}, 'Fields'), h('dd', {}, fields.join(', ')));
  const on = state.bench.some((e) => e.meta.id === m.id);
  // The default view is just the title with its actions right under it — Add first, so
  // the eye lands on it. Description, stats, source and fields sit behind "Details";
  // the style controls behind "Edit style". One of the two can be open at a time.
  const addBtn = h('button', { type: 'button', class: 'btn-primary pv-add-inline', id: 'pv-add' },
    on ? 'Update on workbench' : 'Add to workbench');
  addBtn.addEventListener('click', addPreviewToBench);
  const detailsBtn = h('button', { type: 'button', class: 'btn-edit' + (pv.showDetails ? ' active' : '') ,
    onclick: () => { pv.showDetails = !pv.showDetails; if (pv.showDetails) pv.editing = false; renderPreview(); } },
    pv.showDetails ? 'Hide details' : 'Details');
  const styleBtn = h('button', { type: 'button', class: 'btn-edit' + (pv.editing ? ' active' : ''),
    onclick: () => { pv.editing = !pv.editing; if (pv.editing) pv.showDetails = false; renderPreview(); } },
    pv.editing ? 'Hide style' : 'Edit style');
  // note: body.append(null) would literally print "null", so drop empties first
  body.append(...[
    h('div', { class: 'pv-title' }, swatch(m, pv.settings), h('h2', {}, m.title || m.id)),
    h('div', { class: 'pv-acts' }, addBtn, detailsBtn, styleBtn),
    pv.error ? h('div', { class: 'card-err', style: 'margin:10px 14px 0' }, pv.error) : null,
    pv.showDetails ? h('div', { class: 'pv-meta' }, m.description ? h('p', { class: 'pv-desc' }, m.description) : null,
      h('div', { class: 'tiles' }, tiles.map(([v, k]) => h('div', { class: 'tile' }, h('span', { class: 'tv', title: v }, v), h('span', { class: 'tk' }, k)))), dl) : null,
    pv.editing ? h('div', { class: 'pv-ctls' }, controls(pv)) : h('div', { class: 'pv-ctls' }, previewFacts(pv)),
  ].filter(Boolean));
  pv.el = body;
}

$('#pv-back').addEventListener('click', () => endPreview());
async function addPreviewToBench() {
  const pv = state.preview;
  if (!pv) return;
  const settings = { ...pv.settings };
  const id = pv.meta.id;
  const existing = state.bench.find((e) => e.meta.id === id);
  endPreview(false);
  if (existing) { existing.settings = settings; refreshClasses(existing); safeApply(existing); existing.open = true; }
  else await addToBench(id, settings);
  renderBench(); renderLibrary(); updateSources();
}

// ------------------------------------------------------------------ rails
// The columns float over the map, so the map's own centre sits behind them. Padding tells
// MapLibre where the usable viewport really is, which keeps the city centred in the open
// space and lets it drift back when a column collapses to a rail.
function mapPadding() {
  // phones: the columns are bottom sheets, so no left padding — just keep the
  // peek strip of an open sheet out of the usable viewport
  if (phone()) return { top: 0, right: 0, bottom: sheetBottomPad(), left: 0 };
  const mapBox = $('#map').getBoundingClientRect();
  if (!mapBox.width) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cols = [...document.querySelectorAll('.col')].filter((el) => el.offsetParent);
  const right = Math.max(0, ...cols.map((el) => el.getBoundingClientRect().right - mapBox.left));
  // always leave a usable strip of map, however wide the columns are
  const free = Math.max(320, mapBox.width * 0.35);
  const left = Math.min(right ? right + 16 : 0, Math.max(0, mapBox.width - free));
  return { top: 0, right: 0, bottom: 0, left: Math.round(left) };
}

function syncMapPadding(duration = 260) {
  if (!map || typeof map.easeTo !== 'function') return;
  const pad = mapPadding();
  // the breadcrumb hugs the same left edge the padding clears (columns + 12px)
  $('#map-wrap').style.setProperty('--crumb-left', (pad.left ? pad.left - 4 : 12) + 'px');
  swipe.layout();   // the divider stays right of the columns / above a phone sheet
  const cur = map.getPadding ? map.getPadding() : null;
  if (cur && Math.abs((cur.left || 0) - pad.left) < 2 && Math.abs((cur.bottom || 0) - pad.bottom) < 2) return;
  if (duration) map.easeTo({ padding: pad, duration });
  else map.setPadding(pad);
}
window.__syncMapPadding = syncMapPadding;

function setCol(col, rail) {
  const el = document.getElementById(col);
  el.classList.toggle('rail', rail);
  if (col === 'library') $('#app').classList.toggle('lib-rail', rail);
  // measure once the CSS width/left transition has settled, and again in case it ran long
  setTimeout(syncMapPadding, 240);
  setTimeout(syncMapPadding, 560);
}
document.querySelectorAll('.rail-toggle').forEach((b) => b.addEventListener('click', () => setCol(b.dataset.col, true)));
document.querySelectorAll('.rail-label').forEach((b) => b.addEventListener('click', () => setCol(b.dataset.col, false)));
window.addEventListener('resize', () => syncMapPadding(0));
initMobile({ setCol, syncMapPadding });

// ------------------------------------------------------------------ popup
let popup = null;
function closePopup() { if (popup) { popup.remove(); popup = null; } }
function interactiveLayers() {
  const entries = state.preview ? [state.preview] : state.bench.filter((e) => e.visible);
  return entries.flatMap((e) => (e.layerIds || []).filter((id) => /:(fill|line|circle|icon)$/.test(id) && map.getLayer(id)));
}
function entryByKey(key) { return state.preview && state.preview.key === key ? state.preview : state.bench.find((e) => e.key === key); }

map.on('click', (e) => {
  if (measure.active()) return;
  const layers = interactiveLayers();
  const box = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
  const feats = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
  closePopup();
  if (!feats.length) return;
  const f = feats[0];
  const entry = entryByKey(f.layer.metadata && f.layer.metadata.entry);
  if (!entry) return;
  const m = entry.meta;
  const group = (state.catalog.groups.find((g) => g.id === m.group) || {}).title || m.group || '';
  const order = (m.fields || []).map((x) => x.name);
  const keys = Object.keys(f.properties).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  const rows = keys.map((k) => {
    const v = f.properties[k];
    return `<tr><td class="k" title="${esc(k)}">${esc(k)}</td><td class="v">${v === null || v === '' ? '<span class="none">none</span>' : esc(v)}</td></tr>`;
  }).join('');
  const nameKey = keys.find((k) => /(^|_)(name|title)$/i.test(k) && f.properties[k]);
  const html = `<div class="pop"><div class="pop-head"><div class="pop-tag">${group ? esc(group) + ' · ' : ''}${esc(m.title || m.id)}</div>${nameKey ? `<div class="pop-title">${esc(f.properties[nameKey])}</div>` : ''}</div>
    <div class="pop-body">${rows ? `<table>${rows}</table>` : '<div class="pop-more">No attributes</div>'}</div></div>`;
  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '340px', offset: 8 })
    .setLngLat(e.lngLat).setHTML(html).addTo(map);
  popup.on('close', () => { popup = null; });
});
map.on('mousemove', (e) => {
  if (measure.active()) { map.getCanvas().style.cursor = 'crosshair'; return; }
  const layers = interactiveLayers();
  const hit = layers.length && map.queryRenderedFeatures([[e.point.x - 3, e.point.y - 3], [e.point.x + 3, e.point.y + 3]], { layers }).length;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

// ------------------------------------------------------------------ toolbar
const measure = initMeasure(map, { box: $('#measure-box'), val: $('#measure-val'), btn: $('#tb-measure'), onStart: closePopup });
$('#tb-zin').addEventListener('click', () => map.zoomIn());
$('#tb-zout').addEventListener('click', () => map.zoomOut());
$('#tb-home').addEventListener('click', () => home());

const bmBtn = $('#tb-basemap'), bmMenu = $('#bm-menu');
function renderBasemapMenu() {
  bmMenu.innerHTML = '';
  for (const [id, b] of Object.entries(BASEMAPS)) {
    bmMenu.append(h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(id === state.basemap), class: id === state.basemap ? 'on' : '',
      onclick: () => { state.basemap = id; setBasemap(map, id); swipe.refresh(); renderBasemapMenu(); updateSources(); toggleBm(false); } }, b.title));
  }
}
function toggleBm(open) { bmMenu.hidden = !open; bmBtn.setAttribute('aria-expanded', String(open)); }
bmBtn.addEventListener('click', (e) => { e.stopPropagation(); if (bmMenu.hidden && psPop && !psPop.hidden) togglePlaceSearch(false); toggleBm(bmMenu.hidden); });
document.addEventListener('click', (e) => { if (!bmMenu.hidden && !bmMenu.contains(e.target)) toggleBm(false); });

// ------------------------------------------------------------------ place search
// js/place-search.js (shared with the City Timeline and the Accessibility Atlas):
// the observatory's own areas from nav/areas.json first, then OpenStreetMap places
// from Photon. Photon gets the query text only. Not offered in ?embed=1.
let areasP = null;
const loadAreas = () => (areasP ||= fetch('nav/areas.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null));
let placeLocal = [];
function areaPlaces(a) {
  if (!a) return [];
  const corps = Array.isArray(a.corporations) ? a.corporations : [];
  const zones = Array.isArray(a.zones) ? a.zones : [];
  const out = [];
  for (const c of corps) out.push({ name: c.name, kind: 'Corporation', bbox: c.bounds });
  for (const z of zones) out.push({ name: z.name, kind: 'Zone', context: (corps[z.corp] || {}).name, bbox: z.bounds });
  for (const c of Array.isArray(a.circles) ? a.circles : []) out.push({ name: c.name, kind: 'Circle', context: (zones[c.zone] || {}).name, bbox: c.bounds });
  for (const w of Array.isArray(a.wards) ? a.wards : []) {
    const z = zones[w.zone];
    out.push({ name: w.name, kind: 'Ward' + (w.no != null ? ' ' + w.no : ''), context: z ? z.name + ' zone' : '', bbox: w.bounds });
  }
  return out;
}
const psBtn = $('#tb-search'), psPop = $('#ps-pop'), psInput = $('#ps-input');
const placeSearch = createPlaceSearch({
  input: psInput, results: $('#ps-results'), local: () => placeLocal, getMap: () => map,
  // on a phone the popover covers the map: close it once a place is picked
  onSelect: () => { closePopup(); if (phone()) togglePlaceSearch(false); },
});
function togglePlaceSearch(open) {
  psPop.hidden = !open;
  psBtn.setAttribute('aria-expanded', String(open));
  if (!open) { placeSearch.close(); return; }
  toggleBm(false);
  makeRoomForSearch();
  psInput.focus();
  psInput.select();
  if (!placeLocal.length) loadAreas().then((a) => { placeLocal = areaPlaces(a); placeSearch.refresh(); });
}
psBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlaceSearch(psPop.hidden); });
// Esc: place-search.js clears the marker and the list first; the popover closes with it
psInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { togglePlaceSearch(false); psBtn.focus(); } });
document.addEventListener('click', (e) => { if (!psPop.hidden && !psPop.contains(e.target) && !psBtn.contains(e.target)) togglePlaceSearch(false); });

// ------------------------------------------------------------------ sources
const srcBtn = $('#sources-btn'), srcPanel = $('#sources-panel');
srcBtn.addEventListener('click', () => { srcPanel.hidden = !srcPanel.hidden; srcBtn.setAttribute('aria-expanded', String(!srcPanel.hidden)); });
function updateSources() {
  const bm = BASEMAPS[state.basemap];
  const entries = [...(state.preview ? [state.preview] : []), ...state.bench.filter((e) => e.visible)];
  const items = entries.map((e) => {
    const m = e.meta;
    const bits = [m.attribution || m.source_name, m.date].filter(Boolean).join(', ');
    const link = m.source_url && /^https?:\/\//.test(m.source_url) ? ` <a href="${esc(m.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : '';
    return `<li><b>${esc(m.title || m.id)}</b>${esc(bits || 'Hyderabad Urban Observatory')}${link}</li>`;
  });
  if (bm && bm.attribution) items.push(`<li><b>Basemap: ${esc(bm.title)}</b>${esc(bm.attribution)}</li>`);
  if (!EMBED) items.push('<li><b>Place search</b>Photon by komoot, © OpenStreetMap contributors (only the typed text is sent)</li>');
  srcPanel.innerHTML = `<h3>Sources</h3><ul>${items.join('') || '<li>No layers on the map</li>'}</ul>`;
}

// ------------------------------------------------------------------ header
const aboutBtn = $('#btn-about'), aboutCard = $('#about-card');
aboutBtn.addEventListener('click', (e) => { e.stopPropagation(); aboutCard.hidden = !aboutCard.hidden; aboutBtn.setAttribute('aria-expanded', String(!aboutCard.hidden)); });
document.addEventListener('click', (e) => { if (!aboutCard.hidden && !aboutCard.contains(e.target)) { aboutCard.hidden = true; aboutBtn.setAttribute('aria-expanded', 'false'); } });
const home = () => map.easeTo({ ...START, pitch: 0, bearing: 0, duration: 700 });
$('#brandHome').addEventListener('click', home);

// ↻ Reset = back to the original first-visit page: default layers with default
// styles (folded), default basemap, cleared search, start view, clean URL, and
// the walkthrough tour again. ⌂ Home stays camera-only.
const defaultIds = () => state.catalog.layers.filter((l) => l.default_visible).map((l) => l.id);
function benchIsDefault() {
  const def = defaultIds().sort();
  const cur = state.bench.map((e) => e.meta.id).sort();
  return !state.preview && def.length === cur.length && def.every((d, i) => d === cur[i]) && state.bench.every((e) => !changed(e));
}
async function doReset() {
  swipe.stop(); endPreview(false); measure.stop();
  [...state.bench].forEach((e) => { try { removeEntry(map, e); } catch { /* ignore */ } });
  state.bench = []; state.query = ''; $('#lib-search').value = '';
  placeSearch.clear(); togglePlaceSearch(false);
  state.basemap = DEFAULT_BASEMAP; setBasemap(map, state.basemap); renderBasemapMenu();
  setCol('library', false); setCol('bench', false);
  for (const id of defaultIds()) await addToBench(id, null, { quiet: true });
  renderBench(); renderLibrary(); updateSources(); syncUrl(); home();
  import('./tour.js').then((m) => m.startTour(tourDeps())).catch((err) => console.warn('tour', err));
}
const resetBtn = $('#btn-reset'), resetCard = $('#reset-card');
function toggleResetCard(open) { resetCard.hidden = !open; resetBtn.setAttribute('aria-expanded', String(open)); }
resetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (benchIsDefault()) { toggleResetCard(false); doReset(); return; } // nothing to lose: no confirm
  toggleResetCard(resetCard.hidden);
});
$('#reset-confirm').addEventListener('click', () => { toggleResetCard(false); doReset(); });
$('#reset-cancel').addEventListener('click', () => toggleResetCard(false));
document.addEventListener('click', (e) => { if (!resetCard.hidden && !resetCard.contains(e.target)) toggleResetCard(false); });

// ------------------------------------------------------------------ url
function syncUrl() {
  const p = new URLSearchParams(location.search);
  const ids = state.bench.map((e) => e.meta.id);
  // the default first-visit bench keeps a clean URL (no ?layers=)
  const def = state.catalog.layers.filter((l) => l.default_visible).map((l) => l.id).sort();
  const sorted = [...ids].sort();
  const isDefault = def.length === sorted.length && def.every((d, i) => d === sorted[i]);
  if (ids.length && !isDefault) p.set('layers', ids.join(',')); else p.delete('layers');
  const qs = p.toString().replace(/%2C/g, ',');
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
}

// ------------------------------------------------------------------ boot
function status(t) { $('#status').textContent = t || ''; }

async function boot() {
  try { await loadCatalog(); }
  catch (err) { status('Could not load the layer list'); console.warn(err); }
  const failed = (state.catalog.failed || []).length;
  status(`${displayable().length} layers`);
  renderLibrary(); renderBench(); renderBasemapMenu();
  await mapLoaded;
  setBasemap(map, state.basemap);
  let want = (params.get('layers') || '').split(',').map((x) => x.trim()).filter((x) => state.byId.has(x));
  // a fresh visit (no ?layers=) starts with the catalog's default layers on the bench
  if (!want.length && !params.has('layers')) want = state.catalog.layers.filter((l) => l.default_visible).map((l) => l.id);
  // preload in reverse so the URL order is kept (first id on top)
  for (const id of [...want].reverse()) {
    await addToBench(id, null, { quiet: true });
    const i = state.bench.findIndex((e) => e.meta.id === id);
    if (i > 0) { const [e] = state.bench.splice(i, 1); state.bench.unshift(e); }
  }
  applyOrder(); renderBench(); syncUrl();
  if (EMBED) setCol('bench', true);
  updateSources();
  syncMapPadding(0);   // centre the map in the space the columns leave
  // the breadcrumb loads lazily on first idle; ?embed=1 never shows it
  if (!EMBED) map.once('idle', () => {
    import('./breadcrumb.js').then((m) => m.initBreadcrumb(map, { fitTo, loadAreas })).catch((err) => console.warn('breadcrumb', err));
  });
  initHeightHover(map, state);
  document.body.dataset.ready = '1';
  initTourTriggers();
}
boot();

// ------------------------------------------------------------------ tour
// Lazy-loaded guided walkthrough (js/tour.js). Starts on every fresh page load
// and refresh (skippable; never in ?embed=1 — shared ?layers= links do show
// it), and any time from the ? button in the top bar. Skip/Esc/clicking the
// dim closes it for that page view only. The headless check sets
// window.__NO_TOUR (before page scripts run) to keep it out of other flows.
const tourDeps = () => ({ state, startPreview, endPreview, renderBench, setCol });
function initTourTriggers() {
  const btn = $('#btn-tour');
  if (btn) btn.addEventListener('click', () => import('./tour.js').then((m) => m.startTour(tourDeps())).catch((err) => console.warn('tour', err)));
  if (EMBED || window.__NO_TOUR) return;
  setTimeout(() => {
    if (window.__NO_TOUR) return;
    import('./tour.js').then((m) => m.startTour(tourDeps(), { auto: true })).catch((err) => console.warn('tour', err));
  }, 1000);
}

// expose a tiny API for the headless check
window.__viewer = { state, addToBench, startPreview, endPreview, removeFromBench, renderBench, refreshClasses, safeApply, placeSearch };
