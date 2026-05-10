# YT Playlist Player — Handover Instructions

Zero-dependency YouTube playlist player. Pure HTML/CSS/ES-module JS, no build step, served from any static file server.

---

## File structure

```
minimal-yt-pl-player/
  index.html          — shell, all DOM structure
  style.css           — all styles (dark theme, CSS variables)
  player.js           — entry point, YouTube IFrame API, playback, filter, keyboard/swipe
  settings.js         — settings overlay logic, failed-ID store, hide-restricted state
  playlist.js         — custom playlist CRUD, per-playlist state, file ingest, ZIP download
  playlists/
    playlists.json    — array of relative paths to remote playlist JSON files
    pl_*.json         — playlist files (see format below)
```

---

## Playlist file format

```json
{
  "title": "Playlist Title",
  "fetchedAt": "2025-01-01T00:00:00.000Z",
  "items": [
    { "videoId": "dQw4w9WgXcQ", "title": "Artist - Song Title" },
    { "videoId": "abc123", "title": "Artist - Restricted Track", "restricted": true }
  ]
}
```

`restricted: true` causes a track to be dimmed, unclickable, and skipped during navigation.  
`title` is split on ` - ` to separate artist (top line) from song title (subtitle). If no ` - ` is present, the whole string is the primary line.

`playlists.json` is an array of paths relative to itself:
```json
["./pl_2025-1_wave_alternatives.json", "./pl_1992_trance_decade_1.json"]
```

---

## Module responsibilities

### `player.js`
- Injects `<script src="https://www.youtube.com/iframe_api">` dynamically.
- `window.onYouTubeIframeAPIReady` creates `YT.Player` in `#yt-player`.
- Imports `isHideRestricted`, `getHiddenPlaylists`, `initSettings`, `recordFailedId` from `settings.js`.
- Imports `getCustomPlaylists`, `getCustomPlaylistById`, `getPlaylistState`, `savePlaylistState` from `playlist.js`.
- **State**: `items[]`, `currentIndex`, `ytPlayer`, `ytReady`, `pendingLoad`, `activeFilter`, `activePlaylistUrl`, `allPlaylists[]`, `remotePlaylistMeta[]`.
- **Scan state**: `_scanActive`, `_scanCurrentItem`, `_scanResolveTrack` — used exclusively during Scan All Tracks, isolated from normal playback events.

### `settings.js`
- Imports all playlist I/O from `playlist.js`.
- Owns `_settings` (`hideRestricted`, `hiddenPlaylists[]`) under `yt-pl-player.settings.v1`.
- Owns `_failedIds` (Set) under `yt-pl-player.failed.v1`.
- Exports: `isHideRestricted`, `getHiddenPlaylists`, `setHideRestricted`, `toggleHiddenPlaylist`, `getFailedIds`, `recordFailedId`, `initSettings`, `openSettings`, `closeSettings`.
- `initSettings({onHideRestrictedChange, onPlaylistsChange, getAllPlaylists, onOpen, startScan, cancelScan})` wires all settings DOM events.

### `playlist.js`
- Owns `_customPlaylists[]` under `yt-pl-player.custom.v1`.
- Owns `_plState` (`{ [url]: {index, positionSec, filter} }`) under `yt-pl-player.pl-state.v1`.
- Exports: `getCustomPlaylists`, `getCustomPlaylistById`, `addCustomPlaylist`, `deleteCustomPlaylist`, `renameCustomPlaylist`, `getPlaylistState`, `savePlaylistState`, `ingestFile`, `downloadPlaylist`.

---

## localStorage keys

| Key | Contents |
|-----|----------|
| `yt-pl-player.resume.v1` | `{ playlistUrl }` — last active playlist URL |
| `yt-pl-player.pl-state.v1` | `{ [url]: { index, positionSec, filter } }` — per-playlist resume + filter |
| `yt-pl-player.settings.v1` | `{ hideRestricted, hiddenPlaylists[] }` |
| `yt-pl-player.failed.v1` | `[videoId, …]` — recorded failed/restricted video IDs |
| `yt-pl-player.custom.v1` | `[{ id, title, fetchedAt, items[] }]` — uploaded custom playlists |

---

## Features

