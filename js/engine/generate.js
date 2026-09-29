// 构造式出题器。顺序：**先底纹 → 再铺块 → 再钉数字 → 再按推理进度挖数字**。
//
// 为什么是这个顺序：候选池 exactBlocks(底纹) 是计数器和铅笔共用的唯一昂贵件；
// 底纹一定，一次枚举整轮复用，所以"一块底纹可以试很多个分块"，失败代价只是一次铺块 + 一次判据；
// 反过来"先分块再推底纹"要为每个候选块解一次二着色，更贵且连通性天然更难保证。
//
// 关键认识（测量逼出来的）：数字能表达的信息**只有** v(i) = i 所在块的半区大小。
// 所以先把全盘每格都填上 v（信息上界）。若这个"全数字盘"仍过不了判据，说明这底纹/这分块是**钉不死**的，
// 换分块；过了再往下挖——挖的标准是合取的：①唯一 ②铅笔推得满。只挖"唯一"会出无法推理的盘。
//
// 两条要老实写的边界（README/DESIGN 里也得写）：
//   - 池子不带面积上限 ⇒ 枚举成本随底纹变化，有的底纹算不起。这里用**确定的工作量预算**（capWork）
//     换底纹，而不是加一条"块最多 8 格"的规则去把成本压平；预算也不按墙钟算，否则机器速度会换盘。
//     承诺是"这盘在无上限规则下唯一"，不是"所有底纹都算得起"。
//   - 出货的每一盘都由 judge() 当场重证（计数器 exhaustive-1 + 铅笔推满 + check 0 违反 + 两者同解），
//     生成过程中间态的 tiling 不直接当答案用（它是构造证据，不是判据来源）。

import { mkBoard, eqRel, partitionToBlocks } from './rules.js';
import { exactBlocks, numFilter, EnumBudget } from './blocks.js';
import { judge } from './pencil.js';
import { rng } from './rng.js';

export function randomShading(R, C, rr) {
  const N = R * C;
  return new Set(rr.shuffle(Array.from({ length: N }, (_, i) => i)).slice(0, N / 2).sort((a, b) => a - b));
}

// 随机化精确覆盖：找这块底纹的一个合法分块（构造性保证"至少有一解"）。
// bias: 'big' = 大块优先（数字值大、判别力强）；'rand' = 纯随机顺序。
export function findTiling(B, blocks, rr, { bias = 'big', nodeCap = 40000 } = {}) {
  const N = B.cells.length;
  const cover = new Uint8Array(N);
  const chosen = [];
  let nodes = 0;
  const rec = () => {
    if (nodes > nodeCap) return false;
    let f = -1;
    for (let i = 0; i < N; i++) if (!cover[i]) { f = i; break; }
    if (f < 0) return true;
    const pool = (blocks.get(f) || []).map(b => [b, rr.next()]);
    if (bias === 'big') pool.sort((x, y) => (y[0].length - x[0].length) || (x[1] - y[1]));
    else pool.sort((x, y) => x[1] - y[1]);
    for (const [b] of pool) {
      let clash = false;
      for (const i of b) if (cover[i]) { clash = true; break; }
      if (clash) continue;
      nodes++;
      for (const i of b) cover[i] = 1;
      chosen.push(b);
      if (rec()) return true;
      chosen.pop();
      for (const i of b) cover[i] = 0;
    }
    return false;
  };
  return rec() ? { tiling: chosen, nodes } : { tiling: null, nodes };
}

