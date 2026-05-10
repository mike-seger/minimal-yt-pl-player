# minimal-yt-pl-player

A lightweight, zero-dependency YouTube playlist player. No bundler, no npm — just static files served from any HTTP server.

## Features

- Plays a YouTube playlist via the [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
- Scrollable sidebar with track thumbnails, artist and title on separate lines
- Auto-advances to the next track on end; skips errored tracks — stops at the last track (no cycling)
- **Resume persistence** — saves current track and position to `localStorage` every 10 s and on page hide; restored on next load
- **Keyboard navigation**
  - `↑` / `↓` — previous / next track
  - `←` / `→` — seek ±5 s
- **Swipe gestures** — swipe left → next, swipe right → previous
- Prev / Next buttons in the now-playing bar

## File structure

```
minimal-yt-pl-player/
├── index.html              # HTML shell
├── player.js               # All player logic (ES module)
├── style.css               # Styles
└── playlists/
    ├── playlists.json               # Array of playlist JSON paths to load (first entry used)
    └── pl_*.json                # Playlist data files
```

## Playlist format

`playlists.json` is an array of paths **relative to `playlists.json` itself**:

```json
["./pl_2025-1_wave_alternatives.json"]
```

Each playlist JSON file has the shape:

```json
{
  "fetchedAt": "2025-12-13T16:59:39.000Z",
  "title": "afterdark waves",
  "items": [
    { "videoId": "OjkZr57hPdM", "title": "18pm - homeschool" },
    { "videoId": "W7CndC-CQrw", "title": "A Projection - Darwin's Eden" }
  ]
}
```

Track titles follow the convention `"Artist - Song title"`. The player splits on the first ` - ` and renders the artist in the primary line and the song name below it.

Thumbnails are derived from `videoId` at runtime (`https://i.ytimg.com/vi/{videoId}/mqdefault.jpg`) — no thumbnail URLs need to be stored in the playlist.

## Usage

Serve the `minimal-yt-pl-player/` directory from any HTTP server (the YouTube IFrame API requires a non-`file://` origin):

```sh
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` (or whichever port) in a browser.
