import { cleanRegion } from './region.js';
import {
  listSearches, saveSearch, deleteSearch,
  listAnnotations, putAnnotation, deleteAnnotation,
  listNotes, putNote, deleteNote,
  listDeleted, putDeleted, taxonKey,
} from './storage.js';

const FORMAT = 'tw-phenology-backup';
const LABELS = new Set(['flower', 'fruit', 'bud', 'none']);
const TARGETS = new Set(['', 'flower', 'fruit', 'both']);
const KINDS = new Set(['search', 'annotation', 'note']);

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function buildSnapshot() {
  const [searches, annotations, notes, deleted] =
    await Promise.all([listSearches(), listAnnotations(), listNotes(), listDeleted()]);
  return { format: FORMAT, version: 1, exported_at: new Date().toISOString(), searches, annotations, notes, deleted };
}

export async function exportBackup() {
  const data = await buildSnapshot();
  const file = new File([JSON.stringify(data)], `花果期備忘錄-${today()}.json`, { type: 'application/json' });
  const summary = { species: data.searches.length, annotations: data.annotations.length };

  // On phones the share sheet is the reliable way to put a file in Files / AirDrop / Drive
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return summary;
    } catch (e) {
      if (e.name === 'AbortError') return null;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return summary;
}

export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('檔案不是有效的 JSON');
  }
  return mergeSnapshot(data);
}

function isValidSearch(s) {
  return s && typeof s.taxon_name === 'string' && s.taxon_name
    && typeof s.search_date === 'string' && Array.isArray(s.gbif_records ?? []);
}

function isValidAnnotation(a) {
  return a && typeof a.key === 'string' && /^(inat|gbif):/.test(a.key)
    && Array.isArray(a.labels) && a.labels.length && a.labels.every(l => LABELS.has(l));
}

function isValidNote(n) {
  return n && typeof n.taxon === 'string' && n.taxon && TARGETS.has(n.target ?? '');
}

// Records saved into a note: keep only well-formed entries with http(s) links
function cleanPins(pins) {
  if (!Array.isArray(pins)) return [];
  return pins.filter(p => p && typeof p.key === 'string' && /^https?:\/\//.test(p.url || ''))
    .map(p => ({
      key: p.key, source: p.source === 'inat' ? 'inat' : 'gbif',
      date: String(p.date ?? ''), month: Number(p.month) || 0,
      place: String(p.place ?? ''), recorded_by: String(p.recorded_by ?? ''),
      lat: typeof p.lat === 'number' ? p.lat : null, lng: typeof p.lng === 'number' ? p.lng : null,
      url: p.url, photo_url: /^https?:\/\//.test(p.photo_url || '') ? p.photo_url : null,
      added: String(p.added ?? ''),
    }));
}

function isValidTombstone(t) {
  return t && KINDS.has(t.kind) && typeof t.key === 'string' && t.key && typeof t.deleted_at === 'string';
}

// Merge another snapshot into local data. For every species, label and note the
// newer version wins; a deletion wins over anything older than it.
export async function mergeSnapshot(data) {
  if (data?.format !== FORMAT) throw new Error('這不是花果期備忘錄的資料');
  const result = { added: 0, updated: 0, skipped: 0, annotations: 0, notes: 0, deleted: 0 };

  const tombs = new Map((await listDeleted()).map(t => [t.id, t]));
  for (const t of (data.deleted || []).filter(isValidTombstone)) {
    const id = `${t.kind}:${t.key}`;
    const cur = tombs.get(id);
    if (cur && cur.deleted_at >= t.deleted_at) continue;
    const tomb = { kind: t.kind, key: t.key, deleted_at: t.deleted_at };
    await putDeleted(tomb);
    tombs.set(id, { ...tomb, id });
  }
  const deletedAt = (kind, key) => tombs.get(`${kind}:${key}`)?.deleted_at || '';

  // Local items deleted elsewhere
  const localSearches = new Map();
  for (const s of await listSearches()) {
    const k = taxonKey(s.taxon_name);
    if (!localSearches.has(k)) localSearches.set(k, { newest: s, ids: [] });
    localSearches.get(k).ids.push(s.id);
  }
  for (const [k, g] of localSearches) {
    if (deletedAt('search', k) > g.newest.search_date) {
      for (const id of g.ids) await deleteSearch(id);
      localSearches.delete(k);
      result.deleted++;
    }
  }
  const localAnns = new Map((await listAnnotations()).map(a => [a.key, a]));
  for (const [k, a] of localAnns) {
    if (deletedAt('annotation', k) > (a.updated || '')) {
      await deleteAnnotation(k);
      localAnns.delete(k);
      result.deleted++;
    }
  }
  const localNotes = new Map((await listNotes()).map(n => [n.key, n]));
  for (const [k, n] of localNotes) {
    if (deletedAt('note', k) > (n.updated || '')) {
      await deleteNote(k);
      localNotes.delete(k);
      result.deleted++;
    }
  }

  // Incoming items
  for (const s of (data.searches || []).filter(isValidSearch)) {
    const k = taxonKey(s.taxon_name);
    if (deletedAt('search', k) >= s.search_date) continue;
    const cur = localSearches.get(k)?.newest;
    if (!cur) {
      await saveSearch({ ...s, id: s.id || undefined });
      localSearches.set(k, { newest: s, ids: [s.id] });
      result.added++;
    } else if (s.search_date > cur.search_date) {
      await saveSearch({ ...s, id: cur.id });
      result.updated++;
    } else {
      result.skipped++;
    }
  }

  for (const a of (data.annotations || []).filter(isValidAnnotation)) {
    const updated = a.updated || '';
    if (deletedAt('annotation', a.key) >= updated) continue;
    const cur = localAnns.get(a.key);
    if (cur && (cur.updated || '') >= updated) continue;
    await putAnnotation({ key: a.key, taxon: a.taxon || '', labels: a.labels, updated: updated || new Date().toISOString() });
    result.annotations++;
  }

  for (const n of (data.notes || []).filter(isValidNote)) {
    const key = taxonKey(n.taxon);
    const updated = n.updated || '';
    if (deletedAt('note', key) >= updated) continue;
    const cur = localNotes.get(key);
    if (cur && (cur.updated || '') >= updated) continue;
    await putNote({ key, taxon: n.taxon, target: n.target || '', text: String(n.text || ''), pins: cleanPins(n.pins), region: cleanRegion(n.region), updated: updated || new Date().toISOString() });
    result.notes++;
  }

  return result;
}

export function changedCount(r) {
  return r.added + r.updated + r.annotations + r.notes + r.deleted;
}
