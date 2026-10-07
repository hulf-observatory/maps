#!/usr/bin/env node
// Headless check for the map viewer. No npm deps: drives Google Chrome over the
// DevTools protocol using Node's built-in WebSocket (Node 22+).
//
//   node check/check.mjs              # against the live open data (DATA_BASE in js/config.js)
//   node check/check.mjs --fixture    # against check/fixture/layers.json: two small test layers
//                                     # on the real hosts (a PMTiles vector on D, a raster on W)
//   node check/check.mjs --data URL   # any other catalogue base (passed to the page as ?data=)
//   node check/check.mjs --shots      # also write screenshots to screenshots/
//   node check/check.mjs --url http://127.0.0.1:8124/   # use an already running server
//   node check/check.mjs --no-phone   # skip the 390x844 phone-viewport pass
//   node check/check.mjs --no-photon  # block photon.komoot.io: exercises the "unavailable" path
//
// Fails (exit 1) on: console errors, uncaught exceptions, failed or >=400 requests,
// requests to hosts other than own origin, the data base (hulf-observatory.github.io),
// the tiles Worker (hyd-tiles.hulf-observatory.workers.dev), *.arcgisonline.com
// (basemaps), photon.komoot.io (place search) and github.com /
// objects.githubusercontent.com (download redirects), or a layer card showing an error.
// Photon is a public service: if it is unreachable from this machine, its failed
// requests are not counted and the place-search step checks the "unavailable" line.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const FIXTURE = argv.includes('--fixture');
const SHOTS = argv.includes('--shots');
const PHONE = !argv.includes('--no-phone');
const NO_PHOTON = argv.includes('--no-photon');
const urlArg = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
const dataArg = argv.includes('--data') ? argv[argv.indexOf('--data') + 1] : null;
const PORT = FIXTURE ? 8125 : 8126;
const BASE = urlArg || `http://127.0.0.1:${PORT}/`;
// where the page reads its catalogue: the live DATA_BASE unless --fixture / --data
// override it (the page takes the override as ?data=, see js/config.js)
const DEFAULT_DATA_BASE = 'https://hulf-observatory.github.io/hyderabad-data/';
const DATA = dataArg || (FIXTURE ? 'check/fixture/' : null);
const DATA_ABS = DATA ? new URL(DATA, BASE).href : DEFAULT_DATA_BASE;
const page = (qs = '') => { const q = [DATA && 'data=' + DATA, qs].filter(Boolean).join('&'); return BASE + (q ? '?' + q : ''); };
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch { /* */ } });
process.on('exit', cleanup);

async function waitHttp(url, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok) return; } catch { /* */ } await sleep(200); }
  throw new Error('timeout waiting for ' + url);
}

if (!urlArg) {
  const p = spawn('python3', ['dev-server.py', '--port', String(PORT), '--quiet'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  procs.push(p);
  await waitHttp(BASE + 'index.html');
}
if (!existsSync(CHROME)) { console.error('Chrome not found at', CHROME); process.exit(2); }
const dbgPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mv-chrome-'))}`,
  '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'],
{ stdio: 'ignore' });
procs.push(chrome);
await waitHttp(`http://127.0.0.1:${dbgPort}/json/version`);
const targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0; const pending = new Map(); const handlers = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method) handlers.forEach((h) => h(m));
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const problems = [];
const origin = new URL(BASE).origin;
// open-data-scheme.md "Allowed external hosts in the headless check"
const HOSTS = new Set(['hulf-observatory.github.io', 'hyd-tiles.hulf-observatory.workers.dev', 'photon.komoot.io',
  'github.com', 'objects.githubusercontent.com', new URL(DATA_ABS).hostname]);
