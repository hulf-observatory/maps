// Hover-to-inspect for Building Height 2023. While that layer is visible (on the
// bench or in preview), moving the mouse shows a small chip near the cursor with
// the decoded height from the encoded companion tile: "14.5 m · ~4 floors".
// Sampling is throttled to animation frames and reads through the shared decoded
// -tile LRU in js/encoded.js, so it never janks panning.
// Phones are skipped: there is no hover on touch, and the tap gesture is already
// taken by the attribute popup.
import { samplePixel, COMPANIONS } from './encoded.js';
import { phone } from './mobile.js';

const HEIGHT_LAYER = 'buildings_height_2023';

export function initHeightHover(map, state) {
  const chip = document.createElement('div');
  chip.className = 'probe-chip';
  chip.hidden = true;
  document.getElementById('map').append(chip);

  const activeEntry = () => {
    if (state.preview && state.preview.meta.id === HEIGHT_LAYER && state.preview.visible) return state.preview;
    return state.bench.find((e) => e.meta.id === HEIGHT_LAYER && e.visible && !e.suspended) || null;
  };

  let raf = 0, last = null, seq = 0;
  const hide = () => { chip.hidden = true; };

  async function probe(ev) {
    const entry = activeEntry();
    const companion = entry && state.byId.get(COMPANIONS[HEIGHT_LAYER]);
    if (!companion) { hide(); return; }
    const my = ++seq;
    const px = await samplePixel(companion, ev.lngLat.lng, ev.lngLat.lat, map.getZoom());
    if (my !== seq) return; // a newer sample superseded this one
    if (!px || px.a === 0) { hide(); return; }
    const m = (px.r * 256 + px.g) / 10;
    const floors = Math.round(m / 3.2);
    chip.textContent = m >= 3 ? `${m.toFixed(1)} m · ~${floors} floor${floors === 1 ? '' : 's'}` : `${m.toFixed(1)} m`;
    chip.hidden = false;
    // offset so the chip never sits under the cursor; flip when near the edges
    const box = map.getContainer().getBoundingClientRect();
    let x = ev.point.x + 14, y = ev.point.y - 30;
    if (x + chip.offsetWidth + 8 > box.width) x = ev.point.x - chip.offsetWidth - 14;
    if (y < 4) y = ev.point.y + 18;
    chip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  map.on('mousemove', (ev) => {
    if (phone()) return;
    last = ev;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; probe(last); });
  });
  map.getCanvas().addEventListener('mouseleave', hide);
  map.on('movestart', hide);
  return { chip };
}
