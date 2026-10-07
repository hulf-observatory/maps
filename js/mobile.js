// Phone bottom-sheet behaviour (≤768px), mirroring the Accessibility Atlas
// split: layout lives in the media block at the end of css/style.css, behaviour
// here. Desktop is untouched: everything below only acts while the media query
// matches, and the grab handle is only inserted the first time it does.
const mq = window.matchMedia('(max-width: 768px)');
export const PEEK = 160;
export function phone() { return mq.matches; }

let deps = null;
let installed = false;

// bottom map padding: the peek height while a sheet is up (capped at the
// sheet's real height so a nearly-closed sheet never over-pads)
export function sheetBottomPad() {
  if (!phone()) return 0;
  const bench = document.getElementById('bench');
  // note: offsetParent is null for position:fixed, so measure the rect instead
  if (!bench || bench.classList.contains('rail')) return 0;
  const hgt = Math.round(bench.getBoundingClientRect().height);
  return hgt > 0 ? Math.min(PEEK, hgt) : 0;
}

function heights() {
  const H = window.innerHeight;
  const tb = document.getElementById('topbar');
  const top = tb ? tb.offsetHeight : 0;
  return { peek: PEEK, half: Math.round(H * 0.5), full: H - top - 10 };
}

export function openBench(state = 'peek') {
  const bench = document.getElementById('bench');
  const hs = heights();
  bench.style.setProperty('--sheet-h', (hs[state] || hs.peek) + 'px');
  deps.setCol('library', true);
  deps.setCol('bench', false);
  pad();
}

// place search on a phone: the full-screen library would hide the popover and a
// tall workbench sheet would hide the results and the place picked, so fold the
// library to its pill and drop the workbench sheet to its peek height
export function makeRoomForSearch() {
  if (!phone() || !deps) return;
  const lib = document.getElementById('library'), bench = document.getElementById('bench');
  if (!lib.classList.contains('rail')) deps.setCol('library', true);
  if (!bench.classList.contains('rail') && bench.getBoundingClientRect().height > PEEK + 4) bench.style.setProperty('--sheet-h', PEEK + 'px');
  pad();
}

function pad() { deps.syncMapPadding(0); setTimeout(() => deps.syncMapPadding(0), 300); }

function grabHandle(sheet) {
  const g = document.createElement('div');
  g.className = 'sheet-grab';
  g.append(document.createElement('i'));
  sheet.prepend(g);
  let sy = 0, sh = 0, dragging = false;
  g.addEventListener('pointerdown', (e) => {
    dragging = true; sy = e.clientY; sh = sheet.getBoundingClientRect().height;
    g.setPointerCapture(e.pointerId);
  });
  g.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const hs = heights();
    sheet.style.setProperty('--sheet-h', Math.min(hs.full, Math.max(60, sh + (sy - e.clientY))) + 'px');
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const hcur = sheet.getBoundingClientRect().height;
    const hs = heights();
    if (hcur < hs.peek * 0.55) { deps.setCol('bench', true); pad(); return; } // flicked down: collapse to the pill
    const snap = [hs.peek, hs.half, hs.full].reduce((a, b) => (Math.abs(b - hcur) < Math.abs(a - hcur) ? b : a));
    sheet.style.setProperty('--sheet-h', snap + 'px');
    pad();
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
}

function install() {
  if (installed) return;
  installed = true;
  const bench = document.getElementById('bench');
  grabHandle(bench);
  // body.sheet-open lets CSS lift the (i) and breadcrumb above the peek sheet
  const mark = () => document.body.classList.toggle('sheet-open', phone() && !bench.classList.contains('rail'));
  new MutationObserver(mark).observe(bench, { attributes: true, attributeFilter: ['class'] });
  mark();
  // tapping a layer in the full-screen library previews it in a peek sheet
  document.getElementById('lib-list').addEventListener('click', (e) => {
    if (phone() && e.target.closest('.lyr')) setTimeout(() => openBench('peek'), 0);
  });
  // ‹ Back from the preview returns to the full-screen library
  document.getElementById('pv-back').addEventListener('click', () => {
    if (!phone()) return;
    deps.setCol('bench', true);
    deps.setCol('library', false);
    pad();
  });
}

export function initMobile(d) {
  deps = d;
  const apply = () => {
    if (phone()) {
      install();
      deps.setCol('library', true);   // both start as bottom pills
      deps.setCol('bench', true);
    } else {
      document.getElementById('bench').style.removeProperty('--sheet-h');
      document.body.classList.remove('sheet-open');
    }
    pad();
  };
  mq.addEventListener('change', apply);
  if (phone()) apply();
  window.__mobile = { phone, openBench }; // for the headless check
}
