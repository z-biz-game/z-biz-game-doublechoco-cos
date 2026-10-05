// 一份"跑得起来且注入打得进去"的 DOM 宿主：main.js 在 node 里真跑，虚拟时钟与 rAF 可推进。
//
// 为什么从 tools/frame-compare.mjs 抽出来单独一份：三档帧率对拍需要它，重开复位的断言也需要它，
// 而 tools/behavior-test.mjs 原先故意不装 main.js（"它要真 DOM 与真窗口"）。那一句话在有了
// 这份宿主之后就不成立了——关卡内状态的复位（时钟、anim 缓冲、光标、hover 强调、胜局遮罩）
// 是纯状态命题，能在这份宿主里判，不该只在作者机器上的浏览器腿里判。
//
// 三条防假绿/假红的口径（都是实测踩过的坑，逐条留在下面的代码里）：
//  ① 时钟从 1000ms 起；② 固定 LCG 种子，三档同一条随机流；③ 元素桩的 style 要被
//     js/theme.js 的 applyThemeVars 真写（this 绑错就会在装载第一帧抛）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ORDER, ROOT } from './loader.mjs';

const noop = () => {};
function mkCtx(canvas) {
  // pattern 对象要接得住 setTransform(dpr 校准那一步)，否则画布的纹理分支在沙箱里根本走不到。
  const grad = { addColorStop: noop, setTransform: noop };
  return new Proxy({}, {
    get: (o, k) => {
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return o[k] !== undefined ? o[k] : noop;
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
}

// 元素桩：够 js/main.js 与 BoardView 在 node 里真跑；hidden 如实反映，因为 blocked()
// 一度把它当唯一的 DOM 状态源（读不到真 DOM 时注入会被整片丢掉）。
class El {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this._h = {}; this.dataset = {};
    // style 要被 theme.js 的 `document.documentElement.style.setProperty` 用到：
    // 写成方法里的 `this.style[k]=v` 时 this 绑的是 style 自己（恒 undefined），装载第一帧就抛。
    const style = {
      setProperty(k, v) { style[k] = String(v); },
      removeProperty(k) { delete style[k]; },
      getPropertyValue(k) { return style[k] || ''; },
    };
    this.style = style;
    this.children = []; this.textContent = ''; this.innerHTML = ''; this.value = '0';
    this.width = 800; this.height = 600; this.clientWidth = 800; this.clientHeight = 600;
    this.disabled = false; this.hidden = false; this._cls = new Set(); this._attr = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !this._cls.has(c) : !!on; v ? this._cls.add(c) : this._cls.delete(c); return v; },
    };
    const canvas = this;
    this.getContext = () => (this._ctx || (this._ctx = mkCtx(canvas)));
  }
  addEventListener(t, cb) { (this._h[t] = this._h[t] || []).push(cb); }
  removeEventListener(t, cb) { this._h[t] = (this._h[t] || []).filter((f) => f !== cb); }
  setAttribute(k, v) { this._attr[k] = String(v); if (k === 'hidden') this.hidden = v === '' || v === true; }
  getAttribute(k) { return this._attr[k] ?? null; }
  removeAttribute(k) { delete this._attr[k]; if (k === 'hidden') this.hidden = false; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  insertBefore(c) { return this.appendChild(c); }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  focus() {} blur() {}
  // 浏览器报的是**布局之后的 CSS 尺寸**：board.js 的 resize() 会写下 style.width/height，
  // 而落点换算正拿 rect 当分母。恒返回 800×600 的桩等于给 harness 一个假坐标系——
  // 同一根指针在真假桩下会命中不同的段，量出来的"点不中"是桩的毛病不是产品的。
  getBoundingClientRect() {
    const px = (v, fb) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : fb; };
    const width = px(this.style.width, 800), height = px(this.style.height, 600);
    return { left: 0, top: 0, right: width, bottom: height, width, height };
  }
  requestFullscreen() { return Promise.resolve(); }
}

