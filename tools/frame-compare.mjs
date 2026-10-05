// 关卡内三档帧率对拍 + 阴性对照（BRIEF_COS §3/§6 的仓内常驻闸）。
//
// 为什么要自己写而不是只信官方 cos_frame_probe.js：那一棒的沙箱把自己的注入路径喂给了
// 一份 throwaway DOM（querySelector 每次新对象、closest 恒 null），它派了 33 组输入而游戏
// 一个都没接到，于是它的结论停在 `⚪ 未覆盖·静止快照 … ⇒ 需写手自建输入驱动 harness 复验`。
// 简报对这一行的口径很硬：**不算通过**，必须由写手自己的 harness 补判并贴数字。
// 所以这里给的不是"能装载"的最小宿主（那是 tools/loader.mjs 的 baseEnv），而是"能跑起来
// 且注入打得进去"的宿主：具名元素按 index.html 注册（含 hidden 原样）、事件表留在元素上、
// 虚拟时钟与 rAF 队列可推进。
//
// 三条防假绿/假红的口径（都是实测踩过的坑）：
//  ① 时钟从 1000ms 起：从 0 起步，游戏里"第一帧只登记时间源"的哨兵会让 30Hz 比 120Hz 少跑
//     一段 dt，凭空造出帧率依赖。
//  ② 固定 LCG 种子，三档同一条随机流：否则比的是两次不同抽样。
//  ③ 输入只打在 100ms 的整倍数上，并按"第 f 帧结束"的槽位注入而不是按墙钟秒对齐：
//     1000/60 的浮点亏损会让 60Hz 少喂 5e-13 秒，把定步长的东西判红。
//
// 用法：node tools/frame-compare.mjs [虚拟秒数=3]
// 退出码非 0 = 有字段随帧率分叉、或关卡没跑起来、或阴性对照失效（尺子空跑）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ORDER, ROOT } from './loader.mjs';

const SECS = Number(process.argv[2] || 3);
const RATES = [30, 60, 120];
// 判尺口径与官方一致：误差比 = max/min。一阶采样滞后本身就有 ≤3.0 的比值，那是尺的边界；
// 只有 >3.6 才判帧率依赖。
const RATIO_RED = 3.6;
// 阴性对照的靶子：钉在**仍在吃帧 dt** 的那一行（js/anim.js 的 `this.time += dt`），
// 换成常量必须变红。§6 的更正口径：改成累加器之后还去改"每步 dt 恒定"的位移行，
// 结构上就红不了，那种"改不动"不算通过。
const CONTROL = { file: 'js/anim.js', from: 'this.time += dt;', to: 'this.time += 1 / 60;' };
const KEYS = ['state', 'elapsedMs', 'animTime', 'texturesReady', 'pulses', 'moves', 'cuts', 'remaining', 'regions', 'conflicts', 'cursor', 'seed', 'rows', 'cols'];

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
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
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

// 输入排程：三档共用同一张表，槽位都是"第 f 帧末的虚拟毫秒"，且只落在 100ms 整倍数上。
// 方向键移光标、奇数拍带 Shift（画界）、同拍再来一次真 pointerdown/pointerup 打盘面 ——
// 与玩家用的键位表是同一份，不是给测试开后门的路径。
const ARROWS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
const PLAN = new Map();
for (let t = 100; t <= SECS * 1000; t += 100) {
  const i = t / 100;
  PLAN.set(t, [
    { key: ARROWS[i % 4], shift: i % 2 === 1 },
    { tap: true, x: 60 + (i % 6) * 40, y: 60 + ((i >> 1) % 6) * 40 },
  ]);
}

function snapshot(g) {
  const out = {};
  for (const k of KEYS) { const v = g[k]; if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v; }
  return out;
}

function runAt(fps, patch = null) {
  const H = boot(0x2f6e2b1, patch);
  const g = H.env.game;
  if (!g) throw new Error('window.game 没挂上：任何外部量具都读不到状态');
  H.fire(H.env, 'DOMContentLoaded', H.mkEv('DOMContentLoaded'));
  g.start();
  if (g.state !== 'playing') throw new Error(`开局后 state=${g.state}（关卡没跑起来）err=${H.env.__err || ''}`);
  const marks = {};
  const frames = Math.round(SECS * fps);
  for (let f = 1; f <= frames; f++) {
    H.step(fps);
    const ms = Math.round((f * 1000) / fps);
    for (const inp of (PLAN.get(ms) || [])) {
      if (inp.key) {
        H.fire(H.env, 'keydown', H.mkEv('keydown', { key: inp.key, code: inp.key, shiftKey: inp.shift }));
        H.fire(H.env, 'keyup', H.mkEv('keyup', { key: inp.key }));
      } else {
        H.fire(H.board, 'pointerdown', H.mkEv('pointerdown', { clientX: inp.x, clientY: inp.y, pointerType: 'mouse', isPrimary: true }));
        H.fire(H.env, 'pointerup', H.mkEv('pointerup', { clientX: inp.x, clientY: inp.y }));
      }
    }
    if (f % Math.round(fps) === 0) marks[f / Math.round(fps)] = snapshot(g);
  }
  return { snap: snapshot(g), marks, err: H.env.__err || '', keys: H.env.dc ? H.env.dc.keyHits() : null };
}

