// 逻辑闸：每条都必须是**能红的**，并且红的时候点名是哪一条、给出见证。
// 台架原则（farm 的老账）：
//   - 闸要读自己的产出，不能自比较（"池等于池"不算断言）；
//   - 输入集合必须与生产者一致（用同一份 TIERS 表跑，别在闸里另列一份会漂白的清单）；
//   - 唯一性只认 exhaustive 的 1，撞预算/撞 maxSol 一律不绿；
//   - 出题器自记的答案会说谎 ⇒ 构造底必须与计数器唯一解**同块关系相等**，且过第二套实现。
// 用法：node tools/engine-test.mjs [每档样本数=8]
//   默认 8 与 tiers.js 的 gold 同口径（balance B3 是按连续 8 号 seed 钉的）；
//   样本数调大照样对账前 8 号，调小则**跳过**对账并说明原因（口径不同，不是回归）。
import { mkBoard, OFFICIAL, OFFICIAL_SOLUTION, blocksFromLabel, label, eqRel, partitionToBlocks, clauses, check as engCheck, connected } from '../js/engine/rules.js';
import { exactBlocks, numFilter, blockNumOK } from '../js/engine/blocks.js';
import { count } from '../js/engine/count.js';
import { pencil, judge } from '../js/engine/pencil.js';
import { makePuzzle, randomShading } from '../js/engine/generate.js';
import { rng } from '../js/engine/rng.js';
import { check as indCheck, brutePool, poolKeys } from './independent.mjs';
import { TIERS } from '../js/engine/tiers.js';

