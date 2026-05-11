import {
  getCustomPlaylists, getCustomPlaylistById,
  addCustomPlaylist, deleteCustomPlaylist, renameCustomPlaylist,
  downloadPlaylist, ingestFile,
} from './playlist.js';

// ── Persistence keys ──────────────────────────────────────────────────────────
const SETTINGS_KEY = 'yt-pl-player.settings.v1';
const FAILED_KEY   = 'yt-pl-player.failed.v1';

// ── Settings state ────────────────────────────────────────────────────────────
function _loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      hideRestricted:  'hideRestricted' in s ? !!s.hideRestricted : true,
      hiddenPlaylists: Array.isArray(s.hiddenPlaylists) ? s.hiddenPlaylists : [],
      nameOverrides:   (s.nameOverrides && typeof s.nameOverrides === 'object') ? s.nameOverrides : {},
    };
  } catch { return { hideRestricted: true, hiddenPlaylists: [], nameOverrides: {} }; }
}
function _saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch {}
}
let _settings = _loadSettings();

export function isHideRestricted()   { return _settings.hideRestricted; }
export function getHiddenPlaylists() { return new Set(_settings.hiddenPlaylists); }
export function getPlaylistNameOverride(url) { return _settings.nameOverrides[url] ?? null; }
export function setPlaylistNameOverride(url, name) {
  const trimmed = name.trim();
  if (trimmed) {
    _settings.nameOverrides[url] = trimmed;
  } else {
    delete _settings.nameOverrides[url];
  }
  _saveSettings();
}

export function setHideRestricted(val) {
  _settings.hideRestricted = !!val;
  _saveSettings();
  _cb.onHideRestrictedChange?.();
}

export function toggleHiddenPlaylist(url) {
  const set = new Set(_settings.hiddenPlaylists);
  set.has(url) ? set.delete(url) : set.add(url);
  _settings.hiddenPlaylists = [...set];
  _saveSettings();
  _cb.onPlaylistsChange?.();
}

// ── Failed video IDs ──────────────────────────────────────────────────────────
function _loadFailed() {
  try { return new Set(JSON.parse(localStorage.getItem(FAILED_KEY) || '[]')); } catch { return new Set(); }
}
function _saveFailed() {
  try { localStorage.setItem(FAILED_KEY, JSON.stringify([..._failedIds])); } catch {}
}
let _failedIds = _loadFailed();

export function getFailedIds() { return _failedIds; }

export function recordFailedId(id) {
  if (!id || _failedIds.has(id)) return;
  _failedIds.add(id);
  _saveFailed();
  _renderFailedSection();
}

// ── Callbacks injected by player.js ──────────────────────────────────────────
const _cb = { onHideRestrictedChange: null, onPlaylistsChange: null, onOpen: null, startScan: null, cancelScan: null };
let _getAllPlaylists = null;

// ── DOM elements (set after DOMContentLoaded via initSettings) ────────────────
let _overlayEl, _listEl, _failedCountEl, _hideRestrictedCb, _scanBtn, _scanStatus;

export function initSettings({ onHideRestrictedChange, onPlaylistsChange, getAllPlaylists, onOpen, startScan, cancelScan }) {
  _cb.onHideRestrictedChange = onHideRestrictedChange;
  _cb.onPlaylistsChange      = onPlaylistsChange;
  _cb.onOpen                 = onOpen;
  _cb.startScan              = startScan;
  _cb.cancelScan             = cancelScan;
  _getAllPlaylists            = getAllPlaylists;

  _overlayEl        = document.getElementById('settings-overlay');
  _listEl           = document.getElementById('settings-playlist-list');
  _failedCountEl    = document.getElementById('settings-failed-count');
  _hideRestrictedCb = document.getElementById('setting-hide-restricted');
  _scanBtn          = document.getElementById('settings-scan-btn');
  _scanStatus       = document.getElementById('settings-scan-status');

  _hideRestrictedCb.checked = _settings.hideRestricted;
  _hideRestrictedCb.addEventListener('change', () => setHideRestricted(_hideRestrictedCb.checked));

  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });

  const clearBtn = document.getElementById('settings-clear-failed');
  clearBtn.addEventListener('click', () => {
    if (!_failedIds.size) return;
    _failedIds.clear();
    localStorage.setItem(FAILED_KEY, JSON.stringify([]));
    _renderFailedSection();
  });

  const copyBtn = document.getElementById('settings-copy-failed');
  copyBtn.addEventListener('click', async () => {
    const ids = [..._failedIds];
    if (!ids.length) return;
    const text = ids.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
  });

  let _scanning = false;
  _scanBtn.addEventListener('click', () => {
    if (_scanning) {
      _cb.cancelScan?.();
      _scanning = false;
      _scanBtn.textContent = 'Scan All Tracks';
      _scanStatus.hidden = false;
      _scanStatus.textContent = 'Scan stopped.';
      return;
    }
    _scanning = true;
    _scanBtn.textContent = 'Stop Scan';
    _scanStatus.hidden = false;
    _scanStatus.textContent = 'Starting scan…';
    _cb.startScan?.(({ scanned, total, found, title, done }) => {
      if (done) {
        _scanning = false;
        _scanBtn.textContent = 'Scan All Tracks';
        _scanStatus.textContent = `Scan complete — ${found} new failure${found !== 1 ? 's' : ''} found out of ${total} tracks.`;
        _renderFailedSection();
        return;
      }
      const label = title ? ` · ${title.length > 38 ? title.slice(0, 36) + '…' : title}` : '';
      _scanStatus.textContent = `Scanning ${scanned}/${total} · ${found} new failure${found !== 1 ? 's' : ''}${label}`;
    });
  });

  // File drop / click-to-upload
  const dropZone  = document.getElementById('settings-drop-zone');
  const fileInput = document.getElementById('settings-file-input');

  dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) _handleFileUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) _handleFileUpload(fileInput.files[0]);
    fileInput.value = '';
  });
}

