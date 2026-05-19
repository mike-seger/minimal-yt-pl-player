import {
  isHideRestricted, setHideRestricted, isDisableRestricted, setDisableRestricted,
  isStopAtUnplayable, setStopAtUnplayable,
  getScanConsecFailThreshold,
  getHiddenPlaylists, initSettings, updateScanButtons, recordFailedId,
  getPlaylistNameOverride,
} from './settings.js';
import {
  getCustomPlaylists, getCustomPlaylistById,
  getPlaylistState, savePlaylistState,
  initCustomPlaylists,
  getRestrictedOverrides, saveRestrictedOverride, clearRestrictedOverrides,
  getVideoIdOverrides, saveVideoIdOverride,
  getTrackAttributeOverrides, saveTrackAttributeOverride,
} from './playlist.js';
import { openTrackEditor, recordVideoIdHistory } from './track-edit.js';

// ── Rendering thresholds ──────────────────────────────────────────────────────
// Below FULL_RENDER_THRESHOLD (post-filter count) every matching item gets a DOM node.
// At or above it we switch to virtual scrolling. Increase if you want full DOM at larger sizes.
const FULL_RENDER_THRESHOLD = 5_000;
const VSCROLL_ITEM_H = 52; // px — must match --track-item-height in style.css
// ── Scanner constants ──────────────────────────────────────────────────────────────────────
const SCAN_TIMEOUT_MS             = 8000;  // raised from 6 s
const SCAN_RETRIES                = 2;     // extra attempts for transient errors
const SCAN_RETRY_DELAY_MS         = 2500;
const SCAN_INTER_TRACK_MS         = 300;   // polite gap between tracks
const SCAN_CONSEC_FAIL_THRESHOLD  = 10;   // default; overridden at runtime by getScanConsecFailThreshold()
// YT error codes that are permanent (no point retrying):
const PERMANENT_YT_ERRORS   = new Set([100, 101, 150]);
// ── Resume persistence ────────────────────────────────────────────────────────
// Global resume only stores last active playlistUrl; per-playlist state is in playlist.js
const RESUME_KEY = 'yt-pl-player.resume.v1';
const RESUME_SAVE_INTERVAL_MS = 10_000;

function loadResume() {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s;  // { playlistUrl? }
  } catch { return null; }
}

function saveResumeUrl() {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ playlistUrl: activePlaylistUrl ?? null }));
  } catch {}
}

function saveResume(index, positionSec) {
  if (activePlaylistUrl) {
    savePlaylistState(activePlaylistUrl, { index, positionSec });
  }
  saveResumeUrl();
}

// ── State ─────────────────────────────────────────────────────────────────────
let items = [];
let currentIndex = -1;
let ytPlayer = null;
let ytReady = false;
let pendingLoad = null;   // { videoId, positionSec } to apply once the player is ready
let resumeSaveTimer = null;
let activeFilter = '';    // current filter string for the active playlist
let activeYearFilter = new Set(); // selected years; empty = show all
let _selectedIds = new Set();    // videoIds of checked tracks
let _hideUnselected = false;     // when true, only selected tracks are shown

// Scan state (separate from normal playback)
let _scanActive = false;
let _playConsecFails = 0;  // consecutive errors during normal playback
let _scanCurrentItem = null;  // item being tested during scan
let _scanningIdx = -1;        // items[] index of the track currently being scanned (for UI highlight)
let _scanResolveTrack = null; // resolves the per-track promise
let _scanNonce = 0;           // incremented each slot; stale YT events carry the wrong nonce and are ignored
let _scanWasMuted = false;    // whether the player was already muted before a scan started
let _scanResumeState = null;  // { videoId, positionSec } of the track playing before scan started

// Virtual-scroll state
let _vsItems = [];            // current post-filter [{ item, idx }] array in virtual mode
let _vsScrollHandler = null;  // active scroll listener so we can detach on mode switch

