// Thin IndexedDB wrapper. All data lives on the device (local-first).
const DB_NAME = 'justmellow-pos';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับการเก็บข้อมูลในเครื่อง (IndexedDB)'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const products = db.createObjectStore('products', { keyPath: 'id' });
      products.createIndex('dirty', 'dirty');
      const bills = db.createObjectStore('bills', { keyPath: 'id' });
      bills.createIndex('billNo', 'billNo', { unique: true });
      bills.createIndex('day', 'day');
      bills.createIndex('dirty', 'dirty');
      const audit = db.createObjectStore('audit', { keyPath: 'id' });
      audit.createIndex('dirty', 'dirty');
      audit.createIndex('at', 'at');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('เปิดฐานข้อมูลไม่สำเร็จ'));
    req.onblocked = () => reject(new Error('ฐานข้อมูลถูกใช้งานโดยแท็บอื่น กรุณาปิดแท็บอื่นแล้วลองใหม่'));
  });
  return dbPromise;
}

export const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/**
 * Run fn(...stores) inside one transaction. Only await IndexedDB requests inside fn
 * (awaiting anything else lets the transaction auto-commit early).
 */
export async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const t = db.transaction(storeNames, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('การบันทึกถูกยกเลิก'));
  });
  done.catch(() => {});
  let result;
  try {
    result = await fn(...storeNames.map((s) => t.objectStore(s)));
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    throw e;
  }
  await done;
  return result;
}

export const getAll = (store) => tx([store], 'readonly', (s) => req(s.getAll()));
export const getOne = (store, key) => tx([store], 'readonly', (s) => req(s.get(key)));
