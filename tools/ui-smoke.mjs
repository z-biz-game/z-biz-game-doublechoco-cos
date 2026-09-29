// 界面层的 node 烟雾闸：js/ui/game.js（交互状态机）+ js/render/board.js（作画与命中）。
//
// 为什么要有这一份，而不是等浏览器闸：浏览器那一腿慢，而且它能看见像素却不一定点得准。
// 这一段在毫秒级钉住几件浏览器不容易说清的事（每一段的段名就是它自己的承诺）：
//   ① 判据同源：官方例题的解答（从 Nikoli 页解答图量出的那批粗实线）在界面上必须判"通关"，
//      用的是 rules.js 那份 clauses()，不是界面另写的一套。
//   ② 画的 == 点的：board.js 的 segLine 中点必须被 hitSegment 认回同一条段（逐段全数），
//      格心既不是段也要认得回自己那一格。两者共用一份几何，这条不成立就是"点下去偏一格"。
//   ③ 提示不越权：solveWithLogic 每走一步都由铅笔点名，通关时 0 冲突，
//      而且它落下的段串必须与唯一解的段串逐字符相同——"过判据"与"等于答案"确实同时成立。
//   ④ 续局走的是生产路径：js/main.js 用的 tiers.js rebuild()（存档不带解，解由 judge() 当场重证），
//      重证出的块表、推理轮数必须与出题时逐值相同，改过的数字必须被当场拒。
// 坐标一律要求有限数：canvas 遇到 NaN 不报错，只是什么都不画，那正是"看着对、界没画"的形态。

import { readFileSync } from 'node:fs';
import { OFFICIAL, OFFICIAL_SOLUTION, blocksFromLabel, eqRel } from '../js/engine/rules.js';
import { TIERS, tierFor, build, rebuild, GEN_BUDGET_MS } from '../js/engine/tiers.js';
import { Game, puzzleFromParts, BORDER, OPEN, segKey, segmentTable } from '../js/ui/game.js';
import { BoardView, layoutFor } from '../js/render/board.js';
import { Cell, Hit, Palette } from '../js/theme.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? ' :: ' + extra : ''}`); }
};
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// 出货盘一号一号往前找：这一份闸要的是"真盘"，不是随便一块底纹。
// 找不到就当场红——那说明这一档出不了货，比让后面十几条断言在 null 上炸有用。
function ship(tier, from = 1, cap = 24) {
  for (let seed = from; seed < from + cap; seed++) {
    const pz = build(tier, seed);
    if (pz) return pz;
  }
  ok(`${tier.key} 从 seed ${from} 起 ${cap} 号内出得了货`, false);
  return null;
}

// ---- 假 canvas：只记账，不画像素。每次 stroke 都带上几何、线宽与虚线状态 ----
function makeRecorder(w, h) {
  const rec = { strokes: [], texts: [], clips: 0, save: 0, restore: 0, bad: [], off: [] };
  const chk = (fn, args) => {
    for (const a of args) {
      if (typeof a !== 'number') continue;
      if (!Number.isFinite(a)) rec.bad.push(`${fn}(${args.join(',')})`);
    }
  };
  const inBox = (x, y) => { if (x < -1 || y < -1 || x > w + 1 || y > h + 1) rec.off.push(`${x.toFixed(1)},${y.toFixed(1)}`); };
  let cur = null;
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: '', textBaseline: '', lineCap: 'butt',
    __dash: [],
    clearRect: (...a) => chk('clearRect', a),
    setTransform: (...a) => chk('setTransform', a),
    save: () => { rec.save++; },
    restore: () => { rec.restore++; },
    beginPath: () => { cur = null; },
    closePath: () => {},
    moveTo: (x, y) => { chk('moveTo', [x, y]); cur = { x1: x, y1: y, x2: x, y2: y }; },
    lineTo: (x, y) => { chk('lineTo', [x, y]); if (cur) { cur.x2 = x; cur.y2 = y; } },
    rect: (...a) => { chk('rect', a); },
    arc: (...a) => chk('arc', a.slice(0, 5)),
    arcTo: (...a) => chk('arcTo', a.slice(0, 5)),
    clip: () => { rec.clips++; },
    fill: () => {},
    fillRect: (...a) => chk('fillRect', a),
    strokeRect: (...a) => chk('strokeRect', a),
    stroke: () => {
      if (!cur) return;
      rec.strokes.push({ ...cur, lw: ctx.lineWidth, dash: [...ctx.__dash] });
      inBox(cur.x1, cur.y1); inBox(cur.x2, cur.y2);
    },
    setLineDash: (a) => { ctx.__dash = a || []; },
    fillText: (t, x, y) => { chk('fillText', [x, y]); rec.texts.push({ t, x, y, font: ctx.font }); },
    measureText: () => ({ width: 0 }),
  };
  return { ctx, rec };
}

