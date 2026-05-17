#!/usr/bin/env bash
# match-video-by_artist+title.sh
#
# Match playlist video IDs to years from a structured filename list.
#
# Usage:
#   match-video-by_artist+title.sh <filenames.txt> <playlist.json>
#
# Input filenames.txt format (fields separated by __):
#   <pub_year>__<compilation>__<label>__<album>__<orig_year>__<artist - title>.mp3
#
# Output (stdout): TSV  videoId <TAB> year <TAB> artist - title
#   Matched entries come first (year filled in).
#   Unmatched entries follow after a "# UNMATCHED" comment line (year empty).
# Progress:        printed to stderr

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $(basename "$0") <filenames.txt> <playlist.json>" >&2
    exit 1
fi

TXT_FILE="$1"
PLAYLIST_JSON="$2"

if [[ ! -f "$TXT_FILE" ]]; then
    echo "Error: filenames file not found: $TXT_FILE" >&2
    exit 1
fi

if [[ ! -f "$PLAYLIST_JSON" ]]; then
    echo "Error: playlist JSON not found: $PLAYLIST_JSON" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required but not found in PATH" >&2
    exit 1
fi

python3 - "$TXT_FILE" "$PLAYLIST_JSON" <<'PYEOF'
import sys
import json
import re

def normalize(s):
    """Lowercase; replace anything that isn't a letter, digit, space, or hyphen
    with a space; collapse runs of whitespace; strip."""
    s = s.lower()
    s = re.sub(r'[^a-z0-9 -]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def deep_normalize(s):
    """Aggressive fallback normalization: strip leading track-number prefix,
    collapse abbreviation dots, remove featured-artist markers,
    keep only alphanumerics, drop the article 'the'."""
    s = re.sub(r'^\d+\.\s*', '', s)                    # strip leading "04. " style prefix
    s = s.lower()
    s = re.sub(r'(?<=[a-z])\.(?=[a-z\s]|$)', '', s)   # collapse abbrev dots: a.i.d.a. → aida
    s = re.sub(r'\b(?:feat(?:uring)?|ft)\b', ' ', s)  # drop featured-artist markers
    s = re.sub(r'[^a-z0-9]', ' ', s)                  # keep only letters and digits
    s = re.sub(r'\bthe\b', ' ', s)                     # drop article "the"
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def compact_normalize(s):
    """Final fallback: deep_normalize then remove all remaining spaces,
    yielding a single string of alphanumeric chars only."""
    return re.sub(r'\s', '', deep_normalize(s))

def strip_trailing_bracket(s):
    """Remove a single trailing (...) or [...] group."""
    return re.sub(r'\s*[\(\[][^\)\]]*[\)\]]\s*$', '', s).strip()

def has_trailing_bracket(s):
    return bool(re.search(r'[\(\[][^\)\]]*[\)\]]\s*$', s))

txt_file      = sys.argv[1]
playlist_file = sys.argv[2]

# ── Build lookup tables ────────────────────────────────────────────────────────
# Six tables, three normalization strategies × two bracket-stripping variants:
#   lookup / stripped_lookup        — standard normalize()
#   deep_lookup / deep_stripped_lookup  — deep_normalize()   (fallback)
#   compact_lookup / compact_stripped_lookup — compact_normalize() (last resort)
lookup          = {}
stripped_lookup = {}
deep_lookup          = {}
deep_stripped_lookup = {}
compact_lookup          = {}
compact_stripped_lookup = {}

with open(txt_file, encoding='utf-8', errors='replace') as fh:
    for lineno, raw in enumerate(fh, 1):
        line = raw.rstrip('\n')
        if not line:
            continue
        parts = line.split('__')
        if len(parts) < 2:
            continue
        artist_title = parts[-1]
        if artist_title.lower().endswith('.mp3'):
            artist_title = artist_title[:-4]
        orig_year = parts[-2].strip()
        if not re.match(r'^\d{4}$', orig_year):
            continue
        val = (orig_year, artist_title)

        key = normalize(artist_title)
        if key and key not in lookup:
            lookup[key] = val
        if has_trailing_bracket(artist_title):
            skey = normalize(strip_trailing_bracket(artist_title))
            if skey and skey not in stripped_lookup and skey not in lookup:
                stripped_lookup[skey] = val

        dkey = deep_normalize(artist_title)
        if dkey and dkey not in deep_lookup:
            deep_lookup[dkey] = val
        if has_trailing_bracket(artist_title):
            dskey = deep_normalize(strip_trailing_bracket(artist_title))
            if dskey and dskey not in deep_stripped_lookup and dskey not in deep_lookup:
                deep_stripped_lookup[dskey] = val

        ckey = compact_normalize(artist_title)
        if ckey and ckey not in compact_lookup:
            compact_lookup[ckey] = val
        if has_trailing_bracket(artist_title):
            cskey = compact_normalize(strip_trailing_bracket(artist_title))
            if cskey and cskey not in compact_stripped_lookup and cskey not in compact_lookup:
                compact_stripped_lookup[cskey] = val

print(f'Loaded {len(lookup)} unique entries '
      f'({len(stripped_lookup)} bracket-stripped alternates)', file=sys.stderr)

# ── Match against playlist items ──────────────────────────────────────────────
def find_match(title):
    """Return (year, orig_title, method) or None.

    Fallback order (standard normalize first, then deep_normalize):
      1. exact           normalize(pl)              → lookup
      2. strip-txt       normalize(pl)              → stripped_lookup  [no brackets in pl]
      3. strip-pl        normalize(strip(pl))        → lookup           [brackets in pl]
      4. strip-both      normalize(strip(pl))        → stripped_lookup  [brackets in pl]
      5. deep            deep_normalize(pl)           → deep_lookup
      6. deep-strip-txt  deep_normalize(pl)           → deep_stripped_lookup  [no brackets in pl]
      7. deep-strip-pl   deep_normalize(strip(pl))    → deep_lookup      [brackets in pl]
      8. deep-strip-both deep_normalize(strip(pl))    → deep_stripped_lookup  [brackets in pl]
      9. compact         compact_normalize(pl)         → compact_lookup
     10. compact-strip-txt compact_normalize(pl)       → compact_stripped_lookup  [no brackets in pl]
     11. compact-strip-pl  compact_normalize(strip(pl))→ compact_lookup    [brackets in pl]
     12. compact-strip-both compact_normalize(strip(pl))→ compact_stripped_lookup [brackets in pl]
    """
    key = normalize(title)
    if key in lookup:
        return lookup[key] + ('exact',)
    if not has_trailing_bracket(title):
        if key in stripped_lookup:
            return stripped_lookup[key] + ('strip-txt',)
    else:
        key2 = normalize(strip_trailing_bracket(title))
        if key2 in lookup:
            return lookup[key2] + ('strip-pl',)
        if key2 in stripped_lookup:
            return stripped_lookup[key2] + ('strip-both',)

    # Deep fallback
    dkey = deep_normalize(title)
    if dkey in deep_lookup:
        return deep_lookup[dkey] + ('deep',)
    if not has_trailing_bracket(title):
        if dkey in deep_stripped_lookup:
            return deep_stripped_lookup[dkey] + ('deep-strip-txt',)
    else:
        dkey2 = deep_normalize(strip_trailing_bracket(title))
        if dkey2 in deep_lookup:
            return deep_lookup[dkey2] + ('deep-strip-pl',)
        if dkey2 in deep_stripped_lookup:
            return deep_stripped_lookup[dkey2] + ('deep-strip-both',)

    # Compact fallback: all non-alphanumeric removed (no spaces)
    ckey = compact_normalize(title)
    if ckey in compact_lookup:
        return compact_lookup[ckey] + ('compact',)
    if not has_trailing_bracket(title):
        if ckey in compact_stripped_lookup:
            return compact_stripped_lookup[ckey] + ('compact-strip-txt',)
    else:
        ckey2 = compact_normalize(strip_trailing_bracket(title))
        if ckey2 in compact_lookup:
            return compact_lookup[ckey2] + ('compact-strip-pl',)
        if ckey2 in compact_stripped_lookup:
            return compact_stripped_lookup[ckey2] + ('compact-strip-both',)
    return None

with open(playlist_file, encoding='utf-8') as fh:
    playlist = json.load(fh)

items = playlist.get('items', [])
total_with_id = sum(1 for it in items if it.get('videoId'))
matched = 0
by_method = {}
unmatched = []  # list of (video_id, playlist_title)

for item in items:
    video_id = item.get('videoId') or ''
    if not video_id:
        continue
    title = item.get('title') or ''
    result = find_match(title)
    if result:
        year, orig_title, method = result
        print(f'{video_id}\t{year}\t{orig_title}')
        matched += 1
        by_method[method] = by_method.get(method, 0) + 1
    elif 'year' not in item:
        unmatched.append((video_id, title))

# Emit unmatched entries with empty year so they can be filled in manually
if unmatched:
    print('# UNMATCHED — fill in the year column and re-run enrich-videos-by_year.sh')
    for vid, title in unmatched:
        print(f'{vid}\t\t{title}')

print(f'Matched {matched} / {total_with_id} tracks', file=sys.stderr)
for method, count in sorted(by_method.items()):
    print(f'  {method}: {count}', file=sys.stderr)
if unmatched:
    print(f'Unmatched ({len(unmatched)} tracks) appended with empty year', file=sys.stderr)
PYEOF
