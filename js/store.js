// Data layer: products, bills, audit trail, settings. Everything saved on-device first.
import { tx, req, getAll, getOne } from './db.js';
import { SEED_PRODUCTS, buildBill, billNoFor, dayStr, uuid, validateProduct, validateBill, validateProductRecord, validateAuditRecord, PAYMENTS } from './logic.js';

export { PAYMENTS };
// Unedited starter products use the epoch as updatedAt and are not uploaded, so on a new phone they can never
// overwrite (or hide) real edited products when restoring from a file or the cloud.
const SEED_EPOCH = '1970-01-01T00:00:00.000Z';

/* ---------- meta (settings, counters, sync state) ---------- */
export async function getMeta(key, def = null) {
  const r = await getOne('meta', key);
  return r ? r.value : def;
}
export const setMeta = (key, value) => tx(['meta'], 'readwrite', (m) => req(m.put({ key, value })));
export const delMeta = (key) => tx(['meta'], 'readwrite', (m) => req(m.delete(key)));

export async function getSettings() {
  return { shopName: 'JUST MELLOW', deviceCode: '', ...(await getMeta('settings', {})) };
}
export const saveSettings = (s) => setMeta('settings', s);

/* ---------- init ---------- */
export async function initStore() {
  await tx(['products', 'meta'], 'readwrite', async (products, meta) => {
    const seeded = await req(meta.get('seeded'));
    if (seeded) return;
    const now = new Date().toISOString();
    for (let i = 0; i < SEED_PRODUCTS.length; i++) {
      const [category, name, price, provisional] = SEED_PRODUCTS[i];
      await req(products.put({ id: 'seed-' + (i + 1), name, category, price, cost: null, active: true, provisional, sortOrder: i + 1, createdAt: now, updatedAt: SEED_EPOCH, dirty: 0 }));
    }
    await req(meta.put({ key: 'seeded', value: now }));
  });
  let persisted = null;
  try { if (navigator.storage?.persist) persisted = await navigator.storage.persist(); } catch { /* optional */ }
  return { persisted };
}

/* ---------- reads ---------- */
export const listProducts = async () => (await getAll('products')).sort((a, b) => a.sortOrder - b.sortOrder);
export const listBills = async () => (await getAll('bills')).sort((a, b) => b.soldAt.localeCompare(a.soldAt));
export const listAudit = async () => (await getAll('audit')).sort((a, b) => b.at.localeCompare(a.at));

export async function countDirty() {
  return tx(['products', 'bills', 'audit'], 'readonly', async (p, b, a) => {
    const r = IDBKeyRange.only(1);
    const [x, y, z] = await Promise.all([req(p.index('dirty').count(r)), req(b.index('dirty').count(r)), req(a.index('dirty').count(r))]);
    return { products: x, bills: y, audit: z, total: x + y + z };
  });
}

/* ---------- audit ---------- */
function auditRecord(type, fields) {
  const at = new Date().toISOString();
  return { id: uuid(), at, updatedAt: at, type, dirty: 1, ...fields };
}

/* ---------- products ---------- */
export async function saveProduct(input, editingId = null) {
  const products = await listProducts();
  const v = validateProduct(input, products, editingId);
  if (!v.ok) return v;
  const now = new Date().toISOString();
  await tx(['products', 'audit'], 'readwrite', async (ps, au) => {
    const old = editingId ? await req(ps.get(editingId)) : null;
    if (editingId && !old) throw new Error('ไม่พบสินค้าที่แก้ไข');
    const rec = {
      id: old?.id ?? uuid(), ...v.value,
      active: !!input.active, provisional: !!input.provisional,
      sortOrder: old?.sortOrder ?? (Math.max(0, ...products.map((p) => p.sortOrder)) + 1),
      createdAt: old?.createdAt ?? now, updatedAt: now, dirty: 1,
    };
    await req(ps.put(rec));
    const changes = {};
    if (old) for (const k of ['name', 'category', 'price', 'cost', 'active', 'provisional']) if (old[k] !== rec[k]) changes[k] = [old[k], rec[k]];
    if (!old || Object.keys(changes).length) {
      await req(au.put(auditRecord(old ? 'product_update' : 'product_create', { productId: rec.id, productName: rec.name, changes })));
    }
  });
  return v;
}

export async function setProductActive(id, active) {
  const now = new Date().toISOString();
  await tx(['products', 'audit'], 'readwrite', async (ps, au) => {
    const p = await req(ps.get(id));
    if (!p) throw new Error('ไม่พบสินค้า');
    if (p.active === !!active) return;
    await req(ps.put({ ...p, active: !!active, updatedAt: now, dirty: 1 }));
    await req(au.put(auditRecord('product_update', { productId: id, productName: p.name, changes: { active: [p.active, !!active] } })));
  });
}

/* ---------- bills ---------- */
/** Create a bill atomically: allocate number + write bill in one transaction. The bill id is
 *  generated before the tap, so a double-tap / retry hits the primary key and cannot create a 2nd bill. */
