# Spatial Data Repository: map viewer

The Hyderabad Urban Observatory's self-hosted replacement for Felt. It is a static
site (vanilla ES modules, no build step, MapLibre GL JS 5 vendored), with the same
design system as the Accessibility Atlas.

**Design rule: hard to download, easy to view.** The browser only ever gets map
tiles, served from the same origin under `/tiles/`. There are no whole-file URLs,
no `.pmtiles` in the browser, no pmtiles.js protocol, and no export or download
buttons. URLs only ever carry layer ids (`?layers=a,b`), never data.

## Run it

```bash
cd "hyderabad-urban-observatory/spatial data repository"
python3 dev-server.py            # http://127.0.0.1:8124/
```

`dev-server.py` (Python stdlib only):

- serves the viewer files,
- serves `/layers.json` from `../../observatory-data/published/layers.json`
  (`--published PATH` or `PUBLISHED_DIR=...` to change it),
- reverse-proxies `/tiles/*` to `pmtiles serve` on `127.0.0.1:8081`, and starts
  `pmtiles serve <published>/serve --interface=127.0.0.1 --port=8081` itself if
  nothing is listening there yet.

`python3 dev-server.py --fixture` uses the small test set in `check/fixture/`
(wards, slums, 2BHK points, rail lines, the 1911 map, a synthetic terrain) with its
own tile server on port 8082, so it never collides with the real one.

Useful URLs:

- `/?layers=id1,id2` preloads workbench cards (first id is drawn on top).
  Adding from the library keeps points > lines > polygons > rasters banding,
  and a new polygon slots among the polygons by bounds-box area (smaller
  extents draw above larger ones); manual drag reorder afterwards wins.
- `/?embed=1&layers=...` hides the header and library and starts with the
  workbench folded to a rail, for replacing Felt iframes later.

## Check

```bash
node check/check.mjs --fixture --shots   # test fixture, writes screenshots/
node check/check.mjs                     # whatever is in published/ right now
node check/check.mjs --no-phone         # skip the 390x844 phone-viewport pass
node check/check.mjs --no-photon        # block photon.komoot.io: test the search fallback
bash tools/check-place-search.sh        # the three copies of place-search.js are identical
```

No npm dependencies: it drives `/Applications/Google Chrome.app` headless over
the DevTools protocol with Node's built-in WebSocket (Node 22+). It starts its own
dev server, opens the viewer, previews a polygon layer, adds one layer of each kind
that exists (icon points, points, lines, areas, raster, terrain), turns on colour-by,
clicks a feature for the popup, folds both columns to rails, tries 3D terrain and
the embed URL. It also asserts that a `style.palette` layer draws more than one
colour, that the breadcrumb appears and its HMDA menu lists the 4 corporations,
and (unless `--no-phone`) runs a 390x844 phone pass that walks
library → preview peek sheet → add → workbench sheet at half height.
It also drives the built-up year slider (year 2000 must produce recoloured
`yearfilter` tiles, counted on `window.__yearfilterTiles`, and ▶ must advance
and stop on Esc), fires a mousemove over a built pixel of the encoded height
tile (via `window.__encoded`) and expects a plausible hover chip, exercises the
breadcrumb (HMDA plain, corporation caret menu, ward filter), and the tour
(auto-starts on a cleared profile, skip persists the seen flag, ? restarts;
every other pass pre-seeds the flag with `Page.addScriptToEvaluateOnNewDocument`
so the tour stays out of the way).
The swipe pass adds the 1854 Hyderabad plan (or another raster) over the old city,
clicks its Swipe button and asserts a second map canvas whose style has the
basemap and the other bench layers but none of the swiped entry, a divider at
the visible map centre, a real pointer drag and → key moving the clip, opacity
and basemap changes reaching the compare map, a real drag over the right half
panning the main map with the compare centre equal to within 1e-9, and Esc /
hiding the layer tearing the compare map down; the phone pass checks the handle
sits above the half sheet and follows a touch drag (screenshots 18, 19).
The place-search pass opens the magnifier, types "Charminar" key by key (desktop)
and "Ameerpet" (phone), waits for Photon's OpenStreetMap rows, checks the combobox
roles, ↓ / aria-activedescendant and the credit line, picks the first OSM row and
asserts the map moved inside HMDA with a marker, then Esc clears marker and popover
(screenshots 20–23). If Photon is unreachable from the test machine, its failed
requests are not counted and the pass instead expects the "Place search
unavailable" line and picks a local area.
It fails on console errors, exceptions, failed or 4xx/5xx requests,
any request to a host other than the own origin, `*.arcgisonline.com` and
`photon.komoot.io`, a library that doesn't list every layer, or a card that shows
an error.

