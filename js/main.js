import * as S from './store.js';
import * as Sync from './sync.js';
import * as B from './backup.js';
import { formatBaht as money, fmtDateTime, fmtDay, dayStr, uuid, PAYMENTS, MAX_QTY } from './logic.js';
import { rangeFor, RANGE_LABELS, inRange, summarize, profit, rankProducts, productStats } from './reports.js';
import { buildExport } from './exports.js';

const $app = document.getElementById('app');
const $sheets = document.getElementById('sheets');
const $toasts = document.getElementById('toasts');

const st = {
  products: [], bills: [], audit: [], settings: { shopName: 'JUST MELLOW', deviceCode: '' }, qr: null,
  cart: new Map(), draftId: null, payment: 'cash', search: '', cat: 'ทั้งหมด', saving: false, cartSheet: null,
  hist: { range: '7d', from: '', to: '', q: '', status: 'all' },
  rep: { tab: 'sales', range: 'today', from: '', to: '' },
  sync: {}, dirty: { total: 0 }, cloud: null, hasSession: false, persisted: null, installEvt: null, lastManual: null,
};

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => dayStr(new Date());
const PAL = ['var(--c4)', 'var(--c5)', 'var(--c6)'];
const CAT_COL = { 'พุดดิ้ง': 'var(--c1)', 'ชาผลไม้': 'var(--c2)', 'มิลค์เชค': 'var(--c3)' };
const catColor = (c) => CAT_COL[c] || PAL[[...c].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PAL.length];
const categories = () => { const m = new Map(); for (const p of st.products) m.set(p.category, Math.min(m.get(p.category) ?? 1e9, p.sortOrder)); return [...m].sort((a, b) => a[1] - b[1]).map((x) => x[0]); };
const payName = (k) => PAYMENTS[k] || k;

function toast(msg, err = false, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.setAttribute('role', err ? 'alert' : 'status');
  t.textContent = msg;
  $toasts.appendChild(t);
  setTimeout(() => t.remove(), err ? Math.max(ms, 5000) : ms);
}

