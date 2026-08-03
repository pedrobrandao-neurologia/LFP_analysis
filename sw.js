/* Service worker — app shell sempre atualizado.
   Estratégia: NETWORK-FIRST para o HTML (garante que novas versões — novas
   figuras, correções — apareçam assim que publicadas), com queda para o cache
   quando offline; CACHE-FIRST para os demais recursos (ícones, manifest).
   Nenhuma requisição carrega dados do paciente: o app é 100% local. */
const CACHE = 'percept-lfp-studio-v11';
const ASSETS = ['./', './index.html', './manifest.webmanifest',
                './icon-192.png', './icon-512.png', './icon-1024.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    /* network-first: sempre tenta a versão mais nova do app; se estiver
       offline, serve o index.html cacheado. */
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
        }
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  /* demais recursos: cache-first */
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