const allowed = (u) => {
  if (u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank') return true;
  const x = new URL(u);
  return x.origin === origin || HOSTS.has(x.hostname) || x.hostname.endsWith('.arcgisonline.com');
};
const isPhoton = (u) => typeof u === 'string' && u.startsWith('https://photon.komoot.io/');
let photonDown = 0;   // failed Photon requests (the public geocoder unreachable from here)
const reqs = new Map();
let nReq = 0;
const tileHits = new Map(); // tile_url prefix (up to {z}) -> 200 responses seen
handlers.push((m) => {
  const p = m.params;
  if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) problems.push('console.' + p.type + ': ' + p.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.consoleAPICalled' && p.type === 'warning') console.log('  (warn)', p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  if (m.method === 'Log.entryAdded' && p.entry.level === 'error') {
    if (isPhoton(p.entry.url)) photonDown++;
    else problems.push('log: ' + p.entry.text + ' ' + (p.entry.url || ''));
  }
  if (m.method === 'Network.requestWillBeSent') {
    nReq++; reqs.set(p.requestId, p.request.url);
    if (!allowed(p.request.url)) problems.push('foreign host: ' + p.request.url);
  }
  if (m.method === 'Network.responseReceived' && p.response.status === 200) {
    for (const k of tileHits.keys()) if (p.response.url.startsWith(k)) tileHits.set(k, tileHits.get(k) + 1);
  }
  if (m.method === 'Network.responseReceived' && p.response.status >= 400) {
    if (isPhoton(p.response.url)) photonDown++;
    else problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
  }
  if (m.method === 'Network.loadingFailed' && !p.canceled) {
    if (isPhoton(reqs.get(p.requestId))) photonDown++;
    else problems.push(`failed: ${reqs.get(p.requestId)} ${p.errorText}`);
  }
});
await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable');
if (NO_PHOTON) await send('Network.setBlockedURLs', { urls: ['*photon.komoot.io*'] });
// the tour auto-starts on every load: suppress it for every flow except its
// own test, via a test-only hook set before any page script runs (an in-page
// set after load would lose the race against the 1 s auto-start timer)
const NO_TOUR = 'window.__NO_TOUR = true;';
let tourGuard = await send('Page.addScriptToEvaluateOnNewDocument', { source: NO_TOUR });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function waitFor(expr, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await evaluate(expr).catch(() => false)) return true; await sleep(200); }
  console.error('problems so far:', problems);
  throw new Error('timeout: ' + expr);
}
const idle = () => evaluate(`new Promise(r => { const m = window.__map; if (m.loaded() && m.areTilesLoaded()) setTimeout(r, 400); else m.once('idle', () => setTimeout(r, 400)); setTimeout(r, 15000); })`);
async function shot(name) {
  if (!SHOTS) return;
  const dir = join(ROOT, 'screenshots'); mkdirSync(dir, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('  shot', 'screenshots/' + name + '.png');
}
async function clickAt(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function clickSel(sel) {
  const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  await clickAt(r[0], r[1]);
}

// ---------------------------------------------------------------- run
const catalog = await (await fetch(DATA_ABS + 'layers.json', { cache: 'no-cache' })).json();
console.log('data:', DATA_ABS);
// display: false layers are data companions (encoded tiles); the library must not list them
const layers = (catalog.layers || []).filter((l) => l.display !== false);
const pick = (pred) => layers.find(pred);
const chosen = [
  pick((l) => l.kind === 'vector' && l.geom === 'point' && l.style?.icon),
  pick((l) => l.kind === 'vector' && l.geom === 'point'),
  pick((l) => l.kind === 'vector' && l.geom === 'line'),
  pick((l) => l.kind === 'vector' && (l.geom === 'polygon' || !l.geom)),
  pick((l) => l.kind === 'raster'),
  pick((l) => l.kind === 'terrain'),
].filter(Boolean).filter((l, i, a) => a.indexOf(l) === i);
console.log(`catalog: ${layers.length} layers; testing ${chosen.map((l) => l.id).join(', ') || '(none)'}`);
for (const l of chosen) if (l.tile_url) tileHits.set(l.tile_url.split('{')[0], 0);

// ---------------------------------------------------------------- swipe helpers
// the raster to swipe: the 1854 Hyderabad plan over the old city when published
const swipeId = ['map_1854_hyderabad', 'imagery_1979', 'plu_bibinagar'].find((id) => layers.some((l) => l.id === id))
  || (layers.find((l) => l.kind === 'raster' && !/builtup|height/.test(l.id)) || layers.find((l) => l.kind === 'raster') || {}).id;
const swipeView = () => {
  if (swipeId === 'map_1854_hyderabad') return { center: [78.4747, 17.3616], zoom: 14.2 };  // Charminar, the old city
  const b = layers.find((l) => l.id === swipeId).bounds;
  return b ? { center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], zoom: 13 } : { center: [78.47, 17.385], zoom: 12 };
};
const swipeBtn = () => `#bench-list .card[data-id="${swipeId}"] .swipe-btn`;
const cmpIdle = () => evaluate(`new Promise(r => { const m = window.__swipe.map(); if (!m) return r();
  if (m.loaded() && m.areTilesLoaded()) setTimeout(r, 300); else m.once('idle', () => setTimeout(r, 300)); setTimeout(r, 15000); })`);
const clipX = () => evaluate(`(() => { const c = document.getElementById('map-compare'); const m = c && /inset\\(0(px)? 0(px)? 0(px)? ([\\d.]+)px\\)/.exec(c.style.clipPath); return m ? Number(m[4]) : null; })()`);
async function startSwipe() {
  await evaluate(`document.querySelector(${JSON.stringify(swipeBtn())}).scrollIntoView({ block: 'nearest' })`);
  await clickSel(swipeBtn());
  // the compare map exists at once; loaded() also waits for every tile, which at street
  // zoom over a heavy scan can exceed the timeout — cmpIdle() below bounds the settle
  await waitFor('!!window.__swipe.map()');
  await sleep(800); await idle(); await cmpIdle();
}
// real key events (a CDP Escape hides the headless page, so Esc is sent the
// way the other checks send it: a synthetic keydown on the focused element)
const pressEsc = () => evaluate(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
async function pressKey(key, code) {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

// place search (js/place-search.js): open the popover, type a query key by key,
// wait for Photon's OpenStreetMap results (or, when Photon is unreachable from here,
// the "Place search unavailable" line under the local matches), pick one and expect
// the map to move there, inside HMDA, with a marker. Returns a short summary.
const HMDA = [78.00, 16.96, 79.05, 17.90];
async function placeSearchStep(query, shotOpen, shotPicked) {
  await clickSel('#tb-search');
  await waitFor(`!document.getElementById('ps-pop').hidden && document.activeElement === document.getElementById('ps-input')`, 5000);
  const pop = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('ps-pop').getBoundingClientRect())`));
  if (pop.left < 0 || pop.right > (await evaluate('innerWidth'))) problems.push(`place search popover off screen: ${pop.left}..${pop.right}`);
  for (const ch of query) { await send('Input.insertText', { text: ch }); await sleep(60); }
  const settled = `(() => { const r = document.getElementById('ps-results');
    return !r.hidden && (!!r.querySelector('.ps-item.ps-osm') || !!r.querySelector('.ps-status.ps-error:not([hidden])')); })()`;
  const got = await (async () => { const t = Date.now(); while (Date.now() - t < 12000) { if (await evaluate(settled)) return true; await sleep(200); } return false; })();
  const info = JSON.parse(await evaluate(`(() => { const r = document.getElementById('ps-results');
    return JSON.stringify({ osm: r.querySelectorAll('.ps-item.ps-osm').length, local: r.querySelectorAll('.ps-item.ps-local').length,
      status: (r.querySelector('.ps-status:not([hidden])') || {}).textContent || '',
      credit: !r.querySelector('.ps-credit').hidden && r.querySelector('.ps-credit').textContent,
      role: document.getElementById('ps-input').getAttribute('role'), exp: document.getElementById('ps-input').getAttribute('aria-expanded') }); })()`));
  let mode;
  if (!got) { problems.push(`place search "${query}": neither results nor the unavailable line within 12 s`); return; }
  if (info.osm) mode = 'photon';
  else if (info.status === 'Place search unavailable') {
    mode = 'unavailable';
    if (!photonDown) console.log('  (place search: unavailable line without a failed Photon request)');
  } else { problems.push(`place search "${query}": unexpected state ${JSON.stringify(info)}`); return; }
  if (info.role !== 'combobox' || info.exp !== 'true') problems.push(`place search input: role ${info.role}, aria-expanded ${info.exp}`);
  if (!/Photon/.test(info.credit || '') || !/OpenStreetMap/.test(info.credit || '')) problems.push('place search: no Photon / OpenStreetMap credit under the results');
  // keyboard: ↓ makes the first row the active descendant
  await pressKey('ArrowDown', 40);
  const ad = await evaluate(`(() => { const i = document.getElementById('ps-input'); const a = i.getAttribute('aria-activedescendant');
    const li = a && document.getElementById(a); return !!li && li.classList.contains('ps-active') && li === document.querySelector('#ps-results .ps-item'); })()`);
  if (!ad) problems.push('place search: ↓ did not make the first row the active descendant');
  await shot(shotOpen);
  // pick the first OpenStreetMap row (or the first local one when Photon is down)
  const sel = mode === 'photon' ? '#ps-results .ps-item.ps-osm' : '#ps-results .ps-item';
  if (mode === 'unavailable' && !info.local) { console.log(`place search "${query}": Photon unreachable and no local match; skipping the pick`); return mode; }
  const before = await evaluate('window.__map.getCenter().toArray()');
  await evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'nearest' })`);
  await clickSel(sel);
  await sleep(1800); await idle();
  const after = JSON.parse(await evaluate(`JSON.stringify({ c: window.__map.getCenter().toArray(), z: window.__map.getZoom(),
    marker: !!document.querySelector('.ps-marker'), val: document.getElementById('ps-input').value })`));
  const [x, y] = after.c;
  const moved = Math.abs(x - before[0]) + Math.abs(y - before[1]);
  if (!(x >= HMDA[0] && x <= HMDA[2] && y >= HMDA[1] && y <= HMDA[3])) problems.push(`place search: map centre ${x},${y} is outside HMDA after picking`);
  if (!(moved > 0.005)) problems.push(`place search: the map did not move (${moved.toFixed(4)}°)`);
  if (!after.marker) problems.push('place search: no marker after picking a place');
  await shot(shotPicked);
  console.log(`place search "${query}" (${mode}): ${info.local} local + ${info.osm} OSM rows; picked "${after.val}", map at ${x.toFixed(4)},${y.toFixed(4)} z${after.z.toFixed(1)}`);
  return mode;
}
async function placeSearchEsc() {
  if (await evaluate(`document.getElementById('ps-pop').hidden`)) await clickSel('#tb-search');
  await evaluate(`document.getElementById('ps-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);
  const st = JSON.parse(await evaluate(`JSON.stringify({ marker: !!document.querySelector('.ps-marker'), pop: !document.getElementById('ps-pop').hidden })`));
  if (st.marker || st.pop) problems.push(`place search: Esc left ${st.marker ? 'the marker' : ''}${st.marker && st.pop ? ' and ' : ''}${st.pop ? 'the popover' : ''}`);
}

await send('Page.navigate', { url: page() });
await waitFor('document.body.dataset.ready === "1"');
await sleep(1500); await idle();
const dataBase = await evaluate('window.__viewer.DATA_BASE');
if (dataBase !== DATA_ABS) problems.push(`page reads data from ${dataBase}, expected ${DATA_ABS}`);
const libCount = await evaluate('document.querySelectorAll(".lyr").length');
if (libCount !== layers.length) problems.push(`library shows ${libCount} rows, layers.json has ${layers.length}`);
await shot('01-library-map');

// preview the polygon (or first) layer
const pvLayer = chosen.find((l) => l.geom === 'polygon') || chosen[0];
if (pvLayer) {
  await clickSel(`.lyr[data-id="${pvLayer.id}"]`);
  await waitFor(`window.__viewer.state.preview && window.__viewer.state.preview.layerIds.length > 0`);
  await sleep(1200); await idle();
  await shot('02-preview');
  await clickSel('#pv-add');
  await waitFor(`window.__viewer.state.bench.some(e => e.meta.id === ${JSON.stringify(pvLayer.id)})`);
}
for (const l of chosen) await evaluate(`window.__viewer.addToBench(${JSON.stringify(l.id)})`);
await evaluate('void window.__map.jumpTo({center:[78.47,17.385], zoom: 12.2})');
await sleep(1500); await idle();
const errs = await evaluate('window.__viewer.state.bench.filter(e => e.error).map(e => e.meta.id + ": " + e.error)');
errs.forEach((e) => problems.push('card error: ' + e));
const benchIds = await evaluate('window.__viewer.state.bench.map(e => e.meta.id)');
console.log('bench:', benchIds.join(', '));
// rasters must really draw: tiles arrived from the Worker, the source reports loaded,
// and the card's "Loading…" chip has gone quiet again
for (const l of chosen.filter((l) => l.tile_url)) {
  const hits = tileHits.get(l.tile_url.split('{')[0]) || 0;
  if (!hits) problems.push(`no tile of ${l.id} arrived from ${l.tile_url}`);
  const st = JSON.parse(await evaluate(`(() => { const e = window.__viewer.state.bench.find(e => e.meta.id === ${JSON.stringify(l.id)});
    const chip = e && e.el && e.el.querySelector('.loading-chip');
    return JSON.stringify({ loaded: !!e && window.__map.isSourceLoaded(e.srcId), chip: !!chip, hidden: chip ? chip.hidden : null }); })()`));
  if (!st.loaded) problems.push(`${l.id}: source not loaded after idle`);
  if (!st.chip) problems.push(`${l.id}: raster card has no loading chip`);
  else if (!st.hidden) problems.push(`${l.id}: loading chip still showing after idle`);
  else console.log(`${l.id}: ${hits} tiles from the Worker, source loaded, chip hidden`);
}
// colour-by on the polygon layer
if (pvLayer && (pvLayer.fields || []).length) {
  await evaluate(`(() => { const v = window.__viewer; v.state.bench.forEach(e => { e.open = false; });
    const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(pvLayer.id)}); e.open = true;
    const f = (e.meta.fields || []).find(f => !/^(object_?id|fid|id)$/i.test(f.name)) || e.meta.fields[0];
    e.settings.colorBy = f.name; v.refreshClasses(e); v.safeApply(e); v.renderBench(); })()`);
  await sleep(1000); await idle();
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(pvLayer.id)}); v.refreshClasses(e); v.safeApply(e); v.renderBench(); })()`);
}
// labels on the first point layer (exercises the self-hosted glyphs)
await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.geom === 'point' && (e.meta.fields || []).length);
  if (e) { e.settings.labelField = e.meta.fields.find(f => !/^(object_?id|fid|id)$/i.test(f.name))?.name || e.meta.fields[0].name; v.safeApply(e); v.renderBench(); } })()`);
await sleep(800); await idle();
await shot('03-bench');

// Edit style sliders must respond to a real pointer drag (regression guard:
// dragging Opacity has to move the paint property on the map layer)
{
  await evaluate(`(() => { const v = window.__viewer; v.state.bench.forEach(e => { e.open = false; e.editing = false; });
    const e = v.state.bench[0]; e.open = true; e.editing = true; v.renderBench(); })()`);
  await sleep(300);
  const sl = await evaluate(`(() => { const i = document.querySelector('#bench-list .card input[type=range]');
    const b = i.getBoundingClientRect(); return [b.x, b.y + b.height / 2, b.width]; })()`);
  const before = await evaluate('window.__viewer.state.bench[0].settings.opacity');
  // a real drag in steps: the press alone moves the thumb, so the value must end near
  // the RELEASE point — that is what failed when the card itself was draggable
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sl[0] + sl[2] * 0.95, y: sl[1] });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sl[0] + sl[2] * 0.95, y: sl[1], button: 'left', clickCount: 1 });
  for (let k = 1; k <= 8; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sl[0] + sl[2] * (0.95 - 0.65 * k / 8), y: sl[1], button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sl[0] + sl[2] * 0.3, y: sl[1], button: 'left', clickCount: 1 });
  await sleep(200);
  const st = await evaluate(`(() => { const e = window.__viewer.state.bench[0];
    const id = e.layerIds.find(i => /:(circle|line|raster)$/.test(i));
    const prop = id.endsWith(':circle') ? 'circle-opacity' : id.endsWith(':line') ? 'line-opacity' : 'raster-opacity';
    return JSON.stringify({ o: e.settings.opacity, p: window.__map.getPaintProperty(id, prop) }); })()`);
  const { o, p } = JSON.parse(st);
  if (!(Math.abs(o - 0.3) < 0.12 && Math.abs(p - o) < 0.001)) problems.push(`Edit style slider drag: opacity ${before} -> ${o} (expected ~0.3), paint ${p} — the drag did not follow the pointer`);
  else console.log(`edit-style slider drag: opacity ${before} -> ${o}, paint follows`);
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench[0]; e.settings.opacity = 1; e.editing = false; e.open = false; v.safeApply(e); v.renderBench(); })()`);
}

