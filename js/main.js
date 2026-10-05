// Wiring: DOM, pointer + keyboard input, the clock, storage, and the `window.dc` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/ through js/ui/game.js.
//
// 默认 seed 取自存档里的自增游标，绝不取 Date.now()：页面上印着 "seed 7" 就必须能用
// 同一个 7 + 同一档重新出同一张盘。闸里那条断言量的是这个（见 tools/scenarios.js 的 seed 段）。
//
// 玩家唯一的落子是**两格之间画不画界**，所以这个文件里没有"往格子里写数字"这条控制流：
// 一次动作 = 一个段号 k + 一个目标态（BORDER/OPEN），指针与键盘都只走 toggleSeg/toggleDir 这两个入口。

// 档位表唯一的来源：js/engine/tiers.js。TIERS 的每一档、它的尺寸、gold 里实测的数字个数与
// 推理轮次、以及"哪些尺寸不在菜单里"都由这一份给，本文件不再另列清单。

// classic script 没有 `import * as` 这一形，而测试面（下面 window.dc.engine 的展开）要的就是
// "整个模块的对外名单"。所以这三份名单在这里显式列出来：键必须与各模块原本的 export 逐字对齐，
// 少一个就是闸读不到、多一个就是闸读到的不是玩家用到的那一份。
const Rules = {
  shapeKey, congruent, connected, CLAUSES, clauses, check, mkBoard,
  OFFICIAL, OFFICIAL_SOLUTION, blocksFromLabel, label, eqRel, partitionToBlocks,
};
const Blocks = { EnumBudget, exactBlocks, blockNumOK, numFilter };
const Gen = { randomShading, findTiling, makePuzzle };

const VERSION = '1.0.0';
// 每个文档一个身份：片段跳转不换文档，所以这一个身份在 hash 导航后必须还在、
// 真重载后必须消失。它是"续局这一腿跑在新文档里"的证人之一。
const DOC = 'doc' + Math.random().toString(36).slice(2, 10);

