// DOUBLE CHOCO 的离线壳。三条口径是这一份文件存在的全部理由：
//
// 1) cache 名带版本号（VERSION）：装了新 HTML 却还吃着旧 JS 的鬼状态，比没有离线更糟。
// 2) **同源子资源一律网络优先、失败退缓存**。手工 VERSION + cache-first 会把 js/css
//    永久钉死在第一次装上的那一版——这一仓是零构建静态站，js/ 下十几个模块各自带
//    import，cache-first 的结果就是"改了代码但线上永远不变"。
// 3) 只接管同源 GET。跨源（字体、CDN）一律放行不写档：把别人的响应存进自己的 cache
//    等于替别人做一份会过期的副本。
//
// file:// 下这一份根本不会被注册（注册代码在 index.html 的内联脚本里，那里判 protocol），
// 所以本地双击 index.html 打开也玩得起来，只是没有离线。

const VERSION = 'doublechoco-v1.0.0';
const CACHE = `${VERSION}-shell`;

// 装 shell 时逐条 add 而不是一条 addAll：addAll 是全有或全无，任何一张图标路径
// 在 Pages 的前缀形态下漂了一位，整份 SW 就 install 失败，而失败在页面上是看不见的。
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './js/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-1024.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE && name.startsWith('doublechoco-')) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function sameOriginGet(req, url) {
  return req.method === 'GET' && url.origin === self.location.origin;
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (!sameOriginGet(req, url)) return;

  // 导航（含"离线打开已装过的站点"）：网络优先，退到 shell 里那份 index.html。
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // 同源子资源：网络优先，失败退缓存，并且只写同源响应。
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const stale = await cache.match(req);
      // 命不中就交回网络错误：静默造一个 200 空响应会让"这个模块加载失败了"
      // 变成一条永远查不出来的错（js/ 是 type=module 的，空响应只表现为一个不报红的白屏）。
      return stale || Response.error();
    }
  })());
});