// popup: click on a rendered vector feature
const pt = await evaluate(`(() => {
  const m = window.__map; const ids = m.getStyle().layers.map(l => l.id).filter(id => /^b:.*:(circle|line|fill)$/.test(id));
  const c = m.getCanvas(); const W = c.clientWidth, H = c.clientHeight;
  const x0 = Math.max(60, ...[...document.querySelectorAll('.col')].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().right - c.getBoundingClientRect().left + 10));
  for (let y = 80; y < H - 40; y += 23) for (let x = x0 + 150; x < W - 70; x += 23) {
    if (m.queryRenderedFeatures([x, y], { layers: ids }).length) { const r = c.getBoundingClientRect(); return [r.x + x, r.y + y]; }
  }
  return null; })()`);
if (pt) {
  await clickAt(pt[0], pt[1]); await sleep(500);
  const pop = await evaluate('!!document.querySelector(".maplibregl-popup .pop-tag")');
  if (!pop) problems.push('popup did not open on feature click');
  await shot('04-popup');
  await evaluate('document.querySelector(".maplibregl-popup-close-button")?.click()');
} else if (chosen.some((l) => l.kind === 'vector')) problems.push('no rendered vector feature found to click');

// collapsed rails
await clickSel('#library .rail-toggle'); await clickSel('#bench-view .rail-toggle');
await sleep(600); await idle();
await shot('05-rails');
await clickSel('#library .rail-label'); await clickSel('#bench .rail-label');

