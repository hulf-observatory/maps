#!/usr/bin/env bash
# The shared place search module (Photon + local areas) lives as identical copies,
# one per app, because each app deploys on its own:
#   maps/js/place-search.js            (this viewer; the reference copy)
#   timeline/place-search.js           (City Timeline, the sibling repo next to this one)
# A third copy, the Accessibility Atlas's frontend/js/place-search.js, lives in
# Amruth's repo (amruthkiran94/hyderabad-urban-observatory) and is compared only
# when that checkout is given as $ATLAS_PLACE_SEARCH.
# Edit one, copy it over the others, then run this. Exit 1 if they differ.
#   bash tools/check-place-search.sh
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
ref="$here/js/place-search.js"
status=0
if [ ! -f "$ref" ]; then echo "missing: $ref"; exit 1; fi
others=("$here/../timeline/place-search.js")
if [ -n "${ATLAS_PLACE_SEARCH:-}" ]; then others+=("$ATLAS_PLACE_SEARCH"); fi
for f in "${others[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing: $f"; status=1
  elif ! cmp -s "$ref" "$f"; then
    echo "differs from the viewer copy: $f"
    diff -u "$ref" "$f" | head -40
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo "place-search.js: the copies are identical"; fi
exit "$status"