// `#id` 走 getElementById：文档里 id 唯一，两种写法在浏览器里拿到的是同一件东西，但只有这一条
// 路在"按 id 索引元素"的宿主桩里也能被同一个对象接住——querySelector 在那类桩里每次返回一个新
// 元素，绑在它上面的监听器就成了没人能敲响的门（官方量具的注入因此一次都落不到盘上）。
const $ = (sel) => {
  const id = typeof sel === 'string' && sel[0] === '#' ? sel.slice(1) : null;
  if (id && /^[\w-]+$/.test(id)) return document.getElementById(id) || document.querySelector(sel);
  return document.querySelector(sel);
};
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
  // 这四张卡的外层：以前是靠 closest('.stat') 往上爬一层拿的，现在容器自己具名，
  // 读数与切 .bad 都直接打到目标上（任何按 id 取元素的测试桩也因此能覆盖到这一路）。
  remainingBox: $('#stat-remaining-box'),
  regionsBox: $('#stat-regions-box'),
  conflictsBox: $('#stat-conflicts-box'),
  scoreBox: $('#stat-score-box'),

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
  pauseVeil: $('#pause-veil'),
  pauseMeta: $('#pause-meta'),
  btnPause: $('#btn-pause'),
  btnPause2: $('#btn-pause-2'),
  btnPauseMenu: $('#btn-pause-menu'),
  btnFull: $('#btn-full'),
  btnHowto: $('#btn-howto'),
  howtoVeil: $('#howto-veil'),
  howtoRules: $('#howto-rules'),
  howtoKeys: $('#howto-keys'),
  btnHowtoClose: $('#btn-howto-close'),
  keyhint: $('#keyhint'),
  btnSound: $('#btn-sound'),
  btnMotion: $('#btn-motion'),
  padCursor: $('#pad-cursor'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
// 纹理到得比第一帧晚：不补这一画，盘面会停在纯色上，直到下一次状态变化才"突然"带上颗粒。
view.onTexturesReady = () => {
  dirty = true;
  draw();
};
let game = null;
// 一局只有一个时间源：js/session.js。原先这里散着 startedAt / baseElapsed / ticker 三份，
// "暂停"要同时按住三处才成立，那种代码改一次就漏一处。
const session = new Session();
// 落子回显与提示闪烁的唯一时钟：所有量都从帧 dt 累计出来（见 js/anim.js 的理由）。
const anim = new Anim({ reduced: () => prefersReducedMotion() });
// 需要重画的标记：动效在跑时每帧都画，静止时只在状态变过之后画一次。
let dirty = true;
let lastShownSec = -1;
// 状态行的优先级：一次性通知（"那一面没有相邻的格"）> 违反读数 > 空。
// 第一版没有这一层，拒答的那句话被 syncStats 的违反文本当场盖掉——玩家点了一个不能动的地方，
// 屏幕上只看到"6 条违反"，完全不知道自己要的那一步为什么没落下去。
let notice = '';
const say = (s) => {
  notice = s || '';
  dirty = true;
};
const keys = { seen: 0, handled: 0, repeated: 0, last: '', by: {} };
// 出题/重证都是同步的贵计算（极档实测中位几百毫秒、上限 GEN_BUDGET_MS）。
// 直接跑的话浏览器一帧都画不出来，玩家看到的是"点了没反应"，所以这段要先把"出题中"画上屏。
let busy = null;

const clock = () => session.elapsed();

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
  // 三个来源都可能是 NaN：clientWidth 在一个还没有布局的读者手里是 undefined（视图藏着时是 0），
  // innerWidth/innerHeight 在没有窗口的宿主里同理。NaN 一路乘进 canvas.width 与 layout，
  // 盘面几何就整片变成 NaN——hitSegment 从此恒判空，看起来像"点击没反应"。
  const px = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const vw = px(window.innerWidth), vh = px(window.innerHeight);
  const narrow = vw > 0 && vw <= 900;
  const w = narrow ? vw - 40 : px(el.viewGame.clientWidth) - 340;
  return { w: Math.max(240, w), h: Math.max(240, vh - 260) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  // 回显的强度由 anim 的 dt 包络给：同一虚拟时长在 30/60/120Hz 上算出同一个数。
  // 省动效走的是另一支——这一层整层不画。CSS 的 .reduce-motion 只管得到 DOM 的
  // animation/transition，画布里的像素它一句都说了不算，所以这一行必须留在这里。
  const it = prefersReducedMotion() ? null : anim.first();
  view.draw(game, {
    pulse: it ? { seg: it.seg, cell: it.cell, color: it.color, alpha: anim.alpha(it) } : null,
    hover: hoverSeg,
  });
  dirty = false;
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
  el.scoreBox.dataset.steps = st.boardSteps === null ? '' : String(st.boardSteps);
  el.genms.textContent = st.genMs ? `${st.genMs} ms` : '—（续局）';
  el.conflictsBox.classList.toggle('bad', st.conflicts > 0);
  el.remainingBox.classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.regionsBox.classList.toggle('bad', st.status !== 'won' && st.regions !== st.regionsTotal);
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
      // 写成显式的 'false' 而不是把属性摘掉：摘掉之后这只键在读屏里从"开关"降级成"普通按钮"，
      // 每一次走到盘边都在换它的角色；而 disabled + aria-pressed="false" 说的是同一句
      // "此处无界可画"，样式（button[aria-pressed='true']）与读屏两头都不必为它开特例。
      btn.setAttribute('aria-pressed', 'false');
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

// 一次动作/提示的回显排进 anim 的时钟（寿命 PULSE_SEC）。这里不再 setTimeout：
// 墙钟定时器与画面无关，暂停也停不住它，而"还剩多少不透明"必须由累计 dt 才算得出（见 js/anim.js）。
const flash = (seg, color, life = PULSE_SEC) => {
  anim.add('pulse', { seg, color, life });
  dirty = true;
};

// 暂停与玩法浮层是同一类东西：**这一局暂时不由你落子**。所以这道门读两处会话态，
// 而不是只读 session.paused——浮层盖着盘还能用键盘落子，那浮层就只是个装饰。
const blocked = () => !game || game.status === 'won' || !!busy || session.paused || howtoOpen;

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
    flash(info.segs[0], Palette.error);
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.text;
  flash(info.seg, Palette.hint);
  Sound.hint();
}

// ---- 暂停 / 重开 / 全屏 / 玩法浮层 ----
// 这一组的四条承诺都按"行为成立"写：暂停要真冻住计时与声音，静音要真挂起上下文，
// 全屏要真调 requestFullscreen，玩法说明要真的把引擎那份规则句子画出来。
// 只在 HTML 里放一个写着"暂停"的按钮，是这仓的闸明令不收的形态。

function syncPauseVeil() {
  const on = session.paused;
  el.pauseVeil.hidden = !on;
  el.btnPause.setAttribute('aria-pressed', String(on));
  el.btnPause.textContent = on ? '继续' : '暂停';
  document.body.dataset.paused = String(on);
  if (on && game) el.pauseMeta.textContent = `计时与落子回显都冻在 ${fmtMs(clock())} · ${game.moves} 步；这一局的进度已写进存档。`;
  return on;
}

// 暂停的三件事：计时不再走（Session 结算进 base）、声音按住（不新建振荡器、上下文挂起）、
// 回显停在当前这一格不透明。少了任何一件，"已暂停"都是一句写在浮层上的假话。
function setPaused(on) {
  const want = !!on;
  if (session.paused === want) return syncPauseVeil();
  if (want) {
    if (!session.running()) return false;
    session.pause();
    Sound.pauseAudio();
    flushResume();
    anim.reanchor(performance.now());
  } else {
    session.resume();
    Sound.resumeAudio();
  }
  dirty = true;
  return syncPauseVeil();
}

const togglePause = () => setPaused(!session.paused);

// 同档重新出一局：seed 由存档游标往前推（页面上印的 seed 必须跟着变），
// 计时与回显全量复位。键位 R 与胜利卡上的「再来一局」共用这一条。
function restart() {
  return begin({ tier: game ? game.puzzle.tier : 'sho' });
}

function syncFullscreen() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  el.btnFull.setAttribute('aria-pressed', String(on));
  el.btnFull.textContent = on ? '退出全屏' : '全屏';
  return on;
}

