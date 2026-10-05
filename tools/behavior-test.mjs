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

console.log(`\nbehavior ${fails.length ? `${pass}/${pass + fails.length} 绿 —— 红：\n    ${fails.join('\n    ')}` : `${pass}/${pass} 绿`}`);
process.exit(fails.length ? 1 : 0);
