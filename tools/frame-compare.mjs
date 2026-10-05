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
import { boot, ROOT } from './app-host.mjs';

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
