// Map-side builders: turn a layers.json entry + user settings into MapLibre
// sources and layers. Every function is defensive; callers wrap in try/catch.
import { ensureIcon } from './icons.js';
import { dataUrl } from './config.js';

export const CAT_COLORS = ['#1F77B4', '#D95F02', '#2E7D32', '#B3261E', '#6A3D9A', '#8C564B', '#D4A017', '#17A5A5', '#E377C2', '#4D4D4D'];
export const OTHER_COLOR = '#B8B3A6';
export const SEQ_COLORS = ['#FFF3C4', '#F6C065', '#E27D3A', '#B3401E', '#5E1A0F'];

export const KIND_RANK = { point: 0, line: 1, polygon: 2, raster: 3, terrain: 4 };
export function geomKind(meta) {
  if (meta.kind === 'raster' || meta.kind === 'terrain') return meta.kind;
  return meta.geom === 'point' || meta.geom === 'line' ? meta.geom : 'polygon';
}
export function kindLabel(meta) {
  return { point: 'points', line: 'lines', polygon: 'areas', raster: 'image', terrain: 'terrain' }[geomKind(meta)];
}
export function isNumericType(t) { return /^(number|int|integer|real|float|double|numeric|decimal)/i.test(t || ''); }

const s = (m) => m.style || {};
export function defaultSettings(meta) {
  const k = geomKind(meta);
  if (k === 'raster') return { opacity: 1, brightness: 0, contrast: 0, palette: '' };
  if (k === 'terrain') return { opacity: 1, intensity: 0.5, exaggeration: 1.5, threeD: false };
  const st = s(meta);
  const color = st.color || st.fill || '#1F4E79';
  const pal = st.palette && st.palette.field ? st.palette.field : '';
  return {
    opacity: 1,
    color,
    lineWidth: Number(st.line_width) || (k === 'line' ? 1.5 : 1),
    fillOn: k === 'polygon' ? (st.fill_opacity ?? 0.3) > 0 : false,
    fillOpacity: st.fill_opacity ?? 0.3,
    colorBy: pal,
    labelField: '',
  };
}

// Absolute tile URL template for raster / terrain / encoded layers. layers.json
// carries it absolute (the tiles Worker, see js/config.js); a relative one is
// resolved against DATA_BASE. Nothing is appended: the release is the version.
export function tileUrl(meta) {
  const u = meta.tile_url;
  if (!u) throw new Error('no tile_url');
  // URL resolution percent-encodes the {z}/{x}/{y} placeholders: restore them
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : dataUrl(u).replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}
// Vector layers are PMTiles archives read over range requests through the
// pmtiles:// protocol (vendor/pmtiles.js, registered once in main.js).
export function pmtilesUrl(meta) {
  if (!meta.pmtiles_url) throw new Error('no pmtiles_url');
  return 'pmtiles://' + dataUrl(meta.pmtiles_url);
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function validBounds(b) { return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3]; }

// Build the colour expression for "colour by" (returns null if not applicable)
export function colorExpr(entry) {
  const cs = entry.classes;
  const f = entry.settings.colorBy;
  if (!f || !cs) return null;
  if (cs.type === 'cat') {
    if (!cs.items.length) return null;
    const m = ['match', ['to-string', ['get', f]]];
    for (const it of cs.items) m.push(String(it.value), it.color);
    m.push(OTHER_COLOR);
    return m;
  }
  if (cs.type === 'num' && cs.breaks.length) {
    const st = ['step', ['to-number', ['get', f], 0], cs.colors[0]];
    cs.breaks.forEach((b, i) => st.push(b, cs.colors[i + 1]));
    return ['case', ['==', ['get', f], null], OTHER_COLOR, st];
  }
  return null;
}

