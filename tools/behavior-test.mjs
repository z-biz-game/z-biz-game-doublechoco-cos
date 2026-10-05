// 行为层的 node 侧闸：暂停 / 真静音 / dt 包络 / 坏档 四组。
//
// 为什么这批断言不放浏览器那一腿（tools/scenarios.js）：那六条腿只在主编机器上跑，
// 而这个仓承诺的四件事（暂停冻计时、静音挂上下文、包络只吃 dt、坏档只丢那一条）
// 全都是**纯状态**的命题，不需要像素就能判。把它们放在能一行 `npm test` 跑到的地方，
// 改动者当场就能知道自己碰坏了哪一件。
//
// 第 2 组带一条阴性对照（§6）：把 anim.js 里"仍在吃帧 dt 的那一行"改成常量，
// 这一条必须变红。不变红的对拍只是两台机器各跑一遍，算不上钉住帧率无关。
//
// 用法: node tools/behavior-test.mjs

import { readFileSync } from 'node:fs';
import { loadGame, ORDER } from './loader.mjs';
import { boot } from './app-host.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => join(HERE, '..', rel);

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const head = (s) => console.log(`\n${s}`);

// ---- 桩：localStorage 与 AudioContext 要在装载之前就交给那份 window ----
// js/store.js 与 js/audio/synth.js 的顶层就用到了它们，而 classic script 是在 vm 的那份
// window 上跑的——往 node 的 globalThis 上挂一份，模块读不到（挂晚了也是同一个结果）。
const localStorageStub = {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); },
};

