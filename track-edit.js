// ── Track attribute editor overlay ───────────────────────────────────────────
// Displays a modal to edit videoId, title, and year for a single track.
// Maintains a per-track videoId history (max 5 entries) in localStorage.

const HIST_STORAGE_KEY = 'yt-pl-player.vid-history.v1';

function _loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_STORAGE_KEY) || '{}'); } catch { return {}; }
}

function _saveHistory(h) {
  try { localStorage.setItem(HIST_STORAGE_KEY, JSON.stringify(h)); } catch {}
}

function _histKey(playlistUrl, overrideKey) {
  return `${playlistUrl}::${overrideKey}`;
}

export function getVideoIdHistory(playlistUrl, overrideKey) {
  return _loadHistory()[_histKey(playlistUrl, overrideKey)] ?? [];
}

export function recordVideoIdHistory(playlistUrl, overrideKey, videoId) {
  if (!videoId) return;
  const h = _loadHistory();
  const k = _histKey(playlistUrl, overrideKey);
  const entries = (h[k] ?? []).filter(id => id !== videoId);
  entries.unshift(videoId);
  h[k] = entries.slice(0, 5);
  _saveHistory(h);
}

// ── Overlay DOM (built lazily) ────────────────────────────────────────────────
let _overlay   = null;
let _vidInput  = null;
let _titleInput = null;
let _yearInput  = null;
let _histList   = null;
let _histBtn    = null;
let _resolve    = null;

function _build() {
  const el = document.createElement('div');
  el.id = 'track-edit-overlay';
  el.setAttribute('hidden', '');
  el.innerHTML = `
    <div id="track-edit-box">
      <div class="track-edit-header">
        <span class="track-edit-title">Edit Track</span>
        <button class="settings-close-btn" id="track-edit-close">&#10005;</button>
      </div>
      <div class="track-edit-body">
        <div class="track-edit-field">
          <span class="track-edit-label">Video ID</span>
          <div class="track-edit-vid-wrap">
            <input class="track-edit-input track-edit-mono" id="track-edit-vid"
              type="text" autocomplete="off" spellcheck="false"
              placeholder="11-char ID or YouTube URL">
            <button class="track-edit-hist-btn" id="track-edit-hist-btn"
              title="Previous video IDs" hidden>&#9660;</button>
          </div>
          <div id="track-edit-hist-list" hidden></div>
        </div>
        <div class="track-edit-field">
          <span class="track-edit-label">Title</span>
          <input class="track-edit-input" id="track-edit-title-inp"
            type="text" autocomplete="off" spellcheck="false">
        </div>
        <div class="track-edit-field">
          <span class="track-edit-label">Year</span>
          <input class="track-edit-input track-edit-year" id="track-edit-year-inp"
            type="text" autocomplete="off" inputmode="numeric" placeholder="e.g. 1995">
        </div>
      </div>
      <div class="track-edit-footer">
        <button class="settings-btn" id="track-edit-cancel">Cancel</button>
        <button class="settings-btn track-edit-ok-btn" id="track-edit-ok">OK</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  _vidInput   = el.querySelector('#track-edit-vid');
  _titleInput = el.querySelector('#track-edit-title-inp');
  _yearInput  = el.querySelector('#track-edit-year-inp');
  _histList   = el.querySelector('#track-edit-hist-list');
  _histBtn    = el.querySelector('#track-edit-hist-btn');

  // History dropdown toggle
  _histBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _histList.hidden = !_histList.hidden;
  });

  // Close history on any outside click (capture phase)
  document.addEventListener('click', () => { if (_histList) _histList.hidden = true; }, true);

  el.querySelector('#track-edit-close').addEventListener('click', () => _dismiss(null));
  el.querySelector('#track-edit-cancel').addEventListener('click', () => _dismiss(null));
  el.querySelector('#track-edit-ok').addEventListener('click', _commit);

  // Backdrop click dismisses
  el.addEventListener('click', (e) => { if (e.target === el) _dismiss(null); });

  // Keyboard: Enter commits, Escape cancels (stop propagation so player.js doesn't see them)
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); _dismiss(null); }
    if (e.key === 'Enter')  { e.stopPropagation(); _commit(); }
  });

  _overlay = el;
}

function _dismiss(result) {
  if (!_overlay) return;
  _overlay.hidden = true;
  if (_histList) _histList.hidden = true;
  if (_resolve) { _resolve(result); _resolve = null; }
}

function _commit() {
  _dismiss({
    videoId: _vidInput.value.trim(),
    title:   _titleInput.value.trim(),
    year:    _yearInput.value.trim(),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Open the track editor overlay.
 * @param {{ videoId?: string, title?: string, year?: string|number }} opts.item
 * @param {string} opts.playlistUrl
 * @param {string} opts.overrideKey  original videoId or '\x00'+title
 * @returns {Promise<{videoId:string,title:string,year:string}|null>}
 */
export function openTrackEditor({ item, playlistUrl, overrideKey }) {
  if (!_overlay) _build();

  // Populate fields with current values
  _vidInput.value   = item.videoId != null ? String(item.videoId) : '';
  _titleInput.value = item.title   != null ? String(item.title)   : '';
  _yearInput.value  = item.year    != null ? String(item.year)    : '';

  // Populate videoId history dropdown
  const hist = getVideoIdHistory(playlistUrl, overrideKey);
  if (hist.length > 0) {
    _histBtn.hidden = false;
    _histList.innerHTML = '';
    for (const vid of hist) {
      const row = document.createElement('div');
      row.className = 'track-edit-hist-entry';
      row.textContent = vid;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        _vidInput.value = vid;
        _histList.hidden = true;
      });
      _histList.appendChild(row);
    }
  } else {
    _histBtn.hidden = true;
    _histList.innerHTML = '';
  }
  _histList.hidden = true;

  _overlay.hidden = false;
  // Focus and select the videoId field so users can immediately type a replacement
  _vidInput.focus();
  _vidInput.select();

  return new Promise(resolve => { _resolve = resolve; });
}