export function openSettings() {
  _cb.onOpen?.();
  _renderPlaylistSection();
  _renderFailedSection();
  _overlayEl.hidden = false;
}

export function closeSettings() {
  _overlayEl.hidden = true;
}

// ── Internal renderers ────────────────────────────────────────────────────────
function _renderPlaylistSection() {
  if (!_listEl || !_getAllPlaylists) return;
  const hidden = getHiddenPlaylists();
  _listEl.innerHTML = '';

  _getAllPlaylists().forEach(({ url, title, playableCount, restrictedCount, isCustom, id }) => {
    const isHidden = hidden.has(url);
    // Display name: user override takes priority over the fetched title
    const displayTitle = getPlaylistNameOverride(url) ?? title;
    const row = document.createElement('div');
    row.className = 'settings-pl-row';
    const countStr = restrictedCount
      ? `${playableCount} tracks · <em>${restrictedCount} restricted</em>`
      : `${playableCount} tracks`;

    row.innerHTML = `
      <div class="settings-pl-toggle">
        <input type="checkbox" ${isHidden ? '' : 'checked'} autocomplete="off">
        <span class="settings-pl-info">
          <input class="settings-pl-rename" type="text" value="${_esc(displayTitle)}" autocomplete="off" spellcheck="false" aria-label="Rename playlist">
          <span class="settings-pl-meta">${countStr}</span>
        </span>
      </div>
      <div class="settings-pl-actions">
        <button class="settings-icon-btn" title="Download">&#11015;</button>
        ${isCustom ? `<button class="settings-icon-btn danger" title="Delete">&#10005;</button>` : ''}
      </div>`;

    row.querySelector('input[type=checkbox]').addEventListener('change', () => {
      toggleHiddenPlaylist(url);
      _renderPlaylistSection();
    });

    const renameInput = row.querySelector('.settings-pl-rename');
    renameInput.addEventListener('click', (e) => e.stopPropagation());
    const _saveRename = () => {
      if (isCustom) {
        renameCustomPlaylist(id, renameInput.value);
      } else {
        setPlaylistNameOverride(url, renameInput.value);
      }
      _cb.onPlaylistsChange?.();
    };
    renameInput.addEventListener('change', _saveRename);
    renameInput.addEventListener('blur',   _saveRename);

    if (isCustom) {
      row.querySelector('[title="Delete"]').addEventListener('click', () => {
        deleteCustomPlaylist(id);
        _cb.onPlaylistsChange?.();
        _renderPlaylistSection();
      });
    }


    row.querySelector('[title="Download"]').addEventListener('click', () =>
      downloadPlaylist({
        url,
        title,
        customId: isCustom ? id : null,
        failedIds: _failedIds,
        fetchFn: async (u) => {
          const r = await fetch(u, { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      })
    );

    _listEl.appendChild(row);
  });
}

function _renderFailedSection() {
  if (!_failedCountEl) return;
  const n = _failedIds.size;
  _failedCountEl.textContent = n === 0
    ? 'No failed videos recorded.'
    : `${n} video ID${n !== 1 ? 's' : ''} recorded.`;
}

async function _handleFileUpload(file) {
  try {
    await ingestFile(file, _failedIds);
    _cb.onPlaylistsChange?.();
    _renderPlaylistSection();
  } catch (err) {
    alert(`Could not import playlist: ${err.message}`);
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
