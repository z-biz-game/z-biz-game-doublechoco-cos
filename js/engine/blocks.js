// 候选块池：**按原规则的构造**枚举，不是"枚举所有连通子集再筛同形"。
//
//   原句（js/engine/rules.js:6-7, 9-11）：一块 = 一个白 area + 一个灰 area，两 area 同形同尺寸。
//   ⇒ 合法块 ≡ (灰连通子集 G, 白连通子集 W) 且 shape(G)==shape(W) 且 G∪W 连通。
//   按这个构造枚举：G、W 各自只在**单色内部**做连通扩展，同形是按分组配对**成立**的，不是筛出来的。
//
//   另一条要紧的：池子**不带面积上限**。上限曾是"让枚举算得起"的拐杖，但它是**我们自己加的规则**——
//   如果"唯一"是加了上限才唯一，那承诺就成了"在我们加的规则下唯一"。这里把上限取消（halfMax = 全盘格数/2），
//   成本改由一条**计数预算**承担（capWork = DFS 访问次数 + 同形配对次数）：超预算就放弃这块底纹，
//   而不是加一条"块最多 8 格"的规则去把成本压平。预算绝不按墙钟算——墙钟进判定＝机器速度换盘。
//   要紧：这条预算只会**放弃**，不会**截断**（超出即 throw，绝不返回半池）⇒ 没抛错的那次枚举
//   给出的就是这块底纹下的**完整池**，"这盘在无上限规则下唯一"因此是可证的。
//   承诺因此是"这盘在**无上限**规则下唯一"，不是"所有底纹都算得起"。
//
// 两条闸读的是**自己的产出**（不是自比较）：
//   - 半区不许重叠 / 块内不许有重复格，否则 V3 的"两半等量"是按重复计数成立的，
//     出题器据此写的数字就不属于任何合法解（这是本仓最早的一次判据红的根因）。
//   - 同一个块不许发出两次，否则精确覆盖会把一个划分数成多解。

import { connected, shapeKey } from './rules.js';

export class EnumBudget extends Error {
  constructor(n, d, where) { super(`${where}超预算 ${n} > ${d}`); this.name = 'EnumBudget'; this.where = where; this.n = n; this.cap = d; }
}

// 单色内部枚举连通子集，按形状指纹分桶。锚在最小下标 + seen 去重。
//
// 预算计量的是**工作量**（DFS 访问的次数 + 同形配对的次数），不是"产出了多少个不同子集"。
// 这一条是被实测逼出来的，而且那个比值每轮都在闸里重看：engine-test 第 5 段逐档打印出货盘的
// `work / subsets`（中位与最大）——6×6 最稀档能看到几百倍（几千次工只换回几百个子集），
// 因为去重前的搜索路径远多于去重后的结果。用"子集个数"当预算 ⇒ 成本没有上界；用它计量才谈得上"等得起"。
// capWork 是**确定的计数预算**，不是墙钟：预算一旦用时间算，同一 seed 在快慢机器上就会
// 换底纹、换池、换盘，"同一 seed 同一档出同一张盘"当场作废（farm 的老坑：msCap 会改盘，nodeCap 才安全）。
// 语义只有一种：**要么整池，要么 throw**。engine-test 第 2b 段拿同一块底纹换一串预算跑，
// 断言没抛的那些次给出的是同一张池（且小尺寸上等于幂集完整枚举）——这条不成立，
// "无上限规则下唯一"就会悄悄换成"在我们算得起的半池里唯一"。
function connectedSubsets(cellsOfColor, nbrs, halfMax, C, ctx) {
  const byShape = new Map();
  const seen = new Set();
  const inColor = new Set(cellsOfColor);
  if (!cellsOfColor.length) return byShape;
  // 坑（踩过两次，都在同一处）：格子从 cand 取进 cur 后**没有**被移出 cand，
  // 而每层循环上界是进入时的 cand.length ⇒ 深层还能再取到同一个格，cur=[0,4,4]。
  // 上一版用 `!cur.includes(kk)` 只挡"新增候选"，挡不住"回头取自己"。
  // 后果不是少块而是**重影**：官方 4x4 盘上 total 82 / 不同块只有 36。
  const inCur = new Uint8Array(Math.max(...cellsOfColor) + 1);
  const bump = () => {
    if ((++ctx.work & 32767) === 0 && ctx.work > ctx.capWork) throw new EnumBudget(ctx.work, ctx.capWork, '工作量');
  };
  for (const root of cellsOfColor) {
    const cur = [root]; inCur[root] = 1;
    const cand = nbrs.get(root).filter(j => j > root && inColor.has(j));
    const rec = () => {
      bump();
      const k = cur.slice().sort((a, b) => a - b).join(',');
      if (!seen.has(k)) {
        seen.add(k);
        const sk = shapeKey(cur, C);
        if (!byShape.has(sk)) byShape.set(sk, []);
        byShape.get(sk).push(cur.slice());
      }
      if (cur.length >= halfMax) return;
      const len = cand.length;
      for (let p = 0; p < len; p++) {
        const j = cand[p];
        if (inCur[j]) continue;
        cur.push(j); inCur[j] = 1;
        const add = [];
        for (const kk of nbrs.get(j)) if (kk > root && inColor.has(kk) && !inCur[kk] && !cand.includes(kk)) { cand.push(kk); add.push(kk); }
        rec();
        cur.pop(); inCur[j] = 0;
        for (let q = add.length - 1; q >= 0; q--) cand.pop();
      }
    };
    rec();
    inCur[root] = 0;
  }
  return byShape;
}