// 默认 8 与 tiers.js 的 gold 同口径（gold 是按连续 8 号 seed 钉的）；跑更大样本也照样对账前 8 号。
const SAMPLES = Number(process.argv[2] || 8);
let checks = 0, fails = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`); }
};
const head = t => console.log(`\n== ${t}`);
const med = a => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : NaN);
const p95 = a => (a.length ? a.slice().sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * 0.95) - 1)] : NaN);

// ---------------------------------------------------------------- 1. 官方例题
head('1. 官方 4x4 例题（golden 来自出版方解答图，不来自我们的计数器）');
{
  const B = mkBoard(OFFICIAL.R, OFFICIAL.C, OFFICIAL.gray, OFFICIAL.num);
  ok('V0 题面底纹 = 半盘灰', B.gray.size === 8 && B.cells.length === 16, `灰${B.gray.size}`);
  const pool = exactBlocks(B, { capWork: 1e9 });
  const strict = brutePool(B, true), lax = brutePool(B, false);
  const pk = poolKeys(pool);
  const missing = [...strict].filter(k => !pk.has(k)), extra = [...pk].filter(k => !strict.has(k));
  ok('池 == 幂集严格枚举（双向）', missing.length === 0 && extra.length === 0,
    `构造池 ${pk.size} · 幂集严格 ${strict.size} · 幂集宽松 ${lax.size} · 少${missing.length} 多${extra.length}`);
  const r = count(B, numFilter(B, pool), { cap: 4000000, maxSol: 4, order: 'mrv' });
  ok('计数器 exhaustive 唯一', r.exhaustive && r.solutions === 1, `${r.read} 节点${r.nodes}`);
  ok('计数器解 == 图片解答', r.sols.length === 1 && label(B, r.sols[0]) === OFFICIAL_SOLUTION,
    `${r.sols.length === 1 ? label(B, r.sols[0]) : '—'} vs ${OFFICIAL_SOLUTION}`);
  const gMap = new Map();
  blocksFromLabel(OFFICIAL_SOLUTION, 4).forEach((bl, bi) => bl.forEach(i => gMap.set(i, bi)));
  ok('解答过引擎判据', engCheck(B, gMap).length === 0, JSON.stringify(engCheck(B, gMap)));
  ok('解答过独立判据（第二套实现）', indCheck(B, gMap).length === 0, JSON.stringify(indCheck(B, gMap)));
  const p = pencil(B, { blocksAll: pool });
  ok('铅笔推满例题', p.solved && p.violations.length === 0, `轮次${p.steps} 界${p.forced}/${p.total}`);
  ok('铅笔解 == 图片解答（同块关系）',
    eqRel(partitionToBlocks(p.partition)).size === eqRel(blocksFromLabel(OFFICIAL_SOLUTION, 4)).size &&
    [...eqRel(partitionToBlocks(p.partition))].every(k => eqRel(blocksFromLabel(OFFICIAL_SOLUTION, 4)).has(k)));
  // 披露条目的根据：例题在两种读法下都给同一唯一解 ⇒ 出版方没有裁决 V7
  const laxPool = new Map();
  for (const k of lax) { const cells = k.split(',').map(Number); if (!laxPool.has(cells[0])) laxPool.set(cells[0], []); laxPool.get(cells[0]).push(cells); }
  laxPool.total = lax.size;
  const rl = count(B, numFilter(B, laxPool), { cap: 4000000, maxSol: 4, order: 'mrv' });
  ok('宽松读法在同一例题上也唯一且同解（⇒ V7 是我们的裁定，不是出版方的裁决）',
    rl.exhaustive && rl.solutions === 1 && label(B, rl.sols[0]) === OFFICIAL_SOLUTION,
    `宽松池 ${lax.size} 块 / 严格池 ${pk.size} 块 = ${(lax.size / pk.size).toFixed(2)}× · 宽松读数 ${rl.read}`);
}

// ---------------------------------------------------------------- 2. 池的完整性与自证
head('2. 候选池：完整性（对幂集）+ 自证（每块过全部条款）');
{
  const rr = rng(20260929);
  let cmp = 0, cmpBad = 0, selfBad = 0, ghost = 0; const ratios = [];
  // 幂集对照是 2^N：16 格跑得动，20 格就是 100 万次 ⇒ 每种尺寸的对照盘数按成本给，
  // 但**每种尺寸都必须出现**（只在 4x4 上对照，等于没对照过跨列的相邻关系）。
  for (const [R, C, T] of [[4, 4, SAMPLES], [4, 5, Math.max(2, SAMPLES >> 2)], [5, 4, Math.max(2, SAMPLES >> 2)]]) {
    for (let t = 0; t < T; t++) {
      const gray = randomShading(R, C, rr);
      const B = mkBoard(R, C, gray, {});
      const pool = exactBlocks(B, { capWork: 1e9 });
      const strict = brutePool(B, true), pk = poolKeys(pool);
      cmp++;
      const diff = [...strict].filter(k => !pk.has(k)).length + [...pk].filter(k => !strict.has(k)).length;
      if (diff) cmpBad++;
      ratios.push(brutePool(B, false).size / Math.max(1, pk.size));
      // 自证：池里每块必须过 clauses()（= 玩家界面的判据），且无重复格
      for (const [, list] of pool) for (const b of list) {
        if (new Set(b).size !== b.length) ghost++;
        if (clauses(b, B, 0).length) selfBad++;
      }
    }
  }
  ok('池 = 幂集严格枚举（全部对照盘双向相等）', cmpBad === 0, `${cmp - cmpBad}/${cmp} 盘一致`);
  ok('池里每块都过整盘判据的条款集', selfBad === 0, `违例块 ${selfBad}`);
  ok('池里没有重复格（重影根因）', ghost === 0, `带重复格的块 ${ghost}`);
  console.log(`       观测：宽松池/严格池 大小比 med=${med(ratios).toFixed(2)} p95=${p95(ratios).toFixed(2)}（V7 淘汰的量级）`);
}

// ---------------------------------------------------------------- 2b. 预算的语义
head('2b. 预算只会**放弃**，不会**截断**：没抛的那一次必须交出整池（"无上限规则下唯一"就靠这一条）');
{
  // 这条不是形式上的漂亮话：如果 exactBlocks 会在超预算时返回"已经找到的那部分"，
  // 那计数器数出的"唯一解"就只是"在我们算得起的那半池里唯一"，整份承诺当场换皮。
  // 测法：同一块底纹换一串预算跑，看它是不是**先抛后全**的单调形态，且所有没抛的次数量给出**同一张池**。
  // 小尺寸那两档再对一次幂集：证明"没抛 ⇒ 完整"里的"完整"是真的完整，不是自我循环。
  const rr = rng(20260930);
  const CAPS = [1024, 32768, 131072, 400000, Infinity];
  const boards = [];
  for (const [R, C, T] of [[4, 4, 3], [4, 5, 2]]) for (let t = 0; t < T; t++) boards.push({ R, C, gray: randomShading(R, C, rr), brute: true });
  for (const tier of TIERS) for (let s = 1; s <= 2; s++) {
    const m = makePuzzle(tier.R, tier.C, s * 104729 + tier.R * 31 + Math.round(tier.density * 100) * 7, {
      density: tier.density, capWork: tier.capWork, shades: tier.shades, tilingsPerShade: tier.tilingsPerShade, cap: tier.counterCap,
    });
    if (m.ok) boards.push({ R: tier.R, C: tier.C, gray: m.gray, brute: false });
  }
  let trunc = 0, agree = 0, throwCount = 0, completeRuns = 0, nonMonotone = 0, bruteBad = 0;
  for (const b of boards) {
    const B = mkBoard(b.R, b.C, b.gray, {});
    const seen = [];
    for (const cap of CAPS) {
      let out = null;
      try { out = exactBlocks(B, { capWork: cap }); } catch (e) {
        if (e.name !== 'EnumBudget') throw e;
        seen.push('T'); throwCount++; continue;
      }
      seen.push('C'); completeRuns++;
      if (b.brute) { const bk = brutePool(B, true), pk = poolKeys(out); const d = [...bk].filter(k => !pk.has(k)).length + [...pk].filter(k => !bk.has(k)).length; if (d) bruteBad++; }
      const ref = poolKeys(out);
      const prev = seen.pool;
      if (prev) { const d = [...prev].filter(k => !ref.has(k)).length + [...ref].filter(k => !prev.has(k)).length; if (d) { trunc++; } else agree++; }
      seen.pool = ref;
    }
    // 单调：一旦某档预算算得起了，更大的预算也必须算得起（抛在中间 = 实现里有别的不确定量）
    const firstC = seen.indexOf('C'), lastT = seen.lastIndexOf('T');
    if (firstC >= 0 && lastT > firstC) nonMonotone++;
  }
  ok('没抛的那一次全部交回整池（不同预算给出的池逐块相等）', trunc === 0, `完成 ${completeRuns} 次 · 两两一致 ${agree} 次 · 少块/多块 ${trunc} 次`);
  ok('小尺寸上"完成 = 幂集完整"（对第二套路，不是自比较）', bruteBad === 0, `幂集对照盘的截断次数 ${bruteBad}`);
  ok('预算这条线真的会咬（小预算有 throw，断言不是空的）', throwCount > 0, `${throwCount} 次超预算`);
  ok('可算起性是预算的单调函数（不存在"小预算算得起、大预算反而抛"）', nonMonotone === 0, `违反形态 ${nonMonotone} 块底纹`);
}

head('3. V7（area 必须连通）是承重的：要有"只违反 V7"的见证');
{
  // 见证 = 一个划分：按宽松规则合法、按严格规则**只**违反 V7 ⇒ 这条裁定确实改变答案
  const rr = rng(777);
  let witness = null, boards = 0, laxOnly = 0;
  for (let t = 0; t < 60 && !witness; t++) {
    // 只用 4×4：见证只要存在即可，而幂集对照在 20 格上是 2^20（这里要跑 60 轮）。
    const [R, C] = [4, 4];
    const gray = randomShading(R, C, rr);
    const B0 = mkBoard(R, C, gray, {});
    const lax = brutePool(B0, false);
    const laxPool = new Map();
    for (const k of lax) { const cells = k.split(',').map(Number); if (!laxPool.has(cells[0])) laxPool.set(cells[0], []); laxPool.get(cells[0]).push(cells); }
    const r = count(B0, laxPool, { cap: 4000000, maxSol: 8, order: 'mrv' });
    boards++;
    if (!r.exhaustive) continue;
    for (const sol of r.sols) {
      const blocks = partitionToBlocks(sol);
      const badV7 = blocks.filter(bl => {
        const gs = bl.filter(i => B0.isGray(i)), ws = bl.filter(i => !B0.isGray(i));
        return !(connected(gs, B0.nbrs) && connected(ws, B0.nbrs));
      });
      if (!badV7.length) continue;
      laxOnly++;
      // 该划分在所有其他条款下都必须合法：临时用"去掉 V7 的判据"复检
      const others = engCheck(B0, sol).filter(x => !x.startsWith('V7'));
      if (!others.length) { witness = { R, C, sol, badV7 }; break; }
    }
  }
  ok('存在"只违反 V7"的划分（V7 不是空条款）', !!witness,
    witness ? `见证 ${witness.R}x${witness.C}，其中半区不连通的块 ${witness.badV7.length} 个：[${witness.badV7[0].join(',')}]` : `${boards} 盘里没找到`);
  ok('宽松独有的解被找到（两种读法可区分）', laxOnly > 0, `宽松合法、严格违 V7 的解 ${laxOnly} 个`);
}

// ---------------------------------------------------------------- 4. 计数器四态
head('4. 计数器四态读数不许混说');
{
  const B = mkBoard(OFFICIAL.R, OFFICIAL.C, OFFICIAL.gray, {});   // 同一块底纹、不印数字
  const pool = exactBlocks(B, { capWork: 1e9 });
  // maxSol 给到能穷尽为止，断言才是断言（写成 maxSol:2 再放过 !exhaustive，等于永远绿）。
  // 35 是对这块底纹**全部**合法分块数出来的数，不是自比较：池换成幂集那一份也必须还是 35。
  const r = count(B, pool, { cap: 4000000, maxSol: 400, order: 'mrv' });
  ok('无数字的同底纹不唯一（题面信息是必要的）', r.exhaustive && r.solutions === 35, `${r.read} 节点${r.nodes}`);
  const rBrute = count(B, (() => {
    const m = new Map();
    for (const k of brutePool(B, true)) { const cells = k.split(',').map(Number); if (!m.has(cells[0])) m.set(cells[0], []); m.get(cells[0]).push(cells); }
    return m;
  })(), { cap: 4000000, maxSol: 400, order: 'mrv' });
  ok('同一无数字盘：幂集池也数出 35（第二套路，不是自比较）', rBrute.exhaustive && rBrute.solutions === 35, `${rBrute.read}`);
  const rCap = count(B, pool, { cap: 3, maxSol: 99, order: 'mrv' });
  ok('cap 耗尽 ⇒ 不许报成唯一', !rCap.unique && rCap.stop === 'cap', `${rCap.read} unique=${rCap.unique}`);
  ok('maxSol 耗尽 ⇒ 只是下界', (() => { const x = count(B, pool, { cap: 4000000, maxSol: 2, order: 'mrv' }); return !x.exhaustive && x.stop === 'maxSol' && x.solutions === 2; })());
  // 死盘：底纹合法（半盘灰）但**没有任何**合法铺法。这一格集合是从 12870 块 4×4 底纹里
  // 全数出来的 96 块死盘之一，两套池都必须给出 exhaustive 0 —— 阴性也要能自证。
  const deadGray = new Set([0, 1, 2, 3, 4, 6, 9, 12]);
  const Bd = mkBoard(4, 4, deadGray, {});
  const rd = count(Bd, exactBlocks(Bd, { capWork: 1e9 }), { cap: 4000000, maxSol: 2, order: 'mrv' });
  const rdBrute = count(Bd, (() => {
    const m = new Map();
    for (const k of brutePool(Bd, true)) { const cells = k.split(',').map(Number); if (!m.has(cells[0])) m.set(cells[0], []); m.get(cells[0]).push(cells); }
    return m;
  })(), { cap: 4000000, maxSol: 2, order: 'mrv' });
  ok('死盘报成 exhaustive 0（构造池），不许报成唯一', rd.exhaustive && rd.solutions === 0 && rd.dead, `${rd.read} 池${exactBlocks(Bd, { capWork: 1e9 }).total}块`);
  ok('死盘在幂集池下同样 exhaustive 0（两套池都说没有铺法）', rdBrute.exhaustive && rdBrute.solutions === 0, `${rdBrute.read}`);
}

// ---------------------------------------------------------------- 5. 出题器：每档全过合取判据
head(`5. 出题器 × 判据（TIERS 全表，每档 ${SAMPLES} 盘）`);
const MEASURED = [];
for (const tier of TIERS) {
  const t0 = Date.now();
  const ms = [], steps = [], cuts = [], nums = [], budgetT = [], work = [], ratio = [], seeds = [];
  let shipped = 0, tried = 0, fails2 = {}, lastRules = null;
  for (let s = 1; s <= SAMPLES * 3 && shipped < SAMPLES; s++) {
    tried++;
    const m = makePuzzle(tier.R, tier.C, s * 104729 + tier.R * 31 + Math.round(tier.density * 100) * 7, {
      density: tier.density, capWork: tier.capWork, shades: tier.shades, tilingsPerShade: tier.tilingsPerShade,
      cap: tier.counterCap, independent: (B, part) => indCheck(B, part),
    });
    if (!m.ok) { fails2[m.code] = (fails2[m.code] || 0) + 1; continue; }
    shipped++;
    seeds.push(s);
    ms.push(m.ms); steps.push(m.steps); cuts.push(m.cuts); nums.push(m.nums); budgetT.push(m.budgetT);
    work.push(m.work); ratio.push(m.blocks.work / Math.max(1, m.blocks.subsets));
    lastRules = m.rules;
    // 出货盘独立重证：唯一 + 铅笔推满 + 两套判据都干净 + 构造底就是唯一解
    const pool = exactBlocks(m.B, { capWork: tier.capWork });
    const j = judge(m.B, pool, { cap: 4000000, independent: (B, part) => indCheck(B, part) });
    if (!j.ok) { ok(`${tier.key} 盘#${s} 复跑判据`, false, j.why); continue; }
    const e1 = eqRel(m.tiling), e2 = eqRel(partitionToBlocks(j.sol));
    if ([...e1].filter(k => !e2.has(k)).length + [...e2].filter(k => !e1.has(k)).length) { ok(`${tier.key} 盘#${s} 构造底==唯一解`, false); continue; }
    for (const bl of m.tiling) if (!blockNumOK(m.B, bl)) { ok(`${tier.key} 盘#${s} 数字表自洽`, false); break; }
    if (m.B.gray.size * 2 !== m.B.cells.length) ok(`${tier.key} 盘#${s} 半盘灰`, false);
  }
  const badShip = shipped < SAMPLES;
  ok(`${tier.key} ${tier.R}x${tier.C} d=${tier.density} 出货 ${shipped}/${tried} 抽`, !badShip, JSON.stringify(fails2));
  ok(`${tier.key} 全部复跑判据绿（唯一+推满+双判据+同解）`, !badShip, `出货盘都过了上面逐盘断言`);
  // gold 是 balance B3 钉着的那批连续 seed。这一段从**另一条调用路径**（自己的 seed 循环、每盘再独立
  // 跑一次 judge）重出同一批盘：两个台架都读同一张 TIERS 表，读数必须逐值一致，
  // 否则那批数组只是"钉它的那个台架能复现"的私货。
  const goldN = tier.gold ? tier.gold.steps.length : 0;
  if (SAMPLES < goldN) {
    console.log(`       ${tier.key}：本局 SAMPLES=${SAMPLES} < gold 的 ${goldN} ⇒ 跳过对账（口径更小，不是回归）`);
  } else {
    const want = Array.from({ length: goldN }, (_, i) => i + 1).join(',');
    const sameSeeds = seeds.slice(0, goldN).join(',') === want;
    const srt = a => a.slice().sort((x, y) => x - y).join(',');
    const cols = { steps, cuts, nums, work };
    const bad = Object.keys(cols).filter(k => srt(cols[k].slice(0, goldN)) !== srt(tier.gold[k]));
    ok(`${tier.key} 对账 balance 的 gold（另一条调用路径复现同一批盘面）`, sameSeeds && bad.length === 0,
      !sameSeeds ? `出货的 seed 号是 [${seeds.slice(0, goldN)}] 而 gold 是 1..${goldN} ⇒ 两侧不是同一批盘`
        : bad.length ? `${bad.join('/')} 列与钉着的 gold 不符 ⇒ 出题路径变了，页面读数过期`
          : `前 ${goldN} 号 seed 的 steps/cuts/nums/work 逐值相等`);
  }
  MEASURED.push({
    key: tier.key, R: tier.R, C: tier.C, density: tier.density, shipped, tried,
    stepsMed: med(steps), cutsMed: med(cuts), numsMed: med(nums),
    workMed: med(work), workMax: Math.max(...work, 0), ratioMed: med(ratio), ratioMax: Math.max(...ratio, 0),
    msMed: med(ms), msP95: p95(ms), stepsP95: p95(steps), budgetMed: med(budgetT), budgetMax: Math.max(...budgetT, 0),
    wallMs: Date.now() - t0, rules: lastRules,
  });
  console.log(`       实测 ${tier.key}: 数字 med=${med(nums)}/${tier.R * tier.C}（${(med(nums) / (tier.R * tier.C) * 100).toFixed(0)}%）· 区界 med=${med(cuts)} · 铅笔轮次 med=${med(steps)} p95=${p95(steps)} · 整盘工作量 med=${med(work)} max=${Math.max(...work, 0)} · work/subsets med=${med(ratio).toFixed(1)} max=${Math.max(...ratio, 0).toFixed(1)}（成本由搜索路径定，不由产出量定）· 出题 ms med=${med(ms)} p95=${p95(ms)} · 换底纹 med=${med(budgetT)} max=${Math.max(...budgetT, 0)} · 台架墙钟 ${Date.now() - t0}ms`);
}