// ── DOM refs ──────────────────────────────────────────────────────────────────
const trackListEl        = document.getElementById('track-list');
const playlistTitleEl    = document.getElementById('playlist-title');
const trackCountEl       = document.getElementById('track-count');
const nowPlayingEl       = document.getElementById('now-playing-title');
const statusOverlay      = document.getElementById('status-overlay');
const btnPrev            = document.getElementById('btn-prev');
const btnNext            = document.getElementById('btn-next');
const pickerEl           = document.getElementById('playlist-picker');
const pickerDropdownEl   = document.getElementById('playlist-picker-dropdown');
const filterInputEl      = document.getElementById('track-filter');
const filterClearBtn     = document.getElementById('filter-clear-btn');
const yearFilterBtnEl    = document.getElementById('year-filter-btn');
const yearFilterDropEl   = document.getElementById('year-filter-dropdown');
const selectBtnEl        = document.getElementById('select-filter-btn');
const selectDropEl       = document.getElementById('select-dropdown');
const confirmOverlayEl   = document.getElementById('confirm-overlay');
const confirmMessageEl   = document.getElementById('confirm-message');
const confirmOkEl        = document.getElementById('confirm-ok');
const confirmCancelEl    = document.getElementById('confirm-cancel');

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Split "Artist - Title" into { artist, song }; returns { artist: '', song: raw } if no " - " found
function splitTitle(raw) {
  const sep = raw.indexOf(' - ');
  if (sep === -1) return { artist: '', song: raw };
  return { artist: raw.slice(0, sep), song: raw.slice(sep + 3) };
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function ytThumb(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function ytWatch(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

async function fetchJson(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} – ${url}`);

  const path = new URL(url, window.location.href).pathname.toLowerCase();
  const isGzipByExt = path.endsWith('.gz');
  if (!isGzipByExt) return resp.json();

  if (typeof DecompressionStream !== 'function') {
    throw new Error(`Gzip playlists are not supported in this browser: ${url}`);
  }

  const compressed = await resp.arrayBuffer();
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

// ── YouTube IFrame API ────────────────────────────────────────────────────────
// The YT script calls window.onYouTubeIframeAPIReady as a plain global.
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady() {
        ytReady = true;
        if (pendingLoad) {
          const { videoId, positionSec } = pendingLoad;
          pendingLoad = null;
          ytPlayer.loadVideoById({ videoId, startSeconds: positionSec });
        }
        startResumeSaveLoop();
      },
      onStateChange(e) {
        if (_scanActive && _scanResolveTrack) {
          // Only PLAYING(1) means the video is genuinely accessible.
          // BUFFERING(3) fires for restricted videos too (before onError),
          // so we must not resolve on it.
          if (e.data === 1) _scanResolveTrack('ok', _scanNonce);
          return;
        }
        if (e.data === YT.PlayerState.PLAYING) {
          // Keep the now-playing label in sync with what's actually playing.
          // syncActiveTrack sets it at playIndex() time; this corrects any
          // stale label (error recovery, resume mismatch, etc.).
          const item  = items[currentIndex];
          const label = item ? (item.title || item.videoId || '') : '–';
          nowPlayingEl.innerHTML = `<span>Now playing:</span>${escapeHtml(label)}`;
          _playConsecFails = 0;  // successful play — reset counter
          // If this track was marked restricted but just played successfully, clear it.
          if (item?.restricted && item.videoId) {
            item.restricted = false;
            _persistRestricted(item.videoId, false);
            renderTrackList();
            _refreshTrackCounts();
          }
        }
        if (e.data === YT.PlayerState.ENDED) {
          const nextIdx = _nextVisibleIdx(currentIndex, 1);
          if (nextIdx >= 0) playIndex(nextIdx, 0, 1);
        }
      },
      onError(e) {
        if (_scanActive && _scanResolveTrack) {
          // Forward the error code so _testOneTrack can decide whether to retry.
          // Do NOT mark the item here — that happens after all retries are exhausted.
          const errId = _scanCurrentItem?.videoId;
          console.warn(`[scan] YT error ${e.data} videoId=${errId ?? '?'}`);
          _scanResolveTrack('fail', _scanNonce, e.data);
          return;
        }
        const errItem = items[currentIndex];
        const errId = errItem?.videoId;
        console.warn(`YT error ${e.data} videoId=${errId ?? '?'} title=${JSON.stringify(errItem?.title ?? '')}`);
        // Only mark permanently restricted for definitive error codes; code 5 is transient
        if (errItem && PERMANENT_YT_ERRORS.has(e.data)) {
          errItem.restricted = true;
          recordFailedId(errId);
          _persistRestricted(errId, true);
          renderTrackList();
          _refreshTrackCounts();
        }
        _playConsecFails++;
        if (_playConsecFails >= getScanConsecFailThreshold()) {
          _playConsecFails = 0;
          return; // stop advancing — too many consecutive failures
        }
        if (isStopAtUnplayable()) return; // stop here — don't skip to next
        if (currentIndex < items.length - 1) setTimeout(() => {
          const nextIdx = _nextVisibleIdx(currentIndex, 1);
          if (nextIdx >= 0) playIndex(nextIdx, 0, 1);
        }, 1500);
      },
    },
  });
};

function loadYTScript() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

// ── Track scanner ────────────────────────────────────────────────────────────

function _persistRestricted(videoId, value) {
  if (!activePlaylistUrl || !videoId) return;
  saveRestrictedOverride(activePlaylistUrl, videoId, value);
  const item = items.find(it => it.videoId === videoId);
  if (item) item.restricted = value;
}

function _refreshTrackCounts() {
  const entry = allPlaylists.find(p => p.url === activePlaylistUrl);
  if (!entry) return;
  entry.playableCount   = items.filter(it => it.restricted !== true).length;
  entry.restrictedCount = items.filter(it => it.restricted === true).length;
  trackCountEl.textContent = entry.restrictedCount
    ? `${entry.playableCount} tracks · ${entry.restrictedCount} restricted`
    : `${entry.playableCount} tracks`;
}

// Tests one track; returns 'ok' | 'fail' | 'cancelled'.
// Retries up to SCAN_RETRIES times for transient (non-permanent) errors.
async function _testOneTrack(item) {
  for (let attempt = 0; attempt <= SCAN_RETRIES; attempt++) {
    if (!_scanActive) return 'cancelled';
    if (attempt > 0) await new Promise(r => setTimeout(r, SCAN_RETRY_DELAY_MS));
    if (!_scanActive) return 'cancelled';

    const { outcome, errCode } = await new Promise(resolve => {
      const myNonce = ++_scanNonce;

      const timer = setTimeout(() => {
        if (_scanNonce !== myNonce) return;
        _scanResolveTrack = null;
        resolve({ outcome: 'ok', errCode: null }); // timeout → assume accessible
      }, SCAN_TIMEOUT_MS);

      _scanCurrentItem = item;
      _scanResolveTrack = (outcome, nonce, errCode) => {
        if (nonce !== myNonce) return;
        clearTimeout(timer);
        _scanCurrentItem = null;
        _scanResolveTrack = null;
        resolve({ outcome, errCode });
      };

      ytPlayer.loadVideoById({ videoId: item.videoId, startSeconds: 0 });
    });

    if (outcome === 'ok') return 'ok';
    if (PERMANENT_YT_ERRORS.has(errCode)) return 'fail'; // no retry for permanent errors
    // transient — loop for next attempt
  }
  return 'fail';
}

function _scanMute()   { _scanWasMuted = ytPlayer.isMuted(); if (!_scanWasMuted) ytPlayer.mute(); }
function _scanUnmute() { if (!_scanWasMuted) ytPlayer.unMute(); }

function _markScanningItem(item) {
  const newIdx = item ? items.indexOf(item) : -1;
  if (newIdx === _scanningIdx) return;
  if (_scanningIdx >= 0)
    trackListEl.querySelector(`.track-item[data-idx="${_scanningIdx}"]`)?.classList.remove('scanning');
  _scanningIdx = newIdx;
  if (_scanningIdx >= 0)
    trackListEl.querySelector(`.track-item[data-idx="${_scanningIdx}"]`)?.classList.add('scanning');
}

function _scrollToScanItem(item) {
  if (!document.getElementById('settings-overlay')?.hidden) return;
  const itemIdx = items.indexOf(item);
  if (itemIdx < 0) return;
  if (_vsScrollHandler) {
    const di = _vsItems.findIndex(v => v.idx === itemIdx);
    if (di < 0) return;
    const top = di * VSCROLL_ITEM_H;
    const bot = top + VSCROLL_ITEM_H;
    const st  = trackListEl.scrollTop;
    const ch  = trackListEl.clientHeight;
    if (bot > st + ch || top < st) {
      trackListEl.scrollTo({ top, behavior: 'smooth' });
      _renderVSlice();
    }
  } else {
    const el = trackListEl.querySelector(`.track-item[data-idx="${itemIdx}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function scanAllTracks(onProgress) {
  if (_scanActive || !ytReady || !ytPlayer) return;
  _scanActive = true;
  const _resumeItem = items[currentIndex];
  _scanResumeState = _resumeItem?.videoId ? {
    videoId: _resumeItem.videoId,
    positionSec: (() => { try { return Math.floor(ytPlayer.getCurrentTime() ?? 0); } catch { return 0; } })(),
  } : null;
  _scanMute();
  let found = 0;
  let consecutiveFails = 0;
  const recentFailed = []; // rolling window for rollback on threshold
  const candidates = items.filter(it => it.restricted == null && it.videoId);
  const total = candidates.length;
  let scanned = 0;

  for (const item of candidates) {
    if (!_scanActive) break;
    scanned++;
    onProgress({ scanned, total, found, title: item.title, done: false });
    _scrollToScanItem(item);
    _markScanningItem(item);

    const result = await _testOneTrack(item);
    if (result === 'fail') {
      found++;
      _persistRestricted(item.videoId, true);
      recentFailed.push(item);
      if (recentFailed.length > getScanConsecFailThreshold()) recentFailed.shift();
      consecutiveFails++;
      renderTrackList();
      _refreshTrackCounts();
      if (consecutiveFails >= getScanConsecFailThreshold()) {
        // YT appears to be blocking everything — revert the last N results
        for (const fi of recentFailed) _persistRestricted(fi.videoId, null);
        renderTrackList();
        _refreshTrackCounts();
        _scanActive = false;
        break;
      }
    } else if (result === 'ok') {
      _persistRestricted(item.videoId, false);
      consecutiveFails = 0;
      recentFailed.length = 0;
    }

    if (_scanActive) await new Promise(r => setTimeout(r, SCAN_INTER_TRACK_MS));
  }

  _scanActive = false;
  _scanCurrentItem = null;
  _scanResolveTrack = null;
  _markScanningItem(null);
  _scanUnmute();
  onProgress({ scanned: total, total, found, title: '', done: true });
}

async function scanRestrictedTracks(onProgress) {
  if (_scanActive || !ytReady || !ytPlayer) return;
  _scanActive = true;
  const _resumeItem = items[currentIndex];
  _scanResumeState = _resumeItem?.videoId ? {
    videoId: _resumeItem.videoId,
    positionSec: (() => { try { return Math.floor(ytPlayer.getCurrentTime() ?? 0); } catch { return 0; } })(),
  } : null;
  _scanMute();
  let unblocked = 0;
  let consecutiveFails = 0;
  const candidates = items.filter(it => it.restricted === true && it.videoId);
  const total = candidates.length;
  let scanned = 0;

  for (const item of candidates) {
    if (!_scanActive) break;
    scanned++;
    onProgress({ scanned, total, unblocked, title: item.title, done: false });
    _scrollToScanItem(item);
    _markScanningItem(item);

    const result = await _testOneTrack(item);
    if (result === 'ok') {
      unblocked++;
      _persistRestricted(item.videoId, false);
      renderTrackList();
      _refreshTrackCounts();
      consecutiveFails = 0;
    } else {
      consecutiveFails++;
      if (consecutiveFails >= getScanConsecFailThreshold()) {
        _scanActive = false;
        break;
      }
    }

    if (_scanActive) await new Promise(r => setTimeout(r, SCAN_INTER_TRACK_MS));
  }

  _scanActive = false;
  _scanCurrentItem = null;
  _scanResolveTrack = null;
  _markScanningItem(null);
  _scanUnmute();
  onProgress({ scanned: total, total, unblocked, title: '', done: true });
}

function clearRestrictedState() {
  if (!activePlaylistUrl) return;
  clearRestrictedOverrides(activePlaylistUrl);
  items.forEach(it => { delete it.restricted; });
  renderTrackList();
  _refreshTrackCounts();
  updateScanButtons();
}

function cancelScan() {
  if (!_scanActive) return;
  _scanActive = false;
  _scanUnmute();
  if (_scanResolveTrack) _scanResolveTrack('ok', _scanNonce);
}

// ── Resume save loop ──────────────────────────────────────────────────────────
function startResumeSaveLoop() {
  if (resumeSaveTimer !== null) return;
  resumeSaveTimer = setInterval(() => {
    if (!ytReady || !ytPlayer || currentIndex < 0) return;
    try {
      const pos = ytPlayer.getCurrentTime() ?? 0;
      saveResume(currentIndex, Math.floor(pos));
    } catch { /* ignore */ }
  }, RESUME_SAVE_INTERVAL_MS);
}

// Also save immediately on page hide (tab switch, close, navigate away).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ytReady && ytPlayer && currentIndex >= 0) {
    try { saveResume(currentIndex, Math.floor(ytPlayer.getCurrentTime() ?? 0)); } catch { /* ignore */ }
  }
});

