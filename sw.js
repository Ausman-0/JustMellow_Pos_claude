// Service worker: caches the app files so the POS opens and sells with no internet.
// Strategy: stale-while-revalidate for same-origin GET requests (opens instantly offline; picks up updates next launch).
const CACHE = 'jm-pos-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/main.js', './js/db.js', './js/store.js', './js/logic.js', './js/reports.js', './js/csv.js', './js/exports.js', './js/backup.js', './js/sync.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Supabase / other sites
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const refresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(refresh); return cached; }
    const res = await refresh;
    if (res) return res;
    if (req.mode === 'navigate') { const shell = await cache.match('./index.html'); if (shell) return shell; }
    return new Response('ออฟไลน์ และยังไม่มีไฟล์นี้ในเครื่อง', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