### Playback
- YouTube IFrame API, `autoplay:1`, `playsinline:1`.
- Auto-advance on `ENDED`. On `onError`: mark track `restricted`, record failed ID, re-render, advance after 1.5 s.
- `playIndex(idx, positionSec, dir)` skips `restricted` items in the given direction (default forward).
- `pendingLoad` stores `{videoId, positionSec}` if the player is not yet ready.

### Resume
- Saves every 10 s via `setInterval` and immediately on `visibilitychange:hidden`.
- Per-playlist: `savePlaylistState(url, {index, positionSec})`.
- Global: `saveResumeUrl()` writes `{playlistUrl}` to `yt-pl-player.resume.v1`.
- On startup: reads last `playlistUrl` → finds per-playlist state → restores index + position.

### Multi-playlist picker
- `playlists/playlists.json` loaded first; all remote playlists prefetched in parallel for title/counts.
- Custom playlists (from localStorage) merged in after.
- `allPlaylists[]` shape: `{ url, title, playableCount, restrictedCount, isCustom, id? }`.
- Custom playlist URL scheme: `custom:<id>`.
- Sidebar header has a click-to-open dropdown (`#playlist-picker-dropdown`). Closes on outside click.
- Switching playlists saves current filter + position first.
- Hidden playlists (from settings) are excluded from the dropdown.

### Track filter
- `#track-filter` search input sits between the playlist picker header and the track list.
- Activates when ≥ 2 characters are typed.
- Multiple space-separated tokens all must match (AND logic), case-insensitive, against `item.title || item.videoId`.
- Tracks hidden by filter are excluded from display; display numbers (`displayNum`) are always gapless.
- Filter value is saved per-playlist and restored when switching back.
- `autocomplete="off"` suppresses browser input history.

### Track list rendering (`renderTrackList`)
- Respects `isHideRestricted()` — restricted tracks are entirely omitted when enabled.
- Respects `matchesFilter()` — filtered-out tracks are omitted.
- `displayNum` increments only for rendered tracks (gapless numbering).
- Each element gets `el.dataset.idx` = true array index (used by `syncActiveTrack` to find the active element regardless of filtering).
- Thumbnails from `https://i.ytimg.com/vi/{videoId}/mqdefault.jpg`, lazy-loaded, hidden on error.
- Title split on ` - `: first part becomes `.track-title`, second part becomes `.track-subtitle`.

### Active track sync (`syncActiveTrack`)
- Toggles `.active` class by matching `el.dataset.idx === currentIndex`.
- Smart scroll: scrolls the track into view only when it falls outside the visible area. Direction-aware: moving forward aligns to top of list; moving backward aligns to bottom.

### Keyboard controls
- `Space` — play/pause (ignored when focus is in an input).
- `ArrowUp` / `ArrowDown` — previous / next track.
- `ArrowLeft` / `ArrowRight` — seek ±10 s (ignored with `altKey`).

### Swipe gestures
- Touch: minimum 40 px horizontal, maximum 80 px vertical drift.
- Swipe left → next track, swipe right → previous track.

### Settings overlay
- `position: absolute; inset: 0` inside `#sidebar` (`position: relative`), so it covers only the sidebar.
- Opened by `#btn-settings` (⋮), closed by `#settings-close` (×).
- Opening closes the playlist picker dropdown first.

#### Hide restricted checkbox
- Default: **on** for new users (no saved state).
- Toggle calls `setHideRestricted()` → `onHideRestrictedChange` → `renderTrackList()`.

#### Playlist list
- One row per playlist (remote + custom), with visibility checkbox and track counts.
- **Remote playlists**: name shown as plain text; checkbox toggles `hiddenPlaylists[]` in settings.
- **Custom playlists**: name shown as editable text input (inline rename); also have a Delete button.
  - Rename saves on `change` and `blur`.
  - Delete calls `deleteCustomPlaylist(id)` → `onPlaylistsChange`.
- All playlists have a Download button (⬇).

#### Playlist download
- Downloads a ZIP (via JSZip from `https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js`) containing:
  - `{name}.json` — full playlist JSON.
  - `{name}.tsv` — TSV with columns `videoId`, `title`, `restricted`.
- Before packing: any `videoId` in `_failedIds` that is not already `restricted:true` gets marked `restricted:true`.
- Fallback: if JSZip fails to load, downloads plain JSON.