// density: 0 = 挖到"仍能过判据"的最稀（最难）；1 = 全数字盘；0<d<1 = 挖到底后回填到 d·N 个数字。
// 回填不破坏唯一性（加数字不会造出新解），但**不保证**不破坏可推性，所以每回填一格都重跑 judge，
// 红了就撤掉那一格——这条读自己的产出，不靠单调性假设。
// 预算全是**确定量**（工作量次数、底纹次数、分块次数），没有墙钟：
// 墙钟进判定 ⇒ 快慢机器会抽到不同的盘，"同一 seed 同一档同一盘"就不是承诺了。
// 耗时因此只在观测里报（ms/enumMs/digMs），不参与任何一次 continue/break；
// 而 work（= 这块底纹真的做了多少次 DFS 访问 + 同形配对）是**确定**的成本读数，
// 它和被放弃的底纹都记进来，所以"这一盘花了多少算力"是一个与机器速度无关的数。
export function makePuzzle(R, C, seed, {
  density = 0, capWork = 400_000, shades = 8, tilingsPerShade = 30, cap = 400000,
  bias = 'big', independent = null, log = null,
} = {}) {
  const t0 = Date.now();
  const N = R * C;
  if (N % 2) return { ok: false, code: '奇面积', why: `R*C=${N} 奇数 ⇒ 每块必须偶数格 ⇒ 无解`, shadeTries: 0, tilingTries: 0, work: 0 };
  const rr = rng(seed);
  let shadeTries = 0, tilingTries = 0, budgetT = 0, enumMs = 0, digMs = 0, rejUnique = 0, rejPencil = 0, work = 0;

  for (let s = 0; s < shades; s++) {
    shadeTries++;
    const gray = randomShading(R, C, rr);
    const B0 = mkBoard(R, C, gray, {});
    let blocks;
    const te = Date.now();
    try {
      blocks = exactBlocks(B0, { capWork });
      work += blocks.work;                      // 这块底纹做完的全部工作量
    } catch (e) {
      if (e.name !== 'EnumBudget') throw e;
      work += e.n;                              // 被放弃的底纹也做了 e.n 次才算不起
      budgetT++;                      // 这块底纹算不起：换底纹，不加规则
      log && log(`  底纹#${s} 枚举超预算 ${e.message}`);
      continue;
    }
    enumMs += Date.now() - te;
    if (!blocks.total) { budgetT++; continue; }   // 池空 = 这块底纹本来就无解

    for (let t = 0; t < tilingsPerShade; t++) {
      tilingTries++;
      const { tiling } = findTiling(B0, blocks, rr, { bias });
      if (!tiling) break;                          // 铺不满：换底纹
      const fullNums = {};
      for (const b of tiling) { const v = b.length / 2; for (const i of b) fullNums[i] = v; }
      const B = mkBoard(R, C, gray, fullNums);
      const td = Date.now();
      const j0 = judge(B, blocks, { cap, independent });
      if (!j0.ok) {                                // 全数字盘都过不了判据 ⇒ 这分块钉不死
        rejUnique++;
        log && log(`  盘 分块#${t} 满数字起点不过判据：${j0.why}`);
        continue;
      }
      // 往下挖：逐格试删，删完仍要 ①exhaustive-1 ②铅笔推满 ③check 0 ④与计数器同解
      const put = new Map(Object.entries(fullNums).map(([k, v]) => [+k, v]));
      let removed = 0;
      for (const i of rr.shuffle([...put.keys()])) {
        if (put.size <= 1) break;
        const v = put.get(i);
        put.delete(i); B.num.delete(i);
        const j = judge(B, blocks, { cap, independent });
        if (j.ok) { removed++; } else {
          if (j.why === '铅笔推不满' || j.why === '铅笔 contradiction') rejPencil++; else rejUnique++;
          put.set(i, v); B.num.set(i, v);
          const back = judge(B, blocks, { cap, independent });    // 回滚后必须仍过判据
          if (!back.ok) { log && log(`  挖到一半回滚后判据红：${back.why} —— 弃这盘`); removed = -1; break; }
        }
      }
      if (removed < 0) continue;
      // 回填（只有 density>0 才回填）。want 的下界是**挖完剩下的格数**，不是"挖掉的格数"：
      // 上一版写成 Math.max(removed, d*N)，removed 是删掉的个数 ⇒ d=0.25 与 d=0.5 都落回同一个 88%，
      // 密度旋钮根本没在拧密度，打出来的档位表会是谎。
      let refilled = 0;
      if (density > 0) {
        const want = Math.max(put.size, Math.round(density * N));
        for (const i of rr.shuffle(B0.cells.filter(x => !put.has(x)))) {
          if (put.size >= want) break;
          put.set(i, fullNums[i]); B.num.set(i, fullNums[i]);
          const j = judge(B, blocks, { cap, independent });
          if (j.ok) refilled++; else { put.delete(i); B.num.delete(i); }
        }
      }
      digMs += Date.now() - td;
      const Bf = mkBoard(R, C, gray, Object.fromEntries(put));
      const jf = judge(Bf, blocks, { cap, independent });
      if (!jf.ok) { rejUnique++; log && log(`  终态不过判据：${jf.why} —— 换分块`); continue; }
      // cuts = 玩家要画的区界条数（答案给的"工作量"），和轮次一起构成难度实测的两个口径
      const inBlock = new Map();
      tiling.forEach((bl, bi) => bl.forEach(i => inBlock.set(i, bi)));
      let cuts = 0;
      for (const i of Bf.cells) for (const j of Bf.nbrs.get(i)) if (j > i && inBlock.get(i) !== inBlock.get(j)) cuts++;
      // 出题器自记的答案会说谎（farm 的老坑）：构造时铺的那块底必须就是计数器的唯一解，
      // 否则数字表描述的不是任何合法解，界面按数字判也会判错。这里按同块关系比，不按 gid。
      const e1 = eqRel(tiling), e2 = eqRel(partitionToBlocks(jf.sol));
      const diff = [...e1].filter(k => !e2.has(k)).concat([...e2].filter(k => !e1.has(k)));
      if (diff.length) { rejUnique++; log && log(`  构造底 ≠ 计数器唯一解（${diff.length} 处同块关系不符）—— 换分块`); continue; }
      return {
        ok: true, B: Bf, gray, tiling, blocks, seed,
        nums: put.size, removed, refilled, tried: tilingTries, cuts, pieces: tiling.length,
        shadeTries, tilingTries, budgetT, rejUnique, rejPencil, work,
        enumMs, digMs, ms: Date.now() - t0,
        steps: jf.steps, rules: jf.rules, nodes: jf.nodes, read: jf.read,
      };
    }
  }
  return {
    ok: false,
    code: budgetT === shadeTries ? '枚举超预算' : '钉不死',
    why: `${shadeTries} 块底纹 × ${tilingTries} 次分块都没出货（枚举超工作量预算 ${budgetT} 块、判据拒 ${rejUnique + rejPencil} 次）`,
    shadeTries, tilingTries, budgetT, rejUnique, rejPencil, work, enumMs, digMs, ms: Date.now() - t0,
  };
}
