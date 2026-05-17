// ── playlist.js ───────────────────────────────────────────────────────────────
// Handles:
//  • Custom playlist CRUD — IndexedDB persistence (falls back to localStorage)
//  • Per-playlist state (resume index, positionSec, filter) — localStorage
//  • Ingesting JSON / CSV / TSV uploads
//  • ZIP + JSON/TSV download via JSZip CDN
// ─────────────────────────────────────────────────────────────────────────────

const CUSTOM_LS_KEY = 'yt-pl-player.custom.v1'; // legacy / fallback key
const PL_STATE_KEY  = 'yt-pl-player.pl-state.v1';
const IDB_NAME      = 'yt-pl-player';
const IDB_VERSION   = 1;
const IDB_STORE     = 'custom-playlists';

// ── Per-playlist state (localStorage — small, no size concern) ────────────────
let _plState = (() => {
  try { return JSON.parse(localStorage.getItem(PL_STATE_KEY) || '{}'); } catch { return {}; }
})();

function _savePlState() {
  try { localStorage.setItem(PL_STATE_KEY, JSON.stringify(_plState)); } catch {}
}

export function getPlaylistState(url) {
  return _plState[url] ?? { index: 0, positionSec: 0, filter: '' };
}

export function savePlaylistState(url, state) {
  _plState[url] = { ...(_plState[url] ?? {}), ...state };
  _savePlState();
}

// ── Per-playlist restricted overrides ────────────────────────────────────────
// Stored in _plState[url].restricted as { [videoId]: true | false }.
// Absence of a key means unknown/unscanned (null state).
// This is intentionally per-playlist: the same videoId in two playlists
// has independent restricted state.
export function getRestrictedOverrides(url) {
  return _plState[url]?.restricted ?? {};
}

export function saveRestrictedOverride(url, videoId, value) {
  if (!_plState[url]) _plState[url] = {};
  if (!_plState[url].restricted) _plState[url].restricted = {};
  if (value === null || value === undefined) {
    delete _plState[url].restricted[videoId];
  } else {
    _plState[url].restricted[videoId] = value;
  }
  _savePlState();
}

export function clearRestrictedOverrides(url) {
  if (!_plState[url]) return;
  delete _plState[url].restricted;
  _savePlState();
}

// ── Per-playlist videoId overrides ────────────────────────────────────────────
// Stored in _plState[url].videoIdOverrides as { [key]: newVideoId | null }.
// Key = original videoId, or '\x00' + title for tracks without a videoId.
export function getVideoIdOverrides(url) {
  return _plState[url]?.videoIdOverrides ?? {};
}

export function saveVideoIdOverride(url, key, newVideoId) {
  if (!_plState[url]) _plState[url] = {};
  if (!_plState[url].videoIdOverrides) _plState[url].videoIdOverrides = {};
  if (newVideoId === null || newVideoId === undefined) {
    delete _plState[url].videoIdOverrides[key];
  } else {
    _plState[url].videoIdOverrides[key] = newVideoId;
  }
  _savePlState();
}

// ── Per-playlist track attribute overrides (title, year) ──────────────────────
// Stored in _plState[url].trackOverrides as { [key]: { title?, year? } }.
// Key = same overrideKey as videoIdOverrides (original videoId or '\x00'+title).
// Saving an empty attrs object removes the entry.
export function getTrackAttributeOverrides(url) {
  return _plState[url]?.trackOverrides ?? {};
}

