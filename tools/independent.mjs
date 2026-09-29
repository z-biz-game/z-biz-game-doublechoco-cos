// **独立**第二套实现：故意不复用 js/engine 里的 shapeKey / connected / clauses / exactBlocks。
// 它的用途只有两个：
//   1) 给出货盘当第二判据（engine 说唯一且这货说这盘合法 ⇒ 两条路都得走通）；
//   2) 给候选池当**完整性**对照：在小盘上按"子集幂集"暴力枚举出全部合法块，
//      要求 exactBlocks 的池与之**双向相等**。少了块 ⇒ 我们把唯一性算窄了；多了块 ⇒ 算宽了。
//      没有这一条，"池按构造枚举"只是一个自我一致的假设，不是对规则的忠实实现。
// 幂集只到 2^N，所以 N≤20 才用（4x4 / 4x5）；更大盘由 tools/engine-test.mjs 用别的路径钉。

const RC = (i, C) => [Math.floor(i / C), i % C];
const KEY = pts => {
  const mr = Math.min(...pts.map(p => p[0])), mc = Math.min(...pts.map(p => p[1]));
  return pts.map(p => `${p[0] - mr}:${p[1] - mc}`).sort().join('|');
};
// 8 个刚体+镜像变换，显式矩阵（与 js/engine/rules.js 的 D4 函数表是两套写法）
const XF = [[1, 0, 0, 1], [0, 1, 1, 0], [-1, 0, 0, 1], [0, 1, -1, 0], [1, 0, 0, -1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, -1, -1, 0]];
function sameForm(a, b, C) {
  const pa = a.map(i => RC(i, C)), pb = b.map(i => RC(i, C));
  const kb = KEY(pb);
  for (const [a1, a2, a3, a4] of XF) {
    const t = pa.map(([r, c]) => [a1 * r + a2 * c, a3 * r + a4 * c]);
    if (KEY(t) === kb) return true;
  }
  return false;
}
function link(set, nbrs) {
  const S = new Set(set);
  if (!S.size) return false;
  const q = [set[0]], vis = new Set([set[0]]);
  for (let p = 0; p < q.length; p++) for (const j of nbrs.get(q[p])) if (S.has(j) && !vis.has(j)) { vis.add(j); q.push(j); }
  return vis.size === S.size;
}

// 整盘划分判据（条款号与 js/engine/rules.js 一致，实现独立）
export function check(B, part) {
  const out = [];
  const N = B.cells.length;
  const groups = new Map();
  const owner = new Map();
  for (const i of B.cells) {
    const g = part.get(i);
    if (g == null || g < 0) { out.push(`V1a 格 ${i} 不属于任何块`); continue; }
    if (owner.has(i)) out.push(`V1b 格 ${i} 同时属于块 ${owner.get(i)} 与块 ${g}`);
    else owner.set(i, g);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  for (const [g, cells] of groups) {
    if (!cells.length) { out.push(`V1a 块 ${g} 是空块`); continue; }
    if (!link(cells, B.nbrs)) out.push(`V2 块 ${g} 不连通：${cells.join(',')}`);
    const gs = cells.filter(i => B.isGray(i)), ws = cells.filter(i => !B.isGray(i));
    if (!gs.length || !ws.length) out.push(`V3 块 ${g} 缺一色（灰${gs.length}/白${ws.length}）`);
    else if (gs.length !== ws.length) out.push(`V3 块 ${g} 两半不等量（灰${gs.length}/白${ws.length}）`);
    else {
      if (!sameForm(gs, ws, B.C)) out.push(`V4 块 ${g} 两半不同形 灰[${gs.join(',')}] 白[${ws.join(',')}]`);
      if (!link(gs, B.nbrs)) out.push(`V7 块 ${g} 灰半区不连通：${gs.join(',')}`);
      if (!link(ws, B.nbrs)) out.push(`V7 块 ${g} 白半区不连通：${ws.join(',')}`);
    }
    const ns = cells.filter(i => B.num.has(i));
    for (const i of ns) {
      const want = B.isGray(i) ? gs.length : ws.length;
      if (B.num.get(i) !== want) out.push(`V5 格 ${i}(${B.isGray(i) ? '灰' : '白'}) 数字 ${B.num.get(i)} ≠ 本块同色格数 ${want}`);
    }
    const vs = new Set(ns.map(i => B.num.get(i)));
    if (vs.size > 1) out.push(`V6 块 ${g} 里有 ${[...vs].join(',')} 两种数字`);
  }
  return [...new Set(out)];
}

// 幂集暴力池：strict=true 要求两个半区都连通（本仓采用的读法），false = 宽松读法。
// 返回 Set<"排序后格编号,逗号">，便于与 exactBlocks 的池直接比集合。
export function brutePool(B, strict = true) {
  const N = B.cells.length;
  if (N > 22) throw new Error(`brutePool 只到 2^22，给了 N=${N}`);
  const keys = new Set();
  const size = 1 << N;
  for (let m = 0; m < size; m++) {
    const cells = [];
    for (let i = 0; i < N; i++) if (m & (1 << i)) cells.push(i);
    if (cells.length < 2 || cells.length % 2) continue;
    if (!link(cells, B.nbrs)) continue;
    const gs = cells.filter(i => B.isGray(i)), ws = cells.filter(i => !B.isGray(i));
    if (!gs.length || gs.length !== ws.length) continue;
    if (!sameForm(gs, ws, B.C)) continue;
    if (strict && (!link(gs, B.nbrs) || !link(ws, B.nbrs))) continue;
    keys.add(cells.join(','));
  }
  return keys;
}

export const poolKeys = blocks => {
  const s = new Set();
  for (const [, list] of blocks) for (const b of list) s.add(b.slice().sort((x, y) => x - y).join(','));
  return s;
};