function makeCanvas(w, h) {
  const { ctx, rec } = makeRecorder(w, h);
  const canvas = {
    style: {}, width: 0, height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
  };
  return { canvas, rec };
}

global.window = { devicePixelRatio: 2 };

// "每条该画的界都有具名证人"——hint() 落子前要在 trace 里找到跨越同两个类的那次规则开火，
// 找不到就不落子。这一条如果被破坏，卡住的地方会分不清是"推不动"还是"证人没找到"，
// 所以它在闸里逐档数出来，而不是留在 game.js 的注释里当说法。
function witnessCoverage(g) {
  const { p } = g.pencilNow();
  const part = p.partition;
  const same = (a, b) => part.get(a) === part.get(b);
  let total = 0, missing = 0;
  for (let k = 0; k < g.segs.length; k++) {
    const [i, j] = g.segs[k];
    if (g.st[k] === BORDER || p.decided.get(segKey(i, j)) !== 'b') continue;
    total++;
    if (!p.trace.some((t) => t.kind === 'b' && ((same(t.i, i) && same(t.j, j)) || (same(t.i, j) && same(t.j, i))))) missing++;
  }
  return { total, missing };
}

// ---- ① 官方例题 ----
head('1. 官方 4×4 例题：解答图在界面上判"通关"');
{
  const spec = { key: 'official', name: '官方例题', R: OFFICIAL.R, C: OFFICIAL.C, capWork: TIERS[0].capWork };
  const tiling = blocksFromLabel(OFFICIAL_SOLUTION, OFFICIAL.C);
  const g = new Game(puzzleFromParts(spec, OFFICIAL.gray, OFFICIAL.num, tiling, 'nikoli-4x4'));
  ok('段表条数 = R(C-1)+(R-1)C', g.segs.length === OFFICIAL.R * (OFFICIAL.C - 1) + (OFFICIAL.R - 1) * OFFICIAL.C, `${g.segs.length}`);
  ok('开局不报违反（一条界都没画时那份宽容）', g.errs.length === 0 && g.bad.size === 0);
  ok('开局不判赢', g.status === 'playing' && g.cuts === 0);
  const solCodes = g.solutionCodes();
  const solCuts = [...solCodes].filter((c) => c === '1').length;
  ok('解答图的区界条数与段串一致（解答图是图片量的，不是计数器给的）', solCuts === 11, solCodes);
  g.loadCodes(solCodes);
  ok('照解答图画完 → 判据 0 条', g.errs.length === 0, g.errs.join(' | '));
  ok('照解答图画完 → mismatch 0', g.mismatch === 0);
  ok('照解答图画完 → 通关', g.status === 'won', JSON.stringify(g.winFacts()));
  ok('通关读数是三条各绿', (() => { const w = g.winFacts(); return w.errs === 0 && w.mismatch === 0 && w.cuts > 0 && w.ok; })());
  const one = [...solCodes].findIndex((c) => c === '1');
  g.loadCodes(solCodes.slice(0, one) + '0' + solCodes.slice(one + 1));
  ok('擦掉一条界 → 回到未通关且有违反', g.status === 'playing' && g.errs.length > 0, `${g.errs.length} 条`);
}

