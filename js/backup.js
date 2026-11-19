import { listSearches, saveSearch, listAnnotations, putAnnotation, listNotes, putNote, noteKey } from './storage.js';

const FORMAT = 'tw-phenology-backup';
const LABELS = new Set(['flower', 'fruit', 'bud', 'none']);
const TARGETS = new Set(['', 'flower', 'fruit', 'both']);

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function exportBackup() {
  const [searches, annotations, notes] = await Promise.all([listSearches(), listAnnotations(), listNotes()]);
  const data = { format: FORMAT, version: 1, exported_at: new Date().toISOString(), searches, annotations, notes };
  const file = new File([JSON.stringify(data)], `花果期備忘錄-${today()}.json`, { type: 'application/json' });

  // On phones the share sheet is the reliable way to put a file in Files / AirDrop / Drive
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return { species: searches.length, annotations: annotations.length };
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
  return { species: searches.length, annotations: annotations.length };
}

function isValidSearch(s) {
  return s && typeof s.taxon_name === 'string' && s.taxon_name
    && typeof s.search_date === 'string' && Array.isArray(s.gbif_records ?? []);
}

function isValidAnnotation(a) {
  return a && typeof a.key === 'string' && /^(inat|gbif):/.test(a.key)
    && Array.isArray(a.labels) && a.labels.length && a.labels.every(l => LABELS.has(l));
}

// Merge: per species and per record label, the newer version wins
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('檔案不是有效的 JSON');
  }
  if (data?.format !== FORMAT) throw new Error('這不是花果期備忘錄的匯出檔');

  const result = { added: 0, updated: 0, skipped: 0, annotations: 0, notes: 0 };

  const existing = new Map();
  for (const s of await listSearches()) {
    const k = s.taxon_name.toLowerCase();
    if (!existing.has(k)) existing.set(k, s);
  }
  for (const s of (data.searches || []).filter(isValidSearch)) {
    const cur = existing.get(s.taxon_name.toLowerCase());
    if (!cur) {
      await saveSearch({ ...s, id: s.id || undefined });
      existing.set(s.taxon_name.toLowerCase(), s);
      result.added++;
    } else if (s.search_date > cur.search_date) {
      await saveSearch({ ...s, id: cur.id });
      result.updated++;
    } else {
      result.skipped++;
    }
  }

  const anns = new Map((await listAnnotations()).map(a => [a.key, a]));
  for (const a of (data.annotations || []).filter(isValidAnnotation)) {
    const cur = anns.get(a.key);
    if (cur && (cur.updated || '') >= (a.updated || '')) continue;
    await putAnnotation({ key: a.key, taxon: a.taxon || '', labels: a.labels, updated: a.updated || new Date().toISOString() });
    result.annotations++;
  }

  const notes = new Map((await listNotes()).map(n => [n.key, n]));
  for (const n of data.notes || []) {
    if (!n || typeof n.taxon !== 'string' || !n.taxon || !TARGETS.has(n.target ?? '')) continue;
    const key = noteKey(n.taxon);
    const cur = notes.get(key);
    if (cur && (cur.updated || '') >= (n.updated || '')) continue;
    await putNote({
      key, taxon: n.taxon, target: n.target || '', text: String(n.text || ''),
      updated: n.updated || new Date().toISOString(),
    });
    result.notes++;
  }
  return result;
}
