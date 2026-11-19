const DB_NAME = 'flowering_time_db';
const DB_VERSION = 2;
const STORE = 'searches';
const ANN_STORE = 'annotations';

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
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function run(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction(storeName, mode).objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

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
  return run(ANN_STORE, 'readwrite', s => s.put({ ...ann, updated: new Date().toISOString() }));
}

export function deleteAnnotation(key) {
  return run(ANN_STORE, 'readwrite', s => s.delete(key));
}