## Files

```
index.html           page shell: header, library, workbench/preview, map toolbar
css/style.css        :root tokens copied verbatim from the Accessibility Atlas + viewer components
js/main.js           state, library, preview, workbench cards, popup, toolbar, URL params
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
js/place-search.js   place search (areas + Photon); identical copy in the timeline and the atlas
vendor/              maplibre-gl 5.x js+css, Archivo/Outfit fonts, Noto Sans glyph PBFs for labels
tools/make_areas.py  writes published/nav/areas.json for the breadcrumb and search (python + GDAL)
tools/check-place-search.sh  fails if the three copies of place-search.js differ
dev-server.py        local server (see above)
nginx/maps.conf      production template; nginx/maps-security-headers.conf is its header snippet
check/check.mjs      headless check; check/fixture/ is its small test data set
screenshots/         output of the check with --shots
```

## How layers.json drives everything

The viewer has no layer list of its own. On load it fetches `/layers.json` and:

- builds the library from `groups` (sorted by `order`) and `layers` (by `order`,
  then title). Layers whose `group` is unknown land in an extra group. An
  optional `subgroup` string nests a layer one level deeper under a collapsible
  sub-header inside its group (e.g. the 2031 land use sheets under "GHMC
  Circles" / "Mandals"); search shows matches flat with the subgroup named on
  the row. In the Boundaries group explicit `order:` fields run fine → coarse
  (wards first, districts last).
- builds each map layer from `kind` + `geom`:
  - `vector` + `point`: circle layer, plus an icon on top if `style.icon` names a
    known icon (see `js/icons.js`); `line`: line layer; `polygon`: fill + outline.
    Every vector layer also gets a hidden label layer used by the Label dropdown.
  - `raster`: raster source with `tileSize` = `tile_size` (default 256),
    `raster-resampling: linear`.
  - `terrain` (`encoding: terrarium`): raster-dem source + hillshade; the 3D toggle
    uses `map.setTerrain` on a second copy of the source.
- sources get `tiles: [tile_url + ?v=version]`, `minzoom`, `maxzoom` and `bounds`
  from the entry, so MapLibre overzooms beyond `maxzoom` up to z19.
- `fields` feed the Colour by and Label dropdowns and the popup's attribute order.
- `title`, `description`, `feature_count`, `date`, `source_name`, `source_url`,
  `attribution` show in the preview column and the Sources (i) panel, which also
  carries the basemap attribution (there is no separate attribution chip).
- `style.palette` (`{field, values: {value: colour}}`) is the layer's default
  styling: a categorical match on that field (fill and outline for polygons),
  with grey for anything not in `values`. The card key lists the palette rows;
  "Edit style" overrides it and the card's ↺ restores it.
- `bounds` drive the preview's zoom-to-layer.

All optional fields may be missing. Each layer is built inside try/catch: a bad
layer shows a small note on its card and the rest of the app keeps working.
Reloading the page picks up a rewritten `layers.json`.

## Encoded data companions (year slider, hover heights)

Two layers ship a second, pixel-encoded copy of themselves, registered by the
publish pipeline with `display: false` — the library never lists them, `byId`
still resolves them (`js/main.js` filters the library on `display !== false`):

- `builtup_first_year` → `builtup_first_year_encoded` (PNG, z8–13): alpha 0 =
  never built; R ≥ 5 → year = R + 1980. There is no 2016 value; stray low codes
  are read defensively as 2015.
- `buildings_height_2023` → `buildings_height_2023_encoded` (PNG, z8–16):
  height_dm = R·256 + G, metres = dm/10; alpha 0 = no building.

The display-id → companion-id map is `COMPANIONS` in `js/encoded.js`, which is
the only module that touches the encoded tiles: it fetches them from `/tiles/`,
decodes via `createImageBitmap` + `OffscreenCanvas` (Image + canvas fallback),
and keeps a shared LRU of ~100 decoded `ImageData` tiles.

**Year range filter** (`js/yearslider.js`, the one control above Edit style on
the built-up card and preview — it suppresses the baked legend, because its
ramp IS the legend): a `yearfilter://<companion>/<lo>-<hi>/<palette>/{z}/{x}/{y}`
MapLibre protocol re-colours each decoded tile — cells with
lo ≤ first-built-year ≤ hi get that year's ramp colour (LUT from the baked
legend stops; built-in ramps in `PALETTES`), the rest turn transparent. The
gradient bar carries two keyboard-accessible handles (two overlapped native
range inputs; only the thumbs take pointer events). Readout: "Built 1992–2015",
or "Built by 2015" when lo is 1985. Moving a handle calls `setTiles` with the
new URL; tiles are re-coloured from the LRU, never refetched (~80 ms debounce).
▶ sweeps hi from lo to 2023 at ~350 ms/step (from hi=lo again when already at
2023); Esc, ⏸ or leaving stops it. At the full range the original display
layer shows for fidelity. The check counts produced tiles on
`window.__yearfilterTiles`.