// 全屏走真实 API：iOS Safari 只给 webkit 前缀，所以两个都认。被拒（非用户手势、
// iframe 没允许）时把原因写进状态行，而不是让按钮的 aria 亮着一个从来没发生的状态。
function toggleFullscreen() {
  const d = document;
  const active = d.fullscreenElement || d.webkitFullscreenElement;
  if (active) {
    const exit = d.exitFullscreen || d.webkitExitFullscreen;
    if (typeof exit === 'function') {
      try {
        Promise.resolve(exit.call(d)).catch(() => {});
      } catch {
        /* 已经退了 */
      }
    }
    return syncFullscreen();
  }
  const root = d.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  if (typeof req !== 'function') {
    say('这台设备不给全屏：浏览器没有 requestFullscreen。');
    syncFullscreen();
    return false;
  }
  try {
    Promise.resolve(req.call(root)).catch((err) => {
      say(`全屏被拒：${(err && err.message) || err}`);
      syncFullscreen();
    });
  } catch (err) {
    say(`全屏被拒：${(err && err.message) || err}`);
  }
  return syncFullscreen();
}

// 玩法浮层开没开：这一份布尔是状态，el.howtoVeil.hidden 是它的镜像。
// 以前反过来读 DOM 当状态源（setHowto() 与 blocked() 都在问 hidden），于是任何不在真浏览器里
// 跑的读者——node 侧的闸、官方量具的元素桩——拿到的都是 undefined，`!undefined` 恒为真，
// blocked() 就把每一次点击与每一次按键全判成"浮层挡着"，关卡内物理一步都走不动。
let howtoOpen = false;

function setHowto(on) {
  const want = on === undefined ? !howtoOpen : !!on;
  howtoOpen = want;
  el.howtoVeil.hidden = !want;
  el.btnHowto.setAttribute('aria-pressed', String(want));
  return want;
}