// Map<极小格, [块 cells…]>；与 count.js / pencil.js 的接口一致。
// 每个连通块恰好出现在它极小元的名单里一次，所以精确覆盖不会重复数同一划分。
//
// 预算是一条计数：capWork = DFS 访问次数 + 同形配对次数 的上限。少了它，配对那一步
// 的代价是 Σ_k|G_k|·|W_k|（一个形状桶 3k 灰 × 3k 白就是 900 万次），实测 8×8 有一块底纹
// 在这一步停了 >5 分钟。超预算 ⇒ **放弃这块底纹**，绝不返回半池，所以不伤"完整池"那条论证。
//
// 默认值这里**不读环境变量**：浏览器里没有 process（一次 ReferenceError 就白屏），
// 而在 CI 里设了它就更糟——同一号 seed 会因为环境换一个盘，"同一 seed 同一档同一盘"这句承诺当场作废。
// 出厂预算的唯一来源是 tiers.js 的 CAP_WORK；要试别的预算（balance B6 就干了这件事）
// 由调用方显式传 {capWork}，让换预算这件事在代码里看得见，而不是藏在一次 shell 赋值里。
export function exactBlocks(B, { halfCap = 0, capWork = 400_000 } = {}) {
  const N = B.cells.length;
  if (N % 2) throw new Error(`R*C=${N} 为奇数：两半等量 ⇒ 每块偶数格 ⇒ 无解，直接拒`);
  const halfMax = halfCap > 0 ? halfCap : (N >> 1);   // 0 = 无上限（真实规则）
  const grays = B.cells.filter(i => B.isGray(i)), whites = B.cells.filter(i => !B.isGray(i));
  if (grays.length !== whites.length) throw new Error(`底纹不是半盘灰（灰${grays.length}/白${whites.length}）：V3 ⇒ 无解`);
  const t0 = Date.now();   // 只用于观测 enumMs；判定链上没有一处读时间（墙钟进判定＝机器速度换盘）
  const ctx = { work: 0, capWork };
  const Gs = connectedSubsets(grays, B.nbrs, halfMax, B.C, ctx);
  const Ws = connectedSubsets(whites, B.nbrs, halfMax, B.C, ctx);
  const workEnum = ctx.work;

  const out = new Map();
  const emitted = new Set();
  let total = 0, dupEmit = 0, unionRejected = 0, pairs = 0;
  for (const [sk, gl] of Gs) {
    const wl = Ws.get(sk);
    if (!wl) continue;
    for (const g of gl) for (const w of wl) {
      if ((++ctx.work & 32767) === 0 && ctx.work > capWork) throw new EnumBudget(ctx.work, capWork, '工作量');
      pairs++;
      if (g.length !== w.length) throw new Error(`形状桶配错了（灰${g.length}/白${w.length}）：V3 会失效`);
      const union = new Set(g); for (const i of w) { if (union.has(i)) throw new Error(`半区重叠：灰[${g}] 白[${w}]`); union.add(i); }
      const cells = [...union].sort((a, b) => a - b);
      // G∪W 必须连通：块是"画线分出的区域"，两半只能边接触
      if (!connected(cells, B.nbrs)) { unionRejected++; continue; }
      const key = cells.join(',');
      if (emitted.has(key)) { dupEmit++; continue; }      // 重影闸门：读自己的产出
      emitted.add(key);
      const f = cells[0];
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(cells);
      total++;
    }
  }
  if (dupEmit) throw new Error(`块重影闸红：${dupEmit} 个块被重复发出 ⇒ 计数会把一个划分数成多解`);
  out.total = total;
  out.pairs = pairs;
  out.work = ctx.work;
  out.workEnum = workEnum;
  out.subsets = [...Gs.values()].reduce((a, v) => a + v.length, 0) + [...Ws.values()].reduce((a, v) => a + v.length, 0);
  out.enumMs = Date.now() - t0;
  out.gShape = Gs.size;
  out.wShape = Ws.size;
  out.distinct = emitted.size;
  out.unionRejected = unionRejected;
  return out;
}

// 数字自洽：V5（数字 = 该格自身颜色在块内的格数）+ V6（同块数字必须一致）。
// 候选池在进入精确覆盖之前先过这一关，等价于把 V5/V6 编进搜索空间。
export function blockNumOK(B, blk) {
  const gs = blk.filter(i => B.isGray(i)).length, ws = blk.length - gs;
  let v = null;
  for (const i of blk) {
    if (!B.num.has(i)) continue;
    if (B.num.get(i) !== (B.isGray(i) ? gs : ws)) return false;
    if (v !== null && v !== B.num.get(i)) return false;
    v = B.num.get(i);
  }
  return true;
}

export function numFilter(B, blocks) {
  const out = new Map();
  for (const [s, list] of blocks) out.set(s, list.filter(b => blockNumOK(B, b)));
  out.total = [...out.values()].reduce((a, v) => a + v.length, 0);
  return out;
}