// terrain 3D toggle
const terr = chosen.find((l) => l.kind === 'terrain');
if (terr) {
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(terr.id)}); e.settings.threeD = true; window.__map.setPitch(55); })()`);
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(terr.id)}); e.open = true; document.getElementById('bench-expand').click(); document.getElementById('bench-expand').click(); })()`);
  await evaluate(`(() => { const m = window.__map; const e = window.__viewer.state.bench.find(e => e.meta.id === ${JSON.stringify(terr.id)}); m.setTerrain({ source: e.srcId + '-3d', exaggeration: 2 }); })()`);
  await sleep(1500); await idle();
  await shot('06-terrain-3d');
  await evaluate('window.__map.setTerrain(null); void window.__map.setPitch(0)');
}

// palette layer: default styling must draw >1 fill colour (categorical match)
const palLayer = layers.find((l) => l.kind === 'vector' && l.style?.palette?.field && Object.keys(l.style.palette.values || {}).length > 1);
if (palLayer) {
  await evaluate(`window.__viewer.addToBench(${JSON.stringify(palLayer.id)})`);
  await sleep(600); await idle();
  const expr = await evaluate(`(() => { const e = window.__viewer.state.bench.find(e => e.meta.id === ${JSON.stringify(palLayer.id)});
    if (!e) return 'missing'; const id = e.key + (e.meta.geom === 'point' ? ':circle' : e.meta.geom === 'line' ? ':line' : ':fill');
    return JSON.stringify(window.__map.getPaintProperty(id, '${palLayer.geom === 'point' ? 'circle-color' : palLayer.geom === 'line' ? 'line-color' : 'fill-color'}')); })()`);
  const colours = new Set(String(expr).match(/#[0-9a-fA-F]{3,8}/g) || []);
  if (colours.size < 2) problems.push(`palette layer ${palLayer.id} draws ${colours.size} colour(s): ${expr}`);
  else console.log(`palette: ${palLayer.id} paints ${colours.size} colours`);
  if (palLayer.bounds) await evaluate(`void window.__map.fitBounds([[${palLayer.bounds[0]},${palLayer.bounds[1]}],[${palLayer.bounds[2]},${palLayer.bounds[3]}]], {duration: 0})`);
  await sleep(1200); await idle();
  await shot('08-palette');
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(palLayer.id)}); if (e) v.removeFromBench(e); })()`);
}

// add-time draw order: a polygon slots among the polygons by extent, smaller
// above larger, whichever order they are added in
if (layers.some((l) => l.id === 'ts_districts_33') && layers.some((l) => l.id === 'ghmc_wards_2026')) {
  const idx = (id) => evaluate(`window.__viewer.state.bench.findIndex(e => e.meta.id === '${id}')`);
  const drop = (id) => evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === '${id}'); if (e) v.removeFromBench(e); })()`);
  for (const order of [['ts_districts_33', 'ghmc_wards_2026'], ['ghmc_wards_2026', 'ts_districts_33']]) {
    await drop('ts_districts_33'); await drop('ghmc_wards_2026');
    for (const id of order) await evaluate(`window.__viewer.addToBench('${id}')`);
    const w = await idx('ghmc_wards_2026'), d = await idx('ts_districts_33');
    if (!(w >= 0 && d >= 0 && w < d)) problems.push(`add order ${order.join(' then ')}: wards at ${w}, districts at ${d} - wards must draw above districts`);
  }
  console.log('bench order: wards above districts both ways');
  await drop('ts_districts_33'); await drop('ghmc_wards_2026');
}

