/* Service Worker — Dulcini Checklist Granel
   Objetivo: o app abre e opera mesmo sem internet. Estratégia:
   - App shell (HTML/ícones/logo) pré-cacheado na instalação.
   - Bibliotecas externas (Tesseract.js, jsPDF, html2canvas, QR, fontes) e os
     recursos do OCR (wasm/idioma) são cacheados em tempo de execução na 1ª vez
     online; depois ficam disponíveis offline.
   Sem backend: não há sincronização remota — a persistência é local (IndexedDB).
*/
const CACHE = 'dulcini-granel-v4';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './Logo_Beija-flor_Transp_.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegação (HTML): rede primeiro (para receber atualizações), com queda para o cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Demais recursos (assets locais + bibliotecas/OCR de CDN): cache primeiro, com
  // cacheamento em tempo de execução do que vier da rede.
  event.respondWith(
    caches.match(req).then((cacheado) => {
      if (cacheado) return cacheado;
      return fetch(req)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
          return resp;
        })
        .catch(() => cacheado);
    })
  );
});
