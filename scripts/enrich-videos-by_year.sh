#!/usr/bin/env bash
# enrich-videos-by_year.sh
#
# Add or update the "year" field on playlist items using a TSV match file.
# Items not present in the TSV are left unchanged.
#
# Usage:
#   enrich-videos-by_year.sh <playlist.json> <matches.tsv>
#
# matches.tsv format (output of match-video-by_artist+title.sh):
#   videoId <TAB> year <TAB> artist - title
#   Lines starting with # are ignored.
#
# Output (stdout): enriched playlist JSON (pretty-printed, UTF-8)
# Progress:        printed to stderr

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $(basename "$0") <playlist.json> <matches.tsv>" >&2
    exit 1
fi

PLAYLIST_JSON="$1"
MATCHES_TSV="$2"

if [[ ! -f "$PLAYLIST_JSON" ]]; then
    echo "Error: playlist JSON not found: $PLAYLIST_JSON" >&2
    exit 1
fi

if [[ ! -f "$MATCHES_TSV" ]]; then
    echo "Error: matches TSV not found: $MATCHES_TSV" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required but not found in PATH" >&2
    exit 1
fi

python3 - "$PLAYLIST_JSON" "$MATCHES_TSV" <<'PYEOF'
import sys
import json

playlist_file = sys.argv[1]
tsv_file      = sys.argv[2]

# ── Load year map: videoId → year (int) ───────────────────────────────────────
year_map = {}

with open(tsv_file, encoding='utf-8') as fh:
    for lineno, raw in enumerate(fh, 1):
        line = raw.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) < 2:
            print(f'Warning: skipping malformed line {lineno} (expected at least 2 tab-separated fields)', file=sys.stderr)
            continue
        video_id = parts[0].strip()
        year_str = parts[1].strip()
        if not video_id or not year_str:
            continue  # empty year = not yet filled in, skip silently
        try:
            year_map[video_id] = int(year_str)
        except ValueError:
            print(f'Warning: non-integer year "{year_str}" on line {lineno}, skipping', file=sys.stderr)

print(f'Loaded year data for {len(year_map)} video IDs', file=sys.stderr)

# ── Load and enrich playlist ──────────────────────────────────────────────────
with open(playlist_file, encoding='utf-8') as fh:
    playlist = json.load(fh)

items = playlist.get('items', [])
updated = 0
already_had_year = 0

for item in items:
    video_id = item.get('videoId') or ''
    if video_id in year_map:
        if 'year' in item:
            already_had_year += 1
        item['year'] = year_map[video_id]
        updated += 1

print(f'Updated {updated} / {len(items)} items', file=sys.stderr)
if already_had_year:
    print(f'  ({already_had_year} items already had a year and were overwritten)', file=sys.stderr)

# ── Output enriched JSON ──────────────────────────────────────────────────────
print(json.dumps(playlist, indent=2, ensure_ascii=False))
PYEOF
