// Manual backup (JSON file) export / import. Never includes login tokens.
import * as S from './store.js';
import { listProducts, listBills, listAudit } from './store.js';

const APP = 'justmellow-pos';
export const SCHEMA = 1;

export async function buildBackup() {
  const [products, bills, audit, settings, qrImage] = await Promise.all([listProducts(), listBills(), listAudit(), S.getSettings(), S.getMeta('qrImage', null)]);
  const strip = ({ dirty, ...r }) => r;
  return {
    app: APP, schemaVersion: SCHEMA, exportedAt: new Date().toISOString(),
    counts: { products: products.length, bills: bills.length, audit: audit.length },
    settings, qrImage,
    products: products.map(strip), bills: bills.map(strip), audit: audit.map(strip),
  };
}

/** Parse + validate. Strict: any invalid record rejects the whole file (no half-restored data). */
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, errors: ['ไฟล์ไม่ใช่ JSON ที่ถูกต้อง'] }; }
  if (!obj || obj.app !== APP) return { ok: false, errors: ['ไม่ใช่ไฟล์สำรองของ JUST MELLOW POS'] };
  if (obj.schemaVersion !== SCHEMA) return { ok: false, errors: [`ไฟล์เวอร์ชัน ${obj.schemaVersion} ไม่รองรับ (รองรับเวอร์ชัน ${SCHEMA})`] };
  for (const k of ['products', 'bills', 'audit']) if (!Array.isArray(obj[k])) return { ok: false, errors: [`ไฟล์ไม่มีข้อมูล ${k}`] };
  const { clean, errors } = S.cleanRecords(obj);
  const ids = new Set(); const nos = new Set();
  for (const b of clean.bills) {
    if (ids.has(b.id)) errors.push(`บิล ${b.billNo}: id ซ้ำในไฟล์`);
    if (nos.has(b.billNo)) errors.push(`หมายเลขบิล ${b.billNo} ซ้ำในไฟล์`);
    ids.add(b.id); nos.add(b.billNo);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 6).concat(errors.length > 6 ? [`…และอีก ${errors.length - 6} รายการ`] : []) };
  return { ok: true, data: obj, clean, exportedAt: obj.exportedAt };
}

export async function applyBackup(parsed, mode) {
  let counts;
  if (mode === 'replace') {
    await S.replaceAll(parsed.clean);
    counts = { products: parsed.clean.products.length, bills: parsed.clean.bills.length, audit: parsed.clean.audit.length, skipped: 0 };
  } else {
    counts = await S.mergeRecords(parsed.clean, 1);
  }
  const d = parsed.data;
  if (mode === 'replace' && d.settings) await S.saveSettings({ shopName: 'JUST MELLOW', deviceCode: '', ...d.settings });
  if (d.qrImage && (mode === 'replace' || !(await S.getMeta('qrImage', null)))) await S.setMeta('qrImage', d.qrImage);
  await S.rebuildSequences();
  await S.logEvent(mode === 'replace' ? 'restore_replace' : 'restore_merge', { detail: `${counts.bills} บิล, ${counts.products} สินค้า`, from: parsed.exportedAt ?? null });
  return counts;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function shareBlob(filename, blob, type) {
  const file = new File([blob], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return true; }
  return false;
}

export const canShareFiles = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch { return false; } };
