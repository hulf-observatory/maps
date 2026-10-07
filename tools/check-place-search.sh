#!/usr/bin/env bash
# The shared place search module (Photon + local areas) lives as three identical
# copies, one per app, because each app deploys on its own:
#   spatial data repository/js/place-search.js        (maps viewer; the reference copy)
#   city timeline/place-search.js
#   accessibility atlas/frontend/js/place-search.js
# Edit one, copy it over the other two, then run this. Exit 1 if they differ.
#   bash "spatial data repository/tools/check-place-search.sh"
set -u
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ref="$repo/spatial data repository/js/place-search.js"
status=0
if [ ! -f "$ref" ]; then echo "missing: $ref"; exit 1; fi
for f in "$repo/city timeline/place-search.js" "$repo/accessibility atlas/frontend/js/place-search.js"; do
  if [ ! -f "$f" ]; then
    echo "missing: $f"; status=1
  elif ! cmp -s "$ref" "$f"; then
    echo "differs from the viewer copy: $f"
    diff -u "$ref" "$f" | head -40
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo "place-search.js: the three copies are identical"; fi
exit "$status"
