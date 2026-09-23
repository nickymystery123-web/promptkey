/* PromptKey Float — Service Worker
   策略：静态资源 cache-first，API 请求 network-first（保证 AI 调用实时性） */

const CACHE_NAME = "promptkey-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/css/float.css",
  "/src/main.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// install：预缓存核心静态资源
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// activate：清理旧缓存
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// fetch：静态资源 cache-first，API network-first
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API 请求：始终走网络（AI 调用不能缓存）
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 静态资源：缓存优先，回退网络
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // 同源响应才缓存
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
