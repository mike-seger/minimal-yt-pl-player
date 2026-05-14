#!/usr/bin/env python3
"""
Fetch YouTube video metadata for all video IDs in pl.gz.

Usage:
    python3 scripts/fetch_video_info.py [--limit N] [--input PATH] [--output PATH]

Environment:
    gapikey  — YouTube Data API v3 key

The script batches requests in groups of 50 (API maximum) and requests all
parts that come at no additional quota cost beyond the base 1-unit call:
  snippet, contentDetails, statistics, status

If the output file already exists the script skips video IDs already present,
allowing interrupted runs to be resumed.
"""

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
PARTS = "snippet,contentDetails,statistics,status"
BATCH_SIZE = 50


def load_existing(output_path: str) -> dict:
    """Return a dict of videoId -> record for an existing output file."""
    if not os.path.exists(output_path):
        return {}
    with open(output_path, "r", encoding="utf-8") as fh:
        try:
            data = json.load(fh)
            if isinstance(data, list):
                return {item["id"]: item for item in data if "id" in item}
        except json.JSONDecodeError:
            print(f"[warn] Could not parse existing output file; starting fresh.", file=sys.stderr)
    return {}


def read_video_ids(input_path: str) -> list[str]:
    """Read the gzipped TSV and return the list of video IDs (column 3)."""
    ids = []
    with gzip.open(input_path, "rt", encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if i == 0:
                continue  # skip header
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3 and parts[2].strip():
                ids.append(parts[2].strip())
    return ids


def fetch_batch(video_ids: list[str], api_key: str) -> list[dict]:
    """Call the YouTube videos.list API for a batch of up to 50 IDs."""
    params = urllib.parse.urlencode({
        "part": PARTS,
        "id": ",".join(video_ids),
        "key": api_key,
    })
    url = f"{YOUTUBE_VIDEOS_URL}?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("items", [])
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"[error] HTTP {exc.code}: {error_body}", file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description="Fetch YouTube video metadata from pl.gz")
    parser.add_argument("--limit", type=int, default=None,
                        help="Maximum number of video IDs to process")
    parser.add_argument("--input", default="pl.gz",
                        help="Path to the gzipped TSV input file (default: pl.gz)")
    parser.add_argument("--output", default="scripts/video_info.json",
                        help="Path to the JSON output file (default: scripts/video_info.json)")
    args = parser.parse_args()

    api_key = os.environ.get("gapikey")
    if not api_key:
        sys.exit("[error] Environment variable 'gapikey' is not set.")

    # Resolve paths relative to the script's parent directory (repo root)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    input_path = args.input if os.path.isabs(args.input) else os.path.join(repo_root, args.input)
    output_path = args.output if os.path.isabs(args.output) else os.path.join(repo_root, args.output)

    # Load existing results so we can resume
    results: dict = load_existing(output_path)
    already_done = set(results.keys())
    if already_done:
        print(f"[info] Resuming — {len(already_done)} video(s) already in output file.")

    # Read all IDs from input, apply limit, skip already-fetched
    all_ids = read_video_ids(input_path)
    if args.limit is not None:
        all_ids = all_ids[:args.limit]

    pending = [vid for vid in all_ids if vid not in already_done]
    print(f"[info] {len(all_ids)} total ID(s), {len(pending)} to fetch.")

    if not pending:
        print("[info] Nothing to do.")
        return

    fetched = 0
    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start:batch_start + BATCH_SIZE]
        items = fetch_batch(batch, api_key)
        for item in items:
            results[item["id"]] = item
        fetched += len(items)

        # Persist after every batch so a crash doesn't lose work
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(list(results.values()), fh, ensure_ascii=False, indent=2)

        print(f"[info] Fetched {fetched}/{len(pending)} — batch {batch_start // BATCH_SIZE + 1} "
              f"({len(items)} item(s) returned by API).")

        # Polite delay between batches to avoid hammering the API
        if batch_start + BATCH_SIZE < len(pending):
            time.sleep(0.2)

    # Note: video IDs not returned by the API are unavailable/deleted
    missing = set(pending) - set(results.keys()) - already_done
    if missing:
        print(f"[warn] {len(missing)} ID(s) not returned by API (deleted/private): "
              + ", ".join(sorted(missing)[:10])
              + (" ..." if len(missing) > 10 else ""))

    print(f"[done] {len(results)} total record(s) saved to {output_path}")


if __name__ == "__main__":
    main()
