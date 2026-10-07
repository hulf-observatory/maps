// Where the data lives (observatory-work/notes/open-data-scheme.md, host "D").
// Every fetch of layers.json, nav/areas.json, legends and legend pictures goes
// through dataUrl(), so the viewer works from any host (GitHub Pages at /maps/,
// a local python http.server, an iframe on the main site).
//
// For local testing the base can be overridden, in this order:
//   ?data=<url or path>      e.g. ?data=check/fixture/  (relative to the page)
//   window.DATA_BASE = '…'   set in a <script> before js/main.js runs
export const DEFAULT_DATA_BASE = 'https://data.hyderabad.urbanobservatory.in/';

function pickBase() {
  let b = new URLSearchParams(location.search).get('data') || window.DATA_BASE || DEFAULT_DATA_BASE;
  try { b = new URL(b, location.href).href; } catch { b = DEFAULT_DATA_BASE; }
  return b.endsWith('/') ? b : b + '/';
}
export const DATA_BASE = pickBase();

// Absolute URL for a catalogue path. Already-absolute URLs (layers.json carries
// absolute legend / legend_image / pmtiles_url / tile_url) pass through unchanged.
export const dataUrl = (p) => new URL(String(p), DATA_BASE).href;
