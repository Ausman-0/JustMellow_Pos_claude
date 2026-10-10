// Online backup via Supabase (REST). Local-first: failures never block selling.
// Only the PUBLIC anon key + project URL are used; the login password is never stored.
import * as S from './store.js';
import { validateBill } from './logic.js';

const KINDS = [['bills', 'bill'], ['products', 'product'], ['audit', 'audit']];
const BATCH = 100;
let running = null;

export class SyncError extends Error {}

export const getConfig = () => S.getMeta('cloud', null);
export async function saveConfig({ url, anonKey, email }) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(u)) throw new SyncError('ที่อยู่โปรเจกต์ (Project URL) ไม่ถูกต้อง เช่น https://xxxx.supabase.co');
  if (!anonKey || anonKey.trim().length < 20) throw new SyncError('กรุณาใส่ anon public key');
  if (!/^\S+@\S+\.\S+$/.test(String(email || '').trim())) throw new SyncError('อีเมลไม่ถูกต้อง');
  const cfg = { url: u, anonKey: anonKey.trim(), email: email.trim() };
  await S.setMeta('cloud', cfg);
  return cfg;
}

async function http(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    throw new SyncError(e.name === 'AbortError' ? 'เซิร์ฟเวอร์ตอบช้าเกินไป (หมดเวลา)' : 'เชื่อมต่อไม่ได้ (ไม่มีอินเทอร์เน็ต หรือที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง)');
  } finally { clearTimeout(timer); }
}

async function errText(res) {
  try { const j = await res.json(); return j.msg || j.message || j.error_description || j.error || res.statusText; } catch { return res.statusText || String(res.status); }
}

export async function signIn(password) {
  const cfg = await getConfig();
  if (!cfg) throw new SyncError('ยังไม่ได้ตั้งค่าระบบออนไลน์');
  const res = await http(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password }),
  });
  if (!res.ok) throw new SyncError(res.status === 400 ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : `เข้าสู่ระบบไม่สำเร็จ (${res.status}): ${await errText(res)}`);
  await storeSession(await res.json());
}

async function storeSession(j) {
  await S.setMeta('session', { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, user_id: j.user?.id });
}

export const signOut = () => S.delMeta('session');
export const hasSession = async () => !!(await S.getMeta('session', null));

async function session() {
  const cfg = await getConfig();
  if (!cfg) throw new SyncError('ยังไม่ได้ตั้งค่าระบบออนไลน์');
  let s = await S.getMeta('session', null);
  if (!s) throw new SyncError('ยังไม่ได้เข้าสู่ระบบออนไลน์');
  if (Date.now() > s.expires_at - 60000) {
    const res = await http(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) { await S.delMeta('session'); throw new SyncError('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่'); }
      throw new SyncError('ต่ออายุการเข้าสู่ระบบไม่สำเร็จ ลองใหม่ภายหลัง');
    }
    await storeSession(await res.json());
    s = await S.getMeta('session');
  }
  return { cfg, s };
}

const headers = (cfg, s, extra = {}) => ({ apikey: cfg.anonKey, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', ...extra });

async function setState(patch) {
  const cur = (await S.getMeta('syncState', {})) || {};
  await S.setMeta('syncState', { ...cur, ...patch });
  window.dispatchEvent(new CustomEvent('syncchange'));
}
export const getState = async () => (await S.getMeta('syncState', {})) || {};

/** Upload everything not yet backed up. Safe to call repeatedly: rows are upserted by id (no duplicate bills). */
export function syncNow() {
  if (running) return running;
  running = (async () => {
    const cfg = await getConfig();
    if (!cfg || !(await hasSession())) return { skipped: 'not-configured' };
    if (navigator.onLine === false) { await setState({ offline: true }); return { skipped: 'offline' }; }
    await setState({ syncing: true, offline: false });
    let pushed = 0;
    try {
      const { s } = await session();
      for (const [storeName, kind] of KINDS) {
        const dirty = await S.listDirty(storeName);
        for (let i = 0; i < dirty.length; i += BATCH) {
          const chunk = dirty.slice(i, i + BATCH);
          const rows = chunk.map(({ dirty: _d, ...payload }) => ({ user_id: s.user_id, kind, rec_id: payload.id, payload, updated_at: payload.updatedAt }));
          const res = await http(`${cfg.url}/rest/v1/mellow_records?on_conflict=user_id,kind,rec_id`, {
            method: 'POST', headers: headers(cfg, s, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows),
          }, 30000);
          if (!res.ok) {
            const msg = await errText(res);
            if (res.status === 401) { await S.delMeta('session'); throw new SyncError('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่'); }
            if (res.status === 404 || /mellow_records/.test(msg)) throw new SyncError('ไม่พบตาราง mellow_records บน Supabase — ต้องรันไฟล์ supabase/setup.sql ก่อน');
            throw new SyncError(`สำรองข้อมูลไม่สำเร็จ (${res.status}): ${msg}`);
          }
          for (const r of chunk) await S.markSynced(storeName, r);
          pushed += chunk.length;
        }
      }
      await setState({ syncing: false, lastSuccessAt: new Date().toISOString(), lastError: null, offline: false });
      return { pushed };
    } catch (e) {
      await setState({ syncing: false, lastError: e.message || String(e), lastErrorAt: new Date().toISOString() });
      throw e;
    }
  })().finally(() => { running = null; });
  return running;
}

/** Download everything from the cloud and merge (newer wins). Used when reinstalling or changing phone. */
export async function restoreFromCloud() {
  if (navigator.onLine === false) throw new SyncError('ไม่มีอินเทอร์เน็ต');
  const { cfg, s } = await session();
  const got = { products: [], bills: [], audit: [] };
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await http(`${cfg.url}/rest/v1/mellow_records?select=kind,rec_id,payload&order=updated_at.asc&limit=${PAGE}&offset=${offset}`, { headers: headers(cfg, s) }, 30000);
    if (!res.ok) throw new SyncError(`ดึงข้อมูลไม่สำเร็จ (${res.status}): ${await errText(res)}`);
    const rows = await res.json();
    for (const r of rows) {
      if (r.kind === 'bill') got.bills.push(r.payload);
      else if (r.kind === 'product') got.products.push(r.payload);
      else if (r.kind === 'audit') got.audit.push(r.payload);
    }
    if (rows.length < PAGE) break;
  }
  const { clean, errors } = S.cleanRecords(got);
  if (errors.length) throw new SyncError(`ข้อมูลออนไลน์บางรายการไม่ถูกต้อง (${errors.length}) จึงไม่นำเข้า: ${errors[0]}`);
  const counts = await S.mergeRecords(clean, 0);
  await S.rebuildSequences();
  await S.logEvent('restore_cloud', { detail: `${counts.bills} บิล, ${counts.products} สินค้า` });
  return { ...counts, fetched: got.bills.length + got.products.length + got.audit.length };
}
