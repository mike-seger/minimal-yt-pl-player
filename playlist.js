// ── playlist.js ───────────────────────────────────────────────────────────────
// Handles:
//  • Custom playlist CRUD + localStorage persistence
//  • Per-playlist state (resume index, positionSec, filter)
//  • Ingesting JSON / CSV / TSV uploads
//  • ZIP + JSON/TSV download via JSZip CDN
// ─────────────────────────────────────────────────────────────────────────────

const CUSTOM_KEY   = 'yt-pl-player.custom.v1';
const PL_STATE_KEY = 'yt-pl-player.pl-state.v1'; // { [url]: {index, positionSec, filter} }

// ── Per-playlist state ────────────────────────────────────────────────────────
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

// ── Custom playlists ──────────────────────────────────────────────────────────
let _customPlaylists = (() => {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; }
})();

function _saveCustom() {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(_customPlaylists)); } catch {}
}

export function getCustomPlaylists()      { return _customPlaylists; }
export function getCustomPlaylistById(id) { return _customPlaylists.find(p => p.id === id) ?? null; }

export function addCustomPlaylist(data) {
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    title: (typeof data.title === 'string' && data.title.trim()) || 'Custom playlist',
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    items: Array.isArray(data.items)
      ? data.items.map(it => ({
          videoId: String(it.videoId ?? ''),
          title: it.userTitle || it.title || it.videoId || '',
          ...(it.restricted ? { restricted: true } : {}),
        }))
      : [],
  };
  _customPlaylists.push(entry);
  _saveCustom();
  return entry;
}

export function deleteCustomPlaylist(id) {
  _customPlaylists = _customPlaylists.filter(p => p.id !== id);
  _saveCustom();
}

export function renameCustomPlaylist(id, newTitle) {
  const pl = _customPlaylists.find(p => p.id === id);
  if (!pl) return;
  pl.title = newTitle.trim() || pl.title;
  _saveCustom();
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function _parseJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.items)) throw new Error('Missing "items" array.');
  return data;
}

// Parse CSV or TSV with required header: videoId, title, restricted
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
    const restricted = restrictCol !== -1 && cols[restrictCol]
      ? (cols[restrictCol].toLowerCase() === 'true' || cols[restrictCol] === '1')
      : false;
    items.push({ videoId, title, ...(restricted ? { restricted: true } : {}) });
  }

  return { title: '', fetchedAt: new Date().toISOString(), items };
}

export function ingestFile(file, failedIds = new Set()) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const name = file.name.toLowerCase();
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
        // Apply recorded failures
        if (failedIds.size > 0 && Array.isArray(data.items)) {
          data = {
            ...data,
            items: data.items.map(it =>
              !it.restricted && failedIds.has(it.videoId) ? { ...it, restricted: true } : it
            ),
          };
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
  const rows = ['videoId\ttitle\trestricted'];
  for (const it of data.items ?? []) {
    const id  = String(it.videoId ?? '').replace(/\t/g, ' ');
    const ttl = String(it.title   ?? '').replace(/\t|\n/g, ' ');
    rows.push(`${id}\t${ttl}\t${it.restricted ? 'true' : 'false'}`);
  }
  return rows.join('\n');
}

export async function downloadPlaylist({ url, title, customId, failedIds = new Set(), fetchFn }) {
  let data;
  if (customId) {
    data = getCustomPlaylistById(customId);
    if (!data) return;
  } else {
    try {
      data = await fetchFn(url);
    } catch { alert('Failed to download playlist.'); return; }
  }

  // Apply recorded failures
  if (Array.isArray(data.items) && failedIds.size > 0) {
    data = {
      ...data,
      items: data.items.map(it =>
        !it.restricted && failedIds.has(it.videoId) ? { ...it, restricted: true } : it
      ),
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