function boot(seed, patch) {
  let rs = seed >>> 0;
  const lcg = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const els = new Map();
  for (const m of html.matchAll(/<[a-z]+[^>]*\bid=["']([^"']+)["'][^>]*>/gi)) {
    const tag = /<(a|button|canvas|div|input|p|section|span|ul|li|h\d)/i.exec(m[0]);
    const e = new El(tag ? tag[1] : 'div', m[1]);
    e.hidden = /\bhidden\b/i.test(m[0]);
    els.set(m[1], e);
  }
  let clock = 1000, pending = [], timers = [], tid = 1;
  const doc = {
    _h: {},
    getElementById: (i) => els.get(i) || null,
    querySelector: (sel) => { const m = /^#([\w-]+)$/.exec(sel || ''); return m ? els.get(m[1]) || null : null; },
    querySelectorAll: () => [],
    createElement: (t) => new El(t),
    body: new El('body'), documentElement: new El('html'),
    title: '', hidden: false, fullscreenElement: null, webkitFullscreenElement: null,
    addEventListener(t, cb) { (doc._h[t] = doc._h[t] || []).push(cb); },
    removeEventListener(t, cb) { doc._h[t] = (doc._h[t] || []).filter((f) => f !== cb); },
  };
  const env = {
    console: { log: noop, warn: noop, error: noop }, document: doc,
    requestAnimationFrame: (cb) => { pending.push(cb); return pending.length; }, cancelAnimationFrame: noop,
    setTimeout(cb, ms) { const id = tid++; timers.push({ at: clock + Math.max(0, Number(ms) || 0), cb, id }); return id; },
    setInterval(cb, ms) { const iv = Math.max(1, Number(ms) || 1), id = tid++; timers.push({ at: clock + iv, cb, id, iv }); return id; },
    clearTimeout(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    clearInterval(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    performance: { now: () => clock, timeOrigin: 1000 },
    Date: class D { constructor(t) { this._t = t === undefined ? clock : t; } static now() { return clock; } getTime() { return this._t; } },
    addEventListener(t, cb) { (env._h[t] = env._h[t] || []).push(cb); },
    removeEventListener(t, cb) { env._h[t] = (env._h[t] || []).filter((f) => f !== cb); },
    _h: {},
    AudioContext: function () {
      const param = () => ({ value: 1, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, setTargetAtTime: noop, cancelScheduledValues: noop, cancelAndHoldAtTime: noop });
      const node = (x = {}) => ({ connect: (d) => d, disconnect: noop, ...x });
      return {
        state: 'running', currentTime: 0, sampleRate: 44100, destination: node(),
        createOscillator: () => { env.__osc = (env.__osc || 0) + 1; return node({ frequency: param(), type: 'sine', start: noop, stop: noop }); },
        createGain: () => node({ gain: param() }),
        createBiquadFilter: () => node({ frequency: param(), Q: param(), type: 'lowpass' }),
        createBufferSource: () => node({ start: noop, stop: noop, playbackRate: param() }),
        createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
        createBuffer: () => ({ getChannelData: () => new Float32Array(1024) }),
        resume: () => Promise.resolve(), suspend: () => Promise.resolve(), close: () => Promise.resolve(),
      };
    },
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    location: { href: 'file:///index.html', protocol: 'file:', hash: '' },
    navigator: { userAgent: 'frame-compare', maxTouchPoints: 0 },
    history: { replaceState: noop, pushState: noop },
    localStorage: { _s: new Map(), getItem(k) { return this._s.has(k) ? this._s.get(k) : null; }, setItem(k, v) { this._s.set(k, String(v)); }, removeItem(k) { this._s.delete(k); } },
    CustomEvent: function (t, o) { Object.assign(this, o || {}, { type: t }); },
    Event: function (t) { this.type = t; },
    // 图在下一拍就绪（两张纹理各 256×256）：画布的 pattern 分支必须真的在 30/60/120Hz
    // 对跑里被执行过，否则量的是"没有底纹"的那条路径，纹理改了物理也看不见。
    Image: function () {
      const im = { width: 256, height: 256, _h: {}, onload: null, onerror: null,
        addEventListener(t, cb) { (im._h[t] = im._h[t] || []).push(cb); } };
      env.setTimeout(() => {
        for (const cb of (im._h.load || [])) cb();
        if (im.onload) im.onload();
      }, 0);
      return im;
    },
    DOMMatrix: function () { this.scale = () => this; },
    URL: globalThis.URL,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    alert: noop, confirm: () => false,
    OffscreenCanvas: function () { return { getContext: () => mkCtx(null) }; },
    Math: new Proxy(globalThis.Math, { get: (o, k) => (k === 'random' ? lcg : o[k]) }),
  };
  for (const k of ['JSON', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Number', 'Array', 'Object', 'String', 'Boolean', 'Error',
    'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'RegExp', 'Function', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'Symbol', 'DataView', 'ArrayBuffer', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array',
    'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'TextDecoder', 'TextEncoder', 'URL', 'structuredClone']) {
    if (globalThis[k] !== undefined) env[k] = globalThis[k];
  }
  env.window = env; env.global = env; env.self = env; env.globalThis = env;
  const ctx = vm.createContext(env);
  // 装载顺序只有一个来源（loader.ORDER ← index.html 的 script src），内联块照文档顺序执行，
  // 与浏览器同一形状；patch 只换 CONTROL 指定的那一行。
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = (/src\s*=\s*["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (!src) { if ((m[2] || '').trim()) vm.runInContext(m[2], ctx, { filename: 'inline' }); continue; }
    const rel = src.replace(/^\.\//, '');
    if (!ORDER.includes(rel)) continue;
    let code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (patch && rel.includes(patch.file)) code = code.replace(patch.from, patch.to);
    vm.runInContext(code, ctx, { filename: rel });
  }
  const fire = (target, type, ev) => {
    const hs = target && target._h && target._h[type];
    if (!hs || !hs.length) return 0;
    ev.target = ev.target || target; ev.currentTarget = target;
    for (const cb of [...hs]) { try { cb(ev); } catch (e) { env.__err = String(e && e.stack || e); } }
    return hs.length;
  };
  const mkEv = (type, x = {}) => ({ type, preventDefault: noop, stopPropagation: noop, button: 0, buttons: 1, pointers: [], ...x });
  const step = (fps) => {
    clock += 1000 / fps;
    for (const t of [...timers]) if (!t.dead && t.at <= clock) { if (t.iv) t.at = clock + t.iv; else t.dead = true; try { t.cb(); } catch (e) {} }
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].dead) timers.splice(i, 1);
    const batch = pending; pending = [];
    for (const cb of batch) { try { cb(clock); } catch (e) { env.__err = String(e && e.stack || e); } }
  };
  return { env, clock: () => clock, step, fire, mkEv, board: els.get('board'), hits: (el, t) => !!(el && el._h && el._h[t] && el._h[t].length) };
}
export { boot, El, mkCtx, ROOT };