// ---- ② 画的 == 点的 ----
head('2. 几何同源：hitSegment 认得回每一条画出来的段');
function geomLeg(tier, seedFrom) {
  const pz = ship(tier, seedFrom);
  if (!pz) return;
  const g = new Game(pz);
  const avail = { w: 520, h: 420 };
  const { canvas, rec } = makeCanvas(avail.w, avail.h);
  const view = new BoardView(canvas);
  const geo = view.resize(g, avail.w, avail.h);
  const l = layoutFor(g.R, g.C, avail.w, avail.h);
  ok(`${tier.key} resize 与 layoutFor 同一个 cell/原点`, geo.cell === l.cell && geo.x === l.pad && geo.dpr === 2, `${geo.cell}/${l.cell}`);
  ok(`${tier.key} cell 落在 theme 的上下限之间`, geo.cell >= Cell.min && geo.cell <= Cell.max, `${geo.cell}`);
  let wrong = [];
  for (let k = 0; k < g.segs.length; k++) {
    const s = view.segLine(k);
    const back = view.hitSegment((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2);
    if (back !== k) wrong.push(`段${k}→${back}`);
  }
  ok(`${tier.key} 每一条段的中点都命中自己`, wrong.length === 0, wrong.slice(0, 4).join(' '));
  const tol = Math.min(Math.max(5, geo.cell * Hit.segRatio), geo.cell * Hit.maxCell);
  const s0 = view.segLine(0);
  const outK = view.hitSegment((s0.x1 + s0.x2) / 2 + tol + 2, (s0.y1 + s0.y2) / 2);
  let cellHits = [];
  for (const i of g.B.cells) {
    const r = view.cellRect(i);
    const k = view.hitSegment(r.x + r.size / 2, r.y + r.size / 2);
    if (k >= 0) cellHits.push(`${i}→${k}`);
  }
  ok(`${tier.key} 格心不被认成段（点格子=选光标）`, cellHits.length === 0, cellHits.slice(0, 4).join(' '));
  ok(`${tier.key} 离开命中容差就不是段`, outK === -1, `tol=${tol.toFixed(1)} → ${outK}`);
  let offCell = 0;
  for (const i of g.B.cells) {
    const r = view.cellRect(i);
    if (view.hitCell(r.x + r.size / 2, r.y + r.size / 2) !== i) offCell++;
  }
  ok(`${tier.key} 格心命中的就是那一格`, offCell === 0, `偏了 ${offCell} 格`);
  ok(`${tier.key} 盘外既不是段也不是格`, view.hitSegment(-4, -4) === -1 && view.hitCell(geo.w + 40, geo.h + 40) === -1);

  g.loadCodes(g.solutionCodes());
  rec.strokes.length = 0; rec.texts.length = 0; rec.bad.length = 0; rec.off.length = 0;
  rec.clips = 0; rec.save = 0; rec.restore = 0;
  view.draw(g);
  ok(`${tier.key} 作画无 NaN/Infinity 坐标`, rec.bad.length === 0, rec.bad.slice(0, 3).join(' '));
  ok(`${tier.key} 落笔都在这块画布内`, rec.off.length === 0, rec.off.slice(0, 3).join(' '));
  ok(`${tier.key} 每个题面数字都画了一次`, rec.texts.length === g.B.num.size, `${rec.texts.length}/${g.B.num.size}`);
  const solidW = Math.max(2.5, geo.cell * Cell.borderScale);
  const dotW = Math.max(1, geo.cell * Cell.dotScale);
  const solids = rec.strokes.filter((s) => s.dash.length === 0 && Math.abs(s.lw - solidW) < 1e-9);
  const dots = rec.strokes.filter((s) => s.dash.length === 2 && Math.abs(s.lw - dotW) < 1e-9);
  // 一条段在画布上是**两半**：board.js 的 sideStroke 对实线与点线都各画一次、各自 clip 进相邻的
  // 那一格。这不是铺张——两半的墨不一样（灰底 border / 纸底 borderOnPaper），第 6 段拿题面自己的
  // 色差钉住"四种墨都分得开"，并留了一条"两半同色会沉底"的负样本。layout 腿在真像素上逐段两侧
  // 量色距钉那一层，这里钉的是"两半都真的落了笔"，所以条数一定是 2×。
  ok(`${tier.key} 每一条界都画了两半（实线条数 == 已画区界 ×2）`, solids.length === 2 * g.cuts, `${solids.length} vs ${2 * g.cuts}`);
  ok(`${tier.key} 每条实线都是轴对齐的整段`, solids.every((s) => s.x1 === s.x2 || s.y1 === s.y2));
  ok(`${tier.key} 未画的段两半都是点线（点线条数 == 未画段 ×2）`, dots.length === 2 * (g.segs.length - g.cuts), `${dots.length} vs ${2 * (g.segs.length - g.cuts)}`);
  ok(`${tier.key} 每一半都被 clip 进自己那一格（clip 数 == 落笔数）`, rec.clips === 2 * g.segs.length && rec.clips === solids.length + dots.length,
    `clips=${rec.clips} / 段=${g.segs.length} / 实线+点线=${solids.length + dots.length}`);
  ok(`${tier.key} save/restore 配平`, rec.save === rec.restore, `${rec.save}/${rec.restore}`);

  rec.strokes.length = 0; rec.bad.length = 0;
  const pulseK = g.segs.findIndex(([i, j]) => g.st[g.segIx.get(segKey(i, j))] === BORDER);
  view.draw(g, { pulse: { seg: pulseK }, hover: 0 });
  const em = Math.max(5, geo.cell * 0.19);
  const emph = rec.strokes.filter((s) => s.lw >= em - 1e-9).length;
  ok(`${tier.key} 提示与悬停的段都画得出来`, emph === 2 && rec.bad.length === 0, `${emph} 条${rec.bad.length ? ' · ' + rec.bad.slice(0, 2).join(' ') : ''}`);
  // 有违反时红要出现在画布上（bad 的格被填了红底）
  g.loadCodes('0'.repeat(g.segs.length));
  g.toggleSeg(0, BORDER);
  g.toggleSeg(1, BORDER);
  rec.strokes.length = 0;
  view.draw(g);
  ok(`${tier.key} 画错时画面有违反区可指（bad 非空且未通关）`, g.bad.size > 0 && g.status === 'playing');
}
TIERS.forEach((t, ix) => geomLeg(t, 1 + ix * 3));

// ---- ③ 零猜测：铅笔一路推到通关 ----
head('3. 零猜测：每档一盘由铅笔点名的界推到通关');
for (const t of TIERS) {
  const pz = ship(t, 1);
  if (!pz) continue;
  const g = new Game(pz);
  ok(`${t.key} 候选池非空`, g.poolFull.total > 0, `${g.poolFull.total}`);
  const cov0 = witnessCoverage(g);
  ok(`${t.key} 空盘上"该画的界"都有具名证人（${cov0.total - cov0.missing}/${cov0.total}）`, cov0.missing === 0 && cov0.total > 0,
    `缺证人 ${cov0.missing}`);
  ok(`${t.key} 要画的界数 == 出题器数的 cuts`, g.wantCuts === pz.stats.cuts, `${g.wantCuts} vs ${pz.stats.cuts}`);
  const run = g.solveWithLogic({ cap: 1200 });
  ok(`${t.key} 铅笔一路推到通关（${run.hints} 步提示）`, run.won, `status=${run.status} steps=${run.steps}`);
  ok(`${t.key} 通关时 0 冲突`, g.errs.length === 0 && g.bad.size === 0, g.errs.slice(0, 2).join(' | '));
  ok(`${t.key} 铅笔落下的段串 == 唯一解段串`, g.codes() === g.solutionCodes());
  ok(`${t.key} 用到的规则都是具名的`, run.rules.length > 0 && run.rules.every((r) => /^[NX]\d/.test(r)), run.rules.join(','));
  const before = g.cuts;
  g.undo();
  ok(`${t.key} 撤销一步界少一条`, g.cuts === before - 1 && g.status === 'playing', `${g.cuts}/${before}`);
  ok(`${t.key} 撤销不退还提示次数`, g.hints === run.hints);
  const covGap = witnessCoverage(g);
  ok(`${t.key} 只差一条界时仍点得出名（${covGap.total - covGap.missing}/${covGap.total}）`, covGap.missing === 0 && covGap.total >= 1,
    JSON.stringify(covGap));
  g.loadCodes('0'.repeat(g.segs.length));
  const wrongK = g.segs.findIndex(([i, j]) => g.solRel.has(Math.min(i, j) + ':' + Math.max(i, j)));
  g.toggleSeg(wrongK, BORDER);
  const h = g.hint();
  ok(`${t.key} 多画一条界 → 提示报冲突而不是报下一步`, !!h && !!h.conflict && !/必须画界|不能画界/.test(h.conflict), JSON.stringify(h || {}).slice(0, 90));
  ok(`${t.key} 冲突点名到具体段`, !!h && Array.isArray(h.segs) && h.segs.length > 0);
  g.undo();
  ok(`${t.key} 撤销冲突后回到空盘`, g.cuts === 0);
}

head('4. 键盘 / 拖拽 / 存档口径');
{
  const t = TIERS[0];
  const pz = ship(t, 1);
  const g = new Game(pz);
  g.cursor = g.B.id(0, 0);
  ok('盘边往外画被拒', !!g.toggleDir(g.cursor, 'up').refused && !!g.toggleDir(g.cursor, 'left').refused);
  const from = g.B.id(0, 0), to = g.B.id(0, 1);
  const r = g.toggleDir(from, 'right');
  ok('Shift+方向键画的正是那条段', !!r.step && g.st[g.segIx.get(segKey(from, to))] === BORDER);
  const k = g.segIx.get(segKey(from, to));
  ok('同一段再按一次是取反（擦回未画）', g.toggleSeg(k).to === OPEN && g.cuts === 0);
  const chain = [segKey(g.B.id(0, 1), g.B.id(0, 2)), segKey(g.B.id(0, 2), g.B.id(0, 3))]
    .map((s) => g.segIx.get(s)).filter((x) => x !== undefined);
  const moves0 = g.moves, steps0 = g.steps.length;
  for (const kk of chain) g.toggleSeg(kk, BORDER);
  ok('拖过的段都成界', chain.every((kk) => g.st[kk] === BORDER));
  ok('拖拽每段各记一步（撤销一次退一格）', g.steps.length === steps0 + chain.length && g.moves === moves0 + chain.length);
  while (g.steps.length > steps0) g.undo();
  ok('回到拖拽之前', chain.every((kk) => g.st[kk] === OPEN));
  const tbl = segmentTable(g.B);
  ok('段表与 segIx 一一对应（存档第 k 位就是这条段）', tbl.every(([i, j], ix) => g.segIx.get(segKey(i, j)) === ix) && g.segIx.size === tbl.length);
  g.loadCodes(g.solutionCodes());
  const snap = { tier: g.puzzle.tier, seed: g.puzzle.seed, codes: g.codes(), gray: [...g.B.gray], nums: Object.fromEntries(g.B.num), tiling: g.puzzle.tiling };
  const g2 = new Game(puzzleFromParts(tierFor(snap.tier), new Set(snap.gray), snap.nums, snap.tiling, snap.seed));
  g2.loadCodes(snap.codes);
  ok('续局读回来就是通关（判据当场重证，不存"赢没赢"）', g2.status === 'won' && g2.errs.length === 0);
  ok('续局的段总数与出题一致', g2.wantCuts === g.wantCuts);
  const src = readFileSync(new URL('../js/ui/game.js', import.meta.url), 'utf8');
  ok('胜负只问引擎的 B.check（界面不另写一套判据）',
    /rawErrs = this\.B\.check\(/.test(src) && /const errs = \(this\.rawErrs/.test(src));
  ok('提示只问铅笔（界面不直接读答案落子）',
    /const \{ p \} = this\.pencilNow\(\)/.test(src) && !/sol\.get|solutionCodes\(\)/.test(src.replace(/\n  solutionCodes\(\) \{[\s\S]*?\n  \}/, '')));
}

head('5. 续局的生产路径：存档不带解，解由 judge() 当场重证');
{
  // js/store.js 存的是 {gray, nums:[[i,v]…], cells(段串)}，**不含解**；js/main.js 的续局走 tiers.js 的
  // rebuild()。这一段钉的是那条生产路径（上面那条 puzzleFromParts 只证台架自己的拼装）。
  const eqset = (a, b) => {
    const x = eqRel(a), y = eqRel(b);
    return x.size === y.size && [...x].every((k) => y.has(k));
  };
  for (const t of TIERS) {
    const pz = ship(t, 1);
    const nums = [...pz.B.num.entries()];               // 与 store.saveResume 同一形状
    const t0 = Date.now();
    const rb = rebuild(t, [...pz.gray], nums, pz.seed);
    const ms = Date.now() - t0;
    ok(`${t.key} 续局重证过判据`, rb.ok, rb.why);
    ok(`${t.key} 重证出的块表 == 出题时的块表`, rb.ok && eqset(rb.puzzle.tiling, pz.tiling));
    // 同一盘、同一池：铅笔轮数必须逐值相同，否则"续上来的那一局"和昨天那局不是同一道题。
    ok(`${t.key} 续局的推理轮数 == 出题时实测轮数`, rb.ok && rb.proof.steps === pz.stats.steps, `${rb.proof && rb.proof.steps} vs ${pz.stats.steps}`);
    const g = new Game(rb.puzzle);
    ok(`${t.key} 续局盘可玩（段总数与要画的界都对）`, g.segs.length === segmentTable(g.B).length && g.wantCuts === pz.stats.cuts, `${g.wantCuts} vs ${pz.stats.cuts}`);
    // tiers.js 里那句"续局不必重付出题那笔成本"要有读数，不能只是说法：两条一起打印。
    console.log(`      \x1b[2m${t.key} 续局重证 ${ms} ms（出题实测 ${pz.stats.ms} ms）· 上限 ${GEN_BUDGET_MS} ms\x1b[0m`);
    ok(`${t.key} 续局重证耗时在界面预算内`, ms <= GEN_BUDGET_MS, `${ms} ms`);
    // 负面样本：把一个数字改成这一盘不可能兑现的值 ⇒ 必须当场拒，不能拼出一盘"答案由存档定义"的盘。
    const bad = rebuild(t, [...pz.gray], nums.map(([i, v], ix) => (ix === 0 ? [i, t.R * t.C] : [i, v])), pz.seed);
    ok(`${t.key} 改过的数字被当场拒`, !bad.ok, bad.ok ? '竟然拼出了盘' : bad.why);
  }
}

// ---- ⑥ 一条段为什么要画两半：墨与底的色距（token 层）----
head('6. 界与点线在两种底色上都分得开（js/render/board.js 的 sideStroke 那句理由由这里读）');
// 尺由题面自己给：灰格底与纸格底差多少，就是"一眼分得开"的量纲——与 layout 腿同一个口径
// （tools/scenarios.js 的 vis = round(gap * 0.25)）。这里量的是 token 层（渲染的地板），
// 浏览器那一腿量的是合完区域回显之后的真像素，两层各钉一头。
const chan = (s) => {
  const t = String(s).trim();
  if (t[0] === '#') return [1, 3, 5].map((k) => parseInt(t.slice(k, k + 2), 16));
  const n = t.match(/[\d.]+/g).map(Number);
  return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
};
const over = (fg, bg) => { const c = chan(fg); return [0, 1, 2].map((k) => Math.round(c[3] * c[k] + (1 - c[3]) * bg[k])); };
const cdist = (a, b) => a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0);
const GRAY = chan(Palette.gray), PAPER = chan(Palette.paper);
const RANK = cdist(GRAY, PAPER);
const vis = Math.round(RANK * 0.25);
console.log(`      \x1b[2m题面色差（尺）${RANK} ⇒ 可见门槛 ${vis}\x1b[0m`);
ok('题面两色的色差就是这把尺（灰与纸分得开）', RANK >= 120, RANK);
ok(`画了的界在灰格上分得开（border vs 灰底 ≥ ${vis}）`, cdist(chan(Palette.border), GRAY) >= vis, `${cdist(chan(Palette.border), GRAY)} vs ${vis}`);
ok(`画了的界在纸格上分得开（borderOnPaper vs 纸底 ≥ ${vis}）`, cdist(chan(Palette.borderOnPaper), PAPER) >= vis, `${cdist(chan(Palette.borderOnPaper), PAPER)} vs ${vis}`);
ok(`没画的点线在灰格上分得开（dot 合成 vs 灰底 ≥ ${vis}）`, cdist(over(Palette.dot, GRAY), GRAY) >= vis, `${cdist(over(Palette.dot, GRAY), GRAY)} vs ${vis}`);
ok(`没画的点线在纸格上分得开（dotOnPaper 合成 vs 纸底 ≥ ${vis}）`, cdist(over(Palette.dotOnPaper, PAPER), PAPER) >= vis, `${cdist(over(Palette.dotOnPaper, PAPER), PAPER)} vs ${vis}`);
// 负样本：这句才是"分两半、各挑一种墨"的理由。两半同用一枚近白 border 时，纸色那一半
// 沉进纸里（色距低于门槛）——玩家画了、判据认了，屏幕上什么都没有。这一行红就是那种写法回来了。
const cfBorder = cdist(chan(Palette.border), PAPER), cfDot = cdist(over(Palette.dot, PAPER), PAPER);
ok(`负样本成立：两半同色会沉底（border 落纸 ${cfBorder} / dot 落纸 ${cfDot}，都 < ${vis}）`, cfBorder < vis && cfDot < vis, JSON.stringify({ cfBorder, cfDot, vis }));

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}ui-smoke ${pass}/${pass + fail} 绿\x1b[0m`);
process.exit(fail ? 1 : 0);
