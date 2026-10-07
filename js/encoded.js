// Encoded data companions. Two published layers carry pixel-encoded data twins
// (display: false in layers.json, so they never appear in the library):
//
//   builtup_first_year    -> builtup_first_year_encoded     (R>=5 -> year = R+1980; A=0 never built)
//   buildings_height_2023 -> buildings_height_2023_encoded  (height_dm = R*256+G; A=0 no building)
//
// This module is the one place that fetches and decodes those PNG tiles: an LRU
// cache of decoded ImageData keyed by layer/z/x/y, a pixel sampler for the hover
// readout, and the "yearfilter" MapLibre protocol that recolours built-up tiles
// for the year slider without ever refetching from the network.
import { tileUrl } from './layers.js';

// display layer id -> encoded companion id (both must be in layers.json)
export const COMPANIONS = {
  builtup_first_year: 'builtup_first_year_encoded',
  buildings_height_2023: 'buildings_height_2023_encoded',
};

// ------------------------------------------------------------ decoded-tile LRU
const MAX_TILES = 100;
const cache = new Map(); // key -> Promise<ImageData|null>

function lruGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key); cache.set(key, v); // refresh recency
  return v;
}
function lruSet(key, v) {
  cache.set(key, v);
  while (cache.size > MAX_TILES) cache.delete(cache.keys().next().value);
}

async function decodeBlob(blob, size) {
  try {
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    return cx.getImageData(0, 0, cv.width, cv.height);
  } catch {
    // fallback: Image + regular canvas (older engines without OffscreenCanvas)
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth || size; cv.height = img.naturalHeight || size;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, cv.width, cv.height);
    } finally { URL.revokeObjectURL(url); }
  }
}

// Decoded ImageData for one encoded tile; null when the tile doesn't exist.
// meta is the companion's layers.json entry (tile_url + version give the URL).
export function getTileData(meta, z, x, y) {
  const key = `${meta.id}/${z}/${x}/${y}`;
  const hit = lruGet(key);
  if (hit) return hit;
  const url = tileUrl(meta, {}).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const pr = fetch(url)
    .then(async (r) => {
      if (!r.ok || r.status === 204) return null;
      const blob = await r.blob();
      if (!blob.size) return null;
      return decodeBlob(blob, Number(meta.tile_size) || 512);
    })
    .catch(() => null);
  lruSet(key, pr);
  return pr;
}