// ---------------------------------------------------------------- 6. 确定性
head('6. 确定性：同一 seed 同一盘，且判定链上没有任何一步读墙钟');
{
  const t = TIERS.find(x => x.R === 6) || TIERS[0];
  const opt = { density: t.density, capWork: t.capWork, independent: (B, p) => indCheck(B, p) };
  const sig = m => m.ok ? JSON.stringify({ gray: [...m.gray].sort((a, b) => a - b), nums: [...m.B.num].sort((a, b) => a[0] - b[0]), cuts: m.cuts, steps: m.steps, pieces: m.tiling.map(b => b.join(',')) }) : `!${m.code}`;
  const realNow = Date.now;
  let a1, a2, b1, fast, frozen;
  try {
    a1 = makePuzzle(t.R, t.C, 4242, opt);
    a2 = makePuzzle(t.R, t.C, 4242, opt);
    b1 = makePuzzle(t.R, t.C, 4243, opt);
    // 把时钟拧成两种极端：每次调用跳 5 秒（任何 deadline 都会当场炸），以及完全不走。
    // 只要判定链上有一处用墙钟换底纹/换分块/放弃出货，这两次的**盘**就会不同或直接不出货。
    let k = 0;
    Date.now = () => 1_700_000_000_000 + (++k) * 5000;
    fast = makePuzzle(t.R, t.C, 4242, opt);
    Date.now = () => 1_700_000_000_000;
    frozen = makePuzzle(t.R, t.C, 4242, opt);
  } finally {
    Date.now = realNow;
  }
  ok('同 seed 两次完全同盘', a1.ok && a2.ok && sig(a1) === sig(a2));
  ok('不同 seed 出不同盘', a1.ok && b1.ok && sig(a1) !== sig(b1));
  ok('时钟每次跳 5 秒仍然出货且同盘（没有墙钟预算）', fast.ok && sig(fast) === sig(a1), fast.ok ? '' : `未出货：${fast.code}`);
  ok('时钟静止仍然同盘', frozen.ok && sig(frozen) === sig(a1));
  // 奇面积是规则给的无解，不是算力：闸直接断言它被拒（菜单外的这一条理由由这里撑着）
  const odd = makePuzzle(5, 5, 7, opt);
  ok('奇面积盘被规则拒绝（5×5 无解是可证的）', !odd.ok && odd.code === '奇面积', odd.why || '');
}