// Compute classes for a "colour by" field. Uses style.palette if it covers the
// field, otherwise values seen in loaded tiles.
export function computeClasses(map, entry) {
  const meta = entry.meta, f = entry.settings.colorBy;
  if (!f) return null;
  const fld = (meta.fields || []).find((x) => x.name === f) || { name: f };
  const pal = s(meta).palette;
  if (pal && pal.field === f && pal.values && Object.keys(pal.values).length) {
    return { type: 'cat', palette: true, items: Object.entries(pal.values).map(([value, color]) => ({ value, color })), other: true };
  }
  let feats = [];
  try { feats = map.querySourceFeatures(entry.srcId, meta.source_layer ? { sourceLayer: meta.source_layer } : {}); } catch { /* ignore */ }
  const vals = feats.map((ft) => ft.properties[f]).filter((v) => v !== null && v !== undefined && v !== '');
  const numeric = isNumericType(fld.type) || (vals.length && vals.every((v) => typeof v === 'number'));
  if (!vals.length) return { type: numeric ? 'num' : 'cat', items: [], breaks: [], colors: SEQ_COLORS, empty: true };
  if (numeric) {
    const xs = vals.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    const breaks = [...new Set([q(0.2), q(0.4), q(0.6), q(0.8)])].filter((b) => b > xs[0]);
    return { type: 'num', breaks, colors: SEQ_COLORS.slice(0, breaks.length + 1), min: xs[0], max: xs[xs.length - 1] };
  }
  const counts = new Map();
  for (const v of vals) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, CAT_COLORS.length).map(([v]) => v).sort();
  return { type: 'cat', items: top.map((value, i) => ({ value, color: CAT_COLORS[i] })), other: counts.size > top.length };
}

