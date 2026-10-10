// Pure helpers: money (integer satang), dates, validation, bill building.
// No browser APIs here so these can be unit-tested in Node.

export const PAYMENTS = { cash: 'เงินสด', qr: 'QR Code', transfer: 'โอนเงิน' };
export const MAX_QTY = 999;

const pad2 = (n) => String(n).padStart(2, '0');

/** Parse a baht string like "25", "25.5", "1,250.00" -> satang integer. Rejects negatives/NaN/>2 decimals. */
export function parseBaht(text) {
  if (text == null) return { ok: false, empty: true };
  const s = String(text).trim().replace(/[,\s฿]/g, '');
  if (s === '') return { ok: false, empty: true };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return { ok: false };
  const [i, f = ''] = s.split('.');
  return { ok: true, value: parseInt(i, 10) * 100 + parseInt((f + '00').slice(0, 2), 10) };
}

/** satang -> "฿1,234.50" (decimals only when needed) */
export function formatBaht(sat, symbol = true) {
  const neg = sat < 0;
  const a = Math.abs(sat);
  const baht = Math.floor(a / 100).toLocaleString('en-US');
  const s = a % 100;
  return (neg ? '-' : '') + (symbol ? '฿' : '') + (s ? `${baht}.${pad2(s)}` : baht);
}