**Raster palettes**: baked rasters are pictures — only opacity, brightness and
contrast can honestly change, so they get no palette control. The built-up
layer draws through the protocol, so its Edit style offers a Palette dropdown
(Viridis default from the baked legend, plus Magma, warm, cool and Cividis as
a colour-blind-safe option — `PALETTES` in `js/encoded.js`). The choice lives
in `settings.palette`, carries through Add to workbench, and ↺ restores
Viridis. Building Height 2023 keeps its baked picture: repaletting it would
mean routing its display through a second "bands" protocol mode; skipped as
not worth the extra machinery for now.

**Hover heights** (`js/hoverheight.js`): while Building Height 2023 is visible,
mousemove (rAF-throttled) samples the companion pixel under the cursor through
the same cache and shows a chip — "14.5 m · ~4 floors" (floors = m/3.2, omitted
under 3 m). Skipped on phones: no hover on touch, and tap is the popup's.

## Swipe compare (js/swipe.js)

Every raster card on the workbench (scans, imagery, land use, built-up) has a
**Swipe** word in its head. It compares that layer with the map beneath it: left
of the divider is the map as it is, right of it the same map without that
layer. Drag the round ⟷ handle (mouse or touch), or focus it and use ←/→ (5% a
step; Home/End). A pill at the top of the divider names the layer and points to
its side ("◀ 1854 Plan of Hyderabad"). One layer at a time: Swipe on another
raster switches, the active card reads **Swiping**; clicking it again, Esc,
removing or hiding the layer, opening a preview or ↻ Reset leaves swipe. Not
offered in `?embed=1`, and never carried in the URL.

How: MapLibre cannot clip one layer, so this is the two-map technique. A second
`maplibregl.Map` (`#map-compare`, created only when swipe starts, `map.remove()`d
when it ends) sits over the main map with `pointer-events: none` and
`clip-path: inset(0 0 0 Xpx)`. It holds the basemap and every bench entry except
the swiped one, built by the same `buildEntry`/`applySettings`/`syncYearLayer`.
Its entries are shadows, `Object.create(benchEntry)` with their own layer ids,
so settings, visibility, colour-by classes and the built-up year range are read
live from the bench. main.js calls `swipe.refresh()` wherever it re-applies the
main map (safeApply, applyOrder, add/remove, Clear all, basemap, the year range);
the compare map then catches up in the same call. All input goes to the main map;
on every `move` the compare map `jumpTo`s the same centre, zoom, bearing, pitch
and padding, and redraws in the main map's frame. The divider starts at the
centre of the visible map (right of the columns); on a phone the handle sits in
the middle of the map band above the workbench sheet.