// ---------------------------------------------------------------- pixel sampling
// Which tile + pixel covers a lng/lat at a given tile zoom. The tiles are 512 px
// on the standard 256 grid (tile_size 512), so pixel coords scale by tile_size.
export function tileAt(meta, lng, lat, mapZoom) {
  const ts = Number(meta.tile_size) || 512;
  // a 512px tile at tile-zoom z is what the map shows around zoom z+1
  const zRaw = Math.floor(mapZoom) - (ts === 512 ? 1 : 0);
  const z = Math.max(Number(meta.minzoom) || 0, Math.min(Number(meta.maxzoom) || 22, zRaw));
  const n = Math.pow(2, z);
  const xf = ((lng + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const yf = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  if (yf < 0 || yf >= n) return null;
  const x = Math.floor(xf), y = Math.floor(yf);
  return { z, x, y, px: Math.min(ts - 1, Math.floor((xf - x) * ts)), py: Math.min(ts - 1, Math.floor((yf - y) * ts)), ts };
}

// RGBA at a lng/lat, from the companion's tile nearest the current map zoom.
// Returns { r, g, b, a } or null (no tile / outside coverage).
export async function samplePixel(meta, lng, lat, mapZoom) {
  const t = tileAt(meta, lng, lat, mapZoom);
  if (!t) return null;
  const img = await getTileData(meta, t.z, t.x, t.y);
  if (!img) return null;
  const i = (t.py * img.width + t.px) * 4;
  const d = img.data;
  return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
}

// -------------------------------------------------------------- yearfilter protocol
// yearfilter://<companionId>/<lo>-<hi>/<palette>/<z>/<x>/<y>  ->  a PNG where every
// cell whose first built-up year is within [lo, hi] is painted that year's ramp
// colour, everything else transparent. Tiles are decoded once (LRU above); a range
// or palette change only re-colours, it never refetches (the palette is part of
// the tile URL so MapLibre's own tile cache stays coherent).
//
// Defensive decode: A=0 never built; R>=5 -> year = R+1980; 0<R<5 should not occur
// any more (the old R==1 class) and is treated as 2015.
const legendLuts = new Map(); // companionId -> Uint8Array(39*3) from the baked legend
const metas = new Map();      // companionId -> layers.json entry

// Built-in ramps (anchor stops, low year -> high year). 'viridis' doubles as the
// fallback when the baked legend is unreachable; 'cividis' is the
// colour-blind-safe alternative.
export const PALETTES = {
  viridis: { title: 'Viridis', stops: ['#440154', '#482576', '#414487', '#35608d', '#2a788e', '#21918c', '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'] },
  magma: { title: 'Magma', stops: ['#000004', '#1d1147', '#51127c', '#822681', '#b73779', '#e75263', '#fc8961', '#fec488', '#fcfdbf'] },
  warm: { title: 'Warm (yellow-red)', stops: ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026', '#64003c'] },
  cool: { title: 'Cool (blue-purple)', stops: ['#deebf7', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#54278f', '#3f007d'] },
  cividis: { title: 'Cividis (colour-blind safe)', stops: ['#00204d', '#00336f', '#39486b', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#e4cf5b', '#ffea46'] },
};
function hex(c) { const h = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lutFromStops(stops) {
  const lut = new Uint8Array(39 * 3);
  for (let i = 0; i < 39; i++) {
    const p = (i / 38) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(p)), f = p - j;
    const a = hex(stops[j]), b = hex(stops[j + 1]);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = Math.round(a[k] + (b[k] - a[k]) * f);
  }
  return lut;
}
const builtinLuts = new Map(); // palette name -> LUT (shared across layers)
function builtinLut(name) {
  if (!builtinLuts.has(name)) builtinLuts.set(name, lutFromStops((PALETTES[name] || PALETTES.viridis).stops));
  return builtinLuts.get(name);
}
function lutFor(companionId, palette) {
  if (!palette || palette === 'viridis') return legendLuts.get(companionId) || builtinLut('viridis');
  return builtinLut(PALETTES[palette] ? palette : 'viridis');
}

// Register a companion for the protocol. legendDef is the display layer's baked
// legend (stops: [{year, color}]); its colours become the 'viridis' default LUT.
export function registerYearLayer(companionMeta, legendDef) {
  metas.set(companionMeta.id, companionMeta);
  const stops = legendDef && Array.isArray(legendDef.stops) ? legendDef.stops.filter((s) => s && s.year && s.color) : [];
  if (stops.length) {
    const lut = lutFromStops(PALETTES.viridis.stops); // fill gaps (no 2016 stop)
    for (const s of stops) {
      const i = s.year - 1985;
      if (i >= 0 && i < 39) { const [r, g, b] = hex(s.color); lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b; }
    }
    legendLuts.set(companionMeta.id, lut);
  }
}
export const yearColor = (companionId, year, palette) => {
  const lut = lutFor(companionId, palette);
  const i = Math.max(0, Math.min(38, year - 1985)) * 3;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
};
// CSS gradient for a companion's ramp in the given palette (39 sampled steps
// would be overkill; 11 reads identically)
export function rampGradient(companionId, palette) {
  const cols = [];
  for (let i = 0; i <= 10; i++) cols.push(yearColor(companionId, 1985 + Math.round(i * 3.8), palette));
  return `linear-gradient(90deg,${cols.join(',')})`;
}

const TRANSPARENT_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)).buffer;

let protocolOn = false;
export function ensureProtocol() {
  if (protocolOn) return;
  protocolOn = true;
  window.__yearfilterTiles = 0; // the headless check counts recoloured tiles here
  maplibregl.addProtocol('yearfilter', async (params) => {
    const m = /^yearfilter:\/\/([^/]+)\/(\d{4})-(\d{4})\/(\w+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error('bad yearfilter url: ' + params.url);
    const [, id, loS, hiS, pal, z, x, y] = m;
    const meta = metas.get(id);
    const lut = lutFor(id, pal);
    const lo = Number(loS), hi = Number(hiS);
    const img = meta ? await getTileData(meta, z, x, y) : null;
    if (!img) return { data: TRANSPARENT_PNG };
    const out = new ImageData(img.width, img.height);
    const s = img.data, d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i + 3] === 0) continue;               // never built
      const r = s[i];
      const yr = r >= 5 ? r + 1980 : 2015;        // defensive: stray low codes read as 2015
      if (yr < lo || yr > hi) continue;
      const li = Math.max(0, Math.min(38, yr - 1985)) * 3;
      d[i] = lut[li]; d[i + 1] = lut[li + 1]; d[i + 2] = lut[li + 2]; d[i + 3] = 255;
    }
    const cv = new OffscreenCanvas(out.width, out.height);
    cv.getContext('2d').putImageData(out, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    window.__yearfilterTiles++;
    return { data: await blob.arrayBuffer() };
  });
}

// exposed for the headless check
window.__encoded = { getTileData, samplePixel, tileAt, COMPANIONS };
