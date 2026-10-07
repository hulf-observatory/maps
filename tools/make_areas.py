#!/usr/bin/env python3
"""Build published/nav/areas.json for the viewer's breadcrumb.

Reads the boundary GeoPackages (read-only) and writes a small JSON with,
per level, names + bounds, and for wards also aggressively simplified
polygon rings for point-in-polygon. See README.md ("Breadcrumb") for the
format. Rerun whenever the boundary files change.

  python3 tools/make_areas.py            # writes ../../observatory-data/published/nav/areas.json
  python3 tools/make_areas.py --out F    # write somewhere else
"""
import argparse, json, os, sys

try:
    from osgeo import ogr
    ogr.UseExceptions()
except ImportError:
    sys.exit("needs GDAL python bindings (osgeo.ogr)")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "..", "observatory-data"))
BND = os.path.join(DATA, "Spatial_Data_Repositoy", "Vector", "Boundaries")
OUT = os.path.join(DATA, "published", "nav", "areas.json")

SIMPLIFY = 0.0006  # degrees (~65 m): breadcrumb point-in-polygon + bounds only
ROUND = 4          # 4 decimals ~ 11 m

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=OUT)
args = ap.parse_args()


def rnd(x):
    return round(x, ROUND)


def bounds(env):
    # ogr envelope is (minx, maxx, miny, maxy) -> [w, s, e, n]
    return [rnd(env[0]), rnd(env[2]), rnd(env[1]), rnd(env[3])]


def rings(geom):
    """All rings (outer + holes) of a (multi)polygon as flat [x,y,x,y,...] arrays.
    The viewer's even-odd ray casting treats holes correctly this way."""
    out = []
    g = geom.SimplifyPreserveTopology(SIMPLIFY)
    polys = [g.GetGeometryRef(i) for i in range(g.GetGeometryCount())] if g.GetGeometryName() == "MULTIPOLYGON" else [g]
    for p in polys:
        if p is None or p.GetGeometryName() != "POLYGON":
            continue
        for r in range(p.GetGeometryCount()):
            ring = p.GetGeometryRef(r)
            pts = ring.GetPoints()
            if not pts or len(pts) < 4:
                continue
            flat = []
            last = None
            for x, y, *_ in pts:
                q = (rnd(x), rnd(y))
                if q != last:
                    flat.extend(q)
                last = q
            if len(flat) >= 8:
                out.append(flat)
    return out


def read(path, layer):
    ds = ogr.Open(path)
    if ds is None:
        sys.exit("cannot open " + path)
    return ds, ds.GetLayerByName(layer)


# HMDA: bounds only
ds, lyr = read(os.path.join(BND, "HMDA_4326.gpkg"), "HMDA_4326")
env = lyr.GetExtent()
hmda = {"bounds": [rnd(env[0]), rnd(env[2]), rnd(env[1]), rnd(env[3])]}
del ds

# Corporations: name + bounds
corps = []
ds, lyr = read(os.path.join(BND, "2026_Hyderabad_Corporations.gpkg"), "2026_Hyderabad_Corporations")
for f in lyr:
    corps.append({"name": f.GetField("Corporation"), "bounds": bounds(f.GetGeometryRef().GetEnvelope())})
corps.sort(key=lambda c: c["name"])


def norm(name):
    # "Greater Hyderabad Municipal Corporation (GHMC)" vs "... Corporation" across files
    return " ".join(str(name).split()).split("(")[0].strip().lower()


cidx = {norm(c["name"]): i for i, c in enumerate(corps)}
del ds

# Zones: name + parent corporation + bounds
zones = []
ds, lyr = read(os.path.join(BND, "2026_Zones.gpkg"), "2026_Zones")
for f in lyr:
    zones.append({"name": f.GetField("Zone"), "corp": cidx[norm(f.GetField("Corporation"))],
                  "bounds": bounds(f.GetGeometryRef().GetEnvelope())})
zones.sort(key=lambda z: (z["corp"], z["name"]))
zidx = {(z["corp"], z["name"]): i for i, z in enumerate(zones)}
del ds

# Wards: number, name, parent zone, bounds, simplified rings (the only level
# that carries geometry; corporation and zone follow from the ward's fields)
wards = []
ds, lyr = read(os.path.join(BND, "2026_Hyderabad_Wards.gpkg"), "2026_Hyderabad_Wards")
for f in lyr:
    g = f.GetGeometryRef()
    wards.append({"no": f.GetField("Ward No"), "name": f.GetField("Ward"),
                  "zone": zidx[(cidx[norm(f.GetField("Corporation"))], f.GetField("Zone"))],
                  "bounds": bounds(g.GetEnvelope()), "poly": rings(g)})
wards.sort(key=lambda w: (w["zone"], w["no"] or 0))
del ds

out = {"schema": 1, "hmda": hmda, "corporations": corps, "zones": zones, "wards": wards}
os.makedirs(os.path.dirname(args.out), exist_ok=True)
with open(args.out, "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
size = os.path.getsize(args.out)
print(f"wrote {args.out}: {len(corps)} corporations, {len(zones)} zones, {len(wards)} wards, {size/1024:.0f} KB")
if size > 600 * 1024:
    print("WARNING: over the 600 KB budget; raise SIMPLIFY", file=sys.stderr)
