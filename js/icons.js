// Point icons: simple 24x24 glyphs drawn in white on a coloured disc (the disc is
// a MapLibre circle layer; the glyph is an SDF image so its colour can change).
// Keys match layers.json style.icon hints. Unknown hints fall back to a plain circle.

const P = {
  hospital: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  fire: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 2 1 3 2 3 0-3-1-5 1-8z"/>',
  toilet: '<circle cx="8" cy="5" r="2.2"/><circle cx="16" cy="5" r="2.2"/><path d="M5.5 9h5v6H9v7H7v-7H5.5zM13.5 9h5l1.5 7h-2v6h-4v-6h-2z"/>',
  canteen: '<path d="M6 2h1.5v7H9V2h1.5v7c0 1.5-1 2.5-2 2.8V22h-2V11.8C5.5 11.5 4.5 10.5 4.5 9V2H6zM15 2c2.5 0 4 3 4 7s-1 5-2 5v8h-2z"/>',
  community: '<circle cx="12" cy="6" r="3"/><circle cx="5" cy="9" r="2.3"/><circle cx="19" cy="9" r="2.3"/><path d="M7 21v-5a5 5 0 0 1 10 0v5zM1 21v-4a4 4 0 0 1 5-3.8V21zM23 21v-4a4 4 0 0 0-5-3.8V21z"/>',
  anganwadi: '<circle cx="12" cy="5" r="3"/><path d="M7 11h10l-2 5h-1v6h-4v-6H9z"/>',
  market: '<path d="M3 3h18l-1 6H4zM5 11h14v10h-5v-6h-4v6H5z"/>',
  shelter: '<path d="M12 2 1 12h3v10h16V12h3zM9 21v-6h6v6z"/>',
  playground: '<path d="M3 21 8 5h2l5 16h-2l-1-3H6l-1 3zm3.6-5h4.8L9 8.5zM16 5h2v16h-2zM18 7h4v2h-4z"/>',
  park: '<path d="M12 2 5 12h3l-4 6h7v4h2v-4h7l-4-6h3z"/>',
  'open-space': '<path d="M2 20c3-6 6-9 10-9s7 3 10 9zM12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>',
  waste: '<path d="M8 2h8v2h5v2H3V4h5zM5 8h14l-1.5 14h-11z"/>',
  bin: '<path d="M9 2h6v2h5v2H4V4h5zM6 8h12l-1 14H7z"/>',
  heritage: '<path d="M12 2 2 7v2h20V7zM4 11h3v8H4zM10.5 11h3v8h-3zM17 11h3v8h-3zM2 20h20v2H2z"/>',
  metro: '<path d="M4 20V4h3l5 8 5-8h3v16h-3V10l-5 8-5-8v10z"/>',
  rail: '<path d="M7 2h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3l2 4h-2.5l-2-4h-5l-2 4H5l2-4a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm0 3v5h10V5zm1 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  bus: '<path d="M5 2h14a2 2 0 0 1 2 2v14h-2v3h-3v-3H8v3H5v-3H3V4a2 2 0 0 1 2-2zm0 3v6h14V5zm1.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm11 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  house: '<path d="M12 3 2 12h3v9h5v-6h4v6h5v-9h3z"/>',
  slum: '<path d="M1 21v-8l6-5 6 5v8zM13 21v-6l5-4 5 4v6zM5 16h4v5H5z"/>',
  'water-drop': '<path d="M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z"/>',
};

export const ICON_NAMES = Object.keys(P);

export function iconSvg(name, fill = 'currentColor') {
  const p = P[name];
  if (!p) return '';
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="${fill}" aria-hidden="true">${p}</svg>`;
}

// Render the glyph to ImageData (2x) and register as an SDF image "ico-<name>".
export async function ensureIcon(map, name) {
  const id = 'ico-' + name;
  if (!P[name] || map.hasImage(id)) return P[name] ? id : null;
  const px = 48; // 24 css px at 2x
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28" width="${px}" height="${px}" fill="#fff">${P[name]}</svg>`;
  const img = new Image(px, px);
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, px, px);
  if (!map.hasImage(id)) map.addImage(id, ctx.getImageData(0, 0, px, px), { pixelRatio: 2, sdf: true });
  return id;
}