// 逐字段：误差比 = max/min，>3.6 判红。返回红字段列表。
function compare(rows, label) {
  console.log(`\n=== ${label} · 三档末态逐字段（同一虚拟时长 ${SECS}s）===`);
  console.log('field'.padEnd(11), '30Hz'.padStart(13), '60Hz'.padStart(13), '120Hz'.padStart(13), '  误差比   判定');
  const reds = [];
  for (const k of KEYS) {
    const v = RATES.map((f) => rows[f].snap[k]);
    if (!v.every((x) => typeof x === 'number')) {
      const same = v[0] === v[1] && v[1] === v[2];
      console.log(String(k).padEnd(11), String(v[0]).padStart(13), String(v[1]).padStart(13), String(v[2]).padStart(13), '   -      ', same ? 'equal(str)' : '❌ DIFF(str)');
      if (!same) reds.push(k);
      continue;
    }
    const mx = Math.max(...v), mn = Math.min(...v), spread = mx - mn;
    const ratio = spread === 0 ? 1 : (mn === 0 ? Infinity : mx / mn);
    const verdict = ratio > RATIO_RED ? '❌ 帧率依赖' : spread === 0 ? 'equal' : 'ok';
    if (ratio > RATIO_RED) reds.push(k);
    const fmt = (x) => String(Number.isInteger(x) ? x : x.toFixed(4)).padStart(13);
    console.log(k.padEnd(11), fmt(v[0]), fmt(v[1]), fmt(v[2]),
      `  ${(ratio === Infinity ? 'inf' : ratio.toFixed(4)).padStart(8)}  ${verdict}`);
  }
  return reds;
}

// 时长加证：同一档把 1s 与 SECS 秒的读数比一遍。三档全等但这里也不变 ⇒ §3 的
// `⚪ 未覆盖·静止快照`（探针没把关卡跑起来），必须判失败。
function advancing(rows) {
  console.log('\n=== 时长加证（同档 1s → %ss 变化的字段）===', SECS);
  let minAdv = Infinity;
  for (const fps of RATES) {
    const a = rows[fps].marks[1] || {}, b = rows[fps].marks[SECS] || {};
    const ch = Object.keys(b).filter((k) => typeof b[k] === 'number' && k in a && !Object.is(a[k], b[k]));
    console.log(`  ${String(fps).padStart(3)}Hz 推进 ${ch.length} 字段: ${ch.join(',')}`);
    minAdv = Math.min(minAdv, ch.length);
  }
  return minAdv;
}

const fails = [];
const rows = {};
try {
  for (const fps of RATES) rows[fps] = runAt(fps);
} catch (e) {
  console.error(`❌ 关卡内三档对拍无法开跑：${e.message}`);
  process.exit(1);
}
const reds = compare(rows, '真实源码');
if (reds.length) fails.push(`帧率分叉字段：${reds.join(',')}`);
if (advancing(rows) < 3) fails.push('时长加证不足（关卡没真跑起来 ⇒ 静止快照不算通过）');
if (rows[60].err) fails.push(`运行期报错：${rows[60].err.split('\n')[0]}`);
console.log(`\n注入命中的键数：${JSON.stringify(rows[60].keys && rows[60].keys.by || rows[60].keys)}`);
{
  const H = boot(0x2f6e2b1, null);
  H.fire(H.env, 'DOMContentLoaded', H.mkEv('DOMContentLoaded'));
  const cb = H.board && H.board._h.pointerdown ? H.board._h.pointerdown.length : 0;
  const kd = H.env._h.keydown ? H.env._h.keydown.length : 0;
  console.log(`输入接在册：#board pointerdown=${cb} 个，window keydown=${kd} 个`);
  if (!cb || !kd) fails.push(`注入路径没接线（pointerdown=${cb}, keydown=${kd}）`);
}

// 阴性对照：把 js/anim.js 里仍在吃帧 dt 的那一行换成常量，必须变红。
// 红不了 ⇒ 这把尺是空跑的，本闸的"绿"就没有意义。
console.log(`\n=== 阴性对照：${CONTROL.file} 「${CONTROL.from}」→「${CONTROL.to}」 ===`);
let ctrlReds = [];
try {
  const cut = {};
  for (const fps of RATES) cut[fps] = runAt(fps, CONTROL);
  ctrlReds = compare(cut, `变异体（${CONTROL.from}）`);
} catch (e) {
  fails.push(`阴性对照跑不起来：${e.message}`);
}
if (ctrlReds.length) console.log(`✅ 阴性对照生效：${ctrlReds.join(',')}`);
else fails.push('阴性对照未变红 ⇒ 尺子空跑，绿不可信');

console.log(`\n判定：${fails.length ? '❌ ' + fails.join(' / ') : `✅ 三档逐字段可比（${KEYS.length} 字段，误差比 ≤${RATIO_RED}）且随虚拟时长推进，阴性对照变红`}`);
process.exit(fails.length ? 1 : 0);
