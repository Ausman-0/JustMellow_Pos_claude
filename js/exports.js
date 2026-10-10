import { toCsv } from './csv.js';
import { csvBaht, localDateTime, PAYMENTS } from './logic.js';
import { inRange, summarize, dailyRows, profit, rankProducts, productStats } from './reports.js';

const ST = { active: 'ปกติ', void: 'ยกเลิก' };

/** kind: summary | bills | items | profit | best */
export function buildExport(kind, { bills, products, from, to }) {
  const inr = inRange(bills, from, to);
  const all = from === '0000-01-01';
  const range = all ? ['ทั้งหมด', 'ทั้งหมด'] : [from, to];
  const name = (k) => `justmellow_${k}_${all ? 'all' : from + '_' + to}.csv`;

  if (kind === 'summary') {
    const head = ['จากวันที่', 'ถึงวันที่', 'วันที่', 'จำนวนบิลทั้งหมด', 'จำนวนบิลยกเลิก', 'จำนวนบิลสุทธิ', 'จำนวนชิ้นสุทธิ', 'ยอดขายรวมก่อนหักยกเลิก', 'ยอดบิลที่ยกเลิก', 'ยอดขายสุทธิ', 'สุทธิ-เงินสด', 'สุทธิ-QR Code', 'สุทธิ-โอนเงิน'];
    const row = (label, s) => [...range, label, s.billsAll, s.billsVoid, s.billsNet, s.itemsNet, csvBaht(s.grossAll), csvBaht(s.voidTotal), csvBaht(s.net), csvBaht(s.byPay.cash), csvBaht(s.byPay.qr), csvBaht(s.byPay.transfer)];
    const rows = dailyRows(bills, from, to).map((d) => row(d.day, d));
    rows.push(row('รวมทั้งช่วง', summarize(inr)));
    return { filename: name('sales_summary'), csv: toCsv(head, rows) };
  }
  if (kind === 'bills') {
    const head = ['จากวันที่', 'ถึงวันที่', 'หมายเลขบิล', 'วันที่เวลาขาย', 'จำนวนชิ้น', 'ยอดรวมบิล', 'วิธีชำระเงิน', 'สถานะ', 'เวลายกเลิก', 'เหตุผลที่ยกเลิก'];
    const rows = [...inr].sort((a, b) => a.soldAt.localeCompare(b.soldAt)).map((b) => [...range, b.billNo, localDateTime(b.soldAt), b.items.reduce((s, i) => s + i.qty, 0), csvBaht(b.total), PAYMENTS[b.payment], ST[b.status], b.voidedAt ? localDateTime(b.voidedAt) : '', b.voidReason || '']);
    return { filename: name('bills'), csv: toCsv(head, rows) };
  }
  if (kind === 'items') {
    const head = ['จากวันที่', 'ถึงวันที่', 'หมายเลขบิล', 'วันที่เวลาขาย', 'สถานะบิล', 'วิธีชำระเงิน', 'สินค้า', 'หมวด', 'จำนวน', 'ราคาต่อหน่วย', 'ยอดรวมรายการ', 'ต้นทุนต่อหน่วย', 'ต้นทุนรวมรายการ'];
    const rows = [];
    for (const b of [...inr].sort((a, c) => a.soldAt.localeCompare(c.soldAt))) {
      for (const i of b.items) rows.push([...range, b.billNo, localDateTime(b.soldAt), ST[b.status], PAYMENTS[b.payment], i.name, i.category, i.qty, csvBaht(i.unitPrice), csvBaht(i.lineTotal), i.unitCost == null ? '' : csvBaht(i.unitCost), i.unitCost == null ? '' : csvBaht(i.qty * i.unitCost)]);
    }
    return { filename: name('bill_items'), csv: toCsv(head, rows) };
  }
  if (kind === 'profit') {
    const head = ['จากวันที่', 'ถึงวันที่', 'สินค้า', 'หมวด', 'จำนวนที่ขาย(สุทธิ)', 'ยอดขายสุทธิ', 'ต้นทุนรวม', 'กำไรขั้นต้น', 'อัตรากำไรขั้นต้น(%)', 'สถานะต้นทุน'];
    const rows = productStats(inr).sort((a, b) => b.sales - a.sales).map((s) => {
      const ok = s.costComplete;
      const pr = s.sales - s.cost;
      return [...range, s.name, s.category, s.qty, csvBaht(s.sales), ok ? csvBaht(s.cost) : '', ok ? csvBaht(pr) : '', ok && s.sales > 0 ? ((pr / s.sales) * 100).toFixed(1) : '', ok ? 'ครบ' : 'ต้นทุนไม่ครบ'];
    });
    const p = profit(inr);
    if (p.complete && !p.noSales) rows.push([...range, 'รวมทั้งช่วง', '', '', csvBaht(p.net), csvBaht(p.costKnown), csvBaht(p.profitKnown), ((p.profitKnown / p.net) * 100).toFixed(1), 'ครบ']);
    else rows.push([...range, 'รวมทั้งช่วง', '', '', csvBaht(p.net), '', '', '', p.noSales ? 'ไม่มียอดขายสุทธิ' : `ต้นทุนไม่ครบ (${p.missingLines} รายการ) - ไม่คำนวณกำไรรวม`]);
    return { filename: name('cost_profit'), csv: toCsv(head, rows) };
  }
  if (kind === 'best') {
    const head = ['จากวันที่', 'ถึงวันที่', 'อันดับ', 'กลุ่ม', 'สินค้า', 'หมวด', 'จำนวนที่ขาย(สุทธิ)', 'ยอดขายสุทธิ', 'ต้นทุนรวม', 'กำไรขั้นต้น'];
    const { rows: rk, top, bottom } = rankProducts(inr, products);
    const topIds = new Set(top.map((r) => r.productId)); const botIds = new Set(bottom.map((r) => r.productId));
    const rows = rk.map((r) => [...range, r.rank, topIds.has(r.productId) ? 'ขายดี' : botIds.has(r.productId) ? 'ขายน้อย' : '', r.name, r.category, r.qty, csvBaht(r.sales), r.costComplete && r.qty > 0 ? csvBaht(r.cost) : '', r.profit == null ? '' : csvBaht(r.profit)]);
    return { filename: name('best_worst'), csv: toCsv(head, rows) };
  }
  throw new Error('ไม่รู้จักประเภทไฟล์: ' + kind);
}