// ── Playlist loading ──────────────────────────────────────────────────────────
const PLAYLISTS_URL = './playlists/playlists.json';
let allPlaylists = [];        // [{ url, title, playableCount, restrictedCount, isCustom, id? }]
let remotePlaylistMeta = [];  // remote-only entries, rebuilt from playlists.json
let activePlaylistUrl = null;

function rebuildAllPlaylists() {
  const customPls = getCustomPlaylists().map(pl => ({
    url: `custom:${pl.id}`,
    id: pl.id,
    title: getPlaylistNameOverride(`custom:${pl.id}`) ?? pl.title,
    playableCount:   pl.items?.filter(it => !it.restricted).length ?? 0,
    restrictedCount: pl.items?.filter(it =>  it.restricted).length ?? 0,
    isCustom: true,
  }));
  allPlaylists = [...remotePlaylistMeta.map(p => ({
    ...p,
    title: getPlaylistNameOverride(p.url) ?? p.title,
  })), ...customPls];
}

async function switchPlaylist(url, restoreResume = false, deepLinkTarget = null) {
  // Save current filter and position before switching
  if (activePlaylistUrl && currentIndex >= 0 && ytReady && ytPlayer) {
    try { saveResume(currentIndex, Math.floor(ytPlayer.getCurrentTime() ?? 0)); } catch {}
  }
  if (activePlaylistUrl) savePlaylistState(activePlaylistUrl, { filter: activeFilter });

  statusOverlay.textContent = 'Loading playlist…';
  statusOverlay.classList.remove('hidden');

  let playlist;
  if (url.startsWith('custom:')) {
    const id = url.slice(7);
    playlist = getCustomPlaylistById(id);
    if (!playlist) {
      statusOverlay.textContent = 'Custom playlist not found.';
      return;
    }
  } else {
    try {
      playlist = await fetchJson(url);
    } catch (err) {
      statusOverlay.textContent = `Failed to load playlist: ${err.message}`;
      return;
    }
  }

  activePlaylistUrl = url;
  items = Array.isArray(playlist.items) ? playlist.items : [];

  // Apply persistent per-playlist videoId and attribute (title/year) overrides
  const vidOverrides  = getVideoIdOverrides(url);
  const attrOverrides = getTrackAttributeOverrides(url);
  if (Object.keys(vidOverrides).length > 0 || Object.keys(attrOverrides).length > 0) {
    items = items.map(item => {
      const key = item.videoId ?? ('\x00' + (item.title ?? ''));
      let out = item;
      if (key in vidOverrides)  out = { ...out, videoId: vidOverrides[key] };
      if (key in attrOverrides) out = { ...out, ...attrOverrides[key] };
      return out;
    });
  }

  // Load per-playlist state early (needed for removed filter below)
  const plState = getPlaylistState(url);

  // Apply per-playlist restricted overrides (stored locally, independent per playlist URL)
  const overrides = getRestrictedOverrides(activePlaylistUrl);
  const overrideKeys = Object.keys(overrides);
  if (overrideKeys.length > 0) {
    items = items.map(item =>
      item.videoId && item.videoId in overrides
        ? { ...item, restricted: overrides[item.videoId] }
        : item
    );
  }

  // Apply persistent per-playlist removals
  const removedIds = new Set(plState.removed ?? []);
  if (removedIds.size > 0) {
    items = items.filter(it => !it.videoId || !removedIds.has(it.videoId));
  }

  const rawTitle = (typeof playlist.title === 'string' && playlist.title.trim()) || 'Playlist';
  const title = getPlaylistNameOverride(url) ?? rawTitle;
  const playableCount   = items.filter(it => !it.restricted).length;
  const restrictedCount = items.filter(it =>  it.restricted).length;

  playlistTitleEl.textContent = title;
  trackCountEl.textContent = restrictedCount
    ? `${playableCount} tracks · ${restrictedCount} restricted`
    : `${playableCount} tracks`;
  document.title = `${title} – YT Player`;

  // Restore per-playlist state
  activeFilter = plState.filter ?? '';
  filterInputEl.value = activeFilter;
  filterClearBtn.hidden = !activeFilter;
  activeYearFilter = new Set();
  _selectedIds = new Set(plState.selected ?? []);
  _populateYearFilter();
  _syncSelectBtn();

  currentIndex = -1;
  renderTrackList();
  renderPickerDropdown();
  updateScanButtons();
  statusOverlay.classList.add('hidden');

  if (!items.length) return;

  if (deepLinkTarget) {
    let idx = -1;
    if (deepLinkTarget.videoId)
      idx = items.findIndex(it => it.videoId === deepLinkTarget.videoId);
    if (idx < 0 && deepLinkTarget.title) {
      const lc = deepLinkTarget.title.toLowerCase();
      idx = items.findIndex(it => (it.title ?? '').toLowerCase() === lc);
    }
    playIndex(idx >= 0 ? idx : 0);
  } else if (restoreResume) {
    const startIndex = (plState.index >= 0 && plState.index < items.length) ? plState.index : 0;
    const startPos   = plState.positionSec ?? 0;
    playIndex(startIndex, startPos);
  } else {
    playIndex(0);
  }
}

