// ── Resume persistence ────────────────────────────────────────────────────────
const RESUME_KEY = 'yt-pl-player.resume.v1';
const RESUME_SAVE_INTERVAL_MS = 10_000;

function loadResume() {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s.index !== 'number' || typeof s.positionSec !== 'number') return null;
    return s;
  } catch {
    return null;
  }
}

function saveResume(index, positionSec) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ index, positionSec }));
  } catch {
    // ignore (private mode, storage full, …)
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let items = [];
let currentIndex = -1;
let ytPlayer = null;
let ytReady = false;
let pendingLoad = null;   // { videoId, positionSec } to apply once the player is ready
let resumeSaveTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const trackListEl     = document.getElementById('track-list');
const playlistTitleEl = document.getElementById('playlist-title');
const trackCountEl    = document.getElementById('track-count');
const nowPlayingEl    = document.getElementById('now-playing-title');
const statusOverlay   = document.getElementById('status-overlay');
const btnPrev         = document.getElementById('btn-prev');
const btnNext         = document.getElementById('btn-next');

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
        if (e.data === YT.PlayerState.ENDED && currentIndex < items.length - 1) playIndex(currentIndex + 1, 0, 1);
      },
      onError(e) {
        const errItem = items[currentIndex];
        console.warn(`YT error ${e.data} videoId=${errItem?.videoId ?? '?'} title=${JSON.stringify(errItem?.title ?? '')}`);
        // Mark this track restricted so it is skipped and dimmed going forward
        if (items[currentIndex]) items[currentIndex].restricted = true;
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
async function loadPlaylist() {
  statusOverlay.textContent = 'Loading playlist index…';
  statusOverlay.classList.remove('hidden');

  let defaultsList;
  try {
    defaultsList = await fetchJson('./playlists/playlists.json');
  } catch (err) {
    statusOverlay.textContent = `Failed to load playlist index: ${err.message}`;
    return;
  }

  if (!Array.isArray(defaultsList) || !defaultsList.length) {
    statusOverlay.textContent = 'No playlists found in default-playlists.json';
    return;
  }

  statusOverlay.textContent = 'Loading playlist…';
  let playlist;
  try {
    playlist = await fetchJson(defaultsList[0]);
  } catch (err) {
    statusOverlay.textContent = `Failed to load playlist: ${err.message}`;
    return;
  }

  items = Array.isArray(playlist.items) ? playlist.items : [];
  const title = (typeof playlist.title === 'string' && playlist.title.trim()) || 'Playlist';

  playlistTitleEl.textContent = title;
  trackCountEl.textContent = `${items.length} track${items.length !== 1 ? 's' : ''}`;
  document.title = `${title} – YT Player`;

  renderTrackList();
  statusOverlay.classList.add('hidden');

  if (!items.length) return;

  // Restore previous position, or start from the beginning.
  const resume = loadResume();
  const startIndex = (resume && resume.index >= 0 && resume.index < items.length)
    ? resume.index
    : 0;
  const startPos = (resume && resume.index === startIndex) ? (resume.positionSec ?? 0) : 0;

  playIndex(startIndex, startPos);
}

// ── Track list rendering ──────────────────────────────────────────────────────
function renderTrackList() {
  trackListEl.innerHTML = '';
  items.forEach((item, idx) => {
    const el = document.createElement('div');
    const restricted = !!item.restricted;
    el.className = 'track-item' + (idx === currentIndex ? ' active' : '') + (restricted ? ' restricted' : '');
    if (restricted) el.title = 'Not available in your region';

    const raw = item.title || item.videoId || `Track ${idx + 1}`;
    const { artist, song } = splitTitle(raw);
    const thumb = item.videoId ? ytThumb(item.videoId) : (item.thumbnail || item.artwork || '');

    el.innerHTML = `
      <span class="track-num">${idx + 1}</span>
      ${thumb ? `<img class="track-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="track-info">
        <div class="track-title">${escapeHtml(artist || song)}</div>
        ${artist ? `<div class="track-subtitle">${escapeHtml(song)}</div>` : ''}
      </div>`;

    el.addEventListener('click', () => { if (!restricted) playIndex(idx); });
    trackListEl.appendChild(el);
  });
}

function syncActiveTrack() {
  trackListEl.querySelectorAll('.track-item').forEach((el, idx) => {
    el.classList.toggle('active', idx === currentIndex);
  });
  trackListEl.querySelector('.track-item.active')
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

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
  syncActiveTrack();
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

// ── Init ──────────────────────────────────────────────────────────────────────
loadYTScript();
loadPlaylist();