export async function createBill({ id, lines, payment }) {
  const settings = await getSettings();
  const now = new Date();
  const day = dayStr(now);
  return tx(['products', 'bills', 'meta'], 'readwrite', async (ps, bs, meta) => {
    const existing = await req(bs.get(id));
    if (existing) { const e = new Error('บิลนี้ถูกบันทึกแล้ว'); e.code = 'DUPLICATE'; e.bill = existing; throw e; }
    const products = await req(ps.getAll());
    const seqKey = 'seq:' + day;
    const seqRow = await req(meta.get(seqKey));
    const seq = (seqRow?.value ?? 0) + 1;
    const bill = buildBill({ id, lines, payment, products, now, billNo: billNoFor(day, seq, settings.deviceCode) });
    await req(meta.put({ key: seqKey, value: seq }));
    await req(bs.add(bill));
    return bill;
  });
}

export async function voidBill(id, reason) {
  const why = String(reason ?? '').trim();
  if (!why) throw new Error('กรุณากรอกเหตุผลที่ยกเลิกบิล');
  if (why.length > 200) throw new Error('เหตุผลยาวเกิน 200 ตัวอักษร');
  const now = new Date().toISOString();
  return tx(['bills', 'audit'], 'readwrite', async (bs, au) => {
    const b = await req(bs.get(id));
    if (!b) throw new Error('ไม่พบบิล');
    if (b.status === 'void') throw new Error('บิลนี้ถูกยกเลิกไปแล้ว');
    const nb = { ...b, status: 'void', voidReason: why, voidedAt: now, updatedAt: now, dirty: 1 };
    await req(bs.put(nb));
    await req(au.put(auditRecord('void', { billId: b.id, billNo: b.billNo, amount: b.total, reason: why })));
    return nb;
  });
}

/* ---------- merge (import / restore from cloud) ---------- */
/** records: already-validated. Newer updatedAt wins. markDirty=1 for file imports (so they upload), 0 for cloud pulls. */
export async function mergeRecords({ products = [], bills = [], audit = [] }, markDirty) {
  const counts = { products: 0, bills: 0, audit: 0, skipped: 0 };
  await tx(['products', 'bills', 'audit'], 'readwrite', async (ps, bs, au) => {
    const take = async (store, rec, key) => {
      const old = await req(store.get(rec.id));
      if (old && (old.updatedAt ?? '') >= rec.updatedAt) { counts.skipped++; return false; }
      await req(store.put({ ...rec, dirty: markDirty ? 1 : 0 }));
      counts[key]++;
      return true;
    };
    for (const p of products) await take(ps, p, 'products');
    for (const a of audit) await take(au, a, 'audit');
    for (const b of bills) {
      const clash = await req(bs.index('billNo').get(b.billNo));
      let rec = b;
      if (clash && clash.id !== b.id) rec = { ...b, billNo: `${b.billNo}~${b.id.slice(0, 4)}` }; // keep billNo unique across devices
      await take(bs, rec, 'bills');
    }
  });
  return counts;
}

export function cleanRecords(data) {
  const out = { products: [], bills: [], audit: [] }; const errors = [];
  for (const p of data.products ?? []) { const e = validateProductRecord(p); e ? errors.push(e) : out.products.push(p); }
  for (const b of data.bills ?? []) { const e = validateBill(b); e ? errors.push(e) : out.bills.push(b); }
  for (const a of data.audit ?? []) { const e = validateAuditRecord(a); e ? errors.push(e) : out.audit.push({ ...a, updatedAt: a.updatedAt ?? a.at }); }
  return { clean: out, errors };
}

export async function markSynced(storeName, rec) {
  // only clear dirty if the record wasn't changed again while we were uploading
  await tx([storeName], 'readwrite', async (s) => {
    const cur = await req(s.get(rec.id));
    if (cur && cur.updatedAt === rec.updatedAt && cur.dirty) await req(s.put({ ...cur, dirty: 0 }));
  });
}

export async function listDirty(storeName) {
  return tx([storeName], 'readonly', (s) => req(s.index('dirty').getAll(IDBKeyRange.only(1))));
}

export async function replaceAll({ products, bills, audit }) {
  await tx(['products', 'bills', 'audit'], 'readwrite', async (ps, bs, au) => {
    await Promise.all([req(ps.clear()), req(bs.clear()), req(au.clear())]);
    for (const p of products) await req(ps.put({ ...p, dirty: 1 }));
    for (const b of bills) await req(bs.put({ ...b, dirty: 1 }));
    for (const a of audit) await req(au.put({ ...a, dirty: 1 }));
  });
}

export async function logEvent(type, fields) {
  await tx(['audit'], 'readwrite', (au) => req(au.put(auditRecord(type, fields))));
}

// recompute daily sequence counters so numbers never collide after import/restore
export async function rebuildSequences() {
  const bills = await getAll('bills');
  const max = new Map();
  for (const b of bills) {
    const m = /-(\d+)$/.exec(b.billNo);
    if (m) max.set(b.day, Math.max(max.get(b.day) ?? 0, parseInt(m[1], 10)));
  }
  await tx(['meta'], 'readwrite', async (meta) => {
    for (const [day, n] of max) {
      const cur = await req(meta.get('seq:' + day));
      if (!cur || cur.value < n) await req(meta.put({ key: 'seq:' + day, value: n }));
    }
  });
}