function renderPickerDropdown() {
  pickerDropdownEl.innerHTML = '';
  const hidden = getHiddenPlaylists();
  allPlaylists.filter(p => !hidden.has(p.url)).forEach(({ url, title, playableCount, restrictedCount }) => {
    const opt = document.createElement('div');
    opt.className = 'picker-option' + (url === activePlaylistUrl ? ' active' : '');
    const countStr = restrictedCount
      ? `${playableCount} tracks · ${restrictedCount} restricted`
      : `${playableCount} tracks`;
    opt.innerHTML = `<div class="picker-opt-title">${escapeHtml(title)}</div>
      <div class="picker-opt-count">${countStr}</div>`;
    opt.addEventListener('click', () => {
      closePicker();
      if (url !== activePlaylistUrl) switchPlaylist(url);
    });
    pickerDropdownEl.appendChild(opt);
  });
}

function openPicker()  { pickerDropdownEl.hidden = false; pickerEl.classList.add('open'); }
function closePicker() { pickerDropdownEl.hidden = true;  pickerEl.classList.remove('open'); }

pickerEl.querySelector('#playlist-picker-selected').addEventListener('click', () => {
  pickerDropdownEl.hidden ? openPicker() : closePicker();
});
document.addEventListener('click', (e) => {
  if (!pickerEl.contains(e.target)) closePicker();
});