function openSheet(html, { center = false } = {}) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="sheet ${center ? 'center' : ''}" role="dialog" aria-modal="true">${center ? '' : '<div class="grab"></div>'}${html}</div>`;
  o.addEventListener('click', (e) => { if (e.target === o) closeSheet(o); });
  $sheets.appendChild(o);
  const f = o.querySelector('[autofocus],input,textarea'); if (f && !center) setTimeout(() => f.focus({ preventScroll: true }), 50);
  return o;
}
function closeSheet(o) { if (o === st.cartSheet) st.cartSheet = null; o?.remove(); }
const topSheet = () => $sheets.lastElementChild;
const setSheet = (o, html, center = false) => { o.firstElementChild.innerHTML = (center ? '' : '<div class="grab"></div>') + html; };

function confirmDialog({ title, body, ok = 'ยืนยัน', cancel = 'ยกเลิก', danger = false }) {
  return new Promise((resolve) => {
    const o = openSheet(`<h2>${esc(title)}</h2><div class="sub" style="color:var(--ink)">${body}</div>
      <div class="row-btns"><button class="btn" data-x="no">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="yes" autofocus>${esc(ok)}</button></div>`, { center: true });
    const done = (v) => { closeSheet(o); resolve(v); };
    o.querySelector('[data-x=yes]').onclick = () => done(true);
    o.querySelector('[data-x=no]').onclick = () => done(false);
    o.addEventListener('click', (e) => { if (e.target === o) resolve(false); });
  });
}

/* ---------- data ---------- */
async function refresh() {
  const [products, bills, audit, settings, qr, cloud, sync, dirty, hasSession, lastManual] = await Promise.all([
    S.listProducts(), S.listBills(), S.listAudit(), S.getSettings(), S.getMeta('qrImage', null), Sync.getConfig(), Sync.getState(), S.countDirty(), Sync.hasSession(), S.getMeta('lastManualBackup', null),
  ]);
  Object.assign(st, { products, bills, audit, settings, qr, cloud, sync, dirty, hasSession, lastManual });
}

let syncTimer = null;
function scheduleSync(ms = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), ms);
}
async function runSync(manual) {
  try {
    const r = await Sync.syncNow();
    if (manual) {
      if (r?.skipped === 'offline') toast('ออฟไลน์อยู่ จะสำรองให้อัตโนมัติเมื่อมีอินเทอร์เน็ต');
      else if (r?.skipped === 'not-configured') toast('ยังไม่ได้ตั้งค่าระบบออนไลน์', true);
      else toast(r.pushed ? `สำรองข้อมูลแล้ว ${r.pushed} รายการ` : 'ไม่มีข้อมูลใหม่ที่ต้องสำรอง');
    }
  } catch (e) { if (manual) toast(e.message, true); }
  await onSyncChange();
}
async function onSyncChange() {
  await refresh();
  updateChrome();
}

/* ---------- routing ---------- */
const route = () => (location.hash.replace(/^#\/?/, '') || 'home');
const go = (r) => { location.hash = '#/' + (r === 'home' ? '' : r); };

const TITLES = { sell: 'ขายสินค้า', history: 'ประวัติการขาย', reports: 'รายงาน', products: 'จัดการสินค้า', backup: 'สำรองและกู้คืนข้อมูล', settings: 'ตั้งค่าร้าน' };

function onlinePill() {
  const on = navigator.onLine;
  return `<span class="pill ${on ? '' : 'off'}" data-chrome="online"><span class="dot"></span>${on ? 'ออนไลน์' : 'ออฟไลน์'}</span>`;
}
const header = (r) => `<header class="top"><button class="back" data-act="back" aria-label="กลับหน้าหลัก">‹</button><h1>${esc(TITLES[r])}</h1>${onlinePill()}</header>`;

async function render() {
  const r = route();
  const pages = { home, sell, history, reports, products, backup, settings };
  const page = pages[r] || home;
  const body = page();
  $app.innerHTML = (r === 'home' ? '' : header(r)) + `<main>${body}</main>`;
  window.scrollTo(0, 0);
  if (r === 'sell') renderSellDynamic();
  if (r === 'history') renderHistList();
  if (r === 'reports') renderRepBody();
}

function updateChrome() {
  document.querySelectorAll('[data-chrome=online]').forEach((el) => { el.outerHTML = onlinePill(); });
  document.querySelectorAll('[data-syncblock]').forEach((el) => { el.innerHTML = syncBlockHtml(el.dataset.syncblock === 'full'); });
  const r = route();
  if (r === 'home') { const d = document.getElementById('homeStats'); if (d) d.innerHTML = homeStats(); }
}

/* ---------- sync status ---------- */
function syncBlockHtml(full) {
  const s = st.sync || {}; const pending = st.dirty.total;
  const out = [];
  if (!st.cloud) {
    out.push(`<div class="note warn"><b>ยังไม่ได้ตั้งค่าสำรองออนไลน์</b><br>ข้อมูลอยู่ในเครื่องนี้เท่านั้น ถ้าล้างข้อมูลเบราว์เซอร์หรือลบแอป ข้อมูลจะหาย ${full ? '' : '<br><a href="#/backup">ตั้งค่าตอนนี้</a>'}</div>`);
  } else if (!st.hasSession) {
    out.push(`<div class="note warn"><b>ยังไม่ได้เข้าสู่ระบบออนไลน์</b><br>รอสำรอง ${pending} รายการ ${full ? '' : '<br><a href="#/backup">เข้าสู่ระบบ</a>'}</div>`);
  } else {
    if (s.lastError) out.push(`<div class="note err" role="alert"><b>สำรองข้อมูลไม่สำเร็จ</b><br>${esc(s.lastError)}<br><button class="btn sm" data-act="syncnow" style="margin-top:8px">ลองซิงก์ใหม่</button></div>`);
    else if (!navigator.onLine && pending) out.push(`<div class="note warn">ออฟไลน์อยู่ — รอสำรอง <b>${pending}</b> รายการ จะส่งให้อัตโนมัติเมื่อมีอินเทอร์เน็ต</div>`);
    else if (s.syncing) out.push('<div class="note">กำลังสำรองข้อมูล…</div>');
    else if (pending) out.push(`<div class="note warn">รอสำรอง <b>${pending}</b> รายการ <button class="btn sm" data-act="syncnow" style="margin-left:8px">สำรองเดี๋ยวนี้</button></div>`);
    else out.push('<div class="note ok">ข้อมูลทั้งหมดถูกสำรองออนไลน์แล้ว</div>');
    if (full) out.push(`<div class="kv"><span>สำรองออนไลน์สำเร็จล่าสุด</span><b>${s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : 'ยังไม่เคย'}</b></div><div class="kv"><span>รอสำรอง</span><b>${pending} รายการ</b></div>`);
  }
  if (!st.cloud || s.lastError || !s.lastSuccessAt) {
    const days = st.lastManual ? (Date.now() - new Date(st.lastManual)) / 864e5 : Infinity;
    if (st.bills.length && days > 7) out.push(`<div class="note warn">${st.lastManual ? `สำรองเป็นไฟล์ล่าสุดเมื่อ ${fmtDateTime(st.lastManual)}` : 'ยังไม่เคยสำรองเป็นไฟล์'} — ควรสำรองไฟล์ไว้อีกชั้น ${full ? '' : '<a href="#/backup">สำรองเลย</a>'}</div>`);
  }
  return out.join('');
}

/* ---------- home ---------- */
function homeStats() {
  const t = summarize(inRange(st.bills, todayStr(), todayStr()));
  return `<div class="box"><div class="lbl">ยอดขายสุทธิวันนี้</div><div class="val">${money(t.net)}</div></div><div class="box"><div class="lbl">บิลวันนี้ (ไม่รวมยกเลิก)</div><div class="val">${t.billsNet}</div></div>`;
}
function home() {
  return `<main style="padding-top:calc(var(--safe-t) + 14px)">
    <div class="brand" style="display:flex;justify-content:space-between;align-items:flex-start"><div><h1 class="name">${esc(st.settings.shopName)}</h1><p class="sub">POS · ${esc(fmtDay(todayStr()))}</p></div>${onlinePill()}</div>
    <div class="today" id="homeStats">${homeStats()}</div>
    <div data-syncblock="short">${syncBlockHtml(false)}</div>
    <div class="tiles">
      <button class="hometile primary" data-go="sell"><span class="ic">🍮</span><span class="t">ขายสินค้า<small>เริ่มรายการขายใหม่</small></span></button>
      <button class="hometile" data-go="history"><span class="ic">🧾</span><span class="t">ประวัติการขาย</span></button>
      <button class="hometile" data-go="reports"><span class="ic">📊</span><span class="t">รายงาน</span></button>
      <button class="hometile" data-go="products"><span class="ic">🧋</span><span class="t">จัดการสินค้า</span></button>
      <button class="hometile" data-go="backup"><span class="ic">☁️</span><span class="t">สำรองและกู้คืน</span></button>
      <button class="hometile" data-go="settings"><span class="ic">⚙️</span><span class="t">ตั้งค่าร้าน</span></button>
    </div></main>`.replace(/^<main[^>]*>|<\/main>$/g, '');
}

/* ---------- sell ---------- */
function sell() {
  const cats = ['ทั้งหมด', ...categories()];
  return `<input class="search" id="q" type="search" placeholder="ค้นหาชื่อสินค้า" value="${esc(st.search)}" data-in="search" aria-label="ค้นหาสินค้า" autocomplete="off">
    <div class="chips" id="chips">${cats.map((c) => `<button class="chip" data-act="cat" data-v="${esc(c)}" aria-pressed="${c === st.cat}">${esc(c)}</button>`).join('')}</div>
    <div class="grid" id="grid"></div><div class="cartbar" id="cartbar"></div>`;
}
function cartLines() {
  const lines = [];
  for (const [id, qty] of st.cart) { const p = st.products.find((x) => x.id === id); if (p && p.active) lines.push({ p, qty }); }
  return lines;
}
const cartTotal = (lines) => lines.reduce((s, l) => s + l.qty * l.p.price, 0);
function renderSellDynamic() {
  const grid = document.getElementById('grid'); if (!grid) return;
  document.querySelectorAll('#chips .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.cat)));
  const q = st.search.trim().toLowerCase();
  const list = st.products.filter((p) => p.active && (st.cat === 'ทั้งหมด' || p.category === st.cat) && (!q || p.name.toLowerCase().includes(q)));
  grid.innerHTML = list.length ? list.map((p) => `<button class="tile" style="--cat:${catColor(p.category)}" data-act="add" data-id="${p.id}"><span class="n">${esc(p.name)}${p.provisional ? '<span class="tag">ตัวอย่าง</span>' : ''}</span><span class="p">${money(p.price)}</span>${st.cart.get(p.id) ? `<span class="q">${st.cart.get(p.id)}</span>` : ''}</button>`).join('')
    : `<p class="empty" style="grid-column:1/-1">${q ? 'ไม่พบสินค้าที่ค้นหา' : 'ยังไม่มีสินค้าที่เปิดขาย — ไปที่ “จัดการสินค้า”'}</p>`;
  const lines = cartLines(); const n = lines.reduce((s, l) => s + l.qty, 0);
  document.getElementById('cartbar').innerHTML = n ? `<button class="btn primary" data-act="opencart"><span>ดูรายการขาย (${n})</span><b class="mono">${money(cartTotal(lines))}</b></button>` : '';
}
function addToCart(id) {
  const cur = st.cart.get(id) || 0;
  if (cur >= MAX_QTY) return toast(`จำนวนสูงสุด ${MAX_QTY} ต่อรายการ`, true);
  if (!st.draftId) st.draftId = uuid();
  st.cart.set(id, cur + 1); renderSellDynamic();
}
function cartSheetHtml() {
  const lines = cartLines();
  if (!lines.length) return `<h2>รายการขาย</h2><p class="empty">ยังไม่มีสินค้า</p><button class="btn block" data-act="closesheet">ปิด</button>`;
  return `<h2>รายการขาย</h2>
    ${lines.map(({ p, qty }) => `<div class="line"><div class="nm"><b>${esc(p.name)}</b><small>${money(p.price)} × ${qty}</small></div>
      <div class="stepper"><button data-act="dec" data-id="${p.id}" aria-label="ลด ${esc(p.name)}">−</button><span>${qty}</span><button data-act="inc" data-id="${p.id}" aria-label="เพิ่ม ${esc(p.name)}">+</button></div>
      <div class="amt">${money(p.price * qty)}</div><button class="rm" data-act="rm" data-id="${p.id}" aria-label="ลบ ${esc(p.name)}">✕</button></div>`).join('')}
    <div class="total"><span>ยอดรวม</span><b id="cartTotal">${money(cartTotal(lines))}</b></div>
    <div class="sub" style="margin:0">วิธีชำระเงิน</div>
    <div class="seg" role="group" aria-label="วิธีชำระเงิน">${Object.entries(PAYMENTS).map(([k, v]) => `<button data-act="pay" data-v="${k}" aria-pressed="${st.payment === k}">${v}</button>`).join('')}</div>
    ${st.payment === 'qr' ? `<div class="qrbox">${st.qr ? `<img src="${st.qr}" alt="QR Code ของร้าน">` : '<div class="note">ยังไม่ได้ใส่ภาพ QR ของร้าน (ตั้งค่าร้าน)</div>'}<div class="sub">ระบบแค่บันทึกว่าลูกค้าจ่ายด้วย QR — ไม่ได้ตรวจสอบการชำระเงินอัตโนมัติ</div></div>` : ''}
    ${st.payment === 'transfer' ? '<div class="sub">ระบบแค่บันทึกว่าเป็นการโอนเงิน — ไม่ได้ตรวจสอบยอดโอนจริง</div>' : ''}
    <div class="row-btns"><button class="btn" data-act="clearcart">ล้างรายการ</button><button class="btn primary" data-act="checkout" ${st.saving ? 'disabled' : ''}>ยืนยันการขาย</button></div>`;
}
function refreshCartSheet() {
  if (!st.cartSheet) return;
  if (!cartLines().length) { closeSheet(st.cartSheet); st.cartSheet = null; } else setSheet(st.cartSheet, cartSheetHtml());
  renderSellDynamic();
}
async function checkout() {
  if (st.saving) return;
  const lines = cartLines(); if (!lines.length) return;
  const total = cartTotal(lines);
  const ok = await confirmDialog({
    title: 'บันทึกบิลนี้?',
    body: `<div class="kv"><span>จำนวนรายการ</span><b>${lines.reduce((s, l) => s + l.qty, 0)} ชิ้น</b></div><div class="kv"><span>วิธีชำระเงิน</span><b>${payName(st.payment)}</b></div><div class="kv"><span>ยอดรวม</span><b style="font-size:1.3rem">${money(total)}</b></div>`,
    ok: 'บันทึกบิล', cancel: 'กลับไปแก้',
  });
  if (!ok || st.saving) return;
  st.saving = true;
  if (st.cartSheet) setSheet(st.cartSheet, cartSheetHtml());
  try {
    const bill = await S.createBill({ id: st.draftId || uuid(), lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty })), payment: st.payment });
    finishSale(bill);
  } catch (e) {
    if (e.code === 'DUPLICATE') { toast('บิลนี้ถูกบันทึกไปแล้ว (ไม่สร้างซ้ำ)'); finishSale(e.bill); }
    else toast('บันทึกบิลไม่สำเร็จ: ' + (e.message || e), true);
  } finally { st.saving = false; if (st.cartSheet) setSheet(st.cartSheet, cartSheetHtml()); }
}
async function finishSale(bill) {
  st.cart.clear(); st.draftId = null; st.payment = 'cash';
  if (st.cartSheet) closeSheet(st.cartSheet);
  await refresh(); renderSellDynamic(); updateChrome(); scheduleSync();
  const o = openSheet(`<h2>บันทึกบิลแล้ว ✓</h2><p class="sub">${esc(bill.billNo)} · ${esc(fmtDateTime(bill.soldAt))}</p>
    <div class="kv"><span>ยอดรวม</span><b style="font-size:1.4rem">${money(bill.total)}</b></div><div class="kv"><span>ชำระด้วย</span><b>${payName(bill.payment)}</b></div>
    <div class="row-btns" style="margin-top:12px"><button class="btn" data-act="viewbill" data-id="${bill.id}">ดูรายละเอียดบิล</button><button class="btn primary" data-act="closesheet" autofocus>ขายรายการใหม่</button></div>`, { center: true });
  o.dataset.receipt = bill.id;
}

/* ---------- bill detail ---------- */
function billDetailHtml(b) {
  const voidInfo = b.status === 'void' ? `<div class="note err"><b>บิลนี้ถูกยกเลิกแล้ว</b><br>เหตุผล: ${esc(b.voidReason)}<br>เมื่อ ${esc(fmtDateTime(b.voidedAt))}</div>` : '';
  return `<h2>${esc(b.billNo)} <span class="status ${b.status}">${b.status === 'void' ? 'ยกเลิก' : 'ปกติ'}</span></h2>
    <p class="sub">${esc(fmtDateTime(b.soldAt))} · ${payName(b.payment)}</p>${voidInfo}
    ${b.items.map((i) => `<div class="line"><div class="nm"><b>${esc(i.name)}</b><small>${money(i.unitPrice)} × ${i.qty}</small></div><div class="amt">${money(i.lineTotal)}</div></div>`).join('')}
    <div class="total"><span>ยอดรวมบิล</span><b>${money(b.total)}</b></div>
    <div class="row-btns">${b.status === 'active' ? `<button class="btn danger" data-act="voidbill" data-id="${b.id}">ยกเลิกบิล</button>` : ''}<button class="btn" data-act="closesheet">ปิด</button></div>`;
}
function showBill(id) {
  const b = st.bills.find((x) => x.id === id); if (!b) return toast('ไม่พบบิล', true);
  openSheet(billDetailHtml(b)).dataset.bill = id;
}
async function voidFlow(id) {
  const b = st.bills.find((x) => x.id === id); if (!b) return;
  const o = openSheet(`<h2>ยกเลิกบิล ${esc(b.billNo)}</h2><p class="sub">ยอด ${money(b.total)} · บิลจะไม่ถูกลบ แต่จะไม่นับเป็นยอดขายสุทธิ</p>
    <label class="field"><span>เหตุผลที่ยกเลิก (จำเป็น)</span><textarea id="voidWhy" maxlength="200" placeholder="เช่น ลูกค้าเปลี่ยนใจ / กดผิด"></textarea></label><div class="err-t" id="voidErr"></div>
    <div class="row-btns"><button class="btn" data-x="no">ไม่ยกเลิก</button><button class="btn danger" data-x="go">ถัดไป</button></div>`);
  o.querySelector('[data-x=no]').onclick = () => closeSheet(o);
  o.querySelector('[data-x=go]').onclick = async () => {
    const why = o.querySelector('#voidWhy').value.trim();
    if (!why) { o.querySelector('#voidErr').textContent = 'กรุณากรอกเหตุผลที่ยกเลิกบิล'; return; }
    const sure = await confirmDialog({ title: 'ยืนยันยกเลิกบิล?', body: `บิล <b>${esc(b.billNo)}</b> ยอด <b>${money(b.total)}</b><br>เหตุผล: ${esc(why)}<br><br>ยกเลิกแล้วย้อนกลับไม่ได้`, ok: 'ยืนยันยกเลิกบิล', cancel: 'กลับ', danger: true });
    if (!sure) return;
    try {
      await S.voidBill(id, why);
      await refresh();
      document.querySelectorAll('.overlay').forEach((x) => x.remove()); st.cartSheet = null;
      toast('ยกเลิกบิลแล้ว'); scheduleSync(); updateChrome();
      if (route() === 'history') renderHistList(); if (route() === 'reports') renderRepBody();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- history ---------- */
function histRange() { return st.hist.range === 'all' ? rangeFor('all') : rangeFor(st.hist.range, st.hist); }
function history() {
  const h = st.hist;
  const chips = [['today', 'วันนี้'], ['7d', '7 วัน'], ['month', 'เดือนนี้'], ['all', 'ทั้งหมด'], ['custom', 'เลือกวันที่']];
  return `<div class="chips">${chips.map(([k, l]) => `<button class="chip" data-act="hrange" data-v="${k}" aria-pressed="${h.range === k}">${l}</button>`).join('')}</div>
    ${h.range === 'custom' ? `<div class="row-btns" style="margin-bottom:10px"><label class="field" style="margin:0"><span>จาก</span><input type="date" data-in="hfrom" value="${esc(h.from || todayStr())}"></label><label class="field" style="margin:0"><span>ถึง</span><input type="date" data-in="hto" value="${esc(h.to || todayStr())}"></label></div>` : ''}
    <input class="search" type="search" id="hq" placeholder="ค้นหาหมายเลขบิล เช่น 261010-003" value="${esc(h.q)}" data-in="hq" autocomplete="off" aria-label="ค้นหาบิล">
    <div class="chips">${[['all', 'ทุกสถานะ'], ['active', 'ปกติ'], ['void', 'ยกเลิก']].map(([k, l]) => `<button class="chip" data-act="hstatus" data-v="${k}" aria-pressed="${h.status === k}">${l}</button>`).join('')}</div>
    <div id="hlist"></div><button class="btn block ghost" data-act="auditlog" style="margin-top:12px">ดูบันทึกการยกเลิก/แก้ไขย้อนหลัง</button>`;
}
function renderHistList() {
  const el = document.getElementById('hlist'); if (!el) return;
  const { from, to } = histRange(); const q = st.hist.q.trim().toLowerCase();
  const list = inRange(st.bills, from, to).filter((b) => (st.hist.status === 'all' || b.status === st.hist.status) && (!q || b.billNo.toLowerCase().includes(q)));
  const s = summarize(list);
  el.innerHTML = list.length ? `<p class="sub">${list.length} บิล · ยอดสุทธิ ${money(s.net)}</p>` + list.map((b) => `<button class="card click ${b.status === 'void' ? 'void-row' : ''}" data-act="viewbill" data-id="${b.id}">
      <div class="kv" style="padding:0"><b>${esc(b.billNo)}</b><span class="amt">${money(b.total)}</span></div>
      <div class="kv" style="padding:2px 0 0"><span>${esc(fmtDateTime(b.soldAt))} · ${payName(b.payment)}</span><span class="status ${b.status}">${b.status === 'void' ? 'ยกเลิก' : 'ปกติ'}</span></div></button>`).join('')
    : '<p class="empty">ไม่พบบิลในเงื่อนไขนี้</p>';
}
function auditLog() {
  const LBL = { void: 'ยกเลิกบิล', product_create: 'เพิ่มสินค้า', product_update: 'แก้ไขสินค้า', restore_replace: 'กู้คืน (แทนที่)', restore_merge: 'กู้คืน (รวม)', restore_cloud: 'กู้คืนจากออนไลน์' };
  const FL = { name: 'ชื่อ', category: 'หมวด', price: 'ราคา', cost: 'ต้นทุน', active: 'เปิดขาย', provisional: 'ตัวอย่าง' };
  const fv = (k, v) => (k === 'price' || k === 'cost') ? (v == null ? 'ไม่ระบุ' : money(v)) : (typeof v === 'boolean' ? (v ? 'ใช่' : 'ไม่') : String(v));
  const rows = st.audit.slice(0, 200).map((a) => {
    let d = '';
    if (a.type === 'void') d = `${esc(a.billNo)} · ${money(a.amount)}<br>เหตุผล: ${esc(a.reason)}`;
    else if (a.type.startsWith('product')) d = esc(a.productName) + Object.entries(a.changes || {}).map(([k, [o, n]]) => `<br>${FL[k] || k}: ${esc(fv(k, o))} → ${esc(fv(k, n))}`).join('');
    else d = esc(a.detail || '');
    return `<div class="card"><div class="kv" style="padding:0"><b>${LBL[a.type] || esc(a.type)}</b><span>${esc(fmtDateTime(a.at))}</span></div><div style="font-size:.9rem">${d}</div></div>`;
  }).join('');
  openSheet(`<h2>บันทึกการเปลี่ยนแปลง</h2><p class="sub">การยกเลิกบิลและการแก้ไขสินค้า (ล่าสุด 200 รายการ)</p>${rows || '<p class="empty">ยังไม่มีบันทึก</p>'}<button class="btn block" data-act="closesheet">ปิด</button>`);
}

/* ---------- reports ---------- */
function repRange() { return rangeFor(st.rep.range, st.rep); }
function reports() {
  const r = st.rep;
  const tabs = [['sales', 'ยอดขาย'], ['bills', 'รายละเอียดบิล'], ['profit', 'ต้นทุน/กำไร'], ['best', 'ขายดี/ไม่ดี']];
  const ranges = ['today', 'yesterday', '7d', 'month', 'custom'];
  return `<div class="chips">${tabs.map(([k, l]) => `<button class="chip" data-act="rtab" data-v="${k}" aria-pressed="${r.tab === k}">${l}</button>`).join('')}</div>
    <div class="chips">${ranges.map((k) => `<button class="chip" data-act="rrange" data-v="${k}" aria-pressed="${r.range === k}">${RANGE_LABELS[k]}</button>`).join('')}</div>
    ${r.range === 'custom' ? `<div class="row-btns" style="margin-bottom:10px"><label class="field" style="margin:0"><span>จาก</span><input type="date" data-in="rfrom" value="${esc(r.from || todayStr())}"></label><label class="field" style="margin:0"><span>ถึง</span><input type="date" data-in="rto" value="${esc(r.to || todayStr())}"></label></div>` : ''}
    <div id="repBody"></div>`;
}
function renderRepBody() {
  const el = document.getElementById('repBody'); if (!el) return;
  const { from, to } = repRange();
  if (from > to) { el.innerHTML = '<div class="note err">วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด</div>'; return; }
  const bills = inRange(st.bills, from, to);
  const label = from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
  const head = `<p class="sub">ช่วงวันที่: <b>${label}</b></p>`;
  const exp = (k, text) => `<button class="btn block" data-act="export" data-v="${k}" style="margin-top:10px">⬇ ${text}</button>`;
  const t = st.rep.tab;
  if (t === 'sales') {
    const s = summarize(bills);
    el.innerHTML = head + (!bills.length ? '<p class="empty">ไม่มีข้อมูลการขายในช่วงนี้</p>' : `
      <div class="card"><div class="sub" style="margin:0">ยอดขายสุทธิ (หลังหักบิลที่ยกเลิก)</div><p class="big">${money(s.net)}</p></div>
      <div class="card">
        <div class="kv"><span>ยอดขายรวม (ก่อนหักยกเลิก)</span><b>${money(s.grossAll)}</b></div>
        <div class="kv"><span>หัก: ยอดบิลที่ยกเลิก</span><b>−${money(s.voidTotal)}</b></div>
        <div class="hr"></div>
        <div class="kv"><span>ยอดขายสุทธิ</span><b>${money(s.net)}</b></div></div>
      <div class="card">
        <div class="kv"><span>จำนวนบิลทั้งหมด</span><b>${s.billsAll}</b></div>
        <div class="kv"><span>บิลที่ยกเลิก</span><b>${s.billsVoid}</b></div>
        <div class="kv"><span>บิลสุทธิ</span><b>${s.billsNet}</b></div>
        <div class="kv"><span>จำนวนสินค้าที่ขาย (สุทธิ)</span><b>${s.itemsNet} ชิ้น</b></div></div>
      <div class="sec">ยอดขายสุทธิแยกตามวิธีชำระเงิน</div>
      <div class="card">${Object.entries(PAYMENTS).map(([k, v]) => `<div class="kv"><span>${v} (${s.billsByPay[k]} บิล)</span><b>${money(s.byPay[k])}</b></div>`).join('')}</div>`)
      + exp('summary', 'ส่งออกสรุปยอดขาย (CSV)');
  } else if (t === 'bills') {
    el.innerHTML = head + (!bills.length ? '<p class="empty">ไม่มีบิลในช่วงนี้</p>' : bills.map((b) => `<div class="card ${b.status === 'void' ? 'void-row' : ''}">
      <div class="kv" style="padding:0"><b>${esc(b.billNo)}</b><span class="status ${b.status}">${b.status === 'void' ? 'ยกเลิก' : 'ปกติ'}</span></div>
      <div class="sub" style="margin:0 0 6px">${esc(fmtDateTime(b.soldAt))} · ${payName(b.payment)}</div>
      ${b.items.map((i) => `<div class="kv" style="padding:1px 0;font-size:.92rem"><span style="color:var(--ink)">${esc(i.name)} ${i.qty} × ${money(i.unitPrice)}</span><b>${money(i.lineTotal)}</b></div>`).join('')}
      <div class="hr"></div><div class="kv" style="padding:0"><span>ยอดรวมบิล</span><b>${money(b.total)}</b></div>${b.status === 'void' ? `<div class="err-t">เหตุผลยกเลิก: ${esc(b.voidReason)}</div>` : ''}</div>`).join(''))
      + exp('bills', 'ส่งออกรายละเอียดบิล (CSV)') + exp('items', 'ส่งออกรายการสินค้าในแต่ละบิล (CSV)');
  } else if (t === 'profit') {
    const p = profit(bills);
    let body;
    if (p.noSales) body = '<p class="empty">ไม่มียอดขายสุทธิในช่วงนี้ — ยังคำนวณกำไรไม่ได้</p>';
    else if (p.complete) body = `<div class="card"><div class="kv"><span>ยอดขายสุทธิ</span><b>${money(p.net)}</b></div><div class="kv"><span>ต้นทุนสินค้าที่ขาย</span><b>${money(p.costKnown)}</b></div><div class="hr"></div>
      <div class="kv"><span>กำไรขั้นต้น</span><b>${money(p.profitKnown)}</b></div><div class="kv"><span>อัตรากำไรขั้นต้น</span><b>${p.marginKnown.toFixed(1)}%</b></div></div>`;
    else body = `<div class="note warn"><b>ข้อมูลต้นทุนไม่ครบ</b><br>มี ${p.missingLines} รายการขาย (ยอด ${money(p.missingSales)}) ที่สินค้ายังไม่ได้ระบุต้นทุน จึงยังสรุปกำไรขั้นต้นรวมไม่ได้ — ไปที่ “จัดการสินค้า” เพื่อใส่ต้นทุน</div>
      ${p.salesKnown > 0 ? `<div class="card"><div class="sub" style="margin:0 0 6px">คำนวณเฉพาะสินค้าที่มีต้นทุน</div><div class="kv"><span>ยอดขายของสินค้าที่มีต้นทุน</span><b>${money(p.salesKnown)}</b></div><div class="kv"><span>ต้นทุน</span><b>${money(p.costKnown)}</b></div><div class="kv"><span>กำไรขั้นต้น (บางส่วน)</span><b>${money(p.profitKnown)}</b></div><div class="kv"><span>อัตรากำไรขั้นต้น (บางส่วน)</span><b>${p.marginKnown.toFixed(1)}%</b></div></div>` : '<p class="empty">ยังไม่มีสินค้าที่ระบุต้นทุนเลย</p>'}`;
    const rows = productStats(bills).sort((a, b) => b.sales - a.sales);
    el.innerHTML = head + body + (rows.length ? `<div class="sec">แยกตามสินค้า</div><div class="scroll-x"><table class="tbl"><tr><th>สินค้า</th><th>ขาย</th><th>ต้นทุน</th><th>กำไร</th></tr>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${money(r.sales)}</td><td>${r.costComplete ? money(r.cost) : '—'}</td><td>${r.costComplete ? money(r.sales - r.cost) : 'ไม่ครบ'}</td></tr>`).join('')}</table></div>` : '')
      + '<p class="sub" style="margin-top:10px">หมายเหตุ: นี่คือ <b>กำไรขั้นต้น</b> (ยอดขายสุทธิ − ต้นทุนสินค้าที่ขาย) ไม่ใช่กำไรสุทธิหลังหักค่าใช้จ่ายอื่นของร้าน เช่น ค่าเช่า ค่าแรง ค่าน้ำไฟ และใช้ต้นทุน ณ เวลาขาย</p>' + exp('profit', 'ส่งออกรายงานต้นทุนและกำไร (CSV)');
  } else {
    const r = rankProducts(bills, st.products);
    const row = (x) => `<div class="prow"><div class="i"><b>${esc(x.name)}</b><small>${esc(x.category)}</small></div><div style="text-align:right"><b>${x.qty} ชิ้น</b><small style="display:block;color:var(--muted)">${money(x.sales)}${x.qty > 0 ? (x.costComplete ? ` · กำไร ${money(x.sales - x.cost)}` : ' · ต้นทุนไม่ครบ') : ''}</small></div></div>`;
    el.innerHTML = head + (!r.hasSales ? '<p class="empty">ไม่มีข้อมูลการขายในช่วงนี้</p>' : `<div class="sec">ขายดี (ไม่นับบิลที่ยกเลิก)</div>${r.top.map((x, i) => `<div style="display:flex;gap:8px"><b style="min-width:22px;padding-top:10px">${i + 1}</b><div style="flex:1">${row(x)}</div></div>`).join('')}
      <div class="sec">ขายน้อย</div>${r.bottom.length ? r.bottom.map(row).join('') : '<p class="empty">ไม่มี</p>'}`) + exp('best', 'ส่งออกอันดับสินค้า (CSV)');
  }
}
function doExport(kind) {
  const { from, to } = repRange();
  if (from > to) return toast('ช่วงวันที่ไม่ถูกต้อง', true);
  const { filename, csv } = buildExport(kind, { bills: st.bills, products: st.products, from, to });
  B.downloadBlob(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  toast('ส่งออกแล้ว: ' + filename);
}

/* ---------- products ---------- */
function products() {
  const cats = categories();
  const prov = st.products.some((p) => p.provisional);
  return `<button class="btn primary block" data-act="newprod">+ เพิ่มสินค้า</button>
    ${prov ? '<div class="note warn" style="margin-top:12px">สินค้าที่มีป้าย <span class="tag">ตัวอย่าง</span> (มิลค์เชค) เป็นข้อมูลเบื้องต้น ราคาและรสชาติยังไม่ใช่เมนูที่ร้านยืนยัน — แก้ไขได้ทั้งหมด</div>' : ''}
    ${cats.map((c) => `<div class="sec" style="color:var(--muted)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${catColor(c)};margin-right:6px"></span>${esc(c)}</div>
      ${st.products.filter((p) => p.category === c).map((p) => `<div class="prow ${p.active ? '' : 'off'}"><button class="i" data-act="editprod" data-id="${p.id}" style="text-align:left;background:none;border:0;min-height:48px;cursor:pointer"><b>${esc(p.name)}${p.provisional ? '<span class="tag">ตัวอย่าง</span>' : ''}</b>
        <small>ขาย ${money(p.price)} · ${p.cost == null ? '<span style="color:var(--warn)">ยังไม่ระบุต้นทุน</span>' : 'ต้นทุน ' + money(p.cost)}${p.active ? '' : ' · ปิดการขาย'}</small></button>
        <button class="btn sm" data-act="toggleprod" data-id="${p.id}">${p.active ? 'ปิดขาย' : 'เปิดขาย'}</button></div>`).join('')}`).join('')}`;
}
function prodForm(p) {
  const cats = categories();
  const o = openSheet(`<h2>${p ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า'}</h2>${p ? '<p class="sub">แก้ชื่อ/ราคา/ต้นทุนแล้ว บิลเก่าจะไม่เปลี่ยน (บันทึกราคา ณ เวลาขายไว้แล้ว)</p>' : ''}
    <label class="field"><span>ชื่อสินค้า</span><input type="text" id="pf-name" maxlength="60" value="${esc(p?.name)}"><div class="err-t" data-e="name"></div></label>
    <label class="field"><span>หมวดหมู่ (เลือกหรือพิมพ์หมวดใหม่)</span><input type="text" id="pf-cat" list="catlist" maxlength="30" value="${esc(p?.category ?? (cats[0] || ''))}"><datalist id="catlist">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist><div class="err-t" data-e="category"></div></label>
    <div class="row-btns"><label class="field"><span>ราคาขาย (บาท)</span><input type="text" inputmode="decimal" id="pf-price" value="${p ? (p.price / 100).toFixed(p.price % 100 ? 2 : 0) : ''}"><div class="err-t" data-e="price"></div></label>
    <label class="field"><span>ต้นทุนต่อหน่วย (บาท)</span><input type="text" inputmode="decimal" id="pf-cost" placeholder="ยังไม่ทราบ = เว้นว่าง" value="${p && p.cost != null ? (p.cost / 100).toFixed(p.cost % 100 ? 2 : 0) : ''}"><div class="err-t" data-e="cost"></div></label></div>
    <label class="check"><input type="checkbox" id="pf-active" ${p ? (p.active ? 'checked' : '') : 'checked'}> เปิดขาย</label>
    <label class="check"><input type="checkbox" id="pf-prov" ${p?.provisional ? 'checked' : ''}> เป็นเมนูตัวอย่าง (ร้านยังไม่ยืนยันขาย)</label>
    <div class="row-btns"><button class="btn" data-x="no">ยกเลิก</button><button class="btn primary" data-x="save">บันทึก</button></div>`);
  const g = (id) => o.querySelector(id);
  g('[data-x=no]').onclick = () => closeSheet(o);
  g('[data-x=save]').onclick = async () => {
    try {
      const v = await S.saveProduct({ name: g('#pf-name').value, category: g('#pf-cat').value, priceText: g('#pf-price').value, costText: g('#pf-cost').value, active: g('#pf-active').checked, provisional: g('#pf-prov').checked }, p?.id ?? null);
      o.querySelectorAll('[data-e]').forEach((e) => { e.textContent = v.errors?.[e.dataset.e] || ''; });
      if (!v.ok) return;
      closeSheet(o); await refresh(); render(); scheduleSync(); toast('บันทึกสินค้าแล้ว');
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- backup ---------- */
function backup() {
  const c = st.cloud || {};
  return `<div class="sec" style="margin-top:0">สำรองออนไลน์ (อัตโนมัติ)</div>
    <div data-syncblock="full">${syncBlockHtml(true)}</div>
    <div class="row-btns" style="margin:10px 0 14px"><button class="btn" data-act="syncnow">สำรองเดี๋ยวนี้</button><button class="btn" data-act="cloudrestore" ${st.cloud && st.hasSession ? '' : 'disabled'}>กู้คืนจากออนไลน์</button></div>
    <details class="card" ${st.cloud && st.hasSession ? '' : 'open'}><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer"><b>ตั้งค่า / เข้าสู่ระบบออนไลน์ (Supabase)</b></summary>
      <p class="sub">ทำตามขั้นตอนใน README ข้อ “ตั้งค่าสำรองออนไลน์” ก่อน แล้วนำค่ามากรอกที่นี่ รหัสผ่านไม่ถูกเก็บในเครื่อง</p>
      <label class="field"><span>Project URL</span><input type="url" id="cl-url" placeholder="https://xxxx.supabase.co" value="${esc(c.url)}" autocomplete="off"></label>
      <label class="field"><span>anon public key</span><input type="text" id="cl-key" value="${esc(c.anonKey)}" autocomplete="off"></label>
      <label class="field"><span>อีเมลของเจ้าของร้าน</span><input type="email" id="cl-mail" value="${esc(c.email)}" autocomplete="username"></label>
      <label class="field"><span>รหัสผ่าน</span><input type="password" id="cl-pass" autocomplete="current-password"></label>
      <div class="row-btns"><button class="btn primary" data-act="cloudlogin">บันทึกและเข้าสู่ระบบ</button>${st.hasSession ? '<button class="btn" data-act="cloudlogout">ออกจากระบบ</button>' : ''}</div></details>
    <div class="sec">สำรองเป็นไฟล์ (ทำเองได้เสมอ)</div>
    <div class="card"><div class="kv"><span>ข้อมูลในเครื่อง</span><b>${st.bills.length} บิล · ${st.products.length} สินค้า</b></div>
      <div class="kv"><span>สำรองไฟล์ล่าสุด</span><b>${st.lastManual ? fmtDateTime(st.lastManual) : 'ยังไม่เคย'}</b></div>
      <div class="kv"><span>เบราว์เซอร์กันข้อมูลถูกลบ</span><b>${st.persisted === true ? 'เปิดอยู่' : st.persisted === false ? 'ไม่ได้เปิด' : 'ไม่ทราบ'}</b></div>
      <div class="row-btns" style="margin-top:8px"><button class="btn primary" data-act="exportbackup">ดาวน์โหลดไฟล์สำรอง</button>${B.canShareFiles() ? '<button class="btn" data-act="sharebackup">แชร์/ส่งไฟล์</button>' : ''}</div>
      <label class="field" style="margin-top:12px"><span>กู้คืนจากไฟล์สำรอง (.json)</span><input type="file" id="importFile" accept=".json,application/json" data-in="importfile"></label></div>
    <div class="note">⚠ ข้อมูลที่อยู่ในเครื่องจะหายถ้า <b>ล้างข้อมูลเบราว์เซอร์ ลบแอป หรือเปลี่ยนเครื่อง</b> ควรสำรองไฟล์ทุกสัปดาห์ และเก็บไว้ที่อื่น (เช่น Google Drive/LINE Keep)</div>`;
}
async function exportBackup(share) {
  try {
    const data = await B.buildBackup();
    const name = `justmellow_backup_${dayStr()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (share) { if (!(await B.shareBlob(name, blob, 'application/json'))) B.downloadBlob(name, blob); } else B.downloadBlob(name, blob);
    await S.setMeta('lastManualBackup', new Date().toISOString());
    await refresh(); updateChrome(); toast(`สร้างไฟล์สำรองแล้ว (${data.counts.bills} บิล)`);
  } catch (e) { if (e.name !== 'AbortError') toast('สำรองไฟล์ไม่สำเร็จ: ' + e.message, true); }
}
async function handleImport(file) {
  if (!file) return;
  if (file.size > 60e6) return toast('ไฟล์ใหญ่เกินไป', true);
  const parsed = B.parseBackup(await file.text());
  if (!parsed.ok) { openSheet(`<h2>นำเข้าไม่ได้</h2><p class="sub">ไฟล์นี้ไม่ถูกต้อง จึงไม่มีข้อมูลใดถูกเปลี่ยน</p>${parsed.errors.map((e) => `<div class="note err">${esc(e)}</div>`).join('')}<button class="btn block" data-act="closesheet">ปิด</button>`); return; }
  const c = parsed.clean;
  const o = openSheet(`<h2>กู้คืนข้อมูลจากไฟล์</h2><p class="sub">สร้างเมื่อ ${esc(fmtDateTime(parsed.exportedAt))} · ${c.bills.length} บิล · ${c.products.length} สินค้า</p>
    <button class="btn primary block" data-x="merge">รวมกับข้อมูลในเครื่อง (แนะนำ)</button><p class="sub" style="margin:4px 0 12px">เพิ่มสิ่งที่ยังไม่มี และใช้รายการที่ใหม่กว่า ไม่ลบข้อมูลเดิม</p>
    <button class="btn danger block" data-x="replace">แทนที่ข้อมูลทั้งหมดในเครื่อง</button><p class="sub" style="margin:4px 0 12px">ลบข้อมูลปัจจุบันแล้วใช้ตามไฟล์ (ระบบจะดาวน์โหลดไฟล์สำรองของข้อมูลปัจจุบันให้ก่อน)</p>
    <button class="btn block" data-x="no">ยกเลิก</button>`);
  o.querySelector('[data-x=no]').onclick = () => closeSheet(o);
  o.querySelector('[data-x=merge]').onclick = async () => { closeSheet(o); await applyImport(parsed, 'merge'); };
  o.querySelector('[data-x=replace]').onclick = async () => {
    closeSheet(o);
    const ok = await confirmDialog({ title: 'แทนที่ข้อมูลทั้งหมด?', body: 'ข้อมูลในเครื่องตอนนี้จะถูกแทนที่ด้วยข้อมูลในไฟล์ และจะดาวน์โหลดไฟล์สำรองของข้อมูลปัจจุบันไว้ให้ก่อน', ok: 'แทนที่ข้อมูล', danger: true });
    if (!ok) return;
    try { const cur = await B.buildBackup(); B.downloadBlob(`justmellow_before_restore_${dayStr()}.json`, new Blob([JSON.stringify(cur)], { type: 'application/json' })); } catch (e) { return toast('สำรองข้อมูลปัจจุบันไม่สำเร็จ จึงไม่แทนที่: ' + e.message, true); }
    await applyImport(parsed, 'replace');
  };
}
async function applyImport(parsed, mode) {
  try {
    const n = await B.applyBackup(parsed, mode);
    await refresh(); updateChrome(); scheduleSync();
    toast(mode === 'replace' ? `กู้คืนแล้ว ${n.bills} บิล` : `รวมข้อมูลแล้ว: เพิ่ม/อัปเดต ${n.bills} บิล, ${n.products} สินค้า (ข้าม ${n.skipped} ที่มีอยู่แล้ว)`);
    render();
  } catch (e) { toast('กู้คืนไม่สำเร็จ: ' + (e.message || e), true); }
}

/* ---------- settings ---------- */
function settings() {
  const s = st.settings;
  return `<label class="field"><span>ชื่อร้าน</span><input type="text" id="s-name" maxlength="40" value="${esc(s.shopName)}"></label>
    <label class="field"><span>รหัสเครื่อง (ไม่บังคับ ใช้ A–Z 0–9 สูงสุด 3 ตัว)</span><input type="text" id="s-dev" maxlength="3" value="${esc(s.deviceCode)}" placeholder="เช่น A"><span style="margin-top:4px">ถ้าใช้หลายเครื่อง ให้ตั้งรหัสไม่ซ้ำกัน เพื่อไม่ให้เลขบิลซ้ำ (มีผลกับบิลใหม่)</span></label>
    <button class="btn primary block" data-act="savesettings">บันทึกการตั้งค่า</button>
    <div class="sec">QR Code รับเงินของร้าน</div>
    <div class="card">${st.qr ? `<div class="qrbox"><img src="${st.qr}" alt="QR Code ของร้าน"></div>` : '<p class="sub">ยังไม่ได้ใส่ภาพ QR (จะแสดงในหน้าชำระเงินแบบ QR Code)</p>'}
      <input type="file" id="qrFile" accept="image/*" data-in="qrfile">${st.qr ? '<button class="btn sm" data-act="rmqr" style="margin-top:8px">ลบภาพ QR</button>' : ''}
      <p class="sub" style="margin-top:8px">ระบบนี้ไม่ได้เชื่อมต่อธนาคาร และไม่ตรวจสอบว่าลูกค้าจ่ายเงินจริง</p></div>
    <div class="sec">ติดตั้งแอปบนหน้าจอมือถือ</div>
    <div class="card">${st.installEvt ? '<button class="btn primary block" data-act="install">ติดตั้งแอป</button>' : ''}
      <p><b>Android (Chrome):</b> เมนู ⋮ → “ติดตั้งแอป” หรือ “เพิ่มลงในหน้าจอหลัก”</p>
      <p><b>iPhone/iPad (Safari เท่านั้น):</b> กดปุ่มแชร์ <b>⬆︎</b> → “เพิ่มไปยังหน้าจอโฮม” → “เพิ่ม”</p>
      <p class="sub">เปิดแอปครั้งแรกขณะมีอินเทอร์เน็ต 1 ครั้ง เพื่อให้เครื่องเก็บไฟล์ไว้ใช้ออฟไลน์</p></div>
    <p class="sub">JUST MELLOW POS v1.0.0 · เก็บเงินเป็นหน่วยสตางค์ภายในระบบ</p>`;
}
function resizeImage(file, max = 640) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/png')); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดไฟล์ภาพไม่ได้')); };
    img.src = url;
  });
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const goEl = e.target.closest('[data-go]'); if (goEl) return go(goEl.dataset.go);
  const el = e.target.closest('[data-act]'); if (!el) return;
  const { act, id, v } = el.dataset;
  try {
    switch (act) {
      case 'back': return go('home');
      case 'closesheet': return closeSheet(el.closest('.overlay'));
      case 'cat': st.cat = v; return renderSellDynamic();
      case 'add': return addToCart(id);
      case 'opencart': st.cartSheet = openSheet(cartSheetHtml()); return;
      case 'inc': { const c = st.cart.get(id) || 0; if (c >= MAX_QTY) return toast(`จำนวนสูงสุด ${MAX_QTY}`, true); st.cart.set(id, c + 1); return refreshCartSheet(); }
      case 'dec': { const c = (st.cart.get(id) || 0) - 1; if (c <= 0) st.cart.delete(id); else st.cart.set(id, c); return refreshCartSheet(); }
      case 'rm': st.cart.delete(id); return refreshCartSheet();
      case 'pay': st.payment = v; return refreshCartSheet();
      case 'clearcart': if (await confirmDialog({ title: 'ล้างรายการขาย?', body: 'สินค้าทั้งหมดในรายการจะถูกเอาออก', ok: 'ล้างรายการ', danger: true })) { st.cart.clear(); st.draftId = null; refreshCartSheet(); } return;
      case 'checkout': return checkout();
      case 'viewbill': { document.querySelectorAll('.overlay[data-receipt]').forEach((x) => x.remove()); return showBill(id); }
      case 'voidbill': return voidFlow(id);
      case 'hrange': st.hist.range = v; if (v === 'custom') { st.hist.from ||= todayStr(); st.hist.to ||= todayStr(); } return render();
      case 'hstatus': st.hist.status = v; return render();
      case 'auditlog': return auditLog();
      case 'rtab': st.rep.tab = v; return render();
      case 'rrange': st.rep.range = v; if (v === 'custom') { st.rep.from ||= todayStr(); st.rep.to ||= todayStr(); } return render();
      case 'export': return doExport(v);
      case 'newprod': return prodForm(null);
      case 'editprod': return prodForm(st.products.find((p) => p.id === id));
      case 'toggleprod': { const p = st.products.find((x) => x.id === id); await S.setProductActive(id, !p.active); await refresh(); render(); scheduleSync(); return; }
      case 'syncnow': return runSync(true);
      case 'cloudlogin': {
        const pass = document.getElementById('cl-pass').value;
        await Sync.saveConfig({ url: document.getElementById('cl-url').value, anonKey: document.getElementById('cl-key').value, email: document.getElementById('cl-mail').value });
        if (!pass) { await refresh(); render(); return toast('บันทึกการตั้งค่าแล้ว — กรอกรหัสผ่านเพื่อเข้าสู่ระบบ', true); }
        await Sync.signIn(pass); document.getElementById('cl-pass').value = '';
        toast('เข้าสู่ระบบออนไลน์แล้ว'); await refresh(); render(); return runSync(true);
      }
      case 'cloudlogout': await Sync.signOut(); await refresh(); render(); return toast('ออกจากระบบออนไลน์แล้ว (ข้อมูลในเครื่องยังอยู่)');
      case 'cloudrestore': {
        if (!(await confirmDialog({ title: 'กู้คืนจากออนไลน์?', body: 'ดึงข้อมูลที่สำรองไว้บนระบบออนไลน์มารวมกับข้อมูลในเครื่อง (ไม่ลบข้อมูลเดิม)', ok: 'กู้คืน' }))) return;
        const r = await Sync.restoreFromCloud(); await refresh(); render(); return toast(`กู้คืนแล้ว: ${r.bills} บิล, ${r.products} สินค้า`);
      }
      case 'exportbackup': return exportBackup(false);
      case 'sharebackup': return exportBackup(true);
      case 'savesettings': {
        const dev = document.getElementById('s-dev').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
        const name = document.getElementById('s-name').value.trim() || 'JUST MELLOW';
        await S.saveSettings({ shopName: name, deviceCode: dev }); await refresh(); render(); return toast('บันทึกการตั้งค่าแล้ว');
      }
      case 'rmqr': await S.delMeta('qrImage'); await refresh(); render(); return;
      case 'install': { const ev = st.installEvt; st.installEvt = null; await ev.prompt(); return render(); }
    }
  } catch (err) { toast(err.message || String(err), true); await onSyncChange().catch(() => {}); }
});

document.addEventListener('input', (e) => {
  const k = e.target.dataset?.in; if (!k) return;
  if (k === 'search') { st.search = e.target.value; renderSellDynamic(); }
  else if (k === 'hq') { st.hist.q = e.target.value; renderHistList(); }
});
document.addEventListener('change', async (e) => {
  const k = e.target.dataset?.in; if (!k) return;
  try {
    if (k === 'hfrom') { st.hist.from = e.target.value; renderHistList(); }
    else if (k === 'hto') { st.hist.to = e.target.value; renderHistList(); }
    else if (k === 'rfrom') { st.rep.from = e.target.value; renderRepBody(); }
    else if (k === 'rto') { st.rep.to = e.target.value; renderRepBody(); }
    else if (k === 'importfile') { const f = e.target.files[0]; e.target.value = ''; await handleImport(f); }
    else if (k === 'qrfile') { const f = e.target.files[0]; if (f) { await S.setMeta('qrImage', await resizeImage(f)); await refresh(); render(); toast('บันทึกภาพ QR แล้ว'); } }
  } catch (err) { toast(err.message || String(err), true); }
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => { updateChrome(); scheduleSync(500); });
window.addEventListener('offline', updateChrome);
window.addEventListener('syncchange', () => { onSyncChange(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); st.installEvt = e; if (route() === 'settings') render(); });
window.addEventListener('error', (e) => toast('เกิดข้อผิดพลาด: ' + (e.message || 'ไม่ทราบสาเหตุ'), true));
window.addEventListener('unhandledrejection', (e) => toast('เกิดข้อผิดพลาด: ' + (e.reason?.message || e.reason || 'ไม่ทราบสาเหตุ'), true));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(800); });

/* ---------- start ---------- */
(async () => {
  try {
    const { persisted } = await S.initStore(); st.persisted = persisted;
    await refresh(); await render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => toast('เปิดโหมดออฟไลน์ไม่สำเร็จ: ' + e.message, true));
    scheduleSync(1500);
    setInterval(() => scheduleSync(0), 5 * 60 * 1000);
    window.__jm = { st, refresh, render }; // handy for testing
  } catch (e) {
    $app.innerHTML = `<main><div class="note err"><b>เปิดแอปไม่สำเร็จ</b><br>${esc(e.message || e)}<br>ถ้าใช้โหมดไม่ระบุตัวตน/ส่วนตัว ให้เปิดเบราว์เซอร์แบบปกติ</div></main>`;
  }
})();