let acMade = 0;
let oscMade = 0;
class FakeCtx {
  constructor() { acMade++; this.state = 'running'; this.currentTime = 0; this.destination = { connect() {} }; }
  // AudioParam 的方法一个都不能省：synth.js 的包络走 setValueAtTime + 两次
  // exponentialRampToValueAtTime，桩里少一个就是"闸把自己的被测代码撞抛"，不是缺陷证据。
  createGain() {
    return {
      gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(d) { return d; }, disconnect() {},
    };
  }
  createOscillator() {
    oscMade++;
    return {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(d) { return d; },
      start() {},
      stop() {},
    };
  }
  // 真上下文里 suspend/resume 是异步的，这里同步改状态：判的是"有没有被叫到、叫什么状态"。
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const audioStub = FakeCtx;

// 装载走 tools/loader.mjs：与浏览器同一份形状（classic script + index.html 的文档顺序），
// 只把 main.js 那一腿留在外面——它要真 DOM 与真窗口，那是 tools/scenarios.js 在浏览器里判的事。
const load = (extra = {}) => loadGame({
  files: extra.files || ORDER.filter((f) => !f.endsWith('main.js')),
  env: { localStorage: extra.store || localStorageStub, AudioContext: audioStub },
  patch: extra.patch,
});
const BASE = load().exports;
const { Session, Anim, PULSE_SEC, Sound, Store, tierFor } = BASE;

// ============================================================ 1. 一局只有一个时间源
head('1. Session：暂停期间计时逐毫秒冻住（js/session.js 是唯一的时间源）');
{
  let t = 1000;                     // 从 1000ms 起步：0 会与"没在跑"的哨兵撞车
  const ses = new Session(() => t);
  ses.start(0);
  t += 2500;
  ok('开一局 2.5s 后 elapsed=2500', ses.elapsed() === 2500 && ses.running(), `${ses.elapsed()}`);
  ses.pause();
  const frozen = ses.elapsed();
  t += 9000;                        // 玩家离开很久
  ok('暂停之后 elapsed 一动不动', ses.elapsed() === frozen && frozen === 2500, `${frozen}→${ses.elapsed()}`);
  ok('暂停中 running() 为假、paused 为真', ses.running() === false && ses.paused === true);
  t += 400;
  ok('恢复从冻住那一格接着走（不补暂停那段）', ses.resume() === true && ses.elapsed() === 2500, `${ses.elapsed()}`);
  t += 400;
  ok('恢复之后按这一格接着走表', ses.elapsed() === 2900 && ses.running(), `${ses.elapsed()}`);
  const settled = ses.stop();
  t += 5000;
  ok('停表之后读数恒定', ses.elapsed() === settled && settled === 2900, `${ses.elapsed()}`);
  ses.reset();
  ok('reset 之后 base 与 paused 一起归零', ses.elapsed() === 0 && ses.base === 0 && ses.paused === false);
  const ses2 = new Session(() => t);
  ses2.start(60000);
  ok('续局带着存档里的耗时起步', ses2.elapsed() === 60000 && ses2.running(), `${ses2.elapsed()}`);
  ok('没在跑的时候 pause() 不承认（返回 false）', new Session(() => t).pause() === false);
}

// ============================================================ 2. 帧率对拍 + 阴性对照
head('2. Anim：同一虚拟时长在 30/60/120Hz 上算出同一个数（§3 的 node 侧对拍）');

// 一台假帧源：每一帧的时间戳取 1000 + i*step，所以三档在 100ms 的整数倍上**精确同一时刻**
// ——注入时刻的相位差是尺自己的误差，不许记到游戏账上。
function runFrames(Ctor, fps, msTotal, { reduced = false, life = PULSE_SEC } = {}) {
  const a = new Ctor({ reduced: () => reduced });
  const stepMs = 1000 / fps;
  a.step(1000);                                   // 首帧只登记时间源，不产生 dt
  a.add('pulse', { seg: 3, color: '#ffffff', life });
  const seen = {};
  let deathMs = null;
  for (let i = 1; i * stepMs <= msTotal + 1e-9; i++) {
    a.step(1000 + i * stepMs);
    const it = a.first();
    const at = Math.round(i * stepMs);
    if (!it && deathMs === null) deathMs = at;
    if (at % 100 === 0 && seen[at] === undefined) seen[at] = { alpha: a.alpha(it), time: a.state().time };
  }
  return { fps, seen, deathMs };
}

// 三档逐时刻取最大跨度：帧率无关 ⇒ 跨度只有浮点噪声。
function spread(runs, key) {
  const marks = Object.keys(runs[0].seen).map(Number).filter((m) => runs.every((r) => r.seen[m]));
  let worst = 0;
  let where = 0;
  for (const m of marks) {
    const vs = runs.map((r) => r.seen[m][key]);
    const d = Math.max(...vs) - Math.min(...vs);
    if (d > worst) { worst = d; where = m; }
  }
  return { worst, where };
}

const RATES = [30, 60, 120];
const pristine = RATES.map((f) => runFrames(Anim, f, 2400));
const spA = spread(pristine, 'alpha');
const spT = spread(pristine, 'time');
ok(`包络 alpha 三档一致（最大跨度 ${spA.worst.toExponential(1)} @${spA.where}ms）`, spA.worst < 1e-6);
ok(`累计时钟 time 三档一致（最大跨度 ${spT.worst.toExponential(1)} @${spT.where}ms）`, spT.worst < 1e-6);
// 退场时刻只许带**一帧**的量化误差：帧率无关说的是"包络算出同一个数"（上面两条跨度），
// 而"第几帧第一次发现它没了"必然是该档帧距的整数倍——30Hz 的 1600ms 边界落在浮点噪声里，
// 就会晚一帧。把这条写成死等号是拿尺子的采样率去要求被测量。真正的帧率依赖由负样本定罪。
const deaths = pristine.map((r) => `${r.fps}Hz→${r.deathMs}ms`);
ok(`回显在三档上同一虚拟时刻退场，容差一帧（${deaths.join(' ')}）`,
  pristine.every((r) => r.deathMs !== null
    && r.deathMs >= PULSE_SEC * 1000 - 1
    && r.deathMs <= PULSE_SEC * 1000 + 1000 / r.fps + 1));
ok('帧数确实不同（对拍不是"同样三帧"的自证）',
  new Set(RATES.map((f) => Math.round(2400 / (1000 / f)))).size === 3,
  RATES.map((f) => Math.round(2400 / (1000 / f))).join('/'));
ok('首帧满量、退到 0（alpha 单调不增）',
  pristine[0].seen[100].alpha >= pristine[0].seen[900].alpha && pristine[0].seen[1500].alpha < pristine[0].seen[100].alpha);
{
  const red = runFrames(Anim, 60, 2400, { reduced: true });
  ok(`reduced-motion 是真分支：时间不推进、回显一帧内清空（deathMs=${red.deathMs}）`,
    Object.values(red.seen).every((s) => s.time === 0)
    && red.deathMs !== null && red.deathMs <= Math.ceil(1000 / 60)
    && !red.seen[100].alpha,
    JSON.stringify(red.seen[100] || {}));
}

// ---- 阴性对照：把"仍在吃帧 dt 的那一行"改成常量，上面的对拍必须变红 ----
// 变异体是**换掉一行再装一遍**，不是拿正则去读文本：改动的运行期后果（这一格 dt 之后
// 回显什么时候退场）只有真跑一遍才量得到。
function mutant(name, from, to) {
  return load({ patch: { file: 'js/anim.js', from, to }, files: ['js/anim.js'] }).exports;
}
{
  const mA = mutant('mutant_t_fixed_dt', 'it.t += dt;', 'it.t += 1 / 60;');
  if (mA) {
    const runs = RATES.map((f) => runFrames(mA.Anim, f, 2400));
    const sp = spread(runs, 'alpha');
    const deaths = [...new Set(runs.map((r) => r.deathMs))];
    ok(`负样本成立：把 it.t += dt 改成常量之后 alpha 跨度爆到 ${sp.worst.toFixed(3)}（>0.05 判红）`, sp.worst > 0.05);
    ok(`负样本成立：退场时刻随帧率分叉（${runs.map((r) => `${r.fps}Hz→${r.deathMs}ms`).join(' ')}）`, deaths.length === RATES.length);
  }
  const mB = mutant('mutant_time_fixed_dt', 'this.time += dt;', 'this.time += 1 / 60;');
  if (mB) {
    const runs = RATES.map((f) => runFrames(mB.Anim, f, 2400));
    const sp = spread(runs, 'time');
    ok(`负样本成立：把 this.time += dt 改成常量之后 time 跨度爆到 ${sp.worst.toFixed(3)}（>0.05 判红）`, sp.worst > 0.05);
  }
}

// ============================================================ 3. 真静音
head('3. 静音 = 挂起上下文（不是把音量拧成 0，也不是"下次再说"）');
{
  Sound.setMuted(true);
  Sound.place(); Sound.hint(); Sound.win(); Sound.conflict(); Sound.undo();
  ok('静音态下一个振荡器都不建', oscMade === 0, `osc=${oscMade}`);
  ok('静音态下连 AudioContext 都不新建', acMade === 0, `ac=${acMade}`);
  ok('没有上下文就是 none（不假装 suspended）', Sound.ctxState() === 'none', Sound.ctxState());
  Sound.setMuted(false);
  Sound.place();
  ok('解静音之后建了上下文与一个振荡器', acMade === 1 && oscMade === 1, `ac=${acMade} osc=${oscMade}`);
  ok('解静音之后上下文 running', Sound.ctxState() === 'running', Sound.ctxState());
  Sound.setMuted(true);
  ok('静音把上下文挂起（ctx.state === suspended）', Sound.ctxState() === 'suspended', Sound.ctxState());
  const v1 = oscMade;
  Sound.place(); Sound.hint();
  ok('挂起态下再按也不建节点', oscMade === v1, `${v1}→${oscMade}`);
  Sound.setMuted(false);
  Sound.pauseAudio();
  ok('暂停的 hold 走同一条挂起路', Sound.ctxState() === 'suspended' && Sound.held() === true);
  Sound.place();
  ok('hold 期间也不建节点', oscMade === v1, `${v1}→${oscMade}`);
  Sound.resumeAudio();
  ok('解暂停回到 running', Sound.ctxState() === 'running' && Sound.held() === false, Sound.ctxState());
  // 两条标志互不覆盖：解暂停不许越过玩家的静音设定
  Sound.setMuted(true);
  Sound.pauseAudio();
  Sound.resumeAudio();
  ok('解暂停不许把静音的局救回来说话', Sound.ctxState() === 'suspended' && oscMade === v1,
    `${Sound.ctxState()} osc=${oscMade}`);
  Sound.setMuted(false);
  Sound.place();
  ok('再解静音才真的响（振荡器 +1）', oscMade === v1 + 1 && Sound.ctxState() === 'running');
  ok('Sound.voices() 与节点建数同源', Sound.voices() === oscMade, `${Sound.voices()} vs ${oscMade}`);
}

// ============================================================ 4. 坏档只丢那一条
head('4. 存档：四个坏样本各自只丢那一条，纪录与游标不许被连坐');
{
  const spec = tierFor('sho');
  const { R, C } = spec;
  const codesLen = R * (C - 1) + (R - 1) * C;
  const good = {
    tier: 'sho', seed: 7, R, C,
    gray: [...Array((R * C) / 2).keys()],
    nums: [[0, 2]],
    cells: '0'.repeat(codesLen),
    cursor: 0, moves: 3, hints: 1, elapsedMs: 1234,
  };
  Store.data.best = { sho: { ms: 4000, hints: 0, moves: 9, size: `${R}×${C}` } };
  Store.data.seedCounter = 42;
  Store.data.settings = { sound: false, reduceMotion: true };
  Store.data.resume = good;
  ok('整块合法的存档读得回来', JSON.stringify(Store.resume(tierFor)) !== 'null' && Store.resume(tierFor).seed === 7);
  const bad = {
    样本1_没有存档: null,
    样本2_缺字段_没有gray: { ...good, gray: undefined },
    样本3_类型错_seed是字符串: { ...good, seed: '7' },
    样本4_越界_数字大于一盘的格数: { ...good, nums: [[0, R * C + 5]] },
    样本5_底纹不是半盘灰: { ...good, gray: [0, 1] },
    样本6_盘面串长度对不上段数: { ...good, cells: '01' },
    样本7_不是对象: 'a string',
  };
  for (const [name, payload] of Object.entries(bad)) {
    Store.data.resume = payload;
    ok(`坏档 ${name} → 判成"没有存档"而不是抛`, Store.resume(tierFor) === null);
  }
  Store.data.resume = good;
  ok('丢完坏样本之后纪录还在（同一条 data 上的 best 未被连坐）', Store.best('sho') && Store.best('sho').ms === 4000);
  ok('丢完坏样本之后 seed 游标与设定还在', Store.peekSeed() === 42 && Store.setting('sound') === false);
}
{
  // load() 走的是 localStorage：三条都是"整份档没法用"的形状，必须回落默认而不是抛。
  const cases = [
    ['不是 JSON', 'not json at all'],
    ['顶层是数组', '[1,2,3]'],
    ['settings 是个字符串', '{"settings":"x","best":7}'],
  ];
  for (const [name, raw] of cases) {
    const poison = { _s: new Map([[Store.key, raw]]), getItem(k) { return this._s.has(k) ? this._s.get(k) : null; }, setItem(k, v) { this._s.set(k, String(v)); }, removeItem(k) { this._s.delete(k); } };
    const m = load({ store: poison, files: ['js/store.js'] }).exports;
    ok(`load() 遇到「${name}」回落默认（不抛、不清空成 undefined）`,
      m.Store.data && typeof m.Store.data.settings === 'object' && m.Store.data.settings.sound === true
      && m.Store.data.seedCounter === 1 && m.Store.data.resume === null);
  }
  // 好档要真能跨"重启"活下来：写进去 → 换一份模块实例读回来。
  localStorageStub.removeItem(Store.key);
  Store.data.resume = { tier: 'sho', seed: 7, R: tierFor('sho').R, C: tierFor('sho').C, gray: [...Array((tierFor('sho').R * tierFor('sho').C) / 2).keys()], nums: [[0, 2]], cells: '0'.repeat(tierFor('sho').R * (tierFor('sho').C - 1) + (tierFor('sho').R - 1) * tierFor('sho').C), cursor: 0, moves: 1, hints: 0, elapsedMs: 500 };
  Store.save();
  const m2 = load({ files: ['js/store.js'] }).exports;
  ok('存档跨重启读得回来（setItem 与 getItem 成对，不是只写不读）',
    typeof m2.Store.data.resume === 'object' && m2.Store.data.resume.seed === 7);
}

// ---- 5. 重开 / 再来一局：一次复位要把五类状态全部归零，逐值实测 ----
// 简报 §2 对这一项的要求不是"调了一次 init()"，而是"时钟、缓冲、粒子、玩家位置、临时增益
// 全部复位（实测复位前后数值）"。三把闸原先都没量这一项：behavior 的四段是纯状态单元
// （Session/Anim/Sound/Store），engine 那 44 条管出题，ui-smoke 管几何与零猜测——
// "换一局"这条生产路径（#btn-new 的 click → restart() → begin() → openPuzzle()）
// 从来没人把前后数值对过表。这里用 tools/app-host.mjs 那份能跑 main.js 的宿主来判。
head('5. 重开复位逐值（走 #btn-new 的真实 click 路径，不是直接调 init）');
{
  const H = boot(0x2f6e2b1, null);
  H.fire(H.env, 'DOMContentLoaded', H.mkEv('DOMContentLoaded'));
  const g = H.env.game;
  if (!g) { ok('window.game 挂上了', false, '读不到状态面，后面全部作废'); }
  else {
    // 沙箱只推进虚拟时钟，不排空微任务队列；而 restart() → begin() 是 async 的（它要给
    // "出题中"浮层让帧）。只 H.step() 而不 await 一发，那条 await 的尾巴永远不落地——
    // 实测症状是"复位前/复位后逐字段一字不差"，看着像产品没复位，其实是 harness 没让开局跑完。
    const tick = () => new Promise((r) => setImmediate(r));
    async function pump(frames, until = null) {
      for (let f = 1; f <= frames; f++) {
        H.step(60);
        await tick();
        if (until && until()) return f;
      }
      return frames;
    }
    g.start();
    const kd = (key, shift = false) => {
      H.fire(H.env, 'keydown', H.mkEv('keydown', { key, code: key, shiftKey: shift }));
      H.fire(H.env, 'keyup', H.mkEv('keyup', { key }));
    };
    const ARROWS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    // 真玩 1.2 秒：方向键移光标、奇数拍画界、盘面 tap、每 12 拍一次提示（提示的回显排进 anim，
    // 那是"缓冲里有东西"这一类的证人）。
    await pump(12);
    for (let f = 1; f <= 72; f++) {
      if (f % 6 === 0) kd(ARROWS[(f / 6) % 4], (f / 6) % 2 === 1);
      if (f % 9 === 0) {
        const x = 40 + (f % 5) * 30, y = 40 + (f % 4) * 30;
        H.fire(H.board, 'pointerdown', H.mkEv('pointerdown', { clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true }));
        H.fire(H.env, 'pointerup', H.mkEv('pointerup', { clientX: x, clientY: y, pointerType: 'mouse' }));
      }
      if (f % 12 === 0) kd('h');
      await pump(1);
    }
    // 悬停强调只有 pointermove 且指针落在一道段上才产生（触屏设备没有悬停这个状态，见 onPointerMove）。
    // 这里照玩家那扇门扫过去，扫到才算证到——不是把 hover 设出来给断言看。
    let swept = null;
    for (let y = 10; y <= 590 && swept === null; y += 4) {
      for (let x = 10; x <= 790; x += 4) {
        H.fire(H.board, 'pointermove', H.mkEv('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }));
        if (g.hover >= 0) { swept = { x, y, hover: g.hover }; break; }
      }
    }
    const before = { state: g.state, elapsedMs: g.elapsedMs, pulses: g.pulses, moves: g.moves, cuts: g.cuts, hints: g.hints, cursor: g.cursor, hover: g.hover, remaining: g.remaining };
    // 先自证这一局真的被玩过：before 全是 0 的话，"after 是 0"就什么都没说（§6 同一种空跑）。
    // 取证人不选 hints：不产生推进的提示**不收费**（useHint 里那句 unproductive hint is not
    // a purchase），hints==0 是产品说对了，拿它当"玩过"的证据会让这一列恒红。
    ok(`玩过的这一局留下了痕迹（elapsed ${before.elapsedMs}ms / moves ${before.moves} / cuts ${before.cuts} / 回显 ${before.pulses} 条 / hover 指着段 ${before.hover} / cursor ${before.cursor}）`,
      before.state === 'playing' && before.elapsedMs >= 1000 && before.moves > 0 && before.cuts > 0 && before.pulses > 0 && before.hover >= 0 && before.cursor !== 0,
      JSON.stringify({ before, swept }));
    console.log(`      复位前 ${JSON.stringify(before)}（hover 扫到于 ${JSON.stringify(swept)}）`);

    // 走玩家那扇门：#btn-new 的 click。begin() 是 async（要给"出题中"浮层让帧），
    // 所以点完之后照 60Hz 继续喂**并排空微任务**，直到新题面真的落盘（seed 变了）。
    const btn = H.env.document.getElementById('btn-new');
    const seed0 = g.seed;
    H.fire(btn, 'click', H.mkEv('click'));
    const pumped = await pump(240, () => g.seed !== seed0);
    const after = { state: g.state, elapsedMs: g.elapsedMs, pulses: g.pulses, moves: g.moves, cuts: g.cuts, hints: g.hints, cursor: g.cursor, hover: g.hover, remaining: g.remaining };
    console.log(`      复位后 ${JSON.stringify(after)}（喂了 ${pumped} 帧，seed ${seed0}→${g.seed}）`);
    ok(`换局真的换了题面（seed ${seed0} → ${g.seed}）`, g.seed !== seed0, `${seed0} vs ${g.seed}`);
    ok(`时钟归零（${after.elapsedMs}ms < 100ms）`, after.elapsedMs < 100, `${after.elapsedMs}ms`);
    ok(`回显缓冲清空（anim 里 ${after.pulses} 条，复位前 ${before.pulses} 条）`, after.pulses === 0, `${after.pulses}`);
    ok(`手数与界数归零（moves ${after.moves} / cuts ${after.cuts}）`,
      after.moves === 0 && after.cuts === 0, JSON.stringify(after));
    ok(`光标回到左上第一格（cursor ${after.cursor}）`, after.cursor === 0, `${after.cursor}`);
    ok(`悬停强调撤掉（hover ${after.hover}，复位前指着段 ${before.hover}）`, after.hover === -1, `${after.hover}`);
    ok(`违反读数与区域回显归零（conflicts ${g.conflicts}）`, g.conflicts === 0, `${g.conflicts}`);
    ok(`胜局遮罩收着（#win-veil hidden=${H.env.document.getElementById('win-veil').hidden}）`,
      H.env.document.getElementById('win-veil').hidden === true, String(H.env.document.getElementById('win-veil').hidden));
    ok(`重开之后关卡仍在跑（state=${after.state}，remaining ${after.remaining}）`,
      after.state === 'playing' && after.remaining > 0, JSON.stringify(after));
    // 再来一次：同一扇门按两下不许留下第二局的痕迹（"只调一次 init()"的那种写法在这里会红）。
    const seed1 = g.seed;
    H.fire(btn, 'click', H.mkEv('click'));
    await pump(240, () => g.seed !== seed1);
    const again = { elapsedMs: g.elapsedMs, pulses: g.pulses, moves: g.moves, cuts: g.cuts, hover: g.hover, cursor: g.cursor };
    ok(`连按两次"换一局"仍然干净（${JSON.stringify(again)}，seed ${seed1}→${g.seed}）`,
      again.elapsedMs < 100 && again.pulses === 0 && again.moves === 0 && again.cuts === 0 && again.hover === -1 && again.cursor === 0,
      JSON.stringify(again));
    if (H.env.__err) ok('复位路径无运行期报错', false, String(H.env.__err).split('\n')[0]);
  }
}

// ---- 6. 触摸输入：三条门要落下同一条界 ----
head('6. 触摸输入回落（pointerdown / touchstart / mousedown 各画一条且只画一条）');
{
  const H = boot(0x7a1e05, null); // 这台窗口没有 PointerEvent ⇒ 回落应当挂上
  H.fire(H.env, 'DOMContentLoaded', H.mkEv('DOMContentLoaded'));
  const g = H.env.game;
  const tick = () => new Promise((r) => setImmediate(r));
  const pump = async (n, until) => {
    for (let f = 1; f <= n; f++) { H.step(60); await tick(); if (until && until()) return f; }
    return n;
  };
  const btn = H.env.document.getElementById('btn-new');
  const fresh = async () => { const s = g.seed; H.fire(btn, 'click', H.mkEv('click')); await pump(240, () => g.seed !== s); };
  if (!g) ok('window.game 挂上了', false, '读不到状态面，后面全部作废');
  else {
    g.start();
    await pump(6);
    // 落点要"真的在某条段上"才算证到：扫 pointermove，直到 hover 亮起来，那一个坐标就是段上的点。
    let pt = null;
    for (let y = 8; y <= 420 && pt === null; y += 3) {
      for (let x = 8; x <= 520; x += 3) {
        H.fire(H.board, 'pointermove', H.mkEv('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }));
        if (g.hover >= 0) { pt = { x, y }; break; }
      }
    }
    ok(`扫到一个真落在段上的落点（${JSON.stringify(pt)}）`, !!pt, String(JSON.stringify(pt)));
    // 换局不改变几何（同档 R×C 与 cell 同一套），所以同一个坐标在每一局都指着同一条段。
    const doors = [
      ['pointerdown', async () => {
        H.fire(H.board, 'pointerdown', H.mkEv('pointerdown', { clientX: pt.x, clientY: pt.y, pointerType: 'touch', isPrimary: true }));
        H.fire(H.env, 'pointerup', H.mkEv('pointerup', { clientX: pt.x, clientY: pt.y, pointerType: 'touch' }));
      }],
      ['touchstart', async () => {
        const t = { clientX: pt.x, clientY: pt.y };
        H.fire(H.board, 'touchstart', H.mkEv('touchstart', { touches: [t], changedTouches: [t] }));
        H.fire(H.board, 'touchend', H.mkEv('touchend', { touches: [], changedTouches: [t] }));
      }],
      ['mousedown', async () => {
        H.fire(H.board, 'mousedown', H.mkEv('mousedown', { clientX: pt.x, clientY: pt.y, button: 0 }));
        H.fire(H.env, 'mouseup', H.mkEv('mouseup', { clientX: pt.x, clientY: pt.y }));
      }],
    ];
    for (const [name, fire] of doors) {
      await fresh();
      const before = { cuts: g.cuts, moves: g.moves, hover: g.hover };
      await fire();
      await pump(2);
      const delta = g.cuts - before.cuts;
      ok(`${name} 落下恰好一条界（cuts ${before.cuts}→${g.cuts}，moves ${before.moves}→${g.moves}）`,
        delta === 1, `Δcuts=${delta}`);
    }
    // 触屏没有"悬停"这个状态：touchmove 之后 hover 必须还是 -1，否则一条没人指的段会亮着。
    await fresh();
    H.fire(H.board, 'touchmove', H.mkEv('touchmove', { touches: [{ clientX: pt.x, clientY: pt.y }], changedTouches: [{ clientX: pt.x, clientY: pt.y }] }));
    ok(`touchmove 不点亮相（hover ${g.hover}）`, g.hover === -1, `${g.hover}`);
    H.fire(H.board, 'mousemove', H.mkEv('mousemove', { clientX: pt.x, clientY: pt.y }));
    ok(`mousemove 点亮相（hover ${g.hover}，落点 ${JSON.stringify(pt)}）`, g.hover >= 0, `${g.hover}`);

    // 阴性对照：一台**声称支持 Pointer Events** 的窗口里，回落就不许再挂——两边都挂的话
    // 一次点按会同时走 pointerdown 与 mousedown，第二条把第一条擦掉，落子整个反了。
    const H2 = boot(0x7a1e05, null, { pointerEvents: true });
    H2.fire(H2.env, 'DOMContentLoaded', H2.mkEv('DOMContentLoaded'));
    const g2 = H2.env.game;
    const pump2 = async (n) => { for (let f = 1; f <= n; f++) { H2.step(60); await tick(); } };
    g2.start();
    await pump2(6);
    const c0 = g2.cuts;
    H2.fire(H2.board, 'mousedown', H2.mkEv('mousedown', { clientX: pt.x, clientY: pt.y, button: 0 }));
    H2.fire(H2.env, 'mouseup', H2.mkEv('mouseup', { clientX: pt.x, clientY: pt.y }));
    await pump2(2);
    ok(`对照：有 PointerEvent 时 mousedown 不画界（cuts ${c0}→${g2.cuts}）`, g2.cuts === c0, `${c0}→${g2.cuts}`);
    H2.fire(H2.board, 'pointerdown', H2.mkEv('pointerdown', { clientX: pt.x, clientY: pt.y, pointerType: 'mouse', isPrimary: true }));
    H2.fire(H2.env, 'pointerup', H2.mkEv('pointerup', { clientX: pt.x, clientY: pt.y, pointerType: 'mouse' }));
    await pump2(2);
    ok(`对照：同一台窗口里 pointerdown 仍画一条（cuts ${c0}→${g2.cuts}）`, g2.cuts === c0 + 1, `${c0}→${g2.cuts}`);
    if (H.env.__err) ok('回落路径无运行期报错', false, String(H.env.__err).split('\n')[0]);
  }
}

// ---- 7. reduceMotion：开关按下之后时钟不走、回显当场清掉，而玩法一条不少 ----
head('7. reduceMotion 真分支（走 #btn-motion 那扇门，量 anim 时钟与回显）');
{
  const H = boot(0x3c0ffee, null);
  H.fire(H.env, 'DOMContentLoaded', H.mkEv('DOMContentLoaded'));
  const g = H.env.game;
  const tick = () => new Promise((r) => setImmediate(r));
  const pump = async (n) => { for (let f = 1; f <= n; f++) { H.step(60); await tick(); } return n; };
  if (!g) ok('window.game 挂上了', false, '读不到状态面，后面全部作废');
  else {
    g.start();
    await pump(6);
    let pt = null;
    for (let y = 8; y <= 420 && pt === null; y += 3) {
      for (let x = 8; x <= 520; x += 3) {
        H.fire(H.board, 'pointermove', H.mkEv('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }));
        if (g.hover >= 0) { pt = { x, y }; break; }
      }
    }
    ok(`扫到一个段上落点（${JSON.stringify(pt)}）`, !!pt, String(JSON.stringify(pt)));
    const tap = async () => {
      H.fire(H.board, 'pointerdown', H.mkEv('pointerdown', { clientX: pt.x, clientY: pt.y, pointerType: 'mouse', isPrimary: true }));
      H.fire(H.env, 'pointerup', H.mkEv('pointerup', { clientX: pt.x, clientY: pt.y, pointerType: 'mouse' }));
      await pump(1);
    };
    // 常速这一腿是"分支存在"的证人：时钟得真的在走、回显得真的挂得住，
    // 否则下面"关掉之后不推进"可以是由一个根本没跑起来的东西给的。
    const t0 = g.animTime;
    await tap();
    const pulsesOn = g.pulses;
    await pump(30);
    const advance = g.animTime - t0;
    ok(`常速下时钟在走、回显挂得住（animTime +${advance.toFixed(4)}s，落子后 pulses=${pulsesOn}，30 帧后=${g.pulses}）`,
      advance > 0.3 && pulsesOn >= 1, `advance=${advance.toFixed(4)} pulses ${pulsesOn}→${g.pulses}`);
    // 玩家那扇门：#btn-motion
    H.fire(H.env.document.getElementById('btn-motion'), 'click', H.mkEv('click'));
    await pump(1);
    const t1 = g.animTime;
    await pump(30);
    const advanceOff = g.animTime - t1;
    ok(`按下动效开关之后累计时钟不走（30 帧只推进 ${advanceOff.toFixed(6)}s）`,
      advanceOff === 0, `t1=${t1.toFixed(4)} → ${g.animTime.toFixed(4)}`);
    await tap();
    await pump(6);
    ok(`回显当场被清掉（pulses=${g.pulses}，而界照样落下 cuts=${g.cuts}）`,
      g.pulses === 0, `pulses=${g.pulses} cuts=${g.cuts}`);
    const cutsBefore = g.cuts;
    await tap();
    ok(`省动效不许省掉玩法：再落一条界（cuts ${cutsBefore}→${g.cuts}）`,
      g.cuts === cutsBefore + 1, `${cutsBefore}→${g.cuts}`);
    // 阴性对照：把 anim.js 里那条 reduced 分支接成常数 false（= 开关只改界面、不改行为，
    // 正是简报要打死的那种假分支）。同一颗种子、同样 30 帧，时钟必须走起来——
    // 不走就说明上面那条"推进 0.000000s"是空断言。
    const Hm = boot(0x3c0ffee, { file: 'js/anim.js', from: 'if (this.reduced()) {', to: 'if (false) {' });
    Hm.fire(Hm.env, 'DOMContentLoaded', Hm.mkEv('DOMContentLoaded'));
    const gm = Hm.env.game;
    gm.start();
    for (let f = 1; f <= 6; f++) { Hm.step(60); await tick(); }
    Hm.fire(Hm.env.document.getElementById('btn-motion'), 'click', Hm.mkEv('click'));
    const m0 = gm.animTime;
    for (let f = 1; f <= 30; f++) { Hm.step(60); await tick(); }
    const advMut = gm.animTime - m0;
    ok(`阴性对照成立：reduced 分支接成 false 之后同一时长时钟必须走（推进 ${advMut.toFixed(4)}s）`,
      advMut > 0.3, `advance=${advMut.toFixed(6)}`);
    if (H.env.__err) ok('reduceMotion 路径无运行期报错', false, String(H.env.__err).split('\n')[0]);
  }
}

console.log(`\nbehavior ${fails.length ? `${pass}/${pass + fails.length} 绿 —— 红：\n    ${fails.join('\n    ')}` : `${pass}/${pass} 绿`}`);
process.exit(fails.length ? 1 : 0);
