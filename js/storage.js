const DB_NAME = 'flowering_time_db';
const DB_VERSION = 1;
const STORE = 'searches';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
          .createIndex('search_date', 'search_date', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSearch(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const entry = { ...data, id: data.id || crypto.randomUUID() };
    const req = store.put(entry);
    req.onsuccess = () => resolve(entry.id);
    req.onerror = () => reject(req.error);
  });
}

export async function listSearches() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () =>
      resolve(req.result.sort((a, b) => b.search_date.localeCompare(a.search_date)));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSearch(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
