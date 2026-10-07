// place-search.js: one place search for the observatory's map apps.
//
// THREE IDENTICAL COPIES. Edit one, copy it over the other two, then run
//   bash "spatial data repository/tools/check-place-search.sh"
// which fails if they differ:
//   spatial data repository/js/place-search.js        (maps viewer)
//   city timeline/place-search.js                      (City Timeline)
//   accessibility atlas/frontend/js/place-search.js    (Accessibility Atlas)
//
// What it does, the same in every app:
//   - local matches first, from a list the host app already has
//     ([{ name, kind, context?, bbox?|center? }]: wards, zones, heritage...);
//   - then OpenStreetMap places from the public Photon geocoder
//     (https://photon.komoot.io, built for search-as-you-type): from 3 characters,
//     300 ms after the last keystroke, the previous request aborted, bounded to
//     the HMDA extent (results outside it are dropped), 6 results, English names;
//   - Photon gets the query text only: no map position, no referrer, no cookies;
//   - if Photon errors or takes over 5 s, the local matches stay and a quiet
//     "Place search unavailable" line shows. Nothing here throws;
//   - keyboard: Up / Down / Enter / Esc; mouse and touch select;
//   - selecting fits the map to the place's extent, or flies to its point at
//     zoom 15, and drops a small marker (cleared by the next search or Esc).
//
// The module renders plain elements with ps-* class names; each app styles them
// with its own tokens. Plain ES module, no dependencies; MapLibre comes from the
// page (window.maplibregl).

export const HMDA_BBOX = [78.00, 16.96, 79.05, 17.90];   // W, S, E, N
export const PHOTON_API = 'https://photon.komoot.io/api/';
export const PHOTON_CREDIT = 'Search by Photon · © OpenStreetMap contributors';
export const UNAVAILABLE = 'Place search unavailable';

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;
const TIMEOUT_MS = 5000;
const LIMIT = 6;
const MAX_LOCAL = 5;
const POINT_ZOOM = 15;
const FIT_MAX_ZOOM = 16;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const inHmda = (x, y) => x >= HMDA_BBOX[0] && x <= HMDA_BBOX[2] && y >= HMDA_BBOX[1] && y <= HMDA_BBOX[3];
const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] >= b[0] && b[3] >= b[1];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ local
// A host item -> the shape used here: { name, kind, context, bbox, center, source }
function toPlace(it) {
  if (!it || !it.name) return null;
  const bbox = validBox(it.bbox) ? it.bbox : validBox(it.bounds) ? it.bounds : null;
  const center = Array.isArray(it.center) && it.center.length === 2 && it.center.every(Number.isFinite) ? it.center
    : bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null;
  if (!center) return null;
  return { name: String(it.name), kind: it.kind ? String(it.kind) : '', context: it.context ? String(it.context) : '',
    bbox, center, source: 'local' };
}

// Rank: exact name, name starts with the query, a word starts with it, name
// contains it. Ties: shorter name first. Only when no name matches, rows whose
// context contains the query (e.g. the wards of a zone).
export function matchLocal(list, q) {
  const t = norm(q);
  if (!t) return [];
  const out = [];
  for (const it of list || []) {
    const n = norm(it && it.name);
    if (!n) continue;
    let s;
    if (n === t) s = 0;
    else if (n.startsWith(t)) s = 1;
    else if ((' ' + n).includes(' ' + t)) s = 2;
    else if (n.includes(t)) s = 3;
    else if (norm(it.context).includes(t)) s = 4;
    else continue;
    const p = toPlace(it);
    if (p) out.push([s, n.length, p]);
  }
  const named = out.filter((x) => x[0] < 4);
  const use = named.length ? named : out;
  use.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return use.slice(0, MAX_LOCAL).map((x) => x[2]);
}

// ------------------------------------------------------------------ Photon
function kindOf(p) {
  const k = String(p.osm_key || ''), v = String(p.osm_value || '');
  if (k === 'railway' || (k === 'public_transport' && /station|stop|platform/.test(v))) return 'Station';
  if (k === 'highway') return v === 'bus_stop' ? 'Bus stop' : 'Road';
  if (k === 'place') {
    return ({ city: 'City', town: 'Town', village: 'Village', hamlet: 'Village', suburb: 'Locality', quarter: 'Locality',
      neighbourhood: 'Locality', locality: 'Locality', isolated_dwelling: 'Place' })[v] || 'Place';
  }
  if (k === 'boundary') return 'Area';
  if (k === 'waterway' || k === 'water' || (k === 'natural' && v === 'water')) return 'Water';
  if (!v || v === 'yes') return k ? cap(k.replace(/_/g, ' ')) : 'Place';
  return cap(v.replace(/_/g, ' '));
}

function contextOf(p, name) {
  const parts = [];
  for (const x of [p.locality || p.suburb, p.district, p.city || p.county]) {
    const t = x == null ? '' : String(x).trim();
    if (t && t !== name && !parts.includes(t)) parts.push(t);
  }
  return parts.slice(0, 2).join(', ');
}