What stays main-map only: the measure line (it shows left of the divider only),
the hover-height chip and the breadcrumb (both read the main map, which is fine).
Popups work on both sides: only vector layers open popups, and those are the
same on both sides (the swiped layer is always a raster). A second map doubles
tile requests while swiping (mostly from the browser cache).

## Guided tour (js/tour.js)

A no-library walkthrough: a dim mask with a soft rounded cut-out over each real
element and a card beside it (Back / Next / Skip, step dots). It auto-starts on
every fresh page load and refresh (skippable; `?layers=` links included, never
in `?embed=1`), and any time from the round ? button in the top bar. Esc or
clicking the dim closes it for that page view. ↻ Reset also restarts it. The
headless check sets `window.__NO_TOUR` before page scripts run to keep it out
of unrelated flows. Phones get a simplified 4-step version (pills, toolbar,
sources). Steps whose element is missing (e.g. breadcrumb not loaded yet) are
skipped.

## Place search (js/place-search.js)

The magnifier at the top of the map toolbar opens a white popover (the basemap
menu's style) with one search box. "Search layers" in the library is separate: it
filters the catalogue, this one moves the map.

- **Local first:** corporations, zones and wards from `nav/areas.json` (the file
  the breadcrumb uses; one shared fetch), matched on the name (exact, prefix, word
  start, anywhere; the wards of a zone only when no name matches), up to 5 rows.
- **Then OpenStreetMap places** from the public [Photon](https://photon.komoot.io)
  geocoder (komoot; built for search-as-you-type, unlike Nominatim whose usage
  policy forbids autocomplete): from 3 characters, 300 ms after the last key, the
  previous request aborted, `bbox=` HMDA (78.00,16.96,79.05,17.90, results outside
  dropped), `limit=6`, `lang=en`. Each row: name, a short context line (locality /
  district / city) and a kind (Locality, Station, Road...).
- **Privacy:** Photon receives the query text only: no map position, no referrer
  (`referrerPolicy: no-referrer`), no cookies. The credit line "Search by Photon ·
  © OpenStreetMap contributors" shows under the results, and Sources lists it.
- **Failure:** Photon errors or a 5 s timeout leave the local rows plus a quiet
  "Place search unavailable" line. Nothing throws.
- **Keys:** ↑/↓ move through the rows (`role=combobox` + `listbox`,
  `aria-activedescendant`), Enter picks (the first row if none is active), Esc
  clears the marker and closes the popover. Mouse and touch pick directly.
- **A pick** fits the map to the place's extent when it has one (areas, OSM ways
  and boundaries; max zoom 16) or flies to its point at zoom 15, and drops a small
  marker (`.ps-marker`), cleared by the next search or Esc.
- **Phones:** the popover opens left of the magnifier within the screen;
  `mobile.js` folds the library and drops the workbench sheet to its peek first,
  and a pick closes the popover so the map shows.
- Not offered in `?embed=1`.

**One module, three apps.** The same file, byte for byte, serves the City
Timeline (`city timeline/place-search.js`) and the Accessibility Atlas
(`accessibility atlas/frontend/js/place-search.js`). Each app passes its own local
list and styles the `ps-*` elements with its own tokens. Change it here, copy it
over the other two, and run `bash tools/check-place-search.sh` (exit 1 if they
differ).

## Reset vs Home

⌂ (toolbar) is camera-only: back to the start view, layers untouched. ↻ in the
top bar is "start over": after an in-place confirm (skipped when the bench is
already the default), it restores the first-visit page — the catalog's
`default_visible` layers with default styles, default basemap, cleared search,
start view, clean URL — and starts the tour. The URL also stays clean whenever
the bench equals the default set.

## Breadcrumb (nav/areas.json)

The pill at the bottom-left of the map (it slides right of the open columns,
via the `--crumb-left` variable set in `syncMapPadding`) shows where the map
centre is (HMDA › Corporation › Zone › Ward). Each level is two controls: the
name zooms to that area, the caret beside it opens that level's alternatives
(the corporations, the corporation's zones, the zone's wards — the ward list
has a type-to-filter). HMDA is a plain zoom button with no menu, and only
levels that resolve get segments. It is driven by
`<published>/nav/areas.json`, written by `python3 tools/make_areas.py` from the
boundary GeoPackages in `Spatial_Data_Repositoy/Vector/Boundaries/` (read-only).
Rerun the script when those change. If the file is missing the breadcrumb simply
doesn't appear; `?embed=1` never shows it. Format (minified, ~130 KB):

```jsonc
{
  "schema": 1,
  "hmda":        { "bounds": [w, s, e, n] },
  "corporations": [ { "name", "bounds" } ],                       // sorted by name
  "zones":        [ { "name", "corp": <corporations index>, "bounds" } ],
  "wards":        [ { "no", "name", "zone": <zones index>, "bounds",
                      "poly": [ [x0,y0,x1,y1,...], ... ] } ]      // flat rings
}
```

Only wards carry geometry (simplified to ~65 m, 4-decimal coords): the viewer
ray-casts the map centre against the ward rings (even-odd, so holes work) and
derives zone and corporation from the ward's indices. Outside every ward the pill
shows just "HMDA".

## Phone layout (≤768px)

The desktop layout is untouched; everything phone-specific is the media block at
the end of `css/style.css` (layout) plus `js/mobile.js` (behaviour), mirroring the
Accessibility Atlas split. On a phone the map fills the screen and the columns
become sheets: the library is a full-screen sheet opened from a bottom-left pill;
tapping a layer previews it in a bottom sheet that peeks at 160 px (title + Add)
and drags to half or full height on the grab handle (drag below the peek to
dismiss); the workbench is the same sheet. `mapPadding()` returns no left padding
and instead pads the bottom by the open sheet's peek height. The breadcrumb
collapses to its deepest level, and toolbar/top-bar targets grow to 44 px.

## Authoring styles later

Styles live in `layers.json` `style`, written by the bake:

- `color`: line/point colour and polygon outline; `fill`, `fill_opacity`
  (0 means the fill starts off); `line_width`.
- `icon`: one of hospital, fire, toilet, canteen, community, anganwadi, market,
  shelter, playground, park, open-space, waste, bin, heritage, metro, rail, bus,
  house, slum, water-drop. To add one, add a 24x24 SVG path to `js/icons.js`.
- `palette: { field, values: { value: colour } }`: that field becomes the default
  Colour by, with exactly those colours (anything else is grey).

Without a palette, Colour by makes its own classes: text fields get distinct
colours for the 10 most common values seen in the loaded tiles; number fields get
5 quantile classes from the features loaded when the field is picked.
User changes in the viewer are not saved anywhere (the ↺ button resets a card).

## Deploy

1. Copy `index.html`, `css/`, `js/`, `vendor/` to the web root (e.g.
   `/srv/maps-viewer`). Do not copy `check/`, `nginx/`, `screenshots/`,
   `dev-server.py`.
2. Run `pmtiles serve /srv/observatory-data/published/serve --interface=127.0.0.1 --port=8081`
   as a service (systemd). Never bind it to a public interface.
3. Install `nginx/maps.conf` and `nginx/maps-security-headers.conf`
   (as `/etc/nginx/snippets/maps-security-headers.conf`), add the
   `limit_req_zone` line to the http block, and get the certificate with certbot
   (instructions at the top of `maps.conf`).
4. `layers.json` is served with `no-cache`; tiles with a day of caching, busted by
   `?v=<version>`.

The CSP allows only self plus `server.arcgisonline.com` / `services.arcgisonline.com`
for basemap tiles and `photon.komoot.io` (connect-src) for the place search. Fonts
and label glyphs are self-hosted (`vendor/fonts`, `vendor/glyphs`), so no other host
is needed.
