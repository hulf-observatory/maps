# Spatial Data Repository: map viewer

The Hyderabad Urban Observatory's map viewer: a static site (vanilla ES modules, no
build step, MapLibre GL JS 5 and pmtiles.js vendored) that reads the Observatory's
open data straight from where it is published. Live at
**https://maps.hyderabad.urbanobservatory.in/** (GitHub Pages, this repo's `main`).

## Where the data comes from

The viewer has no data of its own and no server. Everything follows the open data
scheme ([SCHEME.md in hyderabad-data](https://github.com/hulf-observatory/hyderabad-data/blob/main/SCHEME.md)):

| | URL | Holds |
|---|---|---|
| **D** | `https://data.hyderabad.urbanobservatory.in/` | `layers.json` (the catalogue), vector PMTiles + GeoParquet, legends, `nav/areas.json` |
| **W** | `https://hyd-tiles.hulf-observatory.workers.dev` | raster tiles `/r/<release>/<id>/{z}/{x}/{y}.<ext>`, read from the GitHub Releases of `hulf-observatory/hyderabad-data` |

- `DATA_BASE` (D) is the one constant, in `js/config.js`. Every fetch of
  `layers.json`, `nav/areas.json`, legend JSON and legend pictures resolves against
  it, so the page works from any host (`/maps/` on Pages, a local server, an iframe).
- **Vector layers** carry `pmtiles_url`; the source is
  `{ type: 'vector', url: 'pmtiles://' + pmtiles_url }` (range requests through the
  `pmtiles` protocol, registered once in `js/main.js`).
- **Raster / terrain / encoded layers** carry an absolute `tile_url` template used as
  is; the release tag is the version, nothing is appended.
- Each layer's **Details** shows its licence and a **Download** link from `download`
  (GeoParquet for vectors, the PMTiles archive for rasters; cross-origin, so the link
  opens the file).
- Raster cards and the preview show a small **Loading…** chip while MapLibre still has
  tiles in flight for that source.

Other hosts the browser talks to: Esri (`*.arcgisonline.com`) for the basemaps and the
public Photon geocoder (`photon.komoot.io`, OpenStreetMap data) for the place search,
which receives only the typed text.

## Run it locally

```bash
python3 dev-server.py              # http://127.0.0.1:8124/  (plain static server, no-cache)
# or: python3 -m http.server 8124
```

The page reads the live catalogue. To point it elsewhere, add `?data=<url or path>`
(or set `window.DATA_BASE` before `js/main.js` loads), e.g.
`http://127.0.0.1:8124/?data=check/fixture/` for the two test layers.

Useful URLs:

- `/?layers=id1,id2` preloads workbench cards (first id is drawn on top). Adding from
  the library keeps points > lines > polygons > rasters banding; a new polygon slots
  among the polygons by bounds-box area (smaller extents draw above larger ones);
  manual drag reorder afterwards wins.
- `/?embed=1&layers=...` hides the header and library and starts with the workbench
  folded to a rail (the main site's map iframes). `/?view=lat,lng,zoom` sets the start view.

## Check

```bash
node check/check.mjs --fixture --shots   # the two test layers on the real hosts; writes screenshots/
node check/check.mjs                     # the live catalogue (needs layers.json at DATA_BASE)
node check/check.mjs --data URL          # any other catalogue base
node check/check.mjs --no-phone          # skip the 390x844 phone-viewport pass
node check/check.mjs --no-photon         # block photon.komoot.io: test the search fallback
bash tools/check-place-search.sh         # place-search.js matches the City Timeline copy
```

No npm dependencies: it drives `/Applications/Google Chrome.app` headless over the
DevTools protocol with Node's built-in WebSocket (Node 22+). It starts `dev-server.py`,
opens the viewer, previews a layer, adds one layer of each kind that exists, turns on
colour-by and labels, drags a style slider, clicks a feature for the popup, folds both
columns to rails, tries 3D terrain, the embed URL, Reset and the tour, drives the
built-up year slider and the height hover chip when those layers are in the catalogue,
exercises the breadcrumb, the place search (Photon, with the "unavailable" fallback
when it is unreachable), swipe compare, and runs a 390x844 phone pass.

It fails on console errors, exceptions, failed or 4xx/5xx requests, a library that
doesn't list every layer, a card that shows an error, or any request to a host other
than the own origin, D, W, `*.arcgisonline.com`, `photon.komoot.io` and the
`github.com` / `objects.githubusercontent.com` download redirects.

`check/fixture/layers.json` is a two-layer catalogue in the live schema pointing at the
test files that exist on D and W (`test/synthetic.pmtiles`, release `test-0`
`synthetic_raster`); `check/fixture/nav/areas.json` feeds the breadcrumb.

## Files

```
index.html           page shell: header, library, workbench/preview, map toolbar
css/style.css        :root tokens shared with the Accessibility Atlas + viewer components
js/config.js         DATA_BASE and dataUrl(): the one place that knows where the data lives
js/main.js           state, library, preview, workbench cards, popup, toolbar, URL params, loading chip
js/layers.js         layers.json entry + settings -> MapLibre sources/layers; colour-by classes
js/breadcrumb.js     HMDA › Corporation › Zone › Ward pill (lazy-loaded on first idle)
js/mobile.js         phone (≤768px) bottom-sheet behaviour; layout in the media block of style.css
js/icons.js          point icon glyphs (inline SVG -> SDF image via map.addImage)
js/basemaps.js       Esri Light Grey (default), Imagery, Topographic, None
js/measure.js        measure distance tool
js/encoded.js        encoded data companions: decode + LRU cache + sampler + yearfilter protocol
js/yearslider.js     year slider/play control for the built-up layer
js/hoverheight.js    hover chip for Building Height 2023
js/swipe.js          swipe compare: a raster vs the map beneath it (second, clipped map)
js/tour.js           guided walkthrough (lazy-loaded)
js/place-search.js   place search (areas + Photon); identical copy in the City Timeline
vendor/              maplibre-gl 5.x js+css, pmtiles.js 4.5, Archivo/Outfit fonts, Noto Sans glyph PBFs
tools/make_areas.py  writes nav/areas.json for the breadcrumb and search (python + GDAL)
tools/check-place-search.sh  fails if place-search.js differs from the City Timeline copy
dev-server.py        plain static server for local work
check/check.mjs      headless check; check/fixture/ is its two-layer test catalogue
screenshots/         output of the check with --shots (not in git)
```

## How layers.json drives everything

On load the viewer fetches `<DATA_BASE>layers.json` (`cache: no-cache`) and:

- builds the library from `groups` (sorted by `order`) and `layers` (by `order`, then
  title). Layers whose `group` is unknown land in an extra group. An optional
  `subgroup` nests a layer under a collapsible sub-header inside its group; search
  shows matches flat with the subgroup named on the row.
- builds each map layer from `kind` + `geom`:
  - `vector` + `point`: circle layer, plus an icon on top if `style.icon` names a
    known icon (`js/icons.js`); `line`: line layer; `polygon`: fill + outline. Every
    vector layer also gets a hidden label layer used by the Label dropdown. The source
    is the layer's PMTiles archive; MapLibre reads its TileJSON through the protocol.
  - `raster`: raster source from `tile_url`, `tileSize` = `tile_size` (default 256),
    `raster-resampling: linear`.
  - `terrain` (`encoding: terrarium`): raster-dem source + hillshade; the 3D toggle
    uses `map.setTerrain` on a second copy of the source.
- sources get `minzoom`, `maxzoom` and `bounds` from the entry, so MapLibre overzooms
  beyond `maxzoom` up to z19.
- `fields` feed the Colour by and Label dropdowns and the popup's attribute order.
- `title`, `description`, `feature_count`, `date`, `source_name`, `source_url`,
  `attribution`, `licence`, `download` show in the preview's Details; the Sources (i)
  panel lists attribution for what is on the map plus the basemap.
- `style.palette` (`{field, values: {value: colour}}`) is the layer's default styling:
  a categorical match on that field, grey for anything not in `values`.
- `legend` (baked legend JSON) and `legend_image` (legend picture) are shown on the
  card instead of a colour key; both are URLs under D.
- `bounds` drive the preview's zoom-to-layer.

All optional fields may be missing. Each layer is built inside try/catch: a bad layer
shows a small note on its card and the rest of the app keeps working.

## Encoded data companions (year slider, hover heights)

Two layers ship a second, pixel-encoded copy of themselves, registered with
`display: false` (the library never lists them; `byId` still resolves them):

- `builtup_first_year` → `builtup_first_year_encoded` (PNG, z8–13): alpha 0 = never
  built; R ≥ 5 → year = R + 1980. Stray low codes are read as 2015.
- `buildings_height_2023` → `buildings_height_2023_encoded` (PNG, z8–16):
  height_dm = R·256 + G, metres = dm/10; alpha 0 = no building.

`COMPANIONS` in `js/encoded.js` maps display id to companion id. That module fetches
the companion tiles from their `tile_url` template on W, decodes via
`createImageBitmap` + `OffscreenCanvas`, and keeps a shared LRU of ~100 decoded tiles.

**Year range filter** (`js/yearslider.js`): a `yearfilter://<companion>/<lo>-<hi>/<palette>/{z}/{x}/{y}`
MapLibre protocol re-colours each decoded tile (lo ≤ first-built-year ≤ hi gets that
year's ramp colour, the rest transparent). Two keyboard-accessible handles on the
gradient bar; ▶ sweeps hi to 2023; Esc stops. Tiles are re-coloured from the LRU, never
refetched. Palettes (`PALETTES`): Viridis from the baked legend, Magma, warm, cool,
Cividis. At the full range the original display layer shows.

**Hover heights** (`js/hoverheight.js`): while Building Height 2023 is visible,
mousemove samples the companion pixel under the cursor and shows a chip ("14.5 m · ~4
floors"). Skipped on phones.

## Swipe compare (js/swipe.js)

Every raster card has a **Swipe** word in its head. Left of the divider is the map as it
is, right of it the same map without that layer. Drag the ⟷ handle or use ←/→ (5% a
step; Home/End). One layer at a time; Esc, removing or hiding the layer, opening a
preview or ↻ Reset leaves swipe. Not offered in `?embed=1`.

How: a second `maplibregl.Map` (`#map-compare`) sits over the main map with
`pointer-events: none` and `clip-path: inset(0 0 0 Xpx)`, holding the basemap and every
bench entry except the swiped one. It follows the main camera on every `move`.

## Guided tour (js/tour.js)

A no-library walkthrough: a dim mask with a cut-out over each element and a card beside
it. It auto-starts on every fresh load (never in `?embed=1`) and from the round ? button.
Esc or Skip closes it for that page view. The headless check sets `window.__NO_TOUR`
before page scripts run. Phones get a simplified 4-step version.

## Place search (js/place-search.js)

The magnifier at the top of the toolbar opens a popover with one search box. Local areas
first (corporations, zones, wards from `nav/areas.json`), then OpenStreetMap places from
the public Photon geocoder (from 3 characters, 300 ms after the last key, `bbox=` HMDA,
`limit=6`). Photon receives the query text only, no referrer, no cookies. If it fails, the
local rows stay plus a quiet "Place search unavailable" line. Keys: ↑/↓, Enter, Esc. Not
offered in `?embed=1`.

**One module, two apps.** The same file, byte for byte, serves the City Timeline
(`../timeline/place-search.js`). Change it here, copy it over, and run
`bash tools/check-place-search.sh`. The Accessibility Atlas keeps its own copy in
Amruth's repo (`amruthkiran94/hyderabad-urban-observatory`).

## Reset vs Home

⌂ (toolbar) is camera-only. ↻ in the top bar is "start over": after an in-place confirm,
it restores the first-visit page (the catalogue's `default_visible` layers, default
basemap, cleared search, start view, clean URL) and starts the tour.

## Breadcrumb (nav/areas.json)

The pill at the bottom-left of the map shows where the map centre is (HMDA ›
Corporation › Zone › Ward). It is driven by `<DATA_BASE>nav/areas.json`, written by
`python3 tools/make_areas.py` from the boundary GeoPackages. Only wards carry geometry
(simplified rings); the viewer ray-casts the map centre against them. If the file is
missing the breadcrumb simply doesn't appear; `?embed=1` never shows it.

## Phone layout (≤768px)

The desktop layout is untouched; everything phone-specific is the media block at the end
of `css/style.css` plus `js/mobile.js`. The map fills the screen and the columns become
sheets: the library is a full-screen sheet opened from a bottom-left pill; preview and
workbench share a bottom sheet that peeks at 160 px and drags to half or full height.

## Authoring styles

Styles live in `layers.json` `style`: `color`, `fill`, `fill_opacity`, `line_width`,
`icon` (one of the names in `js/icons.js`), `palette: { field, values }`. Without a
palette, Colour by makes its own classes: text fields get distinct colours for the 10
most common values seen in the loaded tiles; number fields get 5 quantile classes.
User changes in the viewer are not saved anywhere (↺ resets a card).

## Deploy

Push to `main`; GitHub Pages serves the repo root (`.nojekyll` keeps the glyph folder
names intact). There is nothing to build and no server to run: the data is published
separately to D and W by the release script.