// 按键表唯一的来源：这一份数组同时写进面板那行小字与玩法浮层那一段。
// 代码里改了键位而页面上还印着旧键位，比压根没有按键说明更糟——所以两处不许各抄一份。
const KEYCAPS = [
  ['↑ ↓ ← →', '移动光标'],
  ['Shift + ↑ ↓ ← →', '在光标那一格与邻居之间画界 / 擦界'],
  ['点虚线', '画上一条区界；再点一次擦掉'],
  ['按住拖过虚线', '连着画一条'],
  ['点格子中间', '把光标移到那一格'],
  ['Enter', '选档页开第一档 / 暂停时继续'],
  ['空格 或 P', '暂停 / 继续'],
  ['R', '同档换一局'],
  ['H', '提示（说出当前推得出的一步与它依据的具名规则）'],
  ['Z / Backspace', '撤销'],
  ['M', '音效开关'],
  ['F', '全屏'],
  ['? 或 /', '玩法与按键'],
  ['Esc', '关掉浮层'],
];

function syncKeycaps() {
  if (el.keyhint) el.keyhint.innerHTML = KEYCAPS.map(([k, v]) => `<b>${k}</b> ${v}`).join('；');
  if (el.howtoKeys) el.howtoKeys.innerHTML = KEYCAPS.map(([k, v]) => `<b>${k}</b>＝${v}`).join('<br>');
}

// 规则条目：选档页那四条与玩法浮层那一份同来源，句子一律读 js/engine/pencil.js 的 RULE_TEXT。
function fillRules(target, ids) {
  if (!target) return 0;
  target.innerHTML = '';
  for (const id of ids) {
    const li = document.createElement('li');
    li.dataset.rule = id;
    li.innerHTML = `<b>${id.replace('_', ' ')}</b>：${RULE_TEXT[id] || '（RULE_TEXT 里没有这条，引擎与页面已经不同名）'}`;
    target.appendChild(li);
  }
  return ids.length;
}

function onWin() {
  session.stop();
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
  if (blocked()) return null;
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
  if (!game || busy || session.paused) return null;
  const step = game.undo();
  if (!step) {
    say('没有可撤的步：这一局还没画过任何一条界。');
    syncAll();
    return null;
  }
  anim.clear();
  say('');
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

// 画/擦一条段：k 是段号（segmentTable 的下标），target 省略就是取反。
// 被 game.js 挡回来的那一步会把挡回来的那句话写进状态行——玩家得看得见"为什么没落子"。
function setSeg(k, target = null) {
  if (blocked()) return null;
  const r = game.toggleSeg(k, target);
  if (r.refused) {
    say(r.refused);
    Sound.refuse();
    syncAll();
    return null;
  }
  if (r.noop) return null;
  say('');
  flash(k, r.to === BORDER ? Palette.accent : Palette.info);
  afterStep(r.to === BORDER ? 'place' : 'erase');
  return r;
}

// 键盘那条路：动作发生在"光标这一格与那一面邻居之间"，落子形状与指针完全相同。
function setDir(dir) {
  if (blocked()) return null;
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
  flash(k, r.to === BORDER ? Palette.accent : Palette.info);
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
  return openPuzzle(puzzle, resume);
}

// 同步开局：与 begin() 用同一份 build() 出题、同一个 openPuzzle() 落盘，唯一的区别是不给
// busy 浮层让帧。浮层是给"人眼等得起"那条路用的；而程序化入口与量具要的是——调用返回时
// 这一局已经在盘上了。seed 缺省照旧取存档游标（peekSeed），页面上印的 seed 因此还是真话。
function startLevel(opts = {}) {
  const { tier = TIERS[0].key, seed = null } = typeof opts === 'object' && opts ? opts : {};
  const spec = tierFor(typeof opts === 'number' ? ((TIERS[opts] || TIERS[0]).key) : tier);
  let request = seed;
  if (request === null || !Number.isInteger(request)) request = Store.peekSeed();
  let probe = request;
  let puzzle = null;
  for (let k = 0; k < 5 && !puzzle; k++) {
    puzzle = build(spec, probe);
    if (!puzzle) probe++;
  }
  if (!puzzle) {
    announce(`这一档连着 5 号 seed 都没出货（${spec.name} ${spec.R}×${spec.C}），换一档试试。`);
    return null;
  }
  return openPuzzle(puzzle, null);
}

// 题面到手之后的"落盘"只有一处实现。begin() 是玩家那一腿（出题要给 busy 浮层让帧，所以是
// async），startLevel() 是程序化入口（同步），两条都汇进这里。它是 begin 的尾巴时，
// "开局"在仓里有两种形状；抽出来之后 anim.reset() / session.start() / writeHash() 这套
// 复位只有一份写法——漏一处就是上一局的耗时渗进这一局的纪录，而这种漏要玩到第二局才看得见。
function openPuzzle(puzzle, resume = null) {
  game = new Game(puzzle);
  // 换一局 = 回显与计时一起从零：anim 里留着上一局的脉冲、或 session 里留着上一局的耗时，
  // 都会变成"这一局"的读数——纪录与屏幕上的 00:00 从此各说一套。
  anim.reset();
  // 悬停强调也归零：hoverSeg 只有 pointerleave 会清，而换一局时鼠标往往一直停在盘面上，
  // 于是上一局某条段的虚线会原样亮在这一局上（段的编号在新题面下指向别的东西）。
  hoverSeg = -1;
  el.winVeil.hidden = true;
  const from = resume ? resume.elapsedMs || 0 : 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    game.loadCodes(resume.cells);
    game.cursor = Math.min(resume.cursor || 0, game.B.cells.length - 1);
  } else {
    game.cursor = game.B.id(0, 0);
  }
  nextSeed(puzzle.seed);
  announce('');
  show('game');
  session.start(from);
  // 暂停态下点"换一局"：上一局按下的声音 hold 必须撤掉（要不要仍静音由设定判，不由这里判）。
  Sound.resumeAudio();
  syncPauseVeil();
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
  if (location.hash === h) return;
  // file:// 的文档 origin 是 'null'，replaceState 在那儿直接抛 SecurityError，而这一仓承诺
  // 双击 index.html 就能玩：hash 是深链糖，不是玩法状态（盘面、耗时、纪录全在存档里）。
  // 所以写不上就是不写，绝不退化成去动 location.hash ——那会触发 hashchange，
  // 把 begin() 再叫一次，等于为了一个装饰把自己的局重开掉。
  try { history.replaceState(null, '', h); } catch (err) { /* 深链糖在 file:// 下失效，玩法不受影响 */ }
}

