const DB_NAME = 'flowering_time_db';
const DB_VERSION = 4;
const STORE = 'searches';
const ANN_STORE = 'annotations';
const NOTE_STORE = 'notes';
const DEL_STORE = 'deleted';

// Fired after every write so sync can pick up local changes
export const CHANGE_EVENT = 'tw-data-changed';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
          .createIndex('search_date', 'search_date', { unique: false });
      }
      if (!db.objectStoreNames.contains(ANN_STORE)) {
        db.createObjectStore(ANN_STORE, { keyPath: 'key' })
          .createIndex('taxon', 'taxon', { unique: false });
      }
      if (!db.objectStoreNames.contains(NOTE_STORE)) {
        db.createObjectStore(NOTE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DEL_STORE)) {
        db.createObjectStore(DEL_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function run(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction(storeName, mode).objectStore(storeName));
    req.onsuccess = () => {
      resolve(req.result);
      if (mode === 'readwrite') globalThis.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    };
    req.onerror = () => reject(req.error);
  }));
}

export const taxonKey = name => (name || '').toLowerCase();
export const noteKey = taxonKey;

export async function saveSearch(data) {
  const entry = { ...data, id: data.id || crypto.randomUUID() };
  await run(STORE, 'readwrite', s => s.put(entry));
  return entry.id;
}

export async function listSearches() {
  const all = await run(STORE, 'readonly', s => s.getAll());
  return all.sort((a, b) => b.search_date.localeCompare(a.search_date));
}

export function deleteSearch(id) {
  return run(STORE, 'readwrite', s => s.delete(id));
}

// Annotation: { key: 'inat:123' | 'gbif:456', taxon, labels: ['flower', ...], updated }
export function listAnnotations() {
  return run(ANN_STORE, 'readonly', s => s.getAll());
}

export function putAnnotation(ann) {
  return run(ANN_STORE, 'readwrite', s => s.put({ updated: new Date().toISOString(), ...ann }));
}

export function deleteAnnotation(key) {
  return run(ANN_STORE, 'readwrite', s => s.delete(key));
}

// Note: { key: lowercased scientific name, taxon, target: ''|'flower'|'fruit'|'both', text, updated }
export function listNotes() {
  return run(NOTE_STORE, 'readonly', s => s.getAll());
}

export function putNote(note) {
  return run(NOTE_STORE, 'readwrite', s => s.put({ updated: new Date().toISOString(), ...note }));
}

export function deleteNote(key) {
  return run(NOTE_STORE, 'readwrite', s => s.delete(key));
}

// Tombstones let deletions propagate through merge-based sync.
// { id: `${kind}:${key}`, kind: 'search'|'annotation'|'note', key, deleted_at }
export function listDeleted() {
  return run(DEL_STORE, 'readonly', s => s.getAll());
}

export function putDeleted(t) {
  return run(DEL_STORE, 'readwrite', s => s.put({ ...t, id: `${t.kind}:${t.key}` }));
}

export function markDeleted(kind, key) {
  return putDeleted({ kind, key, deleted_at: new Date().toISOString() });
}