/** satang -> "1234.50" for CSV (always 2 decimals, no thousands separator) */
export function csvBaht(sat) {
  const neg = sat < 0;
  const a = Math.abs(sat);
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + pad2(a % 100);
}

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (x) => x.forEach((_, i) => (x[i] = Math.random() * 256)) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function dayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayStr(new Date(y, m - 1, d + n, 12));
}
export function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d, 12);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
export function localDateTime(iso, sep = ' ') {
  const d = new Date(iso);
  return `${dayStr(d)}${sep}${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDay(day) {
  if (!isDay(day)) return '-';
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function billNoFor(day, seq, deviceCode = '') {
  const [y, m, d] = day.split('-');
  return `JM-${y.slice(2)}${m}${d}-${deviceCode ? deviceCode + '-' : ''}${String(seq).padStart(3, '0')}`;
}

/** Validate product form input. priceText/costText are baht strings. */
export function validateProduct(inp, products, editingId = null) {
  const errors = {};
  const name = String(inp.name ?? '').replace(/\s+/g, ' ').trim();
  const category = String(inp.category ?? '').replace(/\s+/g, ' ').trim();
  if (!name) errors.name = 'กรุณากรอกชื่อสินค้า';
  else if (name.length > 60) errors.name = 'ชื่อยาวเกิน 60 ตัวอักษร';
  if (!category) errors.category = 'กรุณาเลือกหรือพิมพ์หมวดหมู่';
  else if (category.length > 30) errors.category = 'ชื่อหมวดยาวเกิน 30 ตัวอักษร';
  const pr = parseBaht(inp.priceText);
  let price = null;
  if (!pr.ok) errors.price = pr.empty ? 'กรุณากรอกราคาขาย' : 'ราคาไม่ถูกต้อง (ใช้ตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง)';
  else if (pr.value <= 0) errors.price = 'ราคาขายต้องมากกว่า 0';
  else price = pr.value;
  let cost = null;
  const cr = parseBaht(inp.costText);
  if (!cr.ok && !cr.empty) errors.cost = 'ต้นทุนไม่ถูกต้อง (ใช้ตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง)';
  else if (cr.ok) cost = cr.value;
  if (!errors.name && !errors.category) {
    const dup = products.find((p) => p.id !== editingId && p.name.toLowerCase() === name.toLowerCase() && p.category.toLowerCase() === category.toLowerCase());
    if (dup) errors.name = 'มีสินค้าชื่อนี้ในหมวดนี้แล้ว';
  }
  return { ok: Object.keys(errors).length === 0, errors, value: { name, category, price, cost } };
}

/** Build a bill snapshot. Throws Error(Thai message) on invalid input. */
export function buildBill({ id, lines, payment, products, now = new Date(), billNo }) {
  if (typeof id !== 'string' || id.length < 8) throw new Error('รหัสบิลไม่ถูกต้อง');
  if (!PAYMENTS[payment]) throw new Error('กรุณาเลือกวิธีชำระเงิน');
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('ยังไม่มีสินค้าในรายการขาย');
  const byId = new Map(products.map((p) => [p.id, p]));
  const seen = new Set();
  const items = lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new Error('ไม่พบสินค้าในรายการ');
    if (!p.active) throw new Error(`"${p.name}" ปิดการขายอยู่`);
    if (seen.has(p.id)) throw new Error('สินค้าซ้ำในรายการ');
    seen.add(p.id);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) throw new Error(`จำนวนของ "${p.name}" ไม่ถูกต้อง (1–${MAX_QTY})`);
    return { productId: p.id, name: p.name, category: p.category, qty: l.qty, unitPrice: p.price, unitCost: p.cost ?? null, lineTotal: l.qty * p.price };
  });
  const total = items.reduce((s, i) => s + i.lineTotal, 0);
  if (!Number.isSafeInteger(total)) throw new Error('ยอดรวมผิดปกติ');
  const iso = now.toISOString();
  return { id, billNo, soldAt: iso, day: dayStr(now), items, total, payment, status: 'active', voidReason: null, voidedAt: null, createdAt: iso, updatedAt: iso, dirty: 1 };
}

const isInt = (n, min = 0) => Number.isInteger(n) && n >= min && Number.isSafeInteger(n);

/** Returns an error string, or null if the bill record is valid. */
export function validateBill(b) {
  if (!b || typeof b !== 'object') return 'ไม่ใช่ข้อมูลบิล';
  if (typeof b.id !== 'string' || !b.id) return 'บิลไม่มี id';
  if (typeof b.billNo !== 'string' || !b.billNo) return `บิล ${b.id}: ไม่มีหมายเลขบิล`;
  const w = `บิล ${b.billNo}`;
  if (isNaN(new Date(b.soldAt))) return `${w}: วันที่ขายไม่ถูกต้อง`;
  if (!isDay(b.day)) return `${w}: วันที่ (day) ไม่ถูกต้อง`;
  if (typeof b.updatedAt !== 'string' || isNaN(new Date(b.updatedAt))) return `${w}: updatedAt ไม่ถูกต้อง`;
  if (!PAYMENTS[b.payment]) return `${w}: วิธีชำระเงินไม่ถูกต้อง`;
  if (b.status !== 'active' && b.status !== 'void') return `${w}: สถานะไม่ถูกต้อง`;
  if (b.status === 'void' && !String(b.voidReason || '').trim()) return `${w}: บิลยกเลิกไม่มีเหตุผล`;
  if (!Array.isArray(b.items) || b.items.length === 0) return `${w}: ไม่มีรายการสินค้า`;
  let sum = 0;
  for (const i of b.items) {
    if (!i || typeof i.name !== 'string' || !i.name) return `${w}: รายการไม่มีชื่อสินค้า`;
    if (!isInt(i.qty, 1)) return `${w}: จำนวนไม่ถูกต้อง`;
    if (!isInt(i.unitPrice, 0)) return `${w}: ราคาต่อหน่วยไม่ถูกต้อง`;
    if (i.unitCost != null && !isInt(i.unitCost, 0)) return `${w}: ต้นทุนไม่ถูกต้อง`;
    if (i.lineTotal !== i.qty * i.unitPrice) return `${w}: ยอดรายการไม่ตรงกับจำนวน×ราคา`;
    sum += i.lineTotal;
  }
  if (b.total !== sum) return `${w}: ยอดรวมไม่ตรงกับผลรวมรายการ`;
  return null;
}

export function validateProductRecord(p) {
  if (!p || typeof p !== 'object') return 'ไม่ใช่ข้อมูลสินค้า';
  if (typeof p.id !== 'string' || !p.id) return 'สินค้าไม่มี id';
  if (typeof p.name !== 'string' || !p.name.trim()) return `สินค้า ${p.id}: ไม่มีชื่อ`;
  if (typeof p.category !== 'string' || !p.category.trim()) return `สินค้า ${p.name}: ไม่มีหมวด`;
  if (!isInt(p.price, 1)) return `สินค้า ${p.name}: ราคาไม่ถูกต้อง`;
  if (p.cost != null && !isInt(p.cost, 0)) return `สินค้า ${p.name}: ต้นทุนไม่ถูกต้อง`;
  if (typeof p.updatedAt !== 'string' || isNaN(new Date(p.updatedAt))) return `สินค้า ${p.name}: updatedAt ไม่ถูกต้อง`;
  return null;
}

export function validateAuditRecord(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.type !== 'string' || isNaN(new Date(a.at))) return 'บันทึกการเปลี่ยนแปลงไม่ถูกต้อง';
  return null;
}

export const SEED_PRODUCTS = [
  ['พุดดิ้ง', 'พุดดิ้งนมสดคาราเมล', 3000, false],
  ['พุดดิ้ง', 'พุดดิ้งกาแฟ', 3000, false],
  ['พุดดิ้ง', 'พุดดิ้งชาไทย', 2500, false],
  ['พุดดิ้ง', 'พุดดิ้งชาเขียว', 3000, false],
  ['พุดดิ้ง', 'พุดดิ้งโกโก้', 2500, false],
  ['ชาผลไม้', 'ชาผลไม้รวม', 6000, false],
  ['ชาผลไม้', 'ชาองุ่น', 5500, false],
  ['ชาผลไม้', 'ชาแอปเปิล', 5500, false],
  ['ชาผลไม้', 'ชาส้ม', 5000, false],
  ['มิลค์เชค', 'มิลค์เชคช็อกโกแลต', 6500, true],
  ['มิลค์เชค', 'มิลค์เชควานิลลา', 6500, true],
  ['มิลค์เชค', 'มิลค์เชคสตรอว์เบอร์รี', 6500, true],
  ['มิลค์เชค', 'มิลค์เชคกาแฟ', 6500, true],
];
