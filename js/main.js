// Wiring: DOM, pointer + keyboard input, the clock, storage, and the `window.dc` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/ through js/ui/game.js.
//
// 默认 seed 取自存档里的自增游标，绝不取 Date.now()：页面上印着 "seed 7" 就必须能用
// 同一个 7 + 同一档重新出同一张盘。闸里那条断言量的是这个（见 tools/scenarios.js 的 seed 段）。
//
// 玩家唯一的落子是**两格之间画不画界**，所以这个文件里没有"往格子里写数字"这条控制流：
// 一次动作 = 一个段号 k + 一个目标态（BORDER/OPEN），指针与键盘都只走 toggleSeg/toggleDir 这两个入口。

import { Palette, Cell, Hit, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import * as Rules from './engine/rules.js';
import * as Blocks from './engine/blocks.js';
import * as Gen from './engine/generate.js';
import { count } from './engine/count.js';
import { pencil, judge, RULE_TEXT } from './engine/pencil.js';
import { rng } from './engine/rng.js';
// 档位表唯一的来源：js/engine/tiers.js。TIERS 的每一档、它的尺寸、gold 里实测的数字个数与
// 推理轮次、以及"哪些尺寸不在菜单里"都由这一份给，本文件不再另列清单。
import { TIERS, tierOf, tierFor, tierMed, tierMax, OUT_OF_MENU, CAP_WORK, GEN_BUDGET_MS, build, rebuild } from './engine/tiers.js';
import { BoardView } from './render/board.js';
import { Game, puzzleFromParts, BORDER, OPEN, segKey } from './ui/game.js';

const VERSION = '1.0.0';
// 每个文档一个身份：片段跳转不换文档，所以这一个身份在 hash 导航后必须还在、
// 真重载后必须消失。它是"续局这一腿跑在新文档里"的证人之一。
const DOC = 'doc' + Math.random().toString(36).slice(2, 10);

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  rules: $('#rule-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  seed: $('#stat-seed'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  cuts: $('#stat-cuts'),
  remaining: $('#stat-remaining'),
  regions: $('#stat-regions'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  nums: $('#stat-nums'),
  genms: $('#stat-genms'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  menuNote: $('#menu-note'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  busyVeil: $('#busy-veil'),
  busyLine: $('#busy-line'),
  padCursor: $('#pad-cursor'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
// 状态行的优先级：一次性通知（"那一面没有相邻的格"）> 违反读数 > 空。
// 第一版没有这一层，拒答的那句话被 syncStats 的违反文本当场盖掉——玩家点了一个不能动的地方，
// 屏幕上只看到"6 条违反"，完全不知道自己要的那一步为什么没落下去。
let notice = '';
const say = (s) => {
  notice = s || '';
};
const keys = { seen: 0, handled: 0, repeated: 0, last: '', by: {} };
// 出题/重证都是同步的贵计算（极档实测中位几百毫秒、上限 GEN_BUDGET_MS）。
// 直接跑的话浏览器一帧都画不出来，玩家看到的是"点了没反应"，所以这段要先把"出题中"画上屏。
let busy = null;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

// 一句话该写在哪儿：出盘失败/续局丢弃多半发生在**选档页**上，而 #state-line 在棋局视图里，
// 那时候写进去等于写了句没人看得见的话。这一层只判"当前是哪一视图"，两视图共用同一条消息。
function announce(text) {
  const onMenu = !el.viewMenu.hidden;
  el.menuNote.hidden = onMenu ? !text : true;
  el.menuNote.textContent = onMenu && text ? text : '';
  if (!onMenu) el.stateLine.textContent = text || '';
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 等一帧真的画上屏再往下跑。rAF 在后台标签里可能永远不来，所以同时挂一个定时器：
// 宁可贵计算早 120ms 开始，也不能让"出题中"这句话永远停在没画出的那一帧里。
function nextPaint() {
  return new Promise((res) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      res();
    };
    try {
      requestAnimationFrame(() => setTimeout(fin, 0));
    } catch {
      fin();
    }
    setTimeout(fin, 120);
  });
}

// 出题/重证都是同步的贵计算：主线程在那几百毫秒里画不出一帧，页外的闸**量不到**遮罩的几何
// （它一挂上就被同一段的阻塞吞掉了）。所以这一份记录由 paintBusy 在遮罩挂上的那一刻自己量，
// layout 腿断"遮罩盖住了画布"读的是这里抄下的证人，不是闸事后补的一个数。
const busyLog = [];

function paintBusy() {
  el.busyVeil.hidden = !busy;
  el.busyLine.textContent = busy || '';
  el.wrap.dataset.busy = busy ? '1' : '0';
  if (!busy) return;
  const v = el.busyVeil.getBoundingClientRect();
  const c = el.canvas.getBoundingClientRect();
  busyLog.push({ label: busy, veil: [v.left, v.top, v.width, v.height], canvas: [c.left, c.top, c.width, c.height] });
}

async function withBusy(label, fn) {
  busy = label;
  paintBusy();
  await nextPaint();
  try {
    return fn();
  } finally {
    busy = null;
    paintBusy();
  }
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 40 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 260) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, { pulse, hover: hoverSeg });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.R}×${game.C} · ${st.nums} 个数字`;
  el.tier.textContent = st.name;
  el.tier.dataset.tier = st.tier;
  el.seed.textContent = `seed ${st.seed}`;
  el.seed.dataset.seed = String(st.seed);
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.cuts.textContent = `${st.cuts}/${st.wantCuts}`;
  el.remaining.textContent = st.remaining;
  el.regions.textContent = `${st.regions}/${st.regionsTotal}`;
  el.conflicts.textContent = st.conflicts;
  el.nums.textContent = `${st.nums}/${st.cells}`;
  // 难度实测读的是**这一盘**出货时量到的铅笔轮数；续局没有出题过程，就报"—"，不编一个数。
  el.score.textContent = st.boardSteps === null ? `—（本档中位 ${st.medSteps} 轮）` : `${st.boardSteps} 轮`;
  el.score.closest('.stat').dataset.steps = st.boardSteps === null ? '' : String(st.boardSteps);
  el.genms.textContent = st.genMs ? `${st.genMs} ms` : '—（续局）';
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.regions.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.regions !== st.regionsTotal);
  const first = st.conflicts ? game.errs[0] : '';
  el.stateLine.textContent = notice
    ? notice
    : st.conflicts
      ? `${st.conflicts} 条违反：${first}`
      : st.status === 'won'
        ? `每一块都是同形的两半：区界 ${st.cuts} 条全部画完。`
        : '';
  syncPad();
}

// 键盘盘上的四个键就是"光标那一格能做的四个动作"，所以每个键的标签必须点名它落的那条段：
// 一个只写"↑"的按钮说不清它在画哪一条界，闸量的是这个标签里有没有真实的段名。
const DIRS = [
  ['up', '↑', '上'],
  ['down', '↓', '下'],
  ['left', '←', '左'],
  ['right', '→', '右'],
];
function syncPad() {
  if (!game) return;
  el.padCursor.textContent = game.name(game.cursor);
  for (const [dir, glyph] of DIRS) {
    const btn = el.pad[dir];
    const to = game.step(game.cursor, dir);
    btn.textContent = glyph;
    if (to === null) {
      btn.disabled = true;
      btn.setAttribute('aria-label', `${game.name(game.cursor)} 的${DIRS.find((d) => d[0] === dir)[2]}面已经到盘边：那一面没有相邻的格`);
      btn.dataset.seg = '';
      // 按下态是**那一条段**的属性，不是这只键的。光标走到盘边之后这一段已经不存在了，
      // 留着上一次的 aria-pressed="true" 就等于对着"没有相邻的格"这句话亮着一盏已画界灯。
      btn.removeAttribute('aria-pressed');
      continue;
    }
    const k = game.segIx.get(segKey(game.cursor, to));
    btn.disabled = false;
    btn.dataset.seg = String(k);
    btn.setAttribute('aria-pressed', String(game.st[k] === BORDER));
    btn.setAttribute('aria-label', `${game.st[k] === BORDER ? '擦掉' : '画'} ${game.segName(k)} 之间的区界（${game.name(game.cursor)} ↔ ${game.name(to)}）`);
  }
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.codes(), clock(), { moves: game.moves, hints: game.hints, cursor: game.cursor });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和题面矛盾';
    el.hintLine.textContent = info.conflict;
    pulse = { seg: info.segs[0], color: Palette.error };
    markPulse();
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.text;
  pulse = { seg: info.seg, color: Palette.hint };
  markPulse();
  Sound.hint();
}

// 提示点名的那条界闪一下。延迟清 pulse 时先比对身份：期间玩家又画了一条的话，
// 这一帧的清除会把**新**的那条也抹掉，屏幕上就少了一个本该存在的落点回显。
function markPulse() {
  const mine = pulse;
  setTimeout(() => {
    if (pulse === mine) pulse = null;
    draw();
  }, 1600);
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.R}×${game.C}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  const f = game.winFacts();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.R}×${game.C} · seed ${game.puzzle.seed} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent =
    `判据 ${f.errs} 条违反 · 区界 ${f.cuts}/${f.wantCuts} 条 · 分成 ${f.regions} 块 · 与唯一解逐对同块关系相同（${f.mismatch} 处不同） · ` +
    (better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。');
  el.winVeil.hidden = false;
  el.stateLine.textContent = '';
  Sound.win();
  renderRecords();
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.errs.length) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won') return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    syncAll();
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep(null);
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) {
    say('没有可撤的步：这一局还没画过任何一条界。');
    syncAll();
    return null;
  }
  pulse = null;
  say('');
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

// 画/擦一条段：k 是段号（segmentTable 的下标），target 省略就是取反。
// 被 game.js 挡回来的那一步会把挡回来的那句话写进状态行——玩家得看得见"为什么没落子"。
function setSeg(k, target = null) {
  if (!game) return null;
  const r = game.toggleSeg(k, target);
  if (r.refused) {
    say(r.refused);
    Sound.refuse();
    syncAll();
    return null;
  }
  if (r.noop) return null;
  say('');
  pulse = { seg: k, color: r.to === BORDER ? Palette.accent : Palette.info };
  markPulse();
  afterStep(r.to === BORDER ? 'place' : 'erase');
  return r;
}

// 键盘那条路：动作发生在"光标这一格与那一面邻居之间"，落子形状与指针完全相同。
function setDir(dir) {
  if (!game) return null;
  const r = game.toggleDir(game.cursor, dir);
  if (r.refused) {
    say(r.refused);
    Sound.refuse();
    syncAll();
    return null;
  }
  if (r.noop) return null;
  return r.step ? setSegResult(r) : r;
}

// toggleDir 已经改了状态，这里只补上"一次动作的回显与存档"这一步——不再走 setSeg，
// 否则会重复落一次子（取反两次等于没画）。
function setSegResult(r) {
  say('');
  const k = r.seg;
  pulse = { seg: k, color: r.to === BORDER ? Palette.accent : Palette.info };
  markPulse();
  afterStep(r.to === BORDER ? 'place' : 'erase');
  return r;
}

function select(i) {
  if (!game || i < 0) return false;
  const ok = game.select(i);
  say(ok ? '' : `那点不在盘上：光标只能停在格子里。`);
  syncAll();
  return ok;
}

// ---- 出题：seed 只来自存档游标 ----

function nextSeed(used) {
  Store.advanceSeed(used);
  return Store.peekSeed();
}

async function begin({ tier = 'sho', seed = null, resume = null } = {}) {
  const spec = tierFor(tier);
  let puzzle = null;
  if (resume) {
    // 续局照存档里的题面重建，**不重新出题**：那笔实测的生成成本（极档中位几百毫秒）不该重付一次。
    // 存档也不带解，所以解在这里重新证一遍（tiers.js 的 rebuild = judge() 的合取判据当场重跑，
    // 实测四档都在几十毫秒内，台架读数见 tools/ui-smoke.mjs 的续局段）。
    // 证不过就丢弃这份存档并点名拒在哪一条——坏档/改过的档绝不能变成一个"答案由存档定义"的盘。
    const genStart = Date.now();
    const rb = await withBusy(`续局重证中：seed ${resume.seed}`, () => rebuild(spec, resume.gray, resume.nums, resume.seed));
    if (!rb.ok) {
      Store.clearResume();
      announce(`续局丢弃：这存档的题面当场重证不过判据（${rb.why}）。请重新选一档。`);
      renderResumeCard();
      return null;
    }
    puzzle = rb.puzzle;
    puzzle.stats = { ms: Date.now() - genStart };
  } else {
    let request = seed;
    if (request === null || !Number.isInteger(request)) request = Store.peekSeed();
    let probe = request;
    // 游标那一号出不了货就往前推：这里没有"换个随机种子再试一次"的余地，
    // 因为那等于让页面上的 seed 变成一句假话。
    for (let k = 0; k < 5 && !puzzle; k++) {
      puzzle = await withBusy(`出题中：${spec.name} ${spec.R}×${spec.C} · seed ${probe}`, () => build(spec, probe));
      if (!puzzle) probe++;
    }
    if (!puzzle) {
      announce(`这一档连着 5 号 seed 都没出货（${spec.name} ${spec.R}×${spec.C}），换一档试试。`);
      return null;
    }
  }
  game = new Game(puzzle);
  pulse = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.loadCodes(resume.cells);
    game.cursor = Math.min(resume.cursor || 0, game.B.cells.length - 1);
  } else {
    game.cursor = game.B.id(0, 0);
  }
  nextSeed(puzzle.seed);
  announce('');
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.innerHTML = '按 <b>提示</b> 会说出当前能推的一步，以及它依据哪条具名规则。';
  say('');
  syncAll();
  if (game.status === 'won') onWin();
  else flushResume();
  renderResumeCard();
  writeHash();
  return game;
}

function writeHash() {
  if (!game) return;
  const h = `#t=${game.puzzle.tier}&s=${game.puzzle.seed}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

// 只认这一种形状：#t=<档>&s=<seed>。其余的 hash（例如闸里用来证明"片段导航不是重载"的
// #gate-fragment-nav）一律不碰盘面。
function parseHash() {
  const m = /^#t=([a-z]+)&s=(\d+)$/.exec(location.hash || '');
  if (!m) return null;
  const seed = Number(m[2]);
  return { tier: m[1], seed: Number.isInteger(seed) && seed >= 1 ? seed : null };
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderRules();
  renderResumeCard();
}

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${t.note || ''}</span>` +
      `<span class="tier-size mono">${t.R}×${t.C} · 数字 ${tierMed(t, 'nums')} 个 · 区界 ${tierMed(t, 'cuts')} 条 · 实测推理 ${tierMed(t, 'steps')} 轮（最贵一档工作量 ${tierMax(t, 'work')}）</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
  // OUT_OF_MENU 在 tiers.js 里是一条数组（奇面积、10×10 成本），每一条都要单独念出来：
  // 页面上"哪些尺寸不在菜单里"这句话的分母必须与引擎里那条数组同数。
  const out = document.createElement('div');
  out.className = 'tier-out-wrap';
  out.id = 'tier-out';
  for (const o of OUT_OF_MENU) {
    const p = document.createElement('p');
    p.className = 'tier-out mono';
    p.textContent = `${o.R}×${o.C}：${o.why}`;
    out.appendChild(p);
  }
  el.tiers.appendChild(out);
}

// 菜单上那几条规则**不在 HTML 里手抄**：id 写在这里，句子由 js/engine/pencil.js 的 RULE_TEXT 给。
// 规则表改了名，这里当场少一条（页面上不会出现一句引擎里已经不存在的规则）。
const MENU_RULES = ['N1_数字定大小', 'N2_异数不共块', 'N7_无处共块画界', 'N8_唯一候选块'];
function renderRules() {
  el.rules.innerHTML = '';
  for (const id of MENU_RULES) {
    const li = document.createElement('li');
    li.dataset.rule = id;
    li.innerHTML = `<b>${id.replace('_', ' ')}</b>：${RULE_TEXT[id] || '（RULE_TEXT 里没有这条，引擎与页面已经不同名）'}`;
    el.rules.appendChild(li);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume(tierOf);
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.seed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} ${r.R}×${r.C} 的一局`;
  el.resumeMeta.textContent = `seed ${r.seed} · ${fmtMs(r.elapsedMs)} · ${r.moves} 步 · 提示 ${r.hints} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer：一次点要么落在段上（画界/擦界），要么落在格里（移光标）----
// 两者由同一个几何来源判（render/board.js 的 segLine ↔ hitSegment），
// 所以"画面上那条虚线"与"点下去吃到的段"不可能各说一套。

let drag = null; // { target, seen:Set<段号> }：拖过一串段时，每一段都落向同一个目标态
let hoverSeg = -1;

function canvasPoint(ev) {
  const rect = view.canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev) {
  if (!game || game.status === 'won' || busy) return;
  const k = view.hitSegment(ev.clientX, ev.clientY);
  ev.preventDefault();
  el.canvas.focus?.({ preventScroll: true });
  if (k >= 0) {
    const target = game.st[k] === BORDER ? OPEN : BORDER;
    drag = { target, seen: new Set([k]) };
    setSeg(k, target);
    return;
  }
  const i = view.hitCell(ev.clientX, ev.clientY);
  if (i >= 0) select(i);
  drag = null;
}

function onPointerMove(ev) {
  if (!game || busy) return;
  const k = view.hitSegment(ev.clientX, ev.clientY);
  if (drag) {
    if (k >= 0 && !drag.seen.has(k)) {
      drag.seen.add(k);
      setSeg(k, drag.target);
    }
    return;
  }
  // 悬停回显只给指针设备：触屏没有"悬停"这种状态，给它设 hover 会让一条根本没人指的段亮起来。
  if (ev.pointerType === 'mouse' && k !== hoverSeg) {
    hoverSeg = k;
    draw();
  }
}

function onPointerUp() {
  drag = null;
}

function onPointerLeave() {
  drag = null;
  if (hoverSeg !== -1) {
    hoverSeg = -1;
    draw();
  }
}

el.canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
el.canvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
// 手势被浏览器收走时（系统边缘滑动、缩放…）不会补一次 pointerup：不接这一句，drag 会留在原位，
// 之后落在盘上的任何一次移动都还在替一个已经不存在的按住状态画线。
el.canvas.addEventListener('pointercancel', onPointerUp);
el.canvas.addEventListener('pointerleave', onPointerLeave);
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

el.pad = {
  up: $('#btn-edge-up'),
  down: $('#btn-edge-down'),
  left: $('#btn-edge-left'),
  right: $('#btn-edge-right'),
};
for (const [dir] of DIRS) el.pad[dir].addEventListener('click', () => setDir(dir));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'sho' }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'sho' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume(tierOf);
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.place();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

const DIRKEY = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

window.addEventListener('keydown', (ev) => {
  keys.seen++;
  keys.last = ev.key;
  // 门禁要能分辨"浏览器把一次按键发了 N 遍"（自动重复）和"游戏漏收"：两者都会让
  // "派发 4 个 → 到达 4 个"这条断言红，但只有前者会带上 repeat 标志。
  if (ev.repeat) keys.repeated++;
  keys.by[ev.key] = (keys.by[ev.key] || 0) + 1;
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  if (!game || busy) return;
  const k = ev.key;
  if (DIRKEY[k]) {
    if (ev.shiftKey) setDir(DIRKEY[k]);
    else moveCursor(DIRKEY[k]);
    ev.preventDefault();
    keys.handled++;
  } else if (k === 'h' || k === 'H') {
    useHint();
    keys.handled++;
  } else if (k === 'z' || k === 'Z' || k === 'Backspace') {
    undo();
    ev.preventDefault();
    keys.handled++;
  }
});

// 方向键在格子里走，走到盘边就停住——把光标弹到对侧会让人以为按错了。
// 这个游戏里每一格都能落子（灰格与白格都要参与画界），所以光标没有"不停这一格"的那一类。
function moveCursor(dir) {
  const to = game.step(game.cursor, dir);
  if (to === null) return;
  game.cursor = to;
  syncAll();
}

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

const deep = parseHash();
if (deep && deep.seed && tierOf(deep.tier)) begin({ tier: deep.tier, seed: deep.seed });
else if (deep && tierOf(deep.tier)) begin({ tier: deep.tier });

window.dc = {
  version: VERSION,
  doc: DOC,
  timeOrigin: performance.timeOrigin,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  useHint,
  undo,
  select,
  setSeg,
  setDir,
  // 与 onPointerDown 完全同一条路（同一个 hitSegment/hitCell 判，同一个 setSeg/select 落子）：
  // 闸拿真实指针事件跑的那条腿，用它可以复跑同一件事而不需要派发。
  tapAt: (clientX, clientY) => {
    onPointerDown({ clientX, clientY, preventDefault() {} });
    return game ? game.codes() : null;
  },
  busy: () => busy,
  busyLog: () => busyLog.slice(),
  state: () => (game ? { ...game.state(), elapsedMs: clock(), errs: game.errs.slice(0, 3), busy: busy } : null),
  winFacts: () => (game ? game.winFacts() : null),
  codes: () => (game ? game.codes() : null),
  solutionCodes: () => (game ? game.solutionCodes() : null),
  segName: (k) => (game ? game.segName(k) : null),
  cellName: (i) => (game ? game.name(i) : null),
  // 铅笔在这盘上开火的句子（{i,j,kind,rule}），界面提示就是按这条 trace 点名的。
  hintScript: () => (game ? game.pencilNow().p.trace.slice(0, 40) : []),
  keyHits: () => ({ ...keys, by: { ...keys.by } }),
  persistNow: flushResume,
  budgetMs: GEN_BUDGET_MS,
  engine: {
    ...Rules,
    ...Blocks,
    ...Gen,
    count,
    pencil,
    judge,
    RULE_TEXT,
    rng,
    TIERS,
    tierOf,
    tierFor,
    tierMed,
    tierMax,
    OUT_OF_MENU,
    CAP_WORK,
    GEN_BUDGET_MS,
    Game,
    puzzleFromParts,
    Store,
    build,
    rebuild,
    BORDER,
    OPEN,
    segKey,
    // 画布与样式表共用的那一份 token。layout 腿量"格子有没有被 Cell.min/max 夹住"、量两种底色
    // 与区界色的色距都读它：把上限抄进闸里，代码改了而闸还绿，就是那种最没用的绿。
    theme: { Palette, Cell, Hit },
    doc: DOC,
  },
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});

// ---- 静音开关（M）-----------------------------------------------------------------
// M 键切静音，与全屏/重开/提示同一套键位。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});
