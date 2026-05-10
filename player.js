import {
  isHideRestricted, getHiddenPlaylists,
  initSettings, recordFailedId,
} from './settings.js';
import {
  getCustomPlaylists, getCustomPlaylistById,
  getPlaylistState, savePlaylistState,
} from './playlist.js';

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

// Scan state (separate from normal playback)
let _scanActive = false;
let _scanCurrentItem = null;  // item being tested during scan
let _scanResolveTrack = null; // resolves the per-track promise

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

async function fetchJson(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} – ${url}`);
  return resp.json();
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
          if (e.data === 1) _scanResolveTrack('ok');
          return;
        }
        if (e.data === YT.PlayerState.ENDED && currentIndex < items.length - 1) playIndex(currentIndex + 1, 0, 1);
      },
      onError(e) {
        if (_scanActive && _scanResolveTrack) {
          // Record failure and let the scan loop handle advancing
          const errItem = _scanCurrentItem;
          const errId = errItem?.videoId;
          console.warn(`[scan] YT error ${e.data} videoId=${errId ?? '?'}`);
          if (errItem) errItem.restricted = true;
          recordFailedId(errId);
          renderTrackList();
          _scanResolveTrack('fail');
          return;
        }
        const errItem = items[currentIndex];
        const errId = errItem?.videoId;
        console.warn(`YT error ${e.data} videoId=${errId ?? '?'} title=${JSON.stringify(errItem?.title ?? '')}`);
        // Mark this track restricted so it is skipped and dimmed going forward
        if (items[currentIndex]) items[currentIndex].restricted = true;
        recordFailedId(errId);
        renderTrackList();
        if (currentIndex < items.length - 1) setTimeout(() => playIndex(currentIndex + 1, 0, 1), 1500);
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
const SCAN_TIMEOUT_MS = 6000;

async function scanAllTracks(onProgress) {
  if (_scanActive || !ytReady || !ytPlayer) return;
  _scanActive = true;
  let found = 0;
  const total = items.filter(it => !it.restricted && it.videoId).length;
  let scanned = 0;

  for (let idx = 0; idx < items.length; idx++) {
    if (!_scanActive) break;
    const item = items[idx];
    if (item.restricted || !item.videoId) continue;

    scanned++;
    onProgress({ scanned, total, found, title: item.title, done: false });

    const result = await new Promise(resolve => {
      const timer = setTimeout(() => {
        _scanResolveTrack = null;
        resolve('ok');
      }, SCAN_TIMEOUT_MS);

      _scanCurrentItem = item;
      _scanResolveTrack = (outcome) => {
        clearTimeout(timer);
        _scanCurrentItem = null;
        _scanResolveTrack = null;
        resolve(outcome);
      };

      ytPlayer.loadVideoById({ videoId: item.videoId, startSeconds: 0 });
    });

    if (result === 'fail') found++;
  }

  _scanActive = false;
  _scanCurrentItem = null;
  _scanResolveTrack = null;
  onProgress({ scanned: total, total, found, title: '', done: true });
}

function cancelScan() {
  if (!_scanActive) return;
  _scanActive = false;
  if (_scanResolveTrack) _scanResolveTrack('ok');
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
    title: pl.title,
    playableCount:   pl.items?.filter(it => !it.restricted).length ?? 0,
    restrictedCount: pl.items?.filter(it =>  it.restricted).length ?? 0,
    isCustom: true,
  }));
  allPlaylists = [...remotePlaylistMeta, ...customPls];
}

async function switchPlaylist(url, restoreResume = false) {
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
  const title = (typeof playlist.title === 'string' && playlist.title.trim()) || 'Playlist';
  const playableCount   = items.filter(it => !it.restricted).length;
  const restrictedCount = items.filter(it =>  it.restricted).length;

  playlistTitleEl.textContent = title;
  trackCountEl.textContent = restrictedCount
    ? `${playableCount} tracks · ${restrictedCount} restricted`
    : `${playableCount} tracks`;
  document.title = `${title} – YT Player`;

  // Restore per-playlist state
  const plState = getPlaylistState(url);
  activeFilter = plState.filter ?? '';
  filterInputEl.value = activeFilter;

  currentIndex = -1;
  renderTrackList();
  renderPickerDropdown();
  statusOverlay.classList.add('hidden');

  if (!items.length) return;

  if (restoreResume) {
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

  // Resolve URLs relative to playlists.json
  const base = new URL(PLAYLISTS_URL, window.location.href);
  const resolved = entries.map(e => new URL(e, base).href);

  // Prefetch metadata (title + counts) for all remote playlists
  remotePlaylistMeta = await Promise.all(resolved.map(async url => {
    try {
      const pl = await fetchJson(url);
      return {
        url,
        title:           pl.title || url,
        playableCount:   pl.items?.filter(it => !it.restricted).length ?? 0,
        restrictedCount: pl.items?.filter(it =>  it.restricted).length ?? 0,
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
  });

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
function matchesFilter(item) {
  if (!activeFilter || activeFilter.length < 2) return true;
  const haystack = (item.title || item.videoId || '').toLowerCase();
  return activeFilter.toLowerCase().split(/\s+/).filter(Boolean).every(tok => haystack.includes(tok));
}

// ── Track list rendering ──────────────────────────────────────────────────────
function renderTrackList() {
  trackListEl.innerHTML = '';
  const hideRestricted = isHideRestricted();
  let displayNum = 0;

  items.forEach((item, idx) => {
    const restricted = !!item.restricted;
    if (hideRestricted && restricted) return;
    if (!matchesFilter(item)) return;
    displayNum++;

    const el = document.createElement('div');
    el.className = 'track-item' + (idx === currentIndex ? ' active' : '') + (restricted ? ' restricted' : '');
    el.dataset.idx = idx;
    if (restricted) el.title = 'Not available in your region';

    const raw = item.title || item.videoId || `Track ${displayNum}`;
    const { artist, song } = splitTitle(raw);
    const thumb = item.videoId ? ytThumb(item.videoId) : (item.thumbnail || item.artwork || '');

    el.innerHTML = `
      <span class="track-num">${displayNum}</span>
      ${thumb ? `<img class="track-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="track-info">
        <div class="track-title">${escapeHtml(artist || song)}</div>
        ${artist ? `<div class="track-subtitle">${escapeHtml(song)}</div>` : ''}
      </div>`;

    el.addEventListener('click', () => { if (!restricted) playIndex(idx); });
    trackListEl.appendChild(el);
  });
}