function parsePhoton(d) {
  const out = [], seen = new Set();
  for (const f of (d && Array.isArray(d.features) ? d.features : [])) {
    const p = (f && f.properties) || {};
    const c = f && f.geometry && f.geometry.coordinates;
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
    if (!name || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !inHmda(c[0], c[1])) continue;
    const kind = kindOf(p);
    const key = norm(name) + '|' + kind + '|' + c[0].toFixed(3) + ',' + c[1].toFixed(3);
    if (seen.has(key)) continue;   // the same stop mapped twice, a few metres apart
    seen.add(key);
    let bbox = null;
    if (Array.isArray(p.extent) && p.extent.length === 4) {
      const [w, n, e, s] = p.extent.map(Number);   // Photon: [minLon, maxLat, maxLon, minLat]
      if ([w, n, e, s].every(Number.isFinite) && e > w && n > s) {
        const b = [Math.max(w, HMDA_BBOX[0]), Math.max(s, HMDA_BBOX[1]), Math.min(e, HMDA_BBOX[2]), Math.min(n, HMDA_BBOX[3])];
        if (b[2] > b[0] && b[3] > b[1]) bbox = b;
      }
    }
    out.push({ name: String(name), kind, context: contextOf(p, name), bbox, center: [c[0], c[1]], source: 'osm' });
  }
  return out;
}

