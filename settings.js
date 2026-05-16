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
const _cb = { onHideRestrictedChange: null, onPlaylistsChange: null, onOpen: null, startScan: null, cancelScan: null, startScanRestricted: null, clearRestricted: null, getUnknownCount: null, onScanStatus: null };
let _getAllPlaylists = null;

// ── DOM elements (set after DOMContentLoaded via initSettings) ────────────────
let _overlayEl, _listEl, _failedCountEl, _hideRestrictedCb, _scanBtn, _scanRestrictedBtn, _clearRestrictedBtn;

export function initSettings({ onHideRestrictedChange, onPlaylistsChange, getAllPlaylists, onOpen, startScan, cancelScan, startScanRestricted, clearRestricted, getUnknownCount, onScanStatus }) {
  _cb.onHideRestrictedChange = onHideRestrictedChange;
  _cb.onPlaylistsChange      = onPlaylistsChange;
  _cb.onOpen                 = onOpen;
  _cb.startScan              = startScan;
  _cb.cancelScan             = cancelScan;
  _cb.startScanRestricted    = startScanRestricted;
  _cb.clearRestricted        = clearRestricted;
  _cb.getUnknownCount        = getUnknownCount;
  _cb.onScanStatus           = onScanStatus;
  _getAllPlaylists            = getAllPlaylists;

  _overlayEl           = document.getElementById('settings-overlay');
  _listEl              = document.getElementById('settings-playlist-list');
  _failedCountEl       = document.getElementById('settings-failed-count');
  _hideRestrictedCb    = document.getElementById('setting-hide-restricted');
  _scanBtn             = document.getElementById('settings-scan-btn');
  _scanRestrictedBtn   = document.getElementById('settings-scan-restricted-btn');
  _clearRestrictedBtn  = document.getElementById('settings-clear-restricted-btn');
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

  // Updates the status element and notifies the player (live=true while actively scanning).
  function _setScanStatus(text, live = false) {
    _cb.onScanStatus?.(live ? text : null);
  }

  let _scanning = false;
  let _scanStartMs = 0;
  _scanBtn.addEventListener('click', () => {
    if (_scanning) {
      _cb.cancelScan?.();
      _scanning = false;
      _updateScanAllLabel();
      _setScanStatus('Scan stopped.');
      return;
    }
    _scanning = true;
    _scanStartMs = Date.now();
    _scanBtn.textContent = 'Stop Scanning Tracks';
    _setScanStatus('Starting scan…', true);
    _cb.startScan?.(({ scanned, total, found, title, done }) => {
      if (done) {
        _scanning = false;
        _updateScanAllLabel();
        _setScanStatus(`Scan complete — ${found} restricted found out of ${total} unknown track${total !== 1 ? 's' : ''}.`);
        _renderFailedSection();
        return;
      }
      const eta = _fmtEta(_scanStartMs, scanned, total);
      const etaPart = eta ? ` · ETA ${eta}` : '';
      _setScanStatus(`${scanned} / ${total} scanned · ${found} restricted${etaPart}`, true);
    });
  });

  let _scanningRestricted = false;
  let _scanRestrictedStartMs = 0;
  _scanRestrictedBtn.addEventListener('click', () => {
    if (_scanningRestricted) {
      _cb.cancelScan?.();
      _scanningRestricted = false;
      _scanRestrictedBtn.textContent = 'Scan Restricted';
      _setScanStatus('Re-scan stopped.');
      return;
    }
    _scanningRestricted = true;
    _scanRestrictedStartMs = Date.now();
    _scanRestrictedBtn.textContent = 'Stop Scanning Restricted';
    _setScanStatus('Re-scanning restricted tracks…', true);
    _cb.startScanRestricted?.(({ scanned, total, unblocked, title, done }) => {
      if (done) {
        _scanningRestricted = false;
        _scanRestrictedBtn.textContent = 'Scan Restricted';
        _setScanStatus(`Re-scan complete — ${unblocked} track${unblocked !== 1 ? 's' : ''} now playable out of ${total} checked.`);
        return;
      }
      const eta = _fmtEta(_scanRestrictedStartMs, scanned, total);
      const etaPart = eta ? ` · ETA ${eta}` : '';
      _setScanStatus(`${scanned} / ${total} re-scanned · ${unblocked} now playable${etaPart}`, true);
    });
  });

  _clearRestrictedBtn.addEventListener('click', () => {
    _cb.clearRestricted?.();
    _setScanStatus('All track states reset to unknown.');
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

function _fmtEta(startMs, scanned, total) {
  if (scanned <= 0 || total <= scanned) return '';
  const remaining = (total - scanned) * ((Date.now() - startMs) / scanned);
  const eta = new Date(Date.now() + remaining);
  const p = n => String(n).padStart(2, '0');
  return `${eta.getFullYear()}-${p(eta.getMonth() + 1)}-${p(eta.getDate())} ${p(eta.getHours())}:${p(eta.getMinutes())}`;
}

function _updateScanAllLabel() {
  if (!_scanBtn) return;
  const n = _cb.getUnknownCount?.() ?? '?';
  _scanBtn.textContent = `Scan ${n} Tracks`;
}

export function updateScanButtons() {
  _updateScanAllLabel();
}

export function openSettings() {
  _cb.onOpen?.();
  _updateScanAllLabel();
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
        title: renameInput.value.trim() || title,
        customId: isCustom ? id : null,
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
    await ingestFile(file);
    _cb.onPlaylistsChange?.();
    _renderPlaylistSection();
  } catch (err) {
    alert(`Could not import playlist: ${err.message}`);
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
