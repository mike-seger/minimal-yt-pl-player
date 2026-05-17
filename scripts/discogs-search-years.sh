#!/usr/bin/env bash
# discogs-search-years.sh
#
# Look up release years on Discogs for tracks in an unmatched TSV file.
# Respects Discogs rate limits automatically.
#
# Usage:
#   discogs-search-years.sh <unmatched.tsv>
#
# Optional: set DISCOGS_TOKEN env var for authenticated requests (60 req/min
#   instead of 25 req/min).  Get a token at https://www.discogs.com/settings/developers
#
# Input format (tab-separated lines):
#   videoId <TAB> <empty> <TAB> title     → will be looked up
#   videoId <TAB> year   <TAB> title     → passed through unchanged
#   lines starting with # are passed through unchanged
#
# Output (stdout): same TSV, year field filled where Discogs returned a result.
# Progress/stats:  stderr

set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $(basename "$0") <unmatched.tsv>" >&2
    exit 1
fi

INPUT="$1"

if [[ ! -f "$INPUT" ]]; then
    echo "Error: input file not found: $INPUT" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required but not found in PATH" >&2
    exit 1
fi

python3 - "$INPUT" "${DISCOGS_TOKEN:-}" <<'PYEOF'
import sys
import json
import time
import re
import urllib.request
import urllib.parse

input_file = sys.argv[1]
token      = sys.argv[2]   # empty string if DISCOGS_TOKEN not set

RATE_LIMIT = 60 if token else 25          # requests per minute
SLEEP_SECS = 60.0 / RATE_LIMIT + 0.2     # inter-request delay with a small buffer

def search_discogs(query):
    """Search Discogs releases for query; return earliest plausible year or None."""
    params = urllib.parse.urlencode({'q': query, 'type': 'release', 'per_page': '5'})
    url = f'https://api.discogs.com/database/search?{params}'
    headers = {
        'User-Agent': 'YtPlPlaylistYearEnricher/1.0 +https://github.com/minimal-yt-pl-player',
    }
    if token:
        headers['Authorization'] = f'Discogs token={token}'
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        years = [int(r['year']) for r in data.get('results', [])
                 if str(r.get('year', '')).isdigit()]
        valid = [y for y in years if 1982 <= y <= 2010]
        return min(valid) if valid else None
    except Exception as e:
        print(f'  discogs error: {e}', file=sys.stderr)
        return None

def strip_bracket_suffix(s):
    """Remove a single trailing (...) or [...] group."""
    return re.sub(r'\s*[\(\[][^\)\]]*[\)\]]\s*$', '', s).strip()

lines = open(input_file, encoding='utf-8').read().splitlines()

total_todo = sum(
    1 for l in lines
    if l and not l.startswith('#')
    and len(l.split('\t')) >= 2
    and l.split('\t')[1] == ''
)
print(f'Querying Discogs for {total_todo} tracks '
      f'({RATE_LIMIT} req/min → ~{total_todo * SLEEP_SECS / 60:.1f} min estimated)',
      file=sys.stderr)

found = not_found = passed = 0
n = 0

for line in lines:
    if not line or line.startswith('#'):
        print(line)
        continue

    parts      = line.split('\t')
    video_id   = parts[0]
    year_field = parts[1] if len(parts) > 1 else ''
    title      = parts[2] if len(parts) > 2 else ''

    if year_field:
        # Already has a year — pass through unchanged
        print(line)
        passed += 1
        continue

    n += 1
    print(f'[{n}/{total_todo}] {title}', file=sys.stderr)

    # First try with bracket suffix stripped (cleaner query)
    stripped = strip_bracket_suffix(title)
    year = search_discogs(stripped)
    time.sleep(SLEEP_SECS)

    if year is None and stripped != title:
        # Fall back to full title
        year = search_discogs(title)
        time.sleep(SLEEP_SECS)

    if year:
        print(f'{video_id}\t{year}\t{title}')
        found += 1
        print(f'  → {year}', file=sys.stderr)
    else:
        print(f'{video_id}\t\t{title}')
        not_found += 1
        print(f'  → not found', file=sys.stderr)

print(f'Done: {found} found, {not_found} not found, {passed} passed through',
      file=sys.stderr)
PYEOF