async function loadPlaylist() {
  // Ensure custom playlists are loaded from IndexedDB before we build allPlaylists
  await initCustomPlaylists;

  statusOverlay.textContent = 'Loading playlist index…';
  statusOverlay.classList.remove('hidden');

  let entries;
  try {
    entries = await fetchJson(PLAYLISTS_URL);
  } catch (err) {
    statusOverlay.textContent = `Failed to load playlist index: ${err.message}`;
    return;
  }

  if (!Array.isArray(entries) || !entries.length) {
    statusOverlay.textContent = 'No playlists found.';
    return;
  }

  // Resolve URLs relative to playlists.json.
  // playlists.json entries can be:
  //   - a plain string path (existing format) → full fetch required for metadata
  //   - an object { url, title, playableCount?, restrictedCount? } → skip full fetch
  const base = new URL(PLAYLISTS_URL, window.location.href);

  // Normalise each entry into { url, inlineMeta? }
  const resolved = entries.map(e => {
    if (typeof e === 'string') return { url: new URL(e, base).href, inlineMeta: null };
    if (e && typeof e === 'object' && e.url) return { url: new URL(e.url, base).href, inlineMeta: e };
    return null;
  }).filter(Boolean);

  // Prefetch metadata (title + counts) for all remote playlists.
  // If the entry already carries metadata we skip the full-file fetch.
  remotePlaylistMeta = await Promise.all(resolved.map(async ({ url, inlineMeta }) => {
    if (inlineMeta && inlineMeta.title) {
      return {
        url,
        title:           inlineMeta.title,
        playableCount:   inlineMeta.playableCount   ?? 0,
        restrictedCount: inlineMeta.restrictedCount ?? 0,
        isCustom: false,
      };
    }
    try {
      const pl = await fetchJson(url);
      return {
        url,
        title:           pl.title || url,
        playableCount:   pl.playableCount   ?? pl.items?.filter(it => !it.restricted).length ?? 0,
        restrictedCount: pl.restrictedCount ?? pl.items?.filter(it =>  it.restricted).length ?? 0,
        isCustom: false,
      };
    } catch {
      return { url, title: url, playableCount: 0, restrictedCount: 0, isCustom: false };
    }
  }));

  rebuildAllPlaylists();

  initSettings({
    onHideRestrictedChange: () => renderTrackList(),
    onPlaylistsChange:      () => { rebuildAllPlaylists(); renderPickerDropdown(); },
    getAllPlaylists:        () => allPlaylists,
    onOpen:                closePicker,
    startScan:             (onProgress) => scanAllTracks(onProgress),
    cancelScan:            cancelScan,
    startScanRestricted:   (onProgress) => scanRestrictedTracks(onProgress),
    clearRestricted:       clearRestrictedState,
    getUnknownCount:       () => items.filter(it => it.restricted == null && it.videoId).length,
    onScanStatus:          (text) => {
      if (text) {
        nowPlayingEl.innerHTML = `<span>Scanning:</span>${escapeHtml(text)}`;
      } else {
        const item  = items[currentIndex];
        const label = item ? (item.title || item.videoId || '') : '–';
        nowPlayingEl.innerHTML = `<span>Now playing:</span>${escapeHtml(label)}`;
        // Restore the track that was playing before the scan started.
        if (_scanResumeState && ytReady && ytPlayer) {
          ytPlayer.loadVideoById({ videoId: _scanResumeState.videoId, startSeconds: _scanResumeState.positionSec });
          _scanResumeState = null;
        }
      }
    },
  });

  // ── Deep link handling ──────────────────────────────────────────────────────
  const _dlParams = new URLSearchParams(window.location.search);
  const _dlPl = _dlParams.get('pl');
  const _dlV  = _dlParams.get('v');
  const _dlT  = _dlParams.get('t');
  const _dlEntry = _dlPl ? allPlaylists.find(p => p.url === _dlPl || p.id === _dlPl) : null;

  if (_dlEntry) {
    await switchPlaylist(_dlEntry.url, false, { videoId: _dlV, title: _dlT });
    return;
  }
  // ── End deep link handling ──────────────────────────────────────────────────

  // Start with saved playlist (if still available and not hidden), else first non-hidden
  const hidden = getHiddenPlaylists();
  const savedUrl = loadResume()?.playlistUrl;
  const startUrl = (
    savedUrl &&
    allPlaylists.some(p => p.url === savedUrl && !hidden.has(p.url))
  ) ? savedUrl : allPlaylists.find(p => !hidden.has(p.url))?.url;

  if (startUrl) {
    await switchPlaylist(startUrl, true);
  } else {
    statusOverlay.textContent = 'All playlists are hidden — enable one in Settings (⋮).';
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────
function _populateYearFilter() {
  const years = [...new Set(items.map(it => it.year).filter(y => y != null))]
    .sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
  yearFilterDropEl.innerHTML = '';
  if (!years.length) {
    yearFilterBtnEl.style.display = 'none';
    return;
  }
  yearFilterBtnEl.style.display = '';

  // Toggle-all row
  const toggleAllEl = document.createElement('div');
  toggleAllEl.className = 'year-option year-toggle-all';
  const _refreshToggleAll = () => {
    const allSelected = years.every(y => activeYearFilter.has(String(y)));
    toggleAllEl.textContent = allSelected ? 'Clear all' : 'Select all';
    toggleAllEl.classList.toggle('selected', allSelected);
  };
  toggleAllEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const allSelected = years.every(y => activeYearFilter.has(String(y)));
    if (allSelected) {
      activeYearFilter.clear();
    } else {
      years.forEach(y => activeYearFilter.add(String(y)));
    }
    yearFilterDropEl.querySelectorAll('.year-option[data-year]').forEach(opt => {
      opt.classList.toggle('selected', activeYearFilter.has(opt.dataset.year));
    });
    _refreshToggleAll();
    _updateYearFilterBtn();
    renderTrackList();
  });
  _refreshToggleAll();
  yearFilterDropEl.appendChild(toggleAllEl);

  for (const year of years) {
    const y = String(year);
    const opt = document.createElement('div');
    opt.className = 'year-option' + (activeYearFilter.has(y) ? ' selected' : '');
    opt.dataset.year = y;
    opt.textContent = y;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeYearFilter.has(y)) activeYearFilter.delete(y);
      else activeYearFilter.add(y);
      opt.classList.toggle('selected', activeYearFilter.has(y));
      _refreshToggleAll();
      _updateYearFilterBtn();
      renderTrackList();
    });
    yearFilterDropEl.appendChild(opt);
  }
  _updateYearFilterBtn();
}

function _updateYearFilterBtn() {
  if (activeYearFilter.size > 0) {
    yearFilterBtnEl.textContent = `Year (${activeYearFilter.size})`;
    yearFilterBtnEl.classList.add('active');
  } else {
    yearFilterBtnEl.textContent = 'Year';
    yearFilterBtnEl.classList.remove('active');
  }
}

yearFilterBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  selectDropEl.hidden = true;
  yearFilterDropEl.hidden = !yearFilterDropEl.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#year-filter')) yearFilterDropEl.hidden = true;
});

// ── Selection ─────────────────────────────────────────────────────────────────
function _saveSelection() {
  if (activePlaylistUrl) savePlaylistState(activePlaylistUrl, { selected: [..._selectedIds] });
}

function _toggleSelect(videoId) {
  if (!videoId) return;
  _selectedIds.has(videoId) ? _selectedIds.delete(videoId) : _selectedIds.add(videoId);
  _saveSelection();
  for (const el of trackListEl.querySelectorAll('.track-item')) {
    const idx = parseInt(el.dataset.idx, 10);
    if (!isNaN(idx) && items[idx]?.videoId === videoId) {
      el.classList.toggle('selected', _selectedIds.has(videoId));
    }
  }
  _syncSelectBtn();
}

function _syncSelectBtn() {
  selectBtnEl.classList.toggle('active', _selectedIds.size > 0);
}

function _confirm(message) {
  return new Promise(resolve => {
    confirmMessageEl.textContent = message;
    confirmOverlayEl.hidden = false;
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      confirmOverlayEl.hidden = true;
      confirmOkEl.removeEventListener('click', onOk);
      confirmCancelEl.removeEventListener('click', onCancel);
    }
    confirmOkEl.addEventListener('click', onOk);
    confirmCancelEl.addEventListener('click', onCancel);
  });
}

async function _clearSelection() {
  if (!_selectedIds.size) return;
  const n = _selectedIds.size;
  const ok = await _confirm(`Clear ${n} selected track${n !== 1 ? 's' : ''}?`);
  if (!ok) return;
  _selectedIds.clear();
  _saveSelection();
  renderTrackList();
  _syncSelectBtn();
}

function _invertSelection() {
  const newSel = new Set();
  for (const { item } of _buildVisibleItems()) {
    if (item.videoId && !_selectedIds.has(item.videoId)) newSel.add(item.videoId);
  }
  _selectedIds = newSel;
  _saveSelection();
  renderTrackList();
  _syncSelectBtn();
}

function _selectByRestricted(restricted) {
  for (const { item } of _buildVisibleItems()) {
    if (item.videoId && !!item.restricted === restricted) _selectedIds.add(item.videoId);
  }
  _saveSelection();
  renderTrackList();
  _syncSelectBtn();
}

function _copySelectionTsv() {
  const rows = items
    .filter(it => it.videoId && _selectedIds.has(it.videoId))
    .map(it => [it.videoId, it.title ?? '', it.year ?? '', it.restricted != null ? String(it.restricted) : ''].join('\t'));
  if (rows.length) navigator.clipboard.writeText(rows.join('\n'));
}

