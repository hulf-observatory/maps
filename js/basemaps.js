// Esri raster basemaps (tiles fetched directly from arcgisonline.com).
const E = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const ESRI = 'Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors, and the GIS User Community';
export const BASEMAPS = {
  gray: { title: 'Light grey', short: 'Esri', attribution: 'Esri World Light Gray Canvas. ' + ESRI,
    layers: [{ url: E + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxzoom: 16 },
             { url: E + 'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', maxzoom: 16 }] },
  imagery: { title: 'Satellite', short: 'Esri, Maxar, Earthstar Geographics', attribution: 'Esri World Imagery. Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    layers: [{ url: E + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', maxzoom: 19 }] },
  topo: { title: 'Topographic', short: 'Esri', attribution: 'Esri World Topographic Map. ' + ESRI,
    layers: [{ url: E + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxzoom: 19 }] },
  none: { title: 'None', short: '', attribution: '', layers: [] },
};
export const DEFAULT_BASEMAP = 'gray';

export function setBasemap(map, id) {
  for (const l of map.getStyle().layers) if (l.id.startsWith('bm-')) map.removeLayer(l.id);
  for (const s of Object.keys(map.getStyle().sources)) if (s.startsWith('bm-')) map.removeSource(s);
  const bm = BASEMAPS[id] || BASEMAPS[DEFAULT_BASEMAP];
  const layers = map.getStyle().layers;
  const before = layers.length > 1 ? layers[1].id : undefined; // just above the paper background
  bm.layers.forEach((l, i) => {
    const sid = `bm-${id}-${i}`;
    map.addSource(sid, { type: 'raster', tiles: [l.url], tileSize: 256, maxzoom: l.maxzoom, attribution: bm.attribution });
    map.addLayer({ id: sid, type: 'raster', source: sid, paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 100 } }, before);
  });
}
