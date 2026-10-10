// Pure report calculations. The screens AND the CSV exports both use these,
// so exported numbers always equal what is shown in the app.
import { addDays, dayStr } from './logic.js';

export const RANGE_LABELS = { today: 'วันนี้', yesterday: 'เมื่อวาน', '7d': '7 วันที่ผ่านมา', month: 'เดือนนี้', custom: 'กำหนดเอง', all: 'ทั้งหมด' };

export function rangeFor(key, custom = {}, today = dayStr(new Date())) {
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case '7d': return { from: addDays(today, -6), to: today };
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    case 'all': return { from: '0000-01-01', to: '9999-12-31' };
    default: return { from: custom.from || today, to: custom.to || today };
  }
}

export const inRange = (bills, from, to) => bills.filter((b) => b.day >= from && b.day <= to);

export function summarize(bills) {
  const r = { billsAll: bills.length, billsVoid: 0, billsNet: 0, grossAll: 0, voidTotal: 0, net: 0, itemsNet: 0, byPay: { cash: 0, qr: 0, transfer: 0 }, billsByPay: { cash: 0, qr: 0, transfer: 0 } };
  for (const b of bills) {
    r.grossAll += b.total;
    if (b.status === 'void') { r.billsVoid++; r.voidTotal += b.total; continue; }
    r.billsNet++; r.net += b.total;
    r.itemsNet += b.items.reduce((s, i) => s + i.qty, 0);
    r.byPay[b.payment] += b.total; r.billsByPay[b.payment]++;
  }
  return r;
}

/** Gross profit (กำไรขั้นต้น) from cost snapshotted at time of sale. Never silently treats missing cost as 0. */
export function profit(bills) {
  let net = 0, salesKnown = 0, costKnown = 0, missingLines = 0, missingSales = 0;
  for (const b of bills) {
    if (b.status !== 'active') continue;
    for (const i of b.items) {
      net += i.lineTotal;
      if (i.unitCost == null) { missingLines++; missingSales += i.lineTotal; }
      else { salesKnown += i.lineTotal; costKnown += i.qty * i.unitCost; }
    }
  }
  const profitKnown = salesKnown - costKnown;
  return {
    net, complete: missingLines === 0, missingLines, missingSales, salesKnown, costKnown, profitKnown,
    marginKnown: salesKnown > 0 ? (profitKnown / salesKnown) * 100 : null,
    noSales: net === 0,
  };
}

/** Per-product stats over active bills. */
export function productStats(bills) {
  const m = new Map();
  for (const b of bills) {
    if (b.status !== 'active') continue;
    for (const i of b.items) {
      let s = m.get(i.productId);
      if (!s) { s = { productId: i.productId, name: i.name, category: i.category, qty: 0, sales: 0, cost: 0, salesKnown: 0, costComplete: true, last: '' }; m.set(i.productId, s); }
      if (b.soldAt >= s.last) { s.last = b.soldAt; s.name = i.name; s.category = i.category; }
      s.qty += i.qty; s.sales += i.lineTotal;
      if (i.unitCost == null) s.costComplete = false; else { s.cost += i.qty * i.unitCost; s.salesKnown += i.lineTotal; }
    }
  }
  return [...m.values()];
}

export function rankProducts(bills, products) {
  const stats = new Map(productStats(bills).map((s) => [s.productId, s]));
  for (const p of products) if (p.active && !stats.has(p.id)) stats.set(p.id, { productId: p.id, name: p.name, category: p.category, qty: 0, sales: 0, cost: 0, salesKnown: 0, costComplete: true, last: '' });
  const rows = [...stats.values()].sort((a, b) => b.qty - a.qty || b.sales - a.sales || a.name.localeCompare(b.name, 'th'));
  rows.forEach((r, i) => { r.rank = i + 1; r.profit = r.costComplete && r.qty > 0 ? r.sales - r.cost : null; });
  const hasSales = rows.some((r) => r.qty > 0);
  const top = rows.filter((r) => r.qty > 0).slice(0, 5);
  const topIds = new Set(top.map((r) => r.productId));
  const bottom = hasSales ? [...rows].reverse().filter((r) => !topIds.has(r.productId)).slice(0, 5) : [];
  return { rows, top, bottom, hasSales };
}

export function dailyRows(bills, from, to) {
  const days = new Map();
  for (const b of inRange(bills, from, to)) { if (!days.has(b.day)) days.set(b.day, []); days.get(b.day).push(b); }
  return [...days.keys()].sort().map((day) => ({ day, ...summarize(days.get(day)) }));
}
