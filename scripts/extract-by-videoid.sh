#!/usr/bin/env bash
# extract-by-videoid.sh <playlist.gz> <videoids.txt>
#
# Extracts rows from a gzipped TSV whose videoId (column 3) appears in the
# given text file (one video ID per line). Outputs the header + matching rows
# to stdout (uncompressed).
#
# Example:
#   bash scripts/extract-by-videoid.sh "trance db.tsv.gz" yt-api-restricted.txt

set -euo pipefail

PLAYLIST_GZ="${1:?Usage: extract-by-videoid.sh <playlist.gz> <videoids.txt>}"
VIDEOID_FILE="${2:?Usage: extract-by-videoid.sh <playlist.gz> <videoids.txt>}"

python3 - "$PLAYLIST_GZ" "$VIDEOID_FILE" <<'PYEOF'
import gzip, sys

playlist_gz = sys.argv[1]
videoid_file = sys.argv[2]

with open(videoid_file, "r", encoding="utf-8") as fh:
    ids = {line.strip() for line in fh if line.strip()}

with gzip.open(playlist_gz, "rt", encoding="utf-8") as fh:
    for i, line in enumerate(fh):
        line = line.rstrip("\n")
        if i == 0:
            print(line)
            continue
        parts = line.split("\t")
        if len(parts) >= 3 and parts[2].strip() in ids:
            print(line)
PYEOF