// 只认这一种形状：#t=<档>&s=<seed>。其余的 hash（例如闸里用来证明"片段导航不是重载"的
// #gate-fragment-nav）一律不碰盘面。
function parseHash() {
  const m = /^#t=([a-z]+)&s=(\d+)$/.exec(location.hash || '');
  if (!m) return null;
  const seed = Number(m[2]);
  return { tier: m[1], seed: Number.isInteger(seed) && seed >= 1 ? seed : null };
}

// 当前显示的是哪一视图（'menu' / 'game'）。以前这件事只写在 DOM 上（两个视图的 hidden），
// 问"现在在不在局里"就得反过来读 el.viewMenu.hidden ——那是把界面当状态源。这一份是同一件事
// 的正名，唯一的写入点就是下面这一行。
let screen = 'menu';

function show(which) {
  screen = which;
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    // 停表 + 结算 + 存档：三条都在这一条腿上，任何一条留在调用方都会漏（三个不同的按钮
    // 都能回选档，其中一个忘了 flushResume 就等于"回选档丢掉这一局"）。
    flushResume();
    session.stop();
    Sound.resumeAudio();
    syncPauseVeil();
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
  fillRules(el.rules, MENU_RULES);
  fillRules(el.howtoRules, MENU_RULES);
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
  // 这里问的是"这一局还在屏幕上"，不是"计时还在走"：暂停中的局同样在屏幕上，
  // 用 session.running() 判会让暂停后回选档时多出一张继续自己已摆着的那局的卡片。
  const live = !!game && game.status !== 'won' && !el.viewMenu.hidden;
  if (!r || (live && r.seed === game.puzzle.seed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} ${r.R}×${r.C} 的一局`;
  el.resumeMeta.textContent = `seed ${r.seed} · ${fmtMs(r.elapsedMs)} · ${r.moves} 步 · 提示 ${r.hints} 次`;
}

function applySettings() {
  const soundOn = !!Store.setting('sound');
  // 静音是挂起上下文（Sound.setMuted），不是把 gain 拧到 0：前者能被外部读成
  // ctx.state === 'suspended' 且一个振荡器都不建，后者只是"听起来没声"。
  Sound.setMuted(!soundOn);
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  document.body.dataset.muted = String(!soundOn);
  document.body.dataset.paused = String(session.paused);
  el.btnSound.setAttribute('aria-pressed', String(soundOn));
  el.btnSound.textContent = soundOn ? '音效 开' : '音效 关';
  el.btnMotion.setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  el.btnMotion.textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer：一次点要么落在段上（画界/擦界），要么落在格里（移光标）----
// 两者由同一个几何来源判（render/board.js 的 segLine ↔ hitSegment），
// 所以"画面上那条虚线"与"点下去吃到的段"不可能各说一套。

let drag = null; // { target, seen:Set<段号> }：拖过一串段时，每一段都落向同一个目标态
let hoverSeg = -1;

function onPointerDown(ev) {
  if (blocked()) return;
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
  if (blocked()) return;
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

// 回落只挂在**根本没有 PointerEvent** 的引擎上（内嵌 webview 那一类）。条件是问窗口要的，
// 不是 try/catch 造出来的：两边都挂的话，支持的引擎里一次点按会同时走到 pointerdown 与
// mousedown，那条界就被画了两遍——而"画两遍"在这盘上意味着擦掉，落子直接反了。
if (!('PointerEvent' in window)) {
  // 坐标取自触点，preventDefault 必须打回**事件本身**：Touch 上没有这个方法，
  // 照着 ev.preventDefault() 抄一句就会在落子第一下抛穿（实测 touchstart 画 0 条界）。
  const wrap = (ev, point, pointerType) => ({
    clientX: point.clientX, clientY: point.clientY, pointerType, button: 0, buttons: 1, isPrimary: true,
    target: ev.target, preventDefault: () => ev.preventDefault(),
  });
  const first = (ev) => (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
  // passive:false 是给 touchstart/touchmove 的：默认 passive 下 preventDefault 会被忽略，
  // 于是页面照旧滚动、还补一发 synthetic click，界画到一半被滚走。
  el.canvas.addEventListener('touchstart', (ev) => onPointerDown(wrap(ev, first(ev), 'touch')), { passive: false });
  el.canvas.addEventListener('touchmove', (ev) => onPointerMove(wrap(ev, first(ev), 'touch')), { passive: false });
  el.canvas.addEventListener('touchend', onPointerUp);
  el.canvas.addEventListener('touchcancel', onPointerUp);
  el.canvas.addEventListener('mousedown', (ev) => onPointerDown(wrap(ev, ev, 'mouse')));
  el.canvas.addEventListener('mousemove', (ev) => onPointerMove(wrap(ev, ev, 'mouse')));
  window.addEventListener('mouseup', onPointerUp);
}

el.pad = {
  up: $('#btn-edge-up'),
  down: $('#btn-edge-down'),
  left: $('#btn-edge-left'),
  right: $('#btn-edge-right'),
};
for (const [dir] of DIRS) el.pad[dir].addEventListener('click', () => setDir(dir));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', restart);
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', restart);
el.btnPause.addEventListener('click', togglePause);
el.btnPause2.addEventListener('click', () => setPaused(false));
el.btnPauseMenu.addEventListener('click', () => show('menu'));
el.btnFull.addEventListener('click', toggleFullscreen);
el.btnHowto.addEventListener('click', () => setHowto());
el.btnHowtoClose.addEventListener('click', () => setHowto(false));
document.addEventListener('fullscreenchange', () => { syncFullscreen(); dirty = true; });
document.addEventListener('webkitfullscreenchange', () => { syncFullscreen(); dirty = true; });
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume(tierOf);
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
// 音效开关：先写设定，再由 applySettings 决定要不要挂起上下文。最后那一声 place() 是证人——
// 开着时它建一个振荡器，刚静音的那一下必须一个都不建（Sound.voices() 计数不动）。
function toggleSound() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.place();
  return !Sound.isMuted();
}
el.btnSound.addEventListener('click', toggleSound);
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  anim.reset();
  session.reset();
  show('menu');
});

const DIRKEY = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
// 焦点在可激活控件上时，Enter/Space 是"按下这个控件"的浏览器语义，游戏不许抢。
const onCtrl = (ev) => !!(ev.target && /^(button|a|input|select|textarea)$/i.test(ev.target.tagName || ''));

window.addEventListener('keydown', (ev) => {
  keys.seen++;
  keys.last = ev.key;
  // 门禁要能分辨"浏览器把一次按键发了 N 遍"（自动重复）和"游戏漏收"：两者都会让
  // "派发 4 个 → 到达 4 个"这条断言红，但只有前者会带上 repeat 标志。
  if (ev.repeat) keys.repeated++;
  keys.by[ev.key] = (keys.by[ev.key] || 0) + 1;
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key;
  const inGame = !el.viewMenu.hidden;
  // 应用级：静音、全屏、玩法浮层在选档页同样成立（它们不是一局里的动作）。
  if (k === 'm' || k === 'M') {
    toggleSound();
    keys.handled++;
    return;
  }
  if (k === 'f' || k === 'F') {
    toggleFullscreen();
    keys.handled++;
    return;
  }
  if (k === '?' || k === '/') {
    setHowto();
    ev.preventDefault();
    keys.handled++;
    return;
  }
  if (k === 'Escape') {
    if (howtoOpen) setHowto(false);
    else if (session.paused) setPaused(false);
    keys.handled++;
    return;
  }
  if (k === 'Enter' && !onCtrl(ev)) {
    if (howtoOpen) setHowto(false);
    else if (session.paused) setPaused(false);
    else if (!inGame) begin({ tier: TIERS[0].key });
    keys.handled++;
    return;
  }
  if (k === ' ' && !onCtrl(ev) && inGame && game) {
    setPaused(!session.paused);
    ev.preventDefault();
    keys.handled++;
    return;
  }
  if (!game || busy) return;
  if (k === 'p' || k === 'P') {
    if (inGame) setPaused(!session.paused);
    keys.handled++;
    return;
  }
  if (k === 'r' || k === 'R') {
    if (inGame) restart();
    keys.handled++;
    return;
  }
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
  if (blocked()) return;
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

// ---- 主循环：全仓唯一的帧源 ----
// 这一条腿上只挂三件事：动效按**时长**推进、状态变过之后补一次画、计时读数每秒重写一次。
// 原先这三件各有自己的时间源（setInterval 走秒 + setTimeout 清回显），"暂停"就得同时按住三处
// 才成立——而墙钟定时器根本停不住：暂停之后回显照样在玩家看不见的时候退完了。
// 暂停/停表这一支只 reanchor 不 step：不推进 == 不动，这是行为不是说法。
let rafId = 0;
function loop(ts) {
  rafId = requestAnimationFrame(loop);
  if (!session.running()) {
    anim.reanchor(ts);
    return;
  }
  if (anim.step(ts) > 0) dirty = true;
  if (dirty) draw();
  // 读数只在秒真的换过之后重写：每帧写 textContent 让这一行每秒闪 60 次，量不出更多信息。
  const sec = Math.floor(clock() / 1000);
  if (sec !== lastShownSec && el.viewGame.hidden !== true) {
    lastShownSec = sec;
    el.time.textContent = fmtMs(clock());
  }
}

applyThemeVars();
applySettings();
syncKeycaps();
syncFullscreen();
renderMenu();
if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(loop);

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
  // ---- 行为层读数：闸判的是这四条承诺真不真，而它们各自只有一份真状态 ----
  // 暂停：elapsed 冻住 + 声音 held + 浮层在几何上盖住画布，三者都由这里同一份 session/Sound 给。
  paused: () => session.paused,
  setPaused,
  togglePause,
  session: () => session.state(),
  // 动效时钟：frames 是循环活着的证人，time/items 是"包络只吃 dt"的证人（§3 三档对拍读的就是它）。
  anim: () => ({ ...anim.state(), raf: rafId, reduced: prefersReducedMotion() }),
  fullscreen: () => !!(document.fullscreenElement || document.webkitFullscreenElement),
  toggleFullscreen,
  howto: () => howtoOpen,
  setHowto,
  // 真静音的四个证人：设定态、会话 hold、上下文状态、振荡器计数（静音态下必须一个都不建）。
  sound: () => ({ muted: Sound.isMuted(), held: Sound.held(), ctx: Sound.ctxState(), voices: Sound.voices() }),
  resetVoices: () => Sound.resetVoices(),
  keycaps: () => KEYCAPS.map(([key, what]) => ({ key, what })),
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

// ---- 关卡内三档对拍要读的那一份状态：平铺挂在 window 上，取值全部现从三份真状态里取 ----
//
// 三条口径，都是实测出来的：
//  * 这里不留第二份可写的分钟。elapsedMs 走 session、animTime/pulses 走 anim、盘面计数走 game，
//    每一个都是现取——留一份副本就是第四个时间源，对拍会量到副本自己。
//  * 只挂对**虚拟时长**敏感的量，帧计数一个都不挂（anim.frames、rafId 都不在这里）。它们按帧率
//    线性放大：30/60/120Hz 下 90/180/360，挂上去就是让尺把"采样率"读成"玩法推进"，凭空判红——
//    §3 把"仅帧计数"列成不通过，说的就是这件事。
//  * 相位只由 state 这一个键承担，而且互斥：菜单/暂停/通关都写成尺认得的词，绝不与 'playing'
//    同时出现。两个相位词并存会让判据退化成 UNKNOWN，那正是"仅标题态"洗不白的那一支。
window.DoubleChoco = {
  get state() {
    if (screen !== 'game' || !game) return 'menu';
    if (game.status === 'won') return 'win';
    return session.paused ? 'pause' : 'playing';
  },
  get elapsedMs() { return Math.round(clock()); },
  get animTime() { return anim.time; },
  get pulses() { return anim.items.size; },
  get moves() { return game ? game.state().moves : 0; },
  get hints() { return game ? game.state().hints : 0; },
  get cuts() { return game ? game.state().cuts : 0; },
  get remaining() { return game ? game.state().remaining : 0; },
  get regions() { return game ? game.state().regions : 0; },
  get conflicts() { return game ? game.state().conflicts : 0; },
  get cursor() { return game ? game.cursor : 0; },
  get rows() { return game ? game.R : 0; },
  get cols() { return game ? game.C : 0; },
  // 两个入口，两条都是"把玩家已经走过的门再开一次"，不新建任何一条开局/恢复路径：
  //  * start = startLevel()：与点档位卡片/按 Enter 落到的 begin() 共用同一份 build() 出题、
  //    同一个 openPuzzle() 落盘，只差"不给 busy 浮层让帧"。必须是同步这一条——量具在调用返回的
  //    同一刻读 state，而 begin() 是 async（await 至少欠一个微任务，它不去 flush），
  //    于是它永远读到一个菜单；busy 浮层本来是给"人眼等得起"那条路用的。
  //    接一个可选的档位序号或 {tier, seed}，是因为量具按 [] / [0] / [1] / [2] 四种试调形去撞。
  //  * resume = HUD 暂停键的反向（setPaused(false)）。量具的尾拍会撞 Space，
  //    而 Space 在这仓里是暂停——没有反向门，一次撞键就把关卡内物理打成静止快照。
  start(level = null) {
    if (typeof level === 'number') return startLevel({ tier: (TIERS[level] || TIERS[0]).key });
    if (level && typeof level === 'object') return startLevel(level);
    return startLevel({});
  },
  resume() { return setPaused(false); },
  // 探针与任何外部量具读状态只走这一份；window.dc 是给仓内自己的闸用的函数面。
  get seed() { return game ? game.state().seed : 0; },
  // 底纹到底载没载进来：浏览器那一腿只看像素会分不清"纹理失败退了纯色"与"纹理本来就是这么淡"。
  // 读数来自 js/render/board.js 的加载结算，不是再建一份状态。
  get texturesReady() { return boardTexLoaded; },
  // 指针悬停强调的那一条段（-1 = 没有）。它是画布上唯一由指针位置决定的读数，
  // 所以"换一局之后还亮着上一局某条段"这种残留，必须由这里能被读到，node 侧才复验得了。
  get hover() { return hoverSeg; },
};

// 同一个对象，两个名字：`window.<GameName>` 是给玩家与调试用的正名，而官方量具
// （cos_frame_probe.js 的 findGame）只认三条通用形——window.game / window.Game / 带 update()
// 的对象。指过去而不是再造一份：这里没有第二状态源，两个名字读到的就是上面那同一个快照。
// 注：这条赋值不会改脚本里裸 `game` 的含义——顶层 `let game` 是 global lexical 绑定，
// 优先级高于全局对象属性，脚本内部的 `game` 一直是那个 Game 实例。
window.game = window.DoubleChoco;