export function saveTrackAttributeOverride(url, key, attrs) {
  if (!_plState[url]) _plState[url] = {};
  if (!_plState[url].trackOverrides) _plState[url].trackOverrides = {};
  if (!attrs || Object.keys(attrs).length === 0) {
    delete _plState[url].trackOverrides[key];
  } else {
    _plState[url].trackOverrides[key] = attrs;
  }
  _savePlState();
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
let _db = null; // set by initCustomPlaylists; null means use localStorage fallback

function _openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _idbPut(db, entry) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ── Custom playlist in-memory cache ───────────────────────────────────────────
// Reads are always from this array (synchronous).
// Writes go to IDB (async, fire-and-forget) or localStorage (fallback).
let _customPlaylists = [];

function _persistPut(entry) {
  if (_db) {
    _idbPut(_db, entry).catch(err => console.error('[playlist] IDB write failed', err));
  } else {
    try { localStorage.setItem(CUSTOM_LS_KEY, JSON.stringify(_customPlaylists)); } catch {}
  }
}

function _persistDelete(id) {
  if (_db) {
    _idbDelete(_db, id).catch(err => console.error('[playlist] IDB delete failed', err));
  } else {
    try { localStorage.setItem(CUSTOM_LS_KEY, JSON.stringify(_customPlaylists)); } catch {}
  }
}

// ── initCustomPlaylists ───────────────────────────────────────────────────────
// Exported promise — await this in player.js before first use of getCustomPlaylists().
// Opens IDB, migrates any existing localStorage data, populates _customPlaylists cache.
export const initCustomPlaylists = (async () => {
  try {
    _db = await _openIdb();
    const existing = await _idbGetAll(_db);

    if (existing.length > 0) {
      // IDB already has data
      _customPlaylists = existing;
    } else {
      // Attempt migration from localStorage
      const lsRaw = localStorage.getItem(CUSTOM_LS_KEY);
      if (lsRaw) {
        const parsed = JSON.parse(lsRaw);
        if (Array.isArray(parsed) && parsed.length) {
          await Promise.all(parsed.map(entry => _idbPut(_db, entry)));
          _customPlaylists = parsed;
          localStorage.removeItem(CUSTOM_LS_KEY);
        }
      }
    }
  } catch (err) {
    console.warn('[playlist] IndexedDB unavailable, falling back to localStorage:', err);
    _db = null;
    try { _customPlaylists = JSON.parse(localStorage.getItem(CUSTOM_LS_KEY) || '[]'); } catch { _customPlaylists = []; }
  }
})();

// ── Custom playlist CRUD ──────────────────────────────────────────────────────
export function getCustomPlaylists()      { return _customPlaylists; }
export function getCustomPlaylistById(id) { return _customPlaylists.find(p => p.id === id) ?? null; }

export function addCustomPlaylist(data) {
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    title: (typeof data.title === 'string' && data.title.trim()) || 'Custom playlist',
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    items: Array.isArray(data.items)
      ? data.items.map(it => {
          const item = {
            videoId: String(it.videoId ?? ''),
            title: it.userTitle || it.title || it.videoId || '',
          };
          // Preserve three-state restricted: true | false | absent (unknown)
          if (it.restricted === true)  item.restricted = true;
          else if (it.restricted === false) item.restricted = false;
          // null / undefined → omit the property (unknown/unscanned state)
          if (it.year != null) item.year = it.year;
          return item;
        })
      : [],
  };
  _customPlaylists.push(entry);
  _persistPut(entry);
  return entry;
}

export function deleteCustomPlaylist(id) {
  _customPlaylists = _customPlaylists.filter(p => p.id !== id);
  _persistDelete(id);
}

export function renameCustomPlaylist(id, newTitle) {
  const pl = _customPlaylists.find(p => p.id === id);
  if (!pl) return;
  pl.title = newTitle.trim() || pl.title;
  _persistPut(pl);
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function _parseJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.items)) throw new Error('Missing "items" array.');
  return data;
}

// Parse CSV or TSV with required columns: videoId, title — optional: year, restricted
function _parseSeparated(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) throw new Error('Empty file.');

  // Detect separator: if first line has tabs, use TSV; else CSV
  const header = lines[0];
  const sep = header.includes('\t') ? '\t' : ',';

  // Simple field parser: handles quoted fields for CSV
  function parseLine(line) {
    if (sep === '\t') return line.split('\t').map(f => f.trim());
    // Basic CSV parser (no multiline quoted fields)
    const fields = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else field += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') { fields.push(field.trim()); field = ''; }
        else field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = parseLine(header);
  const videoIdCol  = headers.indexOf('videoId');
  const titleCol    = headers.indexOf('title');
  const restrictCol = headers.indexOf('restricted');
  const yearCol     = headers.indexOf('year');
  if (videoIdCol === -1) throw new Error('Missing required column: videoId');
  if (titleCol    === -1) throw new Error('Missing required column: title');

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseLine(line);
    const videoId = cols[videoIdCol] ?? '';
    if (!videoId) continue;
    const title = cols[titleCol] ?? '';
    const restrictedRaw = restrictCol !== -1 ? (cols[restrictCol] ?? '').trim().toLowerCase() : '';
    const restricted = restrictedRaw === 'true'  || restrictedRaw === '1'  ? true
                     : restrictedRaw === 'false' || restrictedRaw === '0'  ? false
                     : null; // empty / absent → unknown/unscanned state
    const yearRaw = yearCol !== -1 ? (cols[yearCol] ?? '').trim() : '';
    const year = yearRaw !== '' ? (isNaN(yearRaw) ? yearRaw : Number(yearRaw)) : null;
    items.push({ videoId, title, ...(restricted !== null ? { restricted } : {}), ...(year !== null ? { year } : {}) });
  }

  return { title: '', fetchedAt: new Date().toISOString(), items };
}