// year slider on the built-up layer: setting 2000 must produce recoloured
// protocol tiles (no network - decoded tiles are cached and only re-coloured),
// then play advances the year on its own
if (layers.some((l) => l.id === 'builtup_first_year') && (catalog.layers || []).some((l) => l.id === 'builtup_first_year_encoded')) {
  await evaluate(`window.__viewer.addToBench('builtup_first_year')`);
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === 'builtup_first_year'); e.open = true; v.renderBench(); })()`);
  await evaluate('void window.__map.jumpTo({center:[78.47,17.40], zoom: 11.6})');
  await sleep(1200); await idle();
  const hasSlider = await evaluate('document.querySelectorAll(".yr-range input[type=range]").length === 2');
  if (!hasSlider) problems.push('built-up card shows no dual-handle year range');
  else {
    const setHandle = (which, v) => evaluate(`(() => { const i = document.querySelectorAll('.yr-range input[type=range]')[${which}]; i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    // lo=1985, hi=2000 -> the simpler "Built by" readout
    await setHandle(1, 2000);
    await waitFor('(window.__yearfilterTiles || 0) > 0');
    await sleep(1500); await idle();
    const made = await evaluate('window.__yearfilterTiles');
    console.log(`year range: ${made} recoloured tiles at 1985-2000`);
    let readout = await evaluate('document.querySelector(".yr-ctl .v").textContent');
    if (readout !== 'Built by 2000') problems.push(`year readout says "${readout}", expected "Built by 2000"`);
    await shot('13-year-slider-2000');
    // a mid-range filter: lo=2000, hi=2010
    await setHandle(1, 2010);
    await setHandle(0, 2000);
    await sleep(1500); await idle();
    readout = await evaluate('document.querySelector(".yr-ctl .v").textContent');
    if (readout !== 'Built 2000–2010') problems.push(`year readout says "${readout}", expected "Built 2000–2010"`);
    const made2 = await evaluate('window.__yearfilterTiles');
    if (!(made2 > made)) problems.push('mid-range filter produced no new yearfilter tiles');
    await shot('17-year-range');
    // palette: switch to Magma in Edit style -> new tiles, new ramp gradient
    const gradBefore = await evaluate('document.querySelector(".yr-grad").style.background');
    await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === 'builtup_first_year'); e.editing = true; v.renderBench(); })()`);
    await evaluate(`(() => { const s = document.querySelector('select[aria-label="Palette"]'); s.value = 'magma'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(600); await idle();
    await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === 'builtup_first_year'); e.editing = false; v.renderBench(); })()`);
    const made3 = await evaluate('window.__yearfilterTiles');
    const gradAfter = await evaluate('document.querySelector(".yr-grad").style.background');
    if (!(made3 > made2)) problems.push('palette switch produced no new yearfilter tiles');
    if (!gradAfter || gradAfter === gradBefore) problems.push('palette switch did not change the ramp gradient');
    else console.log('palette: magma re-coloured tiles and ramp');
    // play sweeps hi from lo to 2023 (~3 ticks), Esc stops it
    await evaluate('document.querySelector(".yr-play").click()');
    await sleep(1250);
    const hi = await evaluate(`window.__viewer.state.bench.find(e => e.meta.id === 'builtup_first_year').yearUI.hi`);
    if (!(hi >= 2012 && hi <= 2020)) problems.push(`play advanced hi to ${hi} after ~3 ticks from 2010, expected 2012-2020`);
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(100);
    const playing = await evaluate(`window.__viewer.state.bench.find(e => e.meta.id === 'builtup_first_year').yearUI.playing`);
    if (playing) problems.push('Esc did not stop the year play');
    else console.log(`year play: hi reached ${hi}, Esc stopped it`);
  }
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === 'builtup_first_year'); if (e) v.removeFromBench(e); })()`);
}

// hover height readout: find a built pixel in the encoded tile at the map
// centre, fire a mousemove there, and expect a plausible chip
if (layers.some((l) => l.id === 'buildings_height_2023') && (catalog.layers || []).some((l) => l.id === 'buildings_height_2023_encoded')) {
  await evaluate(`window.__viewer.addToBench('buildings_height_2023')`);
  await evaluate('void window.__map.jumpTo({center:[78.474,17.40], zoom: 14.5})');
  await sleep(1500); await idle();
  const spot = await evaluate(`(async () => {
    const m = window.__map, c = m.getCenter();
    const meta = window.__viewer.state.byId.get('buildings_height_2023_encoded');
    const t = window.__encoded.tileAt(meta, c.lng, c.lat, m.getZoom());
    const img = await window.__encoded.getTileData(meta, t.z, t.x, t.y);
    if (!img) return null;
    for (let py = 0; py < img.height; py += 2) for (let px = 0; px < img.width; px += 2) {
      const i = (py * img.width + px) * 4;
      if (img.data[i + 3] > 0 && (img.data[i] * 256 + img.data[i + 1]) > 5) {
        const n = Math.pow(2, t.z);
        const lng = ((t.x + (px + 0.5) / t.ts) / n) * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (t.y + (py + 0.5) / t.ts) / n))) * 180 / Math.PI;
        return [lng, lat];
      }
    }
    return null; })()`);
  if (!spot) problems.push('no built pixel found in the encoded height tile at the city centre');
  else {
    await evaluate(`void window.__map.jumpTo({center:[${spot[0]},${spot[1]}], zoom: 15.5})`);
    await sleep(1200); await idle();
    await evaluate(`(() => { const m = window.__map; const ll = { lng: ${spot[0]}, lat: ${spot[1]} };
      m.fire('mousemove', { point: m.project([ll.lng, ll.lat]), lngLat: ll }); })()`);
    await waitFor('(() => { const c = document.querySelector(".probe-chip"); return c && !c.hidden && / m/.test(c.textContent); })()', 8000);
    const txt = await evaluate('document.querySelector(".probe-chip").textContent');
    const metres = parseFloat(txt);
    if (!(metres >= 0.5 && metres <= 200)) problems.push(`hover chip shows "${txt}", expected 0.5-200 m`);
    else console.log(`hover height: chip shows "${txt}"`);
    await shot('14-height-hover');
  }
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === 'buildings_height_2023'); if (e) v.removeFromBench(e); })()`);
}

// breadcrumb: appears; HMDA is a plain zoom button (no menu); the corporation
// caret lists the corporations; the ward menu filters
{
  await evaluate('void window.__map.jumpTo({center:[78.47,17.385], zoom: 12.2})');
  const has = await (async () => { const t = Date.now(); while (Date.now() - t < 15000) {
    if (await evaluate('!!document.querySelector("#crumb .crumb-seg")')) return true; await sleep(300); } return false; })();
  if (!has) problems.push('breadcrumb did not appear');
  else {
    const segs = await evaluate('document.querySelectorAll("#crumb .crumb-seg").length');
    if (segs !== 4) problems.push(`breadcrumb shows ${segs} levels at the city centre, expected 4 (HMDA › corporation › zone › ward)`);
    if (await evaluate('!!document.querySelector("#crumb .crumb-seg:first-child .crumb-caret")')) problems.push('breadcrumb: HMDA has a menu caret, expected a plain zoom button');
    // corporation caret -> the corporations
    await evaluate('document.querySelectorAll("#crumb .crumb-seg")[1].querySelector(".crumb-caret").click()');
    const corps = await evaluate('document.querySelectorAll("#crumb .crumb-seg")[1].querySelectorAll(".crumb-menu button[data-kind=corp]").length');
    if (!(corps >= 4 && corps <= 5)) problems.push(`breadcrumb corporation menu lists ${corps} items, expected 4-5`);
    else console.log(`breadcrumb: 4 levels, HMDA plain, ${corps} corporations`);
    await shot('09-breadcrumb-open');
    await evaluate('document.body.click()');
    // ward caret -> that zone's wards, with a working filter
    await evaluate('document.querySelectorAll("#crumb .crumb-seg")[3].querySelector(".crumb-caret").click()');
    const wardsAll = await evaluate('document.querySelectorAll("#crumb .crumb-seg")[3].querySelectorAll(".crumb-menu button[data-kind=ward]:not([hidden])").length');
    await evaluate(`(() => { const seg = document.querySelectorAll('#crumb .crumb-seg')[3];
      const first = seg.querySelector('.crumb-menu button[data-kind=ward]');
      const inp = seg.querySelector('.crumb-filter'); inp.value = first.textContent.slice(-5); inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const wardsFiltered = await evaluate('document.querySelectorAll("#crumb .crumb-seg")[3].querySelectorAll(".crumb-menu button[data-kind=ward]:not([hidden])").length');
    if (!(wardsAll > 0 && wardsFiltered > 0 && wardsFiltered < wardsAll)) problems.push(`breadcrumb ward filter: ${wardsAll} -> ${wardsFiltered} rows, expected a narrower non-empty list`);
    else console.log(`breadcrumb ward filter: ${wardsAll} -> ${wardsFiltered}`);
    await shot('16-breadcrumb-v2');
    await evaluate('document.body.click()');
  }
}

