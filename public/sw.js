// The production build supplies every chunk, including screens loaded by dynamic import.
importScripts("/sw-assets.js");
const { cache: CACHE, assets } = self.padSyncBuild;
const SHELL = ["/", "/notebook", "/import", "/settings", "/pencil-test", "/pencil-lab"];
const APP_METADATA = ["/manifest.webmanifest", "/icon", "/apple-icon"];
const OFFLINE_FILES = [...SHELL, ...APP_METADATA, ...assets];

self.addEventListener("install", event => {
  // addAll is atomic. A failed update leaves the previous installed app usable.
  event.waitUntil(caches.open(CACHE).then(cache =>
    cache.addAll(OFFLINE_FILES.map(url => new Request(url, { cache: "reload" }))),
  ));
});

self.addEventListener("activate", event => {
  // Let open notebooks finish using their build before retiring its chunks.
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && (key === "padsync-v2" || key.startsWith("padsync-build-"))) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const page = req.mode === "navigate" && SHELL.includes(url.pathname);
  if (!page && !APP_METADATA.includes(url.pathname) && !url.pathname.startsWith("/_next/static/")) return;
  // Notebook ids and deployment query parameters share the same static shell or hashed file.
  // Restrict the lookup to this build so HTML and its JavaScript change together.
  event.respondWith((async () => {
    const cached = await caches.open(CACHE)
      .then(cache => cache.match(url.pathname, { ignoreVary: true }))
      .catch(() => undefined);
    return cached || fetch(req);
  })());
});
