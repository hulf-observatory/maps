// Measure distance: click to add points, double-click or Esc to stop.
export function initMeasure(map, { box, val, btn, onStart }) {
  let on = false; let pts = [];
  const fc = () => ({ type: 'FeatureCollection', features: [
    ...(pts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} }] : []),
    ...pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} })) ] });
  const km = () => { let d = 0; for (let i = 1; i < pts.length; i++) d += hav(pts[i - 1], pts[i]); return d; };
  function draw() {
    const src = map.getSource('measure');
    if (src) src.setData(fc());
    const d = km();
    val.textContent = pts.length < 2 ? 'Click the map to add points' : (d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(2) + ' km');
  }
  function start() {
    on = true; pts = []; onStart && onStart();
    if (!map.getSource('measure')) {
      map.addSource('measure', { type: 'geojson', data: fc() });
      map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#111111', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'measure-pts', type: 'circle', source: 'measure', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#F4F1E8', 'circle-stroke-color': '#111111', 'circle-stroke-width': 2 } });
    }
    map.doubleClickZoom.disable();
    box.hidden = false; btn.setAttribute('aria-pressed', 'true'); draw();
  }
  function stop() {
    on = false; pts = [];
    for (const id of ['measure-line', 'measure-pts']) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource('measure')) map.removeSource('measure');
    map.doubleClickZoom.enable();
    box.hidden = true; btn.setAttribute('aria-pressed', 'false'); map.getCanvas().style.cursor = '';
  }
  btn.addEventListener('click', () => (on ? stop() : start()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && on) stop(); });
  map.on('click', (e) => { if (!on) return; pts.push([e.lngLat.lng, e.lngLat.lat]); draw(); });
  return { active: () => on, stop };
}
function hav(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