// Add source + layers for an entry. entry.key is unique per map instance
// (bench: "b:<id>", preview: "p:<id>"). Returns the created layer ids.
export async function buildEntry(map, entry) {
  const meta = entry.meta, k = geomKind(meta), key = entry.key;
  const srcId = entry.srcId = 'src-' + key;
  const ids = [];
  const md = { entry: key };
  // rasters: a tile template; vectors: the PMTiles archive (MapLibre reads its
  // TileJSON through the protocol, which then wins over these inline values)
  const src = k === 'raster' || k === 'terrain' ? { tiles: [tileUrl(meta)] } : { url: pmtilesUrl(meta) };
  const minz = num(meta.minzoom, 0), maxz = num(meta.maxzoom, 14);
  src.minzoom = minz; src.maxzoom = maxz;
  if (validBounds(meta.bounds)) src.bounds = meta.bounds;
  if (meta.attribution) src.attribution = meta.attribution;

  if (k === 'raster') {
    map.addSource(srcId, { type: 'raster', tileSize: num(meta.tile_size, 256), ...src });
    map.addLayer({ id: key + ':raster', type: 'raster', source: srcId, metadata: md, paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });
    ids.push(key + ':raster');
  } else if (k === 'terrain') {
    const demSrc = { type: 'raster-dem', encoding: meta.encoding || 'terrarium', tileSize: num(meta.tile_size, 256), ...src };
    map.addSource(srcId, demSrc);
    map.addSource(srcId + '-3d', demSrc);
    map.addLayer({ id: key + ':hillshade', type: 'hillshade', source: srcId, metadata: md,
      paint: { 'hillshade-shadow-color': '#3A3527', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#5A5343' } });
    ids.push(key + ':hillshade');
  } else {
    map.addSource(srcId, { type: 'vector', ...src });
    const sl = meta.source_layer || meta.id;
    const base = { source: srcId, 'source-layer': sl, metadata: md };
    if (k === 'polygon') {
      map.addLayer({ id: key + ':fill', type: 'fill', ...base, paint: {} });
      map.addLayer({ id: key + ':line', type: 'line', ...base, paint: {}, layout: { 'line-join': 'round' } });
      ids.push(key + ':fill', key + ':line');
    } else if (k === 'line') {
      map.addLayer({ id: key + ':line', type: 'line', ...base, paint: {}, layout: { 'line-join': 'round', 'line-cap': 'round' } });
      ids.push(key + ':line');
    } else {
      const icon = s(meta).icon ? await ensureIcon(map, s(meta).icon).catch(() => null) : null;
      entry.icon = icon;
      map.addLayer({ id: key + ':circle', type: 'circle', ...base, paint: { 'circle-stroke-color': '#FFFFFF', 'circle-pitch-alignment': 'map' } });
      ids.push(key + ':circle');
      if (icon) {
        map.addLayer({ id: key + ':icon', type: 'symbol', ...base, layout: { 'icon-image': icon, 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 14, 0.7], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
          paint: { 'icon-color': '#FFFFFF' } });
        ids.push(key + ':icon');
      }
    }
    map.addLayer({ id: key + ':label', type: 'symbol', ...base,
      layout: { 'text-field': '', 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-width': 10,
        'text-offset': k === 'point' ? [0, 1.1] : [0, 0], 'text-anchor': k === 'point' ? 'top' : 'center',
        'symbol-placement': k === 'line' ? 'line' : 'point', visibility: 'none' },
      paint: { 'text-color': '#111111', 'text-halo-color': '#F4F1E8', 'text-halo-width': 1.4 } });
    ids.push(key + ':label');
  }
  entry.layerIds = ids;
  applySettings(map, entry);
  return ids;
}

export function removeEntry(map, entry) {
  for (const id of entry.layerIds || []) if (map.getLayer(id)) map.removeLayer(id);
  if (entry.threeDOn) { map.setTerrain(null); entry.threeDOn = false; }
  for (const id of [entry.srcId, entry.srcId + '-3d', entry.srcId + '-year']) if (id && map.getSource(id)) map.removeSource(id);
  entry.layerIds = [];
}

const setP = (map, id, p, v) => { if (map.getLayer(id)) map.setPaintProperty(id, p, v); };
const setL = (map, id, p, v) => { if (map.getLayer(id)) map.setLayoutProperty(id, p, v); };

export function applySettings(map, entry) {
  const meta = entry.meta, k = geomKind(meta), key = entry.key, st = entry.settings;
  const vis = entry.visible && !entry.suspended ? 'visible' : 'none';
  for (const id of entry.layerIds || []) if (!id.endsWith(':label')) setL(map, id, 'visibility', vis);
  const o = st.opacity;
  if (k === 'raster') {
    const b = st.brightness;
    setP(map, key + ':raster', 'raster-opacity', o);
    setP(map, key + ':raster', 'raster-brightness-min', Math.max(0, b));
    setP(map, key + ':raster', 'raster-brightness-max', Math.min(1, 1 + b));
    setP(map, key + ':raster', 'raster-contrast', st.contrast);
    return;
  }
  if (k === 'terrain') {
    setP(map, key + ':hillshade', 'hillshade-exaggeration', Math.min(1, st.intensity * o));
    const want3d = st.threeD && vis === 'visible';
    if (want3d) { map.setTerrain({ source: entry.srcId + '-3d', exaggeration: st.exaggeration }); entry.threeDOn = true; }
    else if (entry.threeDOn) { map.setTerrain(null); entry.threeDOn = false; }
    return;
  }
  const ce = colorExpr(entry) || st.color;
  if (k === 'polygon') {
    setP(map, key + ':fill', 'fill-color', ce);
    setP(map, key + ':fill', 'fill-opacity', st.fillOn ? st.fillOpacity * o : 0);
    // a baked palette colours the outline per category too; a user "colour by"
    // over a fill keeps the base outline colour so classes stay readable
    setP(map, key + ':line', 'line-color', st.fillOn && entry.classes && !entry.classes.palette ? st.color : ce);
    setP(map, key + ':line', 'line-width', st.lineWidth);
    setP(map, key + ':line', 'line-opacity', o);
  } else if (k === 'line') {
    setP(map, key + ':line', 'line-color', ce);
    setP(map, key + ':line', 'line-width', ['interpolate', ['linear'], ['zoom'], 9, st.lineWidth * 0.7, 16, st.lineWidth * 1.8]);
    setP(map, key + ':line', 'line-opacity', o);
  } else {
    const r = entry.icon ? 8 : 4 + st.lineWidth;
    setP(map, key + ':circle', 'circle-color', ce);
    setP(map, key + ':circle', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 9, r * 0.6, 14, r, 18, r * 1.4]);
    setP(map, key + ':circle', 'circle-stroke-width', entry.icon ? 1 : 1);
    setP(map, key + ':circle', 'circle-opacity', o);
    setP(map, key + ':circle', 'circle-stroke-opacity', o);
    setP(map, key + ':icon', 'icon-opacity', o);
  }
  const lf = st.labelField;
  setL(map, key + ':label', 'text-field', lf ? ['to-string', ['get', lf]] : '');
  setL(map, key + ':label', 'visibility', lf && vis === 'visible' ? 'visible' : 'none');
  setP(map, key + ':label', 'text-opacity', o);
}
