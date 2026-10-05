// node 侧的装载器：js/ 里那 15 份是 classic script（index.html 按依赖拓扑序挂 15 个 script 标签，
// 官方量具也按同一个顺序读），而 node 里没有"把一份 script 的顶层词法绑定交出来"的原生形状——
// 顶层 const/class 不挂到 global 对象上。所以这里做两件事：
//  ① 按给定顺序在同一份 vm context 里跑完这些文件（classic script 之间共享 global lexical scope，
//     与浏览器里的行为一致）；
//  ② 再用一份只读表达式把顶层名字取出来。名字是从源码的顶层声明里扫的，不是抄的清单——
//     抄的清单会在新加一个模块时悄悄漏掉它，而漏掉的模块在测试里是 undefined，不是红。
// 依赖顺序在这里是硬要求：classic script 没有 import 声明顺序，被引用的名字在被引用文件
// **执行之前**必须已经初始化，所以这一份顺序与 index.html 里的标签顺序必须一致（下面的
// ORDER 就是从 index.html 里读出来的，不是另一份手抄）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

// 装载顺序只有一个来源：index.html 里那串 script src（文档顺序 = 依赖拓扑序）。
export const ORDER = (() => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  if (!srcs.length) throw new Error('index.html 里一个 script src 都没有，装载顺序无从取得');
  return srcs;
})();

const DECL = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/;
// 顶层声明名：只认第 0 列缩进的声明（模块内部一律是 0 列），与转换成 classic script 时用的同一条尺。
const topLevelNames = (src) => src.split('\n').map((L) => DECL.exec(L)?.[1]).filter(Boolean);

// 一个 harness 只需要 stub 它自己要碰到的那几件宿主东西；这里给的是"能加载完 15 份而不炸"的最小集。
function baseEnv(extra = {}) {
  const store = new Map();
  const noop = () => {};
  const param = () => ({ value: 1, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, setTargetAtTime: noop, cancelScheduledValues: noop, cancelAndHoldAtTime: noop });
  const node = (x = {}) => ({ connect: (d) => d, disconnect: noop, ...x });
  const el = () => ({ hidden: false, textContent: '', innerHTML: '', dataset: {}, style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' }, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: noop, addEventListener: noop, focus: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), getContext: () => new Proxy({}, { get: (o, k) => (k === 'canvas' ? { width: 800, height: 600 } : (o[k] !== undefined ? o[k] : noop)), set: (o, k, v) => { o[k] = v; return true; } }) });
  const doc = {
    _h: {}, documentElement: el(), body: el(), title: '', hidden: false,
    getElementById: () => null, querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener: noop, removeEventListener: noop,
  };
  const env = {
    console: { log: noop, warn: noop, error: noop }, document: doc,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    setTimeout: noop, setInterval: noop, clearTimeout: noop, clearInterval: noop,
    performance: { now: () => 0, timeOrigin: 0 },
    addEventListener: noop, removeEventListener: noop,
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    location: { href: 'http://localhost/', protocol: 'http:', hash: '' },
    navigator: { userAgent: 'node-loader', maxTouchPoints: 0 },
    history: { replaceState: noop, pushState: noop },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    AudioContext: function () {
      return { state: 'running', currentTime: 0, sampleRate: 44100, destination: node(),
        createOscillator: () => node({ frequency: param(), type: 'sine', start: noop, stop: noop }),
        createGain: () => node({ gain: param() }), createBiquadFilter: () => node({ frequency: param(), Q: param(), type: 'lowpass' }),
        createBufferSource: () => node({ start: noop, stop: noop, playbackRate: param() }),
        createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
        createBuffer: () => ({ getChannelData: () => new Float32Array(1024) }),
        resume: () => Promise.resolve(), suspend: () => Promise.resolve(), close: () => Promise.resolve() };
    },
    CustomEvent: function () {}, Event: function () {}, Image: function () { return { addEventListener: noop }; },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), alert: noop, confirm: () => false,
    OffscreenCanvas: function () { return { getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }; },
    Math: globalThis.Math,
  };
  for (const k of ['JSON', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Number', 'Array', 'Object', 'String', 'Boolean', 'Error',
    'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'RegExp', 'Function', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'Symbol', 'DataView', 'ArrayBuffer', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array',
    'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'TextDecoder', 'TextEncoder', 'URL', 'structuredClone']) {
    if (globalThis[k] !== undefined) env[k] = globalThis[k];
  }
  env.window = env; env.global = env; env.self = env; env.globalThis = env;
  return { env: Object.assign(env, extra), doc };
}

// files 可以是 ORDER 的子集（引擎那几份不需要 DOM），但**顺序**照给定的来；
// patch = { file, from, to }：把某一份源码里的某一行换掉再装载——§6 的阴性对照靠它，
// 而"改完真装载一遍"与"读一遍文本正则匹配"是两回事：后者量不到改动在运行期造成的分叉。
export function loadGame({ files = ORDER, env: extraEnv = {}, patch = null, seed = 0x2f6e2b1 } = {}) {
  const { env, doc } = baseEnv(extraEnv);
  let rs = seed >>> 0;
  env.Math = new Proxy(globalThis.Math, {
    get: (o, k) => (k === 'random' ? () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; } : o[k]),
  });
  const ctx = vm.createContext(env);
  const names = new Set();
  for (const rel of files) {
    let src = readFileSync(join(ROOT, rel), 'utf8');
    if (patch && rel.includes(patch.file)) src = src.replace(patch.from, patch.to);
    for (const n of topLevelNames(src)) names.add(n);
    vm.runInContext(src, ctx, { filename: rel });
  }
  const expr = `({${[...names].map((n) => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(',')}})`;
  return { ctx, env, doc, exports: vm.runInContext(expr, ctx, { filename: 'harness-readback' }) };
}
