'use strict';
// service worker 注册：独立成一份文件（不是 index.html 里的内联块）。
//
// 为什么不能内联：部署集闸（tools/deploy-set.mjs）的引用走查是**从 index.html 的每一站
// script 出发**的——它扫 .js/.css 里的 serviceWorker.register / scope / './' 字面量，
// 把"页面会去要的东西"逐条对到部署产物上。HTML 那一边只看 href/src，内联块里的
// register 抓不到 ⇒ sw.js 悄悄不在闸的视野里 ⇒ "忘了把 sw.js 拷进产物"这一类坏法
// 就又从缝里漏过去了（闸自己防的就是这一条）。注册脚本作为独立一站，闸才量得到它。
//
// 三条口径：
//  * file:// 下**整段跳过**且不抛未捕获异常——这一仓要能被直接双击 index.html 打开玩，
//    而 navigator.serviceWorker 在那种上下文里 register 会 reject 一个 SecurityError。
//  * scope 显式取当前目录：Pages 把本站挂在 /z-biz-game-doublechoco-cos/ 下，
//    不写 scope 会拿到根作用域然后注册失败（本地根形态与线上前缀形态因此走同一条代码）。
//  * 注册失败只 warn：断网、隐私模式、上级页面禁止 SW 都不该让一盘能玩的题变成白屏。
window.dcSW = { state: 'skipped', why: '' };
if (location.protocol === 'https:' || /^http:$/i.test(location.protocol)) {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .then((reg) => { window.dcSW = { state: 'registered', why: reg.scope }; })
        .catch((err) => {
          window.dcSW = { state: 'failed', why: String(err && err.message || err) };
          console.warn('sw register skipped:', err && err.message);
        });
    });
  } else {
    window.dcSW = { state: 'unsupported', why: 'navigator.serviceWorker' };
  }
} else {
  window.dcSW = { state: 'skipped', why: location.protocol };
}