function syncActiveTrack(dir = 0) {
  trackListEl.querySelectorAll('.track-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx, 10) === currentIndex);
  });

  const activeEl = trackListEl.querySelector(`.track-item[data-idx="${currentIndex}"]`);
  if (activeEl) {
    const listRect = trackListEl.getBoundingClientRect();
    const elRect   = activeEl.getBoundingClientRect();

    if (dir >= 0 && elRect.bottom > listRect.bottom) {
      // moving forward and item is below visible area → align to top
      const elTopInScroll = elRect.top - listRect.top + trackListEl.scrollTop;
      trackListEl.scrollTo({ top: elTopInScroll, behavior: 'smooth' });
    } else if (dir <= 0 && elRect.top < listRect.top) {
      // moving backward and item is above visible area → align to bottom
      const elBottomInScroll = elRect.bottom - listRect.top + trackListEl.scrollTop;
      trackListEl.scrollTo({ top: elBottomInScroll - trackListEl.clientHeight, behavior: 'smooth' });
    }
    // already visible → no scroll
  }

  const item  = items[currentIndex];
  const label = item ? (item.title || item.videoId || '') : '–';
  nowPlayingEl.innerHTML = `<span>Now playing:</span>${escapeHtml(label)}`;
}

// ── Playback ──────────────────────────────────────────────────────────────────
function playIndex(idx, positionSec = 0, dir = 0) {
  if (!items.length) return;
  if (idx < 0 || idx >= items.length) return;  // no cycling at boundaries

  const item = items[idx];
  if (item?.restricted) {
    // Infer direction from caller if not supplied, default forward
    const step = dir !== 0 ? dir : 1;
    playIndex(idx + step, 0, step);
    return;
  }

  currentIndex = idx;
  syncActiveTrack(dir);
  const videoId = item?.videoId ? String(item.videoId) : '';
  if (!videoId) { playIndex(idx + 1); return; }

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
      if (currentIndex > 0) playIndex(currentIndex - 1, 0, -1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (currentIndex < items.length - 1) playIndex(currentIndex + 1, 0, 1);
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
btnPrev.addEventListener('click', () => { if (currentIndex > 0) playIndex(currentIndex - 1, 0, -1); });
btnNext.addEventListener('click', () => { if (currentIndex < items.length - 1) playIndex(currentIndex + 1, 0, 1); });

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
filterInputEl.addEventListener('input', () => {
  activeFilter = filterInputEl.value;
  if (activePlaylistUrl) savePlaylistState(activePlaylistUrl, { filter: activeFilter });
  renderTrackList();
  // Re-sync active highlight after re-render
  if (currentIndex >= 0) syncActiveTrack(0);
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadYTScript();
loadPlaylist();
