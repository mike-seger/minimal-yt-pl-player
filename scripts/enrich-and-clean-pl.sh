#!/usr/bin/env bash
# enrich-and-clean-pl.sh
#
# Enriches a playlist TSV (videoId / title / restricted) with a year column
# and deduplicates rows that share the same videoId, keeping the entry whose
# title best matches "ARTIST - TRACK" from the matched table.
#
# Usage:
#   scripts/enrich-and-clean-pl.sh INPUT MATCHED          # stdout
#   scripts/enrich-and-clean-pl.sh INPUT MATCHED OUTPUT   # write to file
#
# Columns in output:  videoId  title  year  restricted

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $(basename "$0") INPUT_TSV MATCHED_TSV [OUTPUT_TSV]" >&2
    echo "" >&2
    echo "  INPUT_TSV   playlist TSV with columns: videoId, title, restricted" >&2
    echo "  MATCHED_TSV match table with columns: ARTIST, TRACK, YEAR, matched_video_id, match_score, ..." >&2
    echo "  OUTPUT_TSV  output file (default: stdout)" >&2
    echo "" >&2
    echo "Enriches INPUT_TSV with a year column (from MATCHED_TSV YEAR field) and" >&2
    echo "removes duplicate videoId rows, keeping the entry whose title best matches" >&2
    echo "the ARTIST - TRACK string in the match table (match_score as tiebreaker)." >&2
    echo "Output columns: videoId, title, year, restricted" >&2
    exit 1
fi

INPUT="$1"
MATCHED="$2"
OUTPUT="${3:--}"

python3 - "$INPUT" "$MATCHED" "$OUTPUT" <<'PYEOF'
import sys, csv, difflib
from collections import defaultdict

input_tsv   = sys.argv[1]
matched_tsv = sys.argv[2]
output_file = sys.argv[3]


def sim(a, b):
    """Normalised similarity ratio between two strings (case-insensitive)."""
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


# ---------------------------------------------------------------------------
# 1. Load matched table indexed by matched_video_id
# ---------------------------------------------------------------------------
matched = {}   # vid -> list of {at: "ARTIST - TRACK", year: str, score: float}
with open(matched_tsv, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f, delimiter='\t'):
        vid = (row.get('matched_video_id') or '').strip()
        if not vid:
            continue
        at    = f"{row['ARTIST']} - {row['TRACK']}"
        yr    = (row.get('YEAR') or '').strip()
        score = float(row.get('match_score') or 0)
        matched.setdefault(vid, []).append({'at': at, 'year': yr, 'score': score})

# ---------------------------------------------------------------------------
# 2. Load playlist rows
# ---------------------------------------------------------------------------
with open(input_tsv, newline='', encoding='utf-8') as f:
    rows = list(csv.DictReader(f, delimiter='\t'))

# Group by videoId while preserving first-occurrence order
groups = defaultdict(list)
order  = list(dict.fromkeys(r['videoId'] for r in rows))
for r in rows:
    groups[r['videoId']].append(r)

# ---------------------------------------------------------------------------
# 3. For each unique videoId: pick best-matching playlist row + derive year
# ---------------------------------------------------------------------------
def best_sim_score(title, entries):
    """Return (best_string_sim, best_match_score) for a title against entries."""
    best_s = max(sim(title, e['at']) for e in entries)
    best_m = max(
        e['score'] for e in entries
        if sim(title, e['at']) >= best_s - 1e-9
    )
    return (best_s, best_m)


out_rows = []
for vid in order:
    group   = groups[vid]
    entries = matched.get(vid, [])

    if not entries:
        # No match data at all — keep first occurrence, year unknown
        r = group[0]
        out_rows.append([vid, r['title'], '', r.get('restricted', '')])
        continue

    # Pick the playlist row with the highest (string_sim, match_score)
    best_r = max(group, key=lambda r: best_sim_score(r['title'], entries))

    # Derive year from the matched entry closest to the chosen title
    year_entry = max(
        entries,
        key=lambda e: (sim(best_r['title'], e['at']), e['score'])
    )
    year = year_entry['year']

    out_rows.append([vid, best_r['title'], year, best_r.get('restricted', '')])

# ---------------------------------------------------------------------------
# 4. Write output
# ---------------------------------------------------------------------------
fout = (sys.stdout
        if output_file == '-'
        else open(output_file, 'w', newline='', encoding='utf-8'))
try:
    w = csv.writer(fout, delimiter='\t', lineterminator='\n')
    w.writerow(['videoId', 'title', 'year', 'restricted'])
    w.writerows(out_rows)
finally:
    if output_file != '-':
        fout.close()

total_in  = len(rows)
total_out = len(out_rows)
dupes     = total_in - total_out
print(
    f"Input: {total_in} rows → Output: {total_out} unique videoIds "
    f"({dupes} duplicate(s) removed)",
    file=sys.stderr
)
PYEOF