function _copyPlayerLink() {
  const entry = allPlaylists.find(p => p.url === activePlaylistUrl);
  const item  = items[currentIndex];
  if (!entry || !item) return;
  const params = new URLSearchParams();
  params.set('pl', entry.url);
  if (item.videoId) params.set('v', item.videoId);
  if (item.title)   params.set('t', item.title);
  const base = window.location.origin + window.location.pathname;
  navigator.clipboard.writeText(`${base}?${params}`);
}

async function _removeSelected() {
  if (!_selectedIds.size) return;
  const n = _selectedIds.size;
  const ok = await _confirm(`Permanently remove ${n} selected track${n !== 1 ? 's' : ''}?`);
  if (!ok) return;

  // Persist removed videoIds in playlist state
  if (activePlaylistUrl) {
    const plState = getPlaylistState(activePlaylistUrl);
    const existing = new Set(plState.removed ?? []);
    for (const id of _selectedIds) existing.add(id);
    savePlaylistState(activePlaylistUrl, { removed: [...existing] });
  }

  // Compute currentIndex adjustment before filtering
  let removedBefore = 0;
  let currentRemoved = false;
  items.forEach((it, idx) => {
    if (!it.videoId || !_selectedIds.has(it.videoId)) return;
    if (idx < currentIndex) removedBefore++;
    if (idx === currentIndex) currentRemoved = true;
  });

  items = items.filter(it => !it.videoId || !_selectedIds.has(it.videoId));
  currentIndex = currentRemoved
    ? Math.min(currentIndex - removedBefore, items.length - 1)
    : currentIndex - removedBefore;

  _selectedIds.clear();
  _saveSelection();
  _refreshTrackCounts();
  renderTrackList();
  _syncSelectBtn();

  if (currentRemoved && items.length > 0) playIndex(Math.max(0, currentIndex));
}

const _videoIdUndoStack = []; // [{ idx, overrideKey, oldVideoId }] max 10

function _extractYtVideoId(text) {
  text = text.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split(/[?#]/)[0] || null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  } catch {}
  return null;
}

async function _openEditForTrack(idx) {
  const item = items[idx];
  if (!item || !activePlaylistUrl) return;
  const overrideKey = item.videoId ?? ('\x00' + (item.title ?? ''));

  const result = await openTrackEditor({ item, playlistUrl: activePlaylistUrl, overrideKey });
  if (!result) return;

  // VideoId: extract and persist if changed
  const rawVid = result.videoId;
  const newVid = rawVid ? (_extractYtVideoId(rawVid) ?? null) : null;
  if (newVid && newVid !== item.videoId) {
    if (item.videoId) recordVideoIdHistory(activePlaylistUrl, overrideKey, item.videoId);
    _videoIdUndoStack.push({ idx, overrideKey, oldVideoId: item.videoId ?? null });
    if (_videoIdUndoStack.length > 10) _videoIdUndoStack.shift();
    item.videoId = newVid;
    saveVideoIdOverride(activePlaylistUrl, overrideKey, newVid);
  }

  // Title / year attribute overrides
  const overrideAttrs = {};
  if (result.title) overrideAttrs.title = result.title;
  const yr = result.year.trim();
  if (yr !== '') overrideAttrs.year = isNaN(+yr) ? yr : +yr;
  saveTrackAttributeOverride(activePlaylistUrl, overrideKey, overrideAttrs);
  if (overrideAttrs.title !== undefined) item.title = overrideAttrs.title;
  if (overrideAttrs.year  !== undefined) item.year  = overrideAttrs.year;

  renderTrackList();
}

function _undoVideoIdOverride() {
  const entry = _videoIdUndoStack.pop();
  if (!entry) return;
  const item = items[entry.idx];
  if (!item) return;
  item.videoId = entry.oldVideoId;
  if (activePlaylistUrl) saveVideoIdOverride(activePlaylistUrl, entry.overrideKey, entry.oldVideoId);
  renderTrackList();
}
function _syncDropdownToggles() {
  selectDropEl.querySelector('[data-action="expose-selected"]')
    ?.classList.toggle('select-option-on', _hideUnselected);
  selectDropEl.querySelector('[data-action="toggle-hide-restricted"]')
    ?.classList.toggle('select-option-on', isHideRestricted());
  selectDropEl.querySelector('[data-action="toggle-disable-restricted"]')
    ?.classList.toggle('select-option-on', isDisableRestricted());
  selectDropEl.querySelector('[data-action="toggle-stop-at-unplayable"]')
    ?.classList.toggle('select-option-on', isStopAtUnplayable());
}

selectBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  yearFilterDropEl.hidden = true;
  selectDropEl.hidden = !selectDropEl.hidden;
  if (!selectDropEl.hidden) _syncDropdownToggles();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#select-filter')) selectDropEl.hidden = true;
});
selectDropEl.addEventListener('click', async (e) => {
  const opt = e.target.closest('.select-option');
  if (!opt) return;
  const action = opt.dataset.action;
  const isToggle = action === 'expose-selected' || action.startsWith('toggle-');
  if (!isToggle) selectDropEl.hidden = true;
  if (action === 'clear')                     await _clearSelection();
  if (action === 'invert')                    _invertSelection();
  if (action === 'select-enabled')            _selectByRestricted(false);
  if (action === 'select-disabled')           _selectByRestricted(true);
  if (action === 'copy-tsv')                  _copySelectionTsv();
  if (action === 'copy-link')                 _copyPlayerLink();
  if (action === 'expose-selected')           { _hideUnselected = !_hideUnselected; renderTrackList(); }
  if (action === 'remove')                    await _removeSelected();
  if (action === 'toggle-hide-restricted')    setHideRestricted(!isHideRestricted());
  if (action === 'toggle-disable-restricted') setDisableRestricted(!isDisableRestricted());
  if (action === 'toggle-stop-at-unplayable') setStopAtUnplayable(!isStopAtUnplayable());
  if (isToggle) _syncDropdownToggles();
});

function matchesFilter(item) {
  if (activeYearFilter.size > 0) {
    const y = item.year != null ? String(item.year) : '';
    if (!activeYearFilter.has(y)) return false;
  }
  if (!activeFilter || activeFilter.length < 2) return true;
  const haystack = (item.title || item.videoId || '').toLowerCase();
  return activeFilter.toLowerCase().split(/\s+/).filter(Boolean).every(tok => haystack.includes(tok));
}