// Ask Photon. Never throws: resolves { items, error } or { items: [], aborted: true }
// when the caller's signal aborted it (a newer keystroke).
export async function searchPhoton(q, { signal } = {}) {
  const text = String(q || '').trim();
  if (text.length < MIN_CHARS) return { items: [], error: false };
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const url = PHOTON_API + '?q=' + encodeURIComponent(text) + '&bbox=' + HMDA_BBOX.map((n) => n.toFixed(2)).join(',')
      + '&limit=' + LIMIT + '&lang=en';
    const r = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
    if (!r.ok) return { items: [], error: true };
    return { items: parsePhoton(await r.json()), error: false };
  } catch {
    if (signal && signal.aborted && !timedOut) return { items: [], aborted: true };
    return { items: [], error: true };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ------------------------------------------------------------------ map
// The default marker: one small dot on one map. Hosts that mark several maps
// (the timeline's windows) pass their own { set(lngLat), clear() }.
let pin = null;
export const defaultMarker = {
  set(map, lngLat) {
    this.clear();
    const ml = typeof window !== 'undefined' && window.maplibregl;
    if (!ml || !map) return;
    try {
      const el = document.createElement('div');
      el.className = 'ps-marker';
      el.setAttribute('aria-hidden', 'true');
      pin = new ml.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    } catch { pin = null; }
  },
  clear() { if (pin) { try { pin.remove(); } catch { /* ignore */ } pin = null; } },
};
export function clearPlaceMarker(marker = defaultMarker) { try { marker.clear(); } catch { /* ignore */ } }

// Move the map to a place: fit its extent when it has a real one, else fly to
// its point at zoom 15. Then drop the marker.
export function goToPlace(map, place, { padding = 40, marker = defaultMarker } = {}) {
  if (!map || !place) return;
  const p = place.source ? place : toPlace(place);
  if (!p) return;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduce ? 0 : 1200;
  const b = p.bbox;
  let moved = false;
  if (b && (b[2] - b[0] > 0.002 || b[3] - b[1] > 0.002)) {
    try {
      const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: FIT_MAX_ZOOM });
      if (cam) { map.flyTo({ ...cam, bearing: map.getBearing(), duration }); moved = true; }
    } catch { moved = false; }
  }
  if (!moved) {
    try { map.flyTo({ center: p.center, zoom: POINT_ZOOM, duration }); } catch { /* ignore */ }
  }
  try { marker.set(map, p.center); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ combobox
let uid = 0;

// opts:
//   input      the host's <input>; becomes the combobox
//   results    the host's container; receives the listbox, a status line and the credit
//   local      array, or a function returning the current array, of { name, kind, context?, bbox?|center? }
//   getMap     () => the map to move
//   padding    number/object, or a function returning one, for fitting extents
//   marker     { set(map, lngLat), clear() } (default: one dot on getMap())
//   onSelect   (place) => void, after the map moves
//   onToggle   (open) => void; default toggles results.hidden
//   inline     true: results sit in a panel, not a popover (no close on outside
//              click; the chosen row stays marked)
export function createPlaceSearch(opts) {
  const { input, results } = opts;
  if (!input || !results) return null;
  const id = 'ps' + (++uid);
  const marker = opts.marker || defaultMarker;
  const inline = !!opts.inline;
  const localList = () => { try { return (typeof opts.local === 'function' ? opts.local() : opts.local) || []; } catch { return []; } };
  const mapOf = () => { try { return opts.getMap ? opts.getMap() : null; } catch { return null; } };

  const list = document.createElement('ul');
  list.className = 'ps-list';
  list.id = id + '-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Places');
  const status = document.createElement('p');
  status.className = 'ps-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const credit = document.createElement('p');
  credit.className = 'ps-credit';
  credit.textContent = PHOTON_CREDIT;
  results.replaceChildren(list, status, credit);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  let items = [], active = -1, open = null, timer = null, ctl = null, seq = 0, chosen = null, asked = false, state = '';

  function setOpen(v) {
    if (open === v) return;
    open = v;
    input.setAttribute('aria-expanded', String(v));
    if (!v) input.removeAttribute('aria-activedescendant');
    try { if (opts.onToggle) opts.onToggle(v); else results.hidden = !v; } catch { /* ignore */ }
  }

  function setActive(i) {
    active = items.length ? Math.max(-1, Math.min(items.length - 1, i)) : -1;
    [...list.children].forEach((li, j) => {
      const on = j === active;
      li.classList.toggle('ps-active', on);
      li.setAttribute('aria-selected', String(on));
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', id + '-o' + active);
    else input.removeAttribute('aria-activedescendant');
  }

  function option(p, i) {
    const li = document.createElement('li');
    li.id = id + '-o' + i;
    li.className = 'ps-item ps-' + p.source + (chosen && chosen === p ? ' ps-chosen' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const txt = document.createElement('span');
    txt.className = 'ps-text';
    const nm = document.createElement('span');
    nm.className = 'ps-name';
    nm.textContent = p.name;
    txt.append(nm);
    if (p.context) {
      const cx = document.createElement('span');
      cx.className = 'ps-ctx';
      cx.textContent = p.context;
      txt.append(cx);
    }
    li.append(txt);
    if (p.kind) {
      const k = document.createElement('span');
      k.className = 'ps-kind';
      k.textContent = p.kind;
      li.append(k);
    }
    // keep focus in the input while clicking (so the list does not close first)
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
    li.addEventListener('click', () => select(i));
    return li;
  }

  function render() {
    list.replaceChildren(...items.map(option));
    const text = state === 'searching' ? 'Searching…' : state === 'none' ? 'No places found' : state === 'error' ? UNAVAILABLE : '';
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('ps-error', state === 'error');
    credit.hidden = !asked;
    list.hidden = !items.length;
    setOpen(items.length > 0 || !!text);
    setActive(-1);
  }

  function cancel() {
    clearTimeout(timer);
    timer = null;
    if (ctl) { try { ctl.abort(); } catch { /* ignore */ } ctl = null; }
    seq++;
  }

  function run() {
    cancel();
    try { marker.clear(); } catch { /* ignore */ }
    chosen = null;
    const q = input.value.trim();
    const loc = q ? matchLocal(localList(), q) : [];
    items = loc;
    if (q.length < MIN_CHARS) { asked = false; state = ''; render(); return; }
    asked = true; state = 'searching';
    render();
    const my = seq;
    timer = setTimeout(async () => {
      ctl = new AbortController();
      const r = await searchPhoton(q, { signal: ctl.signal });
      if (my !== seq || r.aborted) return;
      ctl = null;
      items = loc.concat(r.items);
      state = r.error ? 'error' : items.length ? '' : 'none';
      render();
    }, DEBOUNCE_MS);
  }

  function select(i) {
    const p = items[i];
    if (!p) return;
    chosen = p;
    input.value = p.name;
    let pad = opts.padding;
    try { if (typeof pad === 'function') pad = pad(); } catch { pad = undefined; }
    goToPlace(mapOf(), p, { padding: pad == null ? 40 : pad, marker });
    if (inline) {
      [...list.children].forEach((li, j) => li.classList.toggle('ps-chosen', j === i));
      setActive(i);
    } else {
      setOpen(false);
    }
    try { if (opts.onSelect) opts.onSelect(p); } catch (err) { console.warn('place search', err); }
  }

  function escape() {
    const had = open;
    cancel();
    try { marker.clear(); } catch { /* ignore */ }
    chosen = null;
    if (had) { setOpen(false); return; }
    if (input.value) { input.value = ''; items = []; asked = false; state = ''; render(); }
  }

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      if (!open) setOpen(true);
      const n = items.length;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (!items.length) return;
      e.preventDefault();
      select(active >= 0 ? active : 0);
    } else if (e.key === 'Escape') {
      // also stops the browser clearing a type=search field and the page's own Esc
      e.preventDefault();
      e.stopPropagation();
      escape();
    }
  });
  input.addEventListener('focus', () => { if (items.length || state) setOpen(true); });
  if (!inline) {
    document.addEventListener('pointerdown', (e) => {
      if (open && e.target !== input && !results.contains(e.target)) setOpen(false);
    });
  }
  setOpen(false);

  return {
    // empty the field and the list, remove the marker
    clear() { cancel(); input.value = ''; items = []; asked = false; state = ''; chosen = null; try { marker.clear(); } catch { /* ignore */ } render(); },
    close() { setOpen(false); },
    // re-run the current query (e.g. once the host's local list has loaded)
    refresh() { if (input.value.trim() && !chosen) run(); },
    isOpen: () => !!open,
  };
}