// place search: from the western suburbs to Charminar
{
  await evaluate('void window.__map.jumpTo({center:[78.36,17.46], zoom: 12})');
  await sleep(600); await idle();
  await placeSearchStep('Charminar', '20-place-search', '21-place-search-picked');
  await placeSearchEsc();
}

// swipe compare: the raster vs the map beneath it. A second map (everything but
// the raster) is clipped right of the divider and follows the main camera.
if (swipeId) {
  // a quiet bench for the picture: ward outlines (or the previewed polygon layer) + the raster
  const other = layers.find((l) => l.id === 'ghmc_wards_2026') || pvLayer;
  await evaluate(`(() => { const v = window.__viewer; [...v.state.bench].forEach(e => v.removeFromBench(e)); })()`);
  if (other) await evaluate(`window.__viewer.addToBench(${JSON.stringify(other.id)})`);
  await evaluate(`window.__viewer.addToBench(${JSON.stringify(swipeId)})`);
  await evaluate(`void window.__map.jumpTo(${JSON.stringify(swipeView())})`);
  await sleep(1200); await idle();
  const btns = await evaluate('document.querySelectorAll("#bench-list .swipe-btn").length');
  const rasters = await evaluate('window.__viewer.state.bench.filter(e => e.meta.kind === "raster").length');
  if (btns !== rasters) problems.push(`swipe: ${btns} Swipe buttons for ${rasters} raster cards`);
  await startSwipe();
  const key = 'b:' + swipeId + ':';
  const info = JSON.parse(await evaluate(`(() => { const c = window.__swipe.map(), m = window.__map; const ids = c.getStyle().layers.map(l => l.id);
    const W = m.getContainer().getBoundingClientRect().width, pad = m.getPadding();
    const b = document.querySelector(${JSON.stringify(swipeBtn())});
    return JSON.stringify({ canvases: document.querySelectorAll('#map-wrap canvas.maplibregl-canvas').length,
      swiped: ids.filter(i => i.startsWith(${JSON.stringify(key)})).length, basemap: ids.filter(i => i.startsWith('bm-')).length,
      others: ids.filter(i => ${JSON.stringify(other ? 'b:' + other.id + ':' : '#')} !== '#' && i.startsWith(${JSON.stringify(other ? 'b:' + other.id + ':' : '#')})).length,
      mainHas: m.getLayoutProperty(${JSON.stringify(key + 'raster')}, 'visibility') !== 'none',
      x: window.__swipe.x(), centre: (pad.left + W) / 2, btn: b && b.textContent, pressed: b && b.getAttribute('aria-pressed') }); })()`));
  if (info.canvases !== 2) problems.push(`swipe: ${info.canvases} map canvases, expected 2`);
  if (info.swiped) problems.push(`swipe: the compare map carries ${info.swiped} layer(s) of the swiped entry`);
  if (!info.basemap) problems.push('swipe: the compare map has no basemap');
  if (other && !info.others) problems.push('swipe: the compare map is missing the other bench layers');
  if (!info.mainHas) problems.push('swipe: the swiped layer is not showing on the main map');
  if (Math.abs(info.x - info.centre) > 2) problems.push(`swipe: divider at ${info.x}px, expected the visible map centre ${info.centre}px`);
  if (info.btn !== 'Swiping' || info.pressed !== 'true') problems.push(`swipe: active card button reads "${info.btn}" (pressed ${info.pressed})`);
  await shot('18-swipe');
  // drag the handle with real pointer events
  const h0 = await evaluate(`(() => { const r = document.querySelector('.swipe-handle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const clip0 = await clipX();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h0[0], y: h0[1] });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h0[0], y: h0[1], button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h0[0] - 30 * k, y: h0[1] + 5, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h0[0] - 180, y: h0[1] + 5, button: 'left', clickCount: 1 });
  await sleep(150);
  const clip1 = await clipX();
  if (!(clip0 != null && clip1 != null && Math.abs(clip0 - 180 - clip1) <= 2)) problems.push(`swipe: handle drag moved the clip ${clip0} -> ${clip1}, expected -180px`);
  // keyboard: → moves the divider 5% of the map width
  await evaluate(`document.querySelector('.swipe-handle').focus()`);
  const f0 = await evaluate('window.__swipe.frac()');
  await pressKey('ArrowRight', 39);
  const f1 = await evaluate('window.__swipe.frac()');
  if (Math.abs(f1 - f0 - 0.05) > 0.002) problems.push(`swipe: → moved the divider ${f0} -> ${f1}, expected +0.05`);
  // settings on another bench layer follow onto the compare map
  if (other) {
    await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(other.id)}); e.settings.opacity = 0.45; v.safeApply(e); })()`);
    await sleep(150);
    const lid = 'b:' + other.id + (other.geom === 'point' ? ':circle' : ':line');
    const op = await evaluate(`window.__swipe.map().getPaintProperty(${JSON.stringify(lid)}, '${other.geom === 'point' ? 'circle-opacity' : 'line-opacity'}')`);
    if (op !== 0.45) problems.push(`swipe: opacity 0.45 on ${other.id} shows ${op} on the compare map`);
    await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(other.id)}); e.settings.opacity = 1; v.safeApply(e); })()`);
  }
  // basemap switch follows
  await clickSel('#tb-basemap');
  await evaluate(`[...document.querySelectorAll('#bm-menu button')].find(b => /Topographic/.test(b.textContent)).click()`);
  await sleep(150);
  if (!(await evaluate(`window.__swipe.map().getStyle().layers.some(l => l.id.startsWith('bm-topo'))`))) problems.push('swipe: basemap switch did not reach the compare map');
  await clickSel('#tb-basemap');
  await evaluate(`[...document.querySelectorAll('#bm-menu button')].find(b => /Light grey/.test(b.textContent)).click()`);
  // pan the main map with a real drag over the right (compare) half: input
  // passes through to the main map and the compare map follows exactly
  const c0 = await evaluate('window.__map.getCenter().toArray()');
  const px = (await clipX()) + 160;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: 520 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: 520, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 8; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - 15 * k, y: 520 - 8 * k, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px - 120, y: 456, button: 'left', clickCount: 1 });
  await sleep(700);
  const sync = JSON.parse(await evaluate(`JSON.stringify({ a: window.__map.getCenter().toArray(), b: window.__swipe.map().getCenter().toArray(),
    za: window.__map.getZoom(), zb: window.__swipe.map().getZoom() })`));
  const moved = Math.abs(sync.a[0] - c0[0]) + Math.abs(sync.a[1] - c0[1]);
  if (!(moved > 1e-4)) problems.push('swipe: dragging over the compare half did not pan the main map');
  if (!(Math.abs(sync.a[0] - sync.b[0]) < 1e-9 && Math.abs(sync.a[1] - sync.b[1]) < 1e-9 && Math.abs(sync.za - sync.zb) < 1e-9))
    problems.push(`swipe: compare map out of sync: ${JSON.stringify(sync)}`);
  // Esc leaves swipe and tears the compare map down
  await pressEsc();
  await sleep(200);
  const gone = await evaluate(`!document.getElementById('map-compare') && !document.querySelector('.swipe') && !window.__swipe.map()
    && document.querySelectorAll('#map-wrap canvas.maplibregl-canvas').length === 1 && document.querySelector(${JSON.stringify(swipeBtn())}).textContent === 'Swipe'`);
  if (!gone) problems.push('swipe: Esc did not remove the compare map');
  // hiding the swiped layer also leaves swipe
  await startSwipe();
  await evaluate(`document.querySelector('#bench-list .card[data-id="${swipeId}"] .iconbtn[aria-label="Hide"]').click()`);
  await sleep(200);
  if (await evaluate('!!window.__swipe.map()')) problems.push('swipe: hiding the swiped layer did not leave swipe');
  else console.log(`swipe: ${swipeId} — compare map without it, handle drag + keys, camera in sync, Esc/hide exit`);
  await evaluate(`(() => { const v = window.__viewer; const e = v.state.bench.find(e => e.meta.id === ${JSON.stringify(swipeId)}); e.visible = true; v.safeApply(e); v.renderBench(); })()`);
}

// embed mode + ?layers preload
await send('Page.navigate', { url: page('embed=1&layers=' + chosen.map((l) => l.id).join(',')) });
await waitFor('document.body.dataset.ready === "1"');
await sleep(1000); await idle();
const embedOk = await evaluate(`getComputedStyle(document.getElementById('library')).display === 'none' && window.__viewer.state.bench.length === ${chosen.length}`);
if (!embedOk) problems.push('embed mode / ?layers preload failed');
if (await evaluate('!!document.querySelector("#crumb")')) problems.push('breadcrumb visible in ?embed=1');
if (await evaluate('document.getElementById("btn-reset").offsetParent !== null')) problems.push('reset button visible in ?embed=1');
await shot('07-embed');

// ------------------------------------------------- reset = first-visit state
{
  await send('Page.navigate', { url: page() });
  await waitFor('document.body.dataset.ready === "1"');
  await sleep(1000); await idle();
  // add a layer that is NOT in the default set, so there is something to confirm
  const extra = chosen.find((l) => !l.default_visible) || layers.find((l) => !l.default_visible) || chosen[0];
  await evaluate(`window.__viewer.addToBench(${JSON.stringify(extra.id)})`);
  await sleep(600);
  await clickSel('#btn-reset');
  await sleep(300);
  if (extra.default_visible) console.log('  (reset: every layer is default_visible; the confirm card cannot be exercised)');
  else if (await evaluate('document.getElementById("reset-card").hidden')) problems.push('reset showed no confirm although the bench was not the default');
  if (!(await evaluate('document.getElementById("reset-card").hidden'))) await clickSel('#reset-confirm');
  const defIds = layers.filter((l) => l.default_visible).map((l) => l.id).sort();
  await waitFor(`JSON.stringify(window.__viewer.state.bench.map(e => e.meta.id).sort()) === ${JSON.stringify(JSON.stringify(defIds))}`);
  if (await evaluate('new URLSearchParams(location.search).has("layers")')) problems.push('reset left ?layers= in the URL');
  await waitFor('!!document.querySelector(".tour-mask")', 8000);
  console.log('reset: default bench restored, clean URL, tour restarted');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(300);
}

// ------------------------------------------------- guided tour
{
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tourGuard.identifier });
  await send('Page.navigate', { url: page() });
  await waitFor('document.body.dataset.ready === "1"');
  const auto = await (async () => { const t = Date.now(); while (Date.now() - t < 8000) {
    if (await evaluate('!!document.querySelector(".tour-mask")')) return true; await sleep(200); } return false; })();
  if (!auto) problems.push('tour did not auto-start on a fresh load');
  else {
    await evaluate('document.querySelector(".tour-next").click()');
    await sleep(1200); await idle();                          // step 2 opens a preview
    await evaluate('document.querySelector(".tour-next").click()');
    await sleep(600);
    await shot('15-tour');
    const dots = await evaluate('document.querySelectorAll(".tour-dots i").length');
    const step = await evaluate('[...document.querySelectorAll(".tour-dots i")].findIndex(d => d.className === "on")');
    if (!(dots >= 4 && step >= 1)) problems.push(`tour did not advance (dot ${step + 1} of ${dots})`);
    await evaluate('document.querySelector(".tour-skip").click()');
    await sleep(400);
    if (await evaluate('!!document.querySelector(".tour-mask")')) problems.push('Skip tour did not close the tour');
    // the tour returns on every reload (skip lasts for that page view only)
    await send('Page.navigate', { url: page() });
    await waitFor('document.body.dataset.ready === "1"');
    const again = await (async () => { const t = Date.now(); while (Date.now() - t < 8000) {
      if (await evaluate('!!document.querySelector(".tour-mask")')) return true; await sleep(200); } return false; })();
    if (!again) problems.push('tour did not auto-start again on reload');
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(400);
    if (await evaluate('!!document.querySelector(".tour-mask")')) problems.push('Esc did not close the tour');
    // the ? button restarts it any time
    await clickSel('#btn-tour');
    await waitFor('!!document.querySelector(".tour-mask")', 8000);
    await evaluate('document.querySelector(".tour-skip").click()');
    await sleep(400);
    if (await evaluate('!!document.querySelector(".tour-mask")')) problems.push('Skip did not close the restarted tour');
    else console.log('tour: auto on every load, skip/Esc close, ? restarts');
  }
  // keep it suppressed again for the remaining flows (phone pass)
  tourGuard = await send('Page.addScriptToEvaluateOnNewDocument', { source: NO_TOUR });
}

// ------------------------------------------------- phone pass (390x844)
if (PHONE) {
  console.log('phone pass (390x844)');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: page() });
  await waitFor('document.body.dataset.ready === "1"');
  await sleep(1200); await idle();
  const pills = await evaluate('["library","bench"].every(id => document.getElementById(id).classList.contains("rail"))');
  if (!pills) problems.push('phone: columns did not start as bottom pills');
  const padOk = await evaluate('(window.__map.getPadding().left || 0) === 0');
  if (!padOk) problems.push('phone: map keeps left padding');
  // library opens full-screen
  await clickSel('#library .rail-label');
  await sleep(400);
  const full = await evaluate('(() => { const b = document.getElementById("library").getBoundingClientRect(); return b.width > 380 && b.height > 600; })()');
  if (!full) problems.push('phone: library sheet is not full-screen');
  await shot('10-phone-library');
  // tap a layer -> preview peek sheet
  if (chosen[0]) {
    const target = chosen.find((l) => l.geom === 'polygon') || chosen[0];
    await clickSel(`.lyr[data-id="${target.id}"]`);
    await waitFor('window.__viewer.state.preview && window.__viewer.state.preview.layerIds.length > 0');
    await sleep(1200); await idle();
    const peek = await evaluate('(() => { const b = document.getElementById("bench"); const r = b.getBoundingClientRect(); return !b.classList.contains("rail") && r.height > 120 && r.height < 240 && document.getElementById("library").classList.contains("rail"); })()');
    if (!peek) problems.push('phone: preview did not open as a peek bottom sheet');
    const bpad = await evaluate('Math.round(window.__map.getPadding().bottom || 0)');
    if (!(bpad > 100 && bpad <= 200)) problems.push(`phone: map bottom padding is ${bpad}, expected the peek height`);
    await shot('11-phone-preview-peek');
    // add to workbench, open the sheet at half height
    await clickSel('#pv-add');
    await waitFor(`window.__viewer.state.bench.some(e => e.meta.id === ${JSON.stringify(target.id)})`);
    await evaluate('window.__mobile.openBench("half")');
    await sleep(700); await idle();
    const half = await evaluate('(() => { const r = document.getElementById("bench").getBoundingClientRect(); return r.height > 320 && r.height < 520; })()');
    if (!half) problems.push('phone: workbench sheet did not open at half height');
    await shot('12-phone-workbench-half');
  }
  // phone tour: the ? button starts the simplified 4-step tour (its first
  // step collapses both sheets back to pills itself)
  await clickSel('#btn-tour');
  await waitFor('!!document.querySelector(".tour-mask")', 8000);
  const phoneDots = await evaluate('document.querySelectorAll(".tour-dots i").length');
  if (phoneDots !== 4) problems.push(`phone tour has ${phoneDots} steps, expected the simplified 4`);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(300);
  // phone place search: the magnifier opens the popover within the screen, a
  // pick closes it again so the map shows
  {
    await evaluate('void window.__map.jumpTo({center:[78.36,17.46], zoom: 12})');
    await sleep(500);
    const mode = await placeSearchStep('Ameerpet', '22-place-search-phone', '23-place-search-phone-picked');
    if (mode && !(await evaluate(`document.getElementById('ps-pop').hidden`))) problems.push('phone: the place search popover stayed open after a pick');
    await placeSearchEsc();
  }
  // phone swipe: the handle sits in the map band above the half sheet and
  // follows a touch drag
  if (swipeId) {
    await evaluate(`window.__viewer.addToBench(${JSON.stringify(swipeId)})`);
    await evaluate('window.__mobile.openBench("half")');
    await evaluate(`void window.__map.jumpTo(${JSON.stringify(swipeView())})`);
    await sleep(900); await idle();
    await startSwipe();
    const g = JSON.parse(await evaluate(`(() => { const r = document.querySelector('.swipe-handle').getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: r.bottom, sheet: document.getElementById('bench').getBoundingClientRect().top }); })()`));
    if (!(g.bottom <= g.sheet)) problems.push(`phone: swipe handle (bottom ${g.bottom}) is under the sheet (top ${g.sheet})`);
    const t0 = await clipX();
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y }] });
    for (let k = 1; k <= 6; k++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g.x - 15 * k, y: g.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300); await cmpIdle();
    const t1 = await clipX();
    if (!(t0 != null && t1 != null && Math.abs(t0 - 90 - t1) <= 2)) problems.push(`phone: touch drag moved the swipe clip ${t0} -> ${t1}, expected -90px`);
    else console.log(`phone swipe: handle above the sheet, touch drag ${t0} -> ${t1}`);
    await shot('19-swipe-phone');
    await pressEsc();
    await sleep(200);
    if (await evaluate('!!window.__swipe.map()')) problems.push('phone: Esc did not leave swipe');
  }
}

console.log(`requests: ${nReq}${photonDown ? ` (${photonDown} failed Photon requests: public geocoder unreachable, not counted)` : ''}`);
ws.close(); cleanup();
if (problems.length) { console.error('\nFAIL'); [...new Set(problems)].forEach((p) => console.error(' -', p)); process.exit(1); }
console.log('\nPASS');
process.exit(0);