export function ingestFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const originalName = String(file.name || '').trim();
        const name = originalName.toLowerCase();
        const fallbackTitle = (originalName.replace(/\.[^.]+$/, '').trim()) || 'Custom playlist';
        let data;
        if (name.endsWith('.json')) {
          data = _parseJson(text);
        } else if (name.endsWith('.tsv') || name.endsWith('.csv')) {
          data = _parseSeparated(text);
        } else {
          // Try JSON first, then delimited
          try { data = _parseJson(text); }
          catch { data = _parseSeparated(text); }
        }
        if (typeof data.title !== 'string' || !data.title.trim()) {
          data = { ...data, title: fallbackTitle };
        }
        resolve(addCustomPlaylist(data));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsText(file);
  });
}

// ── Download (ZIP with JSON + TSV) ────────────────────────────────────────────
const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js';

let _JSZip = null;
async function _getJSZip() {
  if (_JSZip) return _JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_CDN;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  _JSZip = window.JSZip;
  return _JSZip;
}

function _toTsv(data) {
  const rows = ['videoId\ttitle\tyear\trestricted'];
  for (const it of data.items ?? []) {
    const id  = String(it.videoId ?? '').replace(/\t/g, ' ');
    const ttl = String(it.title   ?? '').replace(/\t|\n/g, ' ');
    const yr  = it.year != null ? String(it.year).replace(/\t/g, ' ') : '';
    // Three-state: true → 'true', false → 'false', null/undefined → ''
    const r = it.restricted === true ? 'true' : it.restricted === false ? 'false' : '';
    rows.push(`${id}\t${ttl}\t${yr}\t${r}`);
  }
  return rows.join('\n');
}

export async function downloadPlaylist({ url, title, customId, fetchFn }) {
  let data;
  if (customId) {
    data = getCustomPlaylistById(customId);
    if (!data) return;
  } else {
    try {
      data = await fetchFn(url);
    } catch { alert('Failed to download playlist.'); return; }
  }

  // Merge scan results (restricted overrides) into items before export
  if (Array.isArray(data.items)) {
    const overrides = getRestrictedOverrides(url);
    if (Object.keys(overrides).length > 0) {
      data = {
        ...data,
        items: data.items.map(it => {
          const ov = overrides[it.videoId];
          if (ov === undefined) return it;
          if (ov === null) { const { restricted: _, ...rest } = it; return rest; }
          return { ...it, restricted: ov };
        }),
      };
    }
  }

  // Embed pre-computed counts so playlists.json entries can skip the full-file prefetch
  if (Array.isArray(data.items)) {
    data = {
      ...data,
      playableCount:   data.items.filter(it => !it.restricted).length,
      restrictedCount: data.items.filter(it =>  it.restricted).length,
    };
  }

  const safeName = title.replace(/[^\w\s-]/g, '').trim() || 'playlist';

  try {
    const JSZip = await _getJSZip();
    const zip = new JSZip();
    zip.file(`${safeName}.json`, JSON.stringify(data, null, 2));
    zip.file(`${safeName}.tsv`,  _toTsv(data));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${safeName}.zip`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (err) {
    console.error('ZIP failed, falling back to JSON', err);
    // Fallback: plain JSON
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${safeName}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
}
