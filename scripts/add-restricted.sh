#!/usr/bin/env bash
# add-restricted.sh <pl.gz> <video_info.json>
#
# Enriches the gzipped TSV with a 4th column "restricted":
#   0 = video is embeddable
#   1 = video is not embeddable, deleted, private, or not found in video_info
#
# Output is streamed to stdout as a gzip-compressed TSV.
#
# Example:
#   bash scripts/add-restricted.sh pl.gz scripts/video_info.json > pl_enriched.gz

set -euo pipefail

INPUT_GZ="${1:?Usage: add-restricted.sh <pl.gz> <video_info.json>}"
VIDEO_INFO="${2:?Usage: add-restricted.sh <pl.gz> <video_info.json>}"

python3 - "$INPUT_GZ" "$VIDEO_INFO" <<'PYEOF' | gzip
import gzip, json, sys

input_gz = sys.argv[1]
video_info_path = sys.argv[2]

opener = gzip.open if video_info_path.endswith(".gz") else open
with opener(video_info_path, "rt", encoding="utf-8") as fh:
    videos = json.load(fh)

# videoId -> True if embeddable, False otherwise
embeddable = {
    v["id"]: v.get("status", {}).get("embeddable", False)
    for v in videos
    if "id" in v
}

with gzip.open(input_gz, "rt", encoding="utf-8") as fh:
    for i, line in enumerate(fh):
        line = line.rstrip("\n")
        if i == 0:
            print(line + "\trestricted")
            continue
        parts = line.split("\t")
        if len(parts) >= 3:
            vid_id = parts[2].strip()
            # Unknown (not in video_info) is treated as restricted
            restricted = 0 if embeddable.get(vid_id) else 1
            print(line + "\t" + str(restricted))
        else:
            print(line + "\t1")
PYEOF