// Returns the post-filter, post-hideRestricted array used by both renderers.
// Each entry: { item, idx (true array index), displayNum (1-based gapless) }
function _buildVisibleItems() {
  const hideRestricted = isHideRestricted();
  const result = [];
  let displayNum = 0;
  items.forEach((item, idx) => {
    if (hideRestricted && item.restricted) return;
    if (!matchesFilter(item)) return;
    if (_hideUnselected && !(item.videoId && _selectedIds.has(item.videoId))) return;
    displayNum++;
    result.push({ item, idx, displayNum });
  });
  return result;
}

// Returns the next raw items[] index from fromIdx in direction dir (+1/-1),
// staying within the currently visible (filtered) items. Returns -1 at boundaries.
function _nextVisibleIdx(fromIdx, dir) {
  const visible = _buildVisibleItems();
  if (!visible.length) return -1;
  const pos = visible.findIndex(v => v.idx === fromIdx);
  if (pos === -1) {
    // current track not in filtered view — snap to start/end of visible list
    return dir > 0 ? visible[0].idx : visible[visible.length - 1].idx;
  }
  const next = pos + dir;
  if (next < 0 || next >= visible.length) return -1;
  return visible[next].idx;
}

// ── Track item DOM builder (shared by both renderers) ─────────────────────────
function _makeTrackEl({ item, idx, displayNum }) {
  const restricted = !!item.restricted;
  const videoId = item?.videoId ? String(item.videoId) : '';
  const el = document.createElement('div');
  el.className = 'track-item' + (idx === currentIndex ? ' active' : '') + (restricted ? ' restricted' : '') + (idx === _scanningIdx ? ' scanning' : '') + (videoId && _selectedIds.has(videoId) ? ' selected' : '');
  el.dataset.idx = idx;
  el.tabIndex = 0;
  if (restricted) {
    el.title = videoId
      ? 'Not available in your region. Middle-click, cmd/ctrl-click, or long-press to open on YouTube.'
      : 'Not available in your region';
  }

  const raw = item.title || item.videoId || `Track ${displayNum}`;
  const { artist, song } = splitTitle(raw);
  const thumb = videoId ? ytThumb(videoId) : (item.thumbnail || item.artwork || '');
  let longPressTriggered = false;

  const openRestrictedTrack = () => {
    if (!restricted || !videoId) return;
    window.open(ytWatch(videoId), 'yt-restricted-track', 'noopener,noreferrer');
  };

  el.innerHTML = `
    <span class="track-checkbox"></span>
    <span class="track-num">${displayNum}</span>
    ${thumb ? `<img class="track-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
    <div class="track-info">
      <div class="track-row1">
        <div class="track-title">${escapeHtml(artist || song)}</div>
        ${item.year != null ? `<span class="track-year">${escapeHtml(String(item.year))}</span>` : ''}
      </div>
      ${artist ? `<div class="track-subtitle">${escapeHtml(song)}</div>` : ''}
    </div>`;

  if (videoId) {
    el.querySelector('.track-checkbox').addEventListener('click', (e) => {
      e.stopPropagation();
      _toggleSelect(videoId);
    });
  }

  if (restricted && videoId) {
    let longPressStartX = 0;
    let longPressStartY = 0;
    let longPressStartAt = 0;
    let longPressMoved = false;
    let touchActive = false;

    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    el.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      openRestrictedTrack();
    });

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      longPressTriggered = false;
      touchActive = true;
      longPressMoved = false;
      longPressStartAt = Date.now();
      longPressStartX = e.touches[0].clientX;
      longPressStartY = e.touches[0].clientY;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!touchActive || e.touches.length !== 1) return;
      const dx = Math.abs(e.touches[0].clientX - longPressStartX);
      const dy = Math.abs(e.touches[0].clientY - longPressStartY);
      if (dx > 12 || dy > 12) longPressMoved = true;
    }, { passive: true });

    el.addEventListener('touchend', () => {
      if (!touchActive) return;
      touchActive = false;
      const heldMs = Date.now() - longPressStartAt;
      if (!longPressMoved && heldMs >= 500) {
        longPressTriggered = true;
        openRestrictedTrack();
      }
    }, { passive: true });

    el.addEventListener('touchcancel', () => {
      touchActive = false;
      longPressMoved = true;
    }, { passive: true });
  }

  el.addEventListener('click', (e) => {
    if (restricted && videoId && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openRestrictedTrack();
      return;
    }
    if (longPressTriggered) {
      longPressTriggered = false;
      e.preventDefault();
      return;
    }
    if (idx !== currentIndex && (!restricted || !isDisableRestricted())) playIndex(idx);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && videoId) { e.preventDefault(); _toggleSelect(videoId); }
    if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      _openEditForTrack(idx);
    }
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.track-checkbox')) return;
    e.preventDefault();
    _openEditForTrack(idx);
  });
  return el;
}

// ── Full rendering (used below threshold) ─────────────────────────────────────
function _enterFullMode(visibleItems) {
  _detachVScroll();
  trackListEl.innerHTML = '';
  for (const entry of visibleItems) {
    trackListEl.appendChild(_makeTrackEl(entry));
  }
}

// ── Virtual scrolling (used at or above threshold) ────────────────────────────
function _detachVScroll() {
  if (_vsScrollHandler) {
    trackListEl.removeEventListener('scroll', _vsScrollHandler);
    _vsScrollHandler = null;
  }
  _vsItems = [];
}

function _renderVSlice() {
  const runway = document.getElementById('track-list-runway');
  if (!runway) return;

  const scrollTop    = trackListEl.scrollTop;
  const clientHeight = trackListEl.clientHeight;
  const count        = _vsItems.length;
  const BUFFER       = 8;

  const startVis = Math.floor(scrollTop / VSCROLL_ITEM_H);
  const endVis   = Math.ceil((scrollTop + clientHeight) / VSCROLL_ITEM_H);
  const start    = Math.max(0, startVis - BUFFER);
  const end      = Math.min(count - 1, endVis + BUFFER);

  // Remove nodes outside the new window
  for (const child of [...runway.children]) {
    const di = parseInt(child.dataset.di, 10);
    if (di < start || di > end) runway.removeChild(child);
  }

  // Collect which display-indices are already rendered
  const rendered = new Set();
  for (const child of runway.children) rendered.add(parseInt(child.dataset.di, 10));

  // Add missing nodes
  for (let di = start; di <= end; di++) {
    if (rendered.has(di)) continue;
    const entry = _vsItems[di];
    const el    = _makeTrackEl(entry);
    el.style.cssText = `position:absolute;top:${di * VSCROLL_ITEM_H}px;left:0;right:0;width:100%`;
    el.dataset.di    = di;
    runway.appendChild(el);
  }
}

function _enterVScrollMode(visibleItems) {
  _detachVScroll();
  _vsItems = visibleItems;

  trackListEl.innerHTML = '';
  const runway = document.createElement('div');
  runway.id = 'track-list-runway';
  runway.style.cssText = `position:relative;height:${visibleItems.length * VSCROLL_ITEM_H}px`;
  trackListEl.appendChild(runway);

  _vsScrollHandler = _renderVSlice;
  trackListEl.addEventListener('scroll', _vsScrollHandler, { passive: true });
  _renderVSlice();
}

// ── Track list rendering ──────────────────────────────────────────────────────
function renderTrackList() {
  const visibleItems = _buildVisibleItems();
  if (visibleItems.length <= FULL_RENDER_THRESHOLD) {
    _enterFullMode(visibleItems);
  } else {
    _enterVScrollMode(visibleItems);
  }
}

function syncActiveTrack(dir = 0) {
  const isVirtual = !!_vsScrollHandler;

  if (isVirtual) {
    // Find the display-index of the active item in the virtual list
    const di = _vsItems.findIndex(v => v.idx === currentIndex);
    if (di !== -1) {
      const itemTop    = di * VSCROLL_ITEM_H;
      const itemBottom = itemTop + VSCROLL_ITEM_H;
      const st         = trackListEl.scrollTop;
      const ch         = trackListEl.clientHeight;

      if (itemTop < st) {
        trackListEl.scrollTo({ top: itemTop, behavior: 'smooth' });
      } else if (itemBottom > st + ch) {
        trackListEl.scrollTo({ top: itemBottom - ch, behavior: 'smooth' });
      }
      // Ensure the node is in the DOM after the potential scroll
      _renderVSlice();
    }
  } else {
    const activeEl = trackListEl.querySelector(`.track-item[data-idx="${currentIndex}"]`);
    if (activeEl) {
      const listRect = trackListEl.getBoundingClientRect();
      const elRect   = activeEl.getBoundingClientRect();
      if (elRect.top < listRect.top) {
        const elTopInScroll = elRect.top - listRect.top + trackListEl.scrollTop;
        trackListEl.scrollTo({ top: elTopInScroll, behavior: 'smooth' });
      } else if (elRect.bottom > listRect.bottom) {
        const elBottomInScroll = elRect.bottom - listRect.top + trackListEl.scrollTop;
        trackListEl.scrollTo({ top: elBottomInScroll - trackListEl.clientHeight, behavior: 'smooth' });
      }
    }
  }

  // Update active class on all currently-rendered track items
  trackListEl.querySelectorAll('.track-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx, 10) === currentIndex);
  });

  // Move focus to the active track element — but not if an input/textarea has focus
  const focusEl = trackListEl.querySelector(`.track-item[data-idx="${currentIndex}"]`);
  const active = document.activeElement;
  const inputFocused = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (focusEl && !inputFocused) focusEl.focus({ preventScroll: true });

  if (!_scanActive) {
    const item  = items[currentIndex];
    const label = item ? (item.title || item.videoId || '') : '–';
    nowPlayingEl.innerHTML = `<span>Now playing:</span>${escapeHtml(label)}`;
  }
}

// ── Playback ──────────────────────────────────────────────────────────────────
function playIndex(idx, positionSec = 0, dir = 0) {
  if (!items.length) return;
  if (idx < 0 || idx >= items.length) return;  // no cycling at boundaries

  const item = items[idx];
  if (item?.restricted && isDisableRestricted()) {
    if (isStopAtUnplayable()) return; // stop, don't skip
    // Infer direction from caller if not supplied, default forward
    const step = dir !== 0 ? dir : 1;
    const nextIdx = _nextVisibleIdx(idx, step);
    if (nextIdx >= 0) playIndex(nextIdx, 0, step);
    return;
  }

  currentIndex = idx;
  syncActiveTrack(dir);
  const videoId = item?.videoId ? String(item.videoId) : '';
  if (!videoId) {
    const nextIdx = _nextVisibleIdx(idx, 1);
    if (nextIdx >= 0) playIndex(nextIdx);
    return;
  }

  saveResume(currentIndex, 0);

  if (ytReady && ytPlayer) {
    ytPlayer.loadVideoById({ videoId, startSeconds: positionSec });
  } else {
    pendingLoad = { videoId, positionSec };
  }
}

// ── Keyboard controls ─────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && _videoIdUndoStack.length) {
    e.preventDefault();
    _undoVideoIdOverride();
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (ytReady && ytPlayer) {
        const state = ytPlayer.getPlayerState();
        if (state === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
        else ytPlayer.playVideo();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      { const ni = _nextVisibleIdx(currentIndex, -1); if (ni >= 0) playIndex(ni, 0, -1); }
      break;
    case 'ArrowDown':
      e.preventDefault();
      { const ni = _nextVisibleIdx(currentIndex, 1); if (ni >= 0) playIndex(ni, 0, 1); }
      break;
    case 'ArrowLeft':
      if (e.altKey) break;
      e.preventDefault();
      if (ytReady && ytPlayer) ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() - 10), true);
      break;
    case 'ArrowRight':
      if (e.altKey) break;
      e.preventDefault();
      if (ytReady && ytPlayer) ytPlayer.seekTo(ytPlayer.getCurrentTime() + 10, true);
      break;
  }
});

// ── Button controls ───────────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => { const ni = _nextVisibleIdx(currentIndex, -1); if (ni >= 0) playIndex(ni, 0, -1); });
btnNext.addEventListener('click', () => { const ni = _nextVisibleIdx(currentIndex,  1); if (ni >= 0) playIndex(ni, 0,  1); });

// ── Swipe gestures ────────────────────────────────────────────────────────────
const SWIPE_MIN_X = 40;
const SWIPE_MAX_Y = 80;
let touchStartX = 0;
let touchStartY = 0;

document.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
  touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dy) > SWIPE_MAX_Y || Math.abs(dx) < SWIPE_MIN_X) return;
  if (dx < 0 ? currentIndex < items.length - 1 : currentIndex > 0)
    playIndex(dx < 0 ? currentIndex + 1 : currentIndex - 1, 0, dx < 0 ? 1 : -1);
}, { passive: true });

// ── Filter input ──────────────────────────────────────────────────────────────
let _filterDebounceTimer = null;
filterInputEl.addEventListener('input', () => {
  activeFilter = filterInputEl.value;
  filterClearBtn.hidden = !activeFilter;
  if (activePlaylistUrl) savePlaylistState(activePlaylistUrl, { filter: activeFilter });
  clearTimeout(_filterDebounceTimer);
  _filterDebounceTimer = setTimeout(() => {
    renderTrackList();
    if (currentIndex >= 0) syncActiveTrack(0);
  }, 150);
});

filterClearBtn.addEventListener('click', () => {
  filterInputEl.value = '';
  filterClearBtn.hidden = true;
  filterInputEl.dispatchEvent(new Event('input'));
  filterInputEl.focus();
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadYTScript();
loadPlaylist();