#### Playlist upload
- Drop zone accepts `.json`, `.tsv`, `.csv`.
- `ingestFile(file, failedIds)` in `playlist.js`:
  - JSON: must have `items[]` array.
  - TSV/CSV: auto-detected by tab in header row. Required columns: `videoId`, `title`. Optional: `restricted` (`true`/`1`).
  - On ingest: failed IDs applied as `restricted:true` to matching items.
  - Calls `addCustomPlaylist(data)` which assigns a unique `id` and normalises items.

#### Failed video IDs
- Automatically recorded on `onError` during normal playback and during Scan.
- Settings section shows count: "N video IDs recorded."
- **Copy to clipboard**: copies newline-separated IDs. Falls back to `execCommand('copy')`.
- **Clear**: empties `_failedIds`, persists empty array.

### Scan All Tracks
- Iterates all non-restricted items in the current playlist, one at a time.
- Loads each via `ytPlayer.loadVideoById`.
- Resolution logic:
  - `PLAYING (1)` → pass (resolve `'ok'`).
  - `onError` → fail (mark `restricted`, record failed ID, resolve `'fail'`).
  - 6 s timeout → pass (resolve `'ok'`). `BUFFERING (3)` is intentionally **not** resolved — restricted videos emit BUFFERING before `onError`.
- Progress callback: `{ scanned, total, found, title, done }`.
- "Stop Scan" button cancels mid-scan; current track resolves immediately as `'ok'`.

---

## Default settings (new user / empty localStorage)

- `hideRestricted` → `true`
- `hiddenPlaylists` → `[]` (all playlists visible)
- Active playlist → first non-hidden playlist in `allPlaylists`

---

## HTML structure summary

```
#app
  aside#sidebar [position:relative]
    #sidebar-header
      #sidebar-header-row
        #playlist-picker [flex:1]
          #playlist-picker-selected   ← click to open dropdown
            #playlist-title
            #track-count
            #playlist-picker-arrow
          #playlist-picker-dropdown [hidden]
        button#btn-settings
    #track-filter-wrap
      input#track-filter [type=search]
    #track-list
    #settings-overlay [hidden, position:absolute, inset:0]
      .settings-header
      .settings-body
        section: Hide restricted checkbox
        section: Playlists (#settings-playlist-list + drop-zone)
        section: Failed video IDs (count, Scan, Copy, Clear buttons, status)
  main#main
    #player-area
      #status-overlay
      #player-wrap > #yt-player
    #now-playing-bar
      #now-playing-title
      button#btn-prev
      button#btn-next
```

---

## CSS notes

- All colours via CSS variables on `:root` (`--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--active-bg`, `--active-border`, `--hover-bg`, `--thumb-size`).
- `#track-filter` is full-bleed, borderless, inside `#track-filter-wrap` which supplies only the bottom border.
- `#settings-overlay` uses `display:flex; flex-direction:column` with `.settings-body` taking `flex:1; overflow-y:auto`.
- `.track-item.restricted` → `opacity:0.35; cursor:default`.
- `.track-item.active` → `background:var(--active-bg); border-left:3px solid var(--active-border)`.
- `.settings-pl-rename` — inline text input styled to match the dark theme, no border radius tricks needed.

---

## Known design decisions / gotchas

- **BUFFERING before error**: The YouTube IFrame API fires `BUFFERING (3)` for restricted/unavailable videos before `onError`. The scan intentionally ignores BUFFERING and only resolves on `PLAYING (1)` or `onError`. Do not add BUFFERING as a passing condition.
- **`el.dataset.idx`**: Always stores the true array index, not the display number. `syncActiveTrack` queries `.track-item[data-idx="${currentIndex}"]` — this survives filter changes.
- **No cycling at boundaries**: `playIndex` returns immediately if `idx < 0` or `idx >= items.length`.
- **Custom playlist URL scheme**: `custom:<id>` is used as the URL key in `allPlaylists`, `hiddenPlaylists`, and `_plState`. `getCustomPlaylistById` strips the `custom:` prefix.
- **Rename does not re-render the picker title**: `onPlaylistsChange` → `rebuildAllPlaylists()` + `renderPickerDropdown()`. The sidebar title only updates on the next `switchPlaylist` call.
- **Keyboard events suppressed in inputs**: `keydown` handler returns early if `e.target.tagName === 'INPUT' || 'TEXTAREA'`, so typing in the filter or rename fields does not trigger playback shortcuts.
