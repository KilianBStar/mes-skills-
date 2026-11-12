// Service worker : garde l'application en cache pour l'ouvrir sans réseau.
// Les adresses, itinéraires et fonds de carte passent toujours par le réseau.
const CACHE = 'cap-colis-v11';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'optimizer.js', 'scan.js', 'postcodes-be.js', 'manifest.webmanifest',
  'icon.svg', 'favicon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js',
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css'];
// Bibliothèques gardées après leur premier usage (lecture des photos hors ligne ensuite).
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // Réseau d'abord pour recevoir les mises à jour, cache en secours.
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else if (LIB_HOSTS.includes(url.hostname)) {
    // Versions figées : le cache suffit.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
  }
});
