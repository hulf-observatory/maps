// Breadcrumb: HMDA › Corporation › Zone › Ward, bottom-left of the map (it
// clears the open columns; main.js repositions it with the same measurement the
// map padding uses). Driven by /nav/areas.json (written by tools/make_areas.py);
// missing areas.json just means no breadcrumb. Loaded lazily on first idle.
//
// Each segment is TWO controls: the name (click = zoom to that area) and a caret
// (click = a menu of that level's alternatives — the corporations, the current
// corporation's zones, the current zone's wards). "HMDA" is a plain button with
// no menu: it just zooms to the whole extent. The ward menu carries a filter
// input, since a zone can hold dozens of wards.
// Point-in-polygon is even-odd ray casting over the wards' simplified rings.

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

// rings: flat [x0,y0,x1,y1,...] arrays (outer rings + holes together)
function inRings(x, y, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      j = i;
    }
  }
  return inside;
}

export async function initBreadcrumb(map, { fitTo, loadAreas }) {
  let areas;
  try {
    // main.js shares one fetch of areas.json with the place search
    if (loadAreas) areas = await loadAreas();
    else {
      const r = await fetch('nav/areas.json', { cache: 'no-cache' });
      if (!r.ok) return;
      areas = await r.json();
    }
  } catch { return; }
  if (!areas || !Array.isArray(areas.wards)) return;

  const el = h('div');
  el.id = 'crumb';
  document.getElementById('map-wrap').append(el);
  document.addEventListener('click', (e) => { if (!el.contains(e.target)) closeMenus(); });

  function closeMenus() {
    el.querySelectorAll('.crumb-menu').forEach((m) => { m.hidden = true; });
    el.querySelectorAll('.crumb-caret').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  // A breadcrumb level: name button (zoom to the area) + caret button (menu of
  // this level's alternatives). current marks the deepest resolved level.
  function seg(label, bounds, items, { current = false, filter = false } = {}) {
    const wrap = h('span', 'crumb-seg' + (current ? ' current' : ''));
    const name = h('button', 'crumb-name', label);
    name.type = 'button';
    name.title = 'Zoom to ' + label;
    name.addEventListener('click', () => { closeMenus(); fitTo({ bounds }); });
    wrap.append(name);
    if (items && items.length) {
      const caret = h('button', 'crumb-caret', '');
      caret.type = 'button';
      caret.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>';
      caret.title = 'Choose another';
      caret.setAttribute('aria-label', 'Choose another');
      caret.setAttribute('aria-haspopup', 'menu');
      caret.setAttribute('aria-expanded', 'false');
      const menu = h('div', 'crumb-menu');
      menu.hidden = true;
      menu.setAttribute('role', 'menu');
      const list = h('div', 'crumb-menu-list');
      if (filter) {
        const inp = h('input', 'crumb-filter');
        inp.type = 'search';
        inp.placeholder = 'Filter…';
        inp.setAttribute('aria-label', 'Filter the list');
        inp.addEventListener('input', () => {
          const q = inp.value.trim().toLowerCase();
          list.querySelectorAll('button').forEach((b) => { b.hidden = q && !b.textContent.toLowerCase().includes(q); });
        });
        inp.addEventListener('click', (e) => e.stopPropagation());
        menu.append(inp);
      }
      for (const it of items) {
        const b = h('button', null, it.label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        if (it.kind) b.dataset.kind = it.kind;
        b.addEventListener('click', () => { closeMenus(); fitTo({ bounds: it.bounds }); });
        list.append(b);
      }
      menu.append(list);
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
        if (open && filter) { const inp = menu.querySelector('.crumb-filter'); inp.value = ''; list.querySelectorAll('button').forEach((b) => { b.hidden = false; }); }
      });
      wrap.append(caret, menu);
    }
    return wrap;
  }

  const corpItems = areas.corporations.map((c, i) => ({ label: c.name, bounds: c.bounds, kind: 'corp', i }));
  let currentWard = null; // -1 = outside all wards, null = not located yet

  function render() {
    el.innerHTML = '';
    // HMDA: plain zoom button, no menu (only levels that resolve get segments)
    el.append(seg('HMDA', areas.hmda.bounds, null, { current: currentWard == null || currentWard < 0 }));
    if (currentWard == null || currentWard < 0) return;
    const w = areas.wards[currentWard];
    const z = areas.zones[w.zone];
    const c = areas.corporations[z.corp];
    const zoneItems = areas.zones.filter((zz) => zz.corp === z.corp).map((zz) => ({ label: zz.name, bounds: zz.bounds, kind: 'zone' }));
    const wardItems = areas.wards.filter((ww) => ww.zone === w.zone).map((ww) => ({ label: (ww.no != null ? ww.no + ' · ' : '') + ww.name, bounds: ww.bounds, kind: 'ward' }));
    el.append(h('span', 'crumb-sep', '›'), seg(c.name, c.bounds, corpItems),
      h('span', 'crumb-sep', '›'), seg(z.name, z.bounds, zoneItems),
      h('span', 'crumb-sep', '›'), seg(w.name, w.bounds, wardItems, { current: true, filter: true }));
  }

  function locate() {
    const c = map.getCenter();
    const x = c.lng, y = c.lat;
    let found = -1;
    // cheap bounds check first, ray casting only on candidates
    for (let i = 0; i < areas.wards.length; i++) {
      const b = areas.wards[i].bounds;
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inRings(x, y, areas.wards[i].poly)) { found = i; break; }
    }
    if (found !== currentWard) { currentWard = found; render(); }
  }

  // moveend fires once per gesture; the trailing timer just coalesces bursts
  let t = null;
  map.on('moveend', () => { clearTimeout(t); t = setTimeout(locate, 150); });
  locate();
}
