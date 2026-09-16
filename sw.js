/* ma offline service worker.
   Shell (html/js/css/keyhint/manifest): network-first, cached fallback → app itself works offline.
   data/artists/*.enc: cache-only — served offline ONLY if the user downloaded them (⤓);
   never auto-cached (storage quota + explicit user intent). */
const SHELL = "ma-shell-v1", OFF = "ma-off";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(n => n.startsWith("ma-shell") && n !== SHELL)
    .map(n => caches.delete(n)));
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  const isMedia = u.pathname.includes("/data/") && !u.pathname.endsWith("manifest.enc");
  if (isMedia) {
    e.respondWith(caches.open(OFF).then(c => c.match(req)).then(r => r || fetch(req)));
  } else {
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(SHELL).then(c => c.put(req, cp)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then(r => r || Response.error()))
    );
  }
});