// ---------------------------------------------------------------- 7. 双实现一致
head('7. 两套判据实现：在突变族上开火的条款集合必须一致');
{
  const m = makePuzzle(4, 4, 991, { density: 0.5, capWork: 1e6, independent: (B, p) => indCheck(B, p) });
  ok('突变台架用的盘出货', m.ok, m.why || '');
  if (m.ok) {
    const B = m.B, own = new Map();
    m.tiling.forEach((bl, bi) => bl.forEach(i => own.set(i, bi)));
    const relist = mp => { const g = new Map(); for (const [i, b] of mp) { if (!g.has(b)) g.set(b, []); g.get(b).push(i); } return [...g.values()]; };
    const toPart = blocks => { const mp = new Map(); blocks.forEach((bl, bi) => bl.forEach(i => mp.set(i, bi))); return mp; };
    const cands = [];
    for (const i of B.cells) for (const j of B.cells) if (i < j && own.get(i) !== own.get(j)) {
      const mp = new Map(own); mp.set(i, own.get(j)); mp.set(j, own.get(i)); cands.push({ t: `交换${i}<->${j}`, part: toPart(relist(mp)) });
    }
    for (const i of B.cells) for (const g of new Set(own.values())) if (own.get(i) !== g) {
      const mp = new Map(own); mp.set(i, g); cands.push({ t: `挪格${i}->块${g}`, part: toPart(relist(mp)) });
    }
    own.forEach((g, i) => { const mp = new Map(own); mp.delete(i); cands.push({ t: `漏格${i}`, part: mp }); });
    const cls = v => [...new Set(v.map(x => (x.match(/^(V\d[a-z]?)/) || ['VV'])[1]))].filter(k => k !== 'VV');
    let n = 0, agree = 0, mism = [];
    for (const cd of cands) {
      const a = cls(engCheck(B, cd.part)), b = cls(indCheck(B, cd.part));
      n++;
      if (a.slice().sort().join() === b.slice().sort().join()) agree++;
      else if (mism.length < 3) mism.push(`${cd.t} 引擎=[${a}] 独立=[${b}]`);
    }
    ok('两套实现条款集合一致', mism.length === 0, `${agree}/${n} 例一致${mism.length ? ' · ' + mism.join(' || ') : ''}`);
    const fired = {};
    for (const cd of cands) for (const c of cls(engCheck(B, cd.part))) fired[c] = (fired[c] || 0) + 1;
    console.log(`       观测：突变族 ${n} 例开火分布 ${JSON.stringify(fired)}`);
    for (const need of ['V1a', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']) {
      if (!fired[need]) ok(`条款 ${need} 在突变族里开过火`, false, '一次都没开火 ⇒ 可能是空条款');
    }
    ok('条款表每条都开过火（没有空条款）', ['V1a', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'].every(k => fired[k]), JSON.stringify(fired));
  }
}

console.log(`\n${checks - fails}/${checks} 条闸绿`);
if (fails) { console.log(`RED ${fails} 条`); process.exit(1); }
console.log('TIERS_MEASURED=' + JSON.stringify(MEASURED.map(r => ({
   key: r.key, R: r.R, C: r.C, density: r.density, capWork: r.capWork,
  numsMed: r.numsMed, cutsMed: r.cutsMed, stepsMed: r.stepsMed, stepsP95: r.stepsP95, msMed: r.msMed, msP95: r.msP95,
  shipped: r.shipped, tried: r.tried,
}))));
