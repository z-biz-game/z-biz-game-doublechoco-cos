// Double Choco 的**铅笔**求解器：只用具名规则，绝不分支。
// 它同时是两件事的证据：① 判据 2（这局零猜测推得满）② 界面提示（提示只说推得出的那一步）。
// 所以每条规则都要能点名、并且把"它推出了什么"按推出顺序记进 trace —— 提示就是 walk 这条 trace。
//
// 规则名每条都能回指到 js/engine/rules.js 头部抄的原句：
//   N1 数字定大小   "the number corresponds to half the number of cells of the block"
//   N2 异数不共块   "A region may contain more than one cell with a number (…same number)"
//                   ⇒ 两个不同数字必在不同区 ⇒ 相邻就直接画界
//   N3 同色计数     "A number indicates the number of cells of that color in the block"
//   N4 两半同形     "A pair of areas must be of the same shape and size" + V7 area 连通
//                   —— 候选池本身就是"按这条构造出来的池"，所以 N4 的淘汰量=池大小；
//                      未封闭的组件只用它的等量推论（N5），封闭时才整块验形（N9）
//   N5 半区满则封闭 由 N1+N3 推得：某块的同色半区已够 v 个 ⇒ 外面再没有同色格能进来
//   N6 交集必同块   若格 i 的所有候选块都含 j ⇒ i,j 同块（这一条不许画界）
//   N7 无处共块必画界 若无任何候选块同时含相邻的 i,j ⇒ 二者之间画界
//   N8 唯一候选块   格 i 只剩一个候选块 ⇒ 该块整个落定
//   N9 封闭组件验形 组件四周已全部画界 ⇒ 它本身就是一个块，必须过 V1–V7
//   X1 无处可放 ⇒ contradiction；X2 计数溢出 ⇒ contradiction
// 输出：solved / forced / total / contradiction / rules(每条开火次数) / partition / trace / steps

import { partitionToBlocks } from './rules.js';
import { exactBlocks, numFilter, blockNumOK } from './blocks.js';
import { count } from './count.js';

export const RULE_TEXT = {
  N1_数字定大小: '数字 v 钉死了这一块必须 2v 格',
  N2_异数不共块: '两个不同的数字不可能在同一块 ⇒ 它们之间画界',
  N3_同色计数: '数字数的是**该格自身颜色**在本块里的格数',
  N4_两半同形筛: '候选池里的每一块都按"两个同形连通 area"构造',
  N5_半区满封闭: '这一色的半区已经够了 ⇒ 外面同色格进不来',
  N6_交集必同块: '所有能容下这格的块都含那格 ⇒ 两格同块',
  N7_无处共块画界: '没有任何块能同时容下相邻两格 ⇒ 它们之间必须画界',
  N8_唯一候选块: '这一格只剩一个候选块 ⇒ 整块落定',
  N9_封闭验形: '四周已全画界的组件就是一个块，必须过全部条款',
  X1_无处可放: ' contradiction：有格无处可放',
  X2_计数溢出: ' contradiction：某色格数已经超了该块的容量',
};

const SEG = (i, j) => (i < j ? `${i}-${j}` : `${j}-${i}`);

export function pencil(B, { blocksAll = null, capWork = 400_000 } = {}) {
  const pool = blocksAll || exactBlocks(B, { capWork });
  const blocksNum = numFilter(B, pool);
  const N = B.cells.length;

  // 数字筛：分别点名 N1/N2/N3 的淘汰量
  let elimN1 = 0, elimN3 = 0, elimN2 = 0;
  const cand = [];
  const contains = Array.from({ length: N }, () => []);
  const maskOf = cells => cells.reduce((m, i) => m | (1n << BigInt(i)), 0n);
  for (const [, list] of blocksNum) for (const cells of list) {
    const gs = cells.filter(i => B.isGray(i)).length, ws = cells.length - gs;
    let v = null, bad = false, why = 0;
    for (const i of cells) if (B.num.has(i)) {
      const want = B.isGray(i) ? gs : ws;
      if (B.num.get(i) !== want) { bad = true; why = 3; }
      if (v !== null && v !== B.num.get(i)) { bad = true; why = 2; }
      v = B.num.get(i);
    }
    if (!bad && v !== null && cells.length !== 2 * v) { bad = true; why = 1; }
    if (bad) { if (why === 1) elimN1++; else if (why === 2) elimN2++; else elimN3++; continue; }
    const id = cand.length;
    cand.push({ cells, mask: maskOf(cells), area: cells.length, gs, ws, v });
    for (const i of cells) contains[i].push(id);
  }
  const M = cand.length;
  const alive = new Uint8Array(M).fill(1);
  const rules = {
    N1_数字定大小: elimN1, N2_异数不共块: elimN2, N3_同色计数: elimN3,
    N4_两半同形筛: 0, N5_半区满封闭: 0, N6_交集必同块: 0, N7_无处共块画界: 0,
    N8_唯一候选块: 0, N9_封闭验形: 0, X1_无处可放: 0, X2_计数溢出: 0,
  };
  const trace = [];

  const parent = Array.from({ length: N }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const bordered = new Set();                 // "rootA|rootB" 已画界（类级）
  const isBordered = (a, b) => { const x = find(a), y = find(b); return x !== y && (bordered.has(x + '|' + y) || bordered.has(y + '|' + x)); };
  const drawBorder = (a, b) => {
    const x = find(a), y = find(b);
    if (x === y) return 'CONTRA';
    const k = x + '|' + y;
    if (bordered.has(k)) return false;
    bordered.add(k);
    return true;
  };
  // 类合并时界关系要搬运，否则"合并前画的界"会凭空消失
  const joinBoth = (a, b) => {
    const x = find(a), y = find(b);
    if (x === y) return false;
    const bx = [...bordered].filter(k => k.startsWith(x + '|') || k.endsWith('|' + x)).map(k => k.split('|').map(Number));
    const by = [...bordered].filter(k => k.startsWith(y + '|') || k.endsWith('|' + y)).map(k => k.split('|').map(Number));
    for (const k of [...bx, ...by]) bordered.delete(k[0] + '|' + k[1]);
    parent[x] = y;
    for (const [p, q] of [...bx, ...by]) {
      const pp = find(p), qq = find(q);
      if (pp !== qq) bordered.add(pp + '|' + qq);
    }
    return true;
  };
  const classCells = () => { const m = new Map(); for (const i of B.cells) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); } return m; };

  // N2 异数画界
  for (const i of B.cells) {
    if (!B.num.has(i)) continue;
    for (const j of B.nbrs.get(i)) if (j > i && B.num.has(j) && B.num.get(j) !== B.num.get(i)) {
      if (drawBorder(i, j) === true) { rules.N2_异数不共块++; trace.push({ i, j, kind: 'b', rule: 'N2_异数不共块' }); }
    }
  }

  const assigned = new Int32Array(N).fill(-1);
  let contradiction = false, steps = 0;
  const fail = tag => { if (!contradiction) { rules[tag]++; contradiction = true; } };

  const classMask = new Map();
  const rebuildClassMasks = () => { classMask.clear(); for (const [r, cs] of classCells()) classMask.set(r, maskOf(cs)); };

  const refresh = () => {
    rebuildClassMasks();
    let changed = false;
    for (let id = 0; id < M; id++) {
      if (!alive[id]) continue;
      const b = cand[id];
      const roots = new Set();
      for (const i of b.cells) roots.add(find(i));
      let dead = false;
      for (const r of roots) { const cm = classMask.get(r); if ((cm & b.mask) !== cm) { dead = true; break; } }
      if (!dead) { const rs = [...roots]; for (let a = 0; a < rs.length && !dead; a++) for (let e = a + 1; e < rs.length; e++) if (bordered.has(rs[a] + '|' + rs[e]) || bordered.has(rs[e] + '|' + rs[a])) { dead = true; break; } }
      if (dead) { alive[id] = 0; changed = true; }
    }
    return changed;
  };

  const fixBlock = id => {
    const b = cand[id];
    for (const i of b.cells) if (assigned[i] >= 0 && assigned[i] !== id) return false;
    for (let p = 0; p < b.cells.length; p++) for (let q = p + 1; q < b.cells.length; q++) {
      if (joinBoth(b.cells[p], b.cells[q])) trace.push({ i: b.cells[p], j: b.cells[q], kind: 'o', rule: 'N8_唯一候选块' });
    }
    for (const i of b.cells) assigned[i] = id;
    for (const i of b.cells) for (const j of B.nbrs.get(i)) if (!b.cells.includes(j)) {
      if (drawBorder(i, j) === true) trace.push({ i, j, kind: 'b', rule: 'N8_唯一候选块' });
    }
    return true;
  };

  let iter = 0;
  while (!contradiction) {
    iter++; steps = iter;
    if (iter > 400) break;
    let changed = refresh();
    // N8 唯一候选 / N6 交集 / X1 无处可放
    for (const i of B.cells) {
      if (assigned[i] >= 0) continue;
      const list = contains[i].filter(id => alive[id]);
      if (!list.length) { fail('X1_无处可放'); break; }
      if (list.length === 1) {
        if (fixBlock(list[0])) { rules.N8_唯一候选块++; changed = true; }
        else { fail('X1_无处可放'); break; }
        continue;
      }
      let inter = cand[list[0]].mask;
      for (const id of list) inter &= cand[id].mask;
      for (const i2 of B.cells) if (i2 !== i && ((inter >> BigInt(i2)) & 1n) === 1n && find(i2) !== find(i)) {
        if (joinBoth(i, i2)) { rules.N6_交集必同块++; trace.push({ i, j: i2, kind: 'o', rule: 'N6_交集必同块' }); changed = true; }
      }
    }
    if (contradiction) break;
    // N7 无处共块必画界
    for (const i of B.cells) for (const j of B.nbrs.get(i)) {
      if (j <= i) continue;
      if (find(i) === find(j) || isBordered(i, j)) continue;
      const both = contains[i].some(id => alive[id] && cand[id].cells.includes(j));
      if (!both) {
        const r = drawBorder(i, j);
        if (r === 'CONTRA') fail('X1_无处可放');
        else if (r === true) { rules.N7_无处共块画界++; trace.push({ i, j, kind: 'b', rule: 'N7_无处共块画界' }); changed = true; }
      }
    }
    if (contradiction) break;
    // N5 半区满则封闭 / X2 计数溢出 / N9 封闭组件验形
    rebuildClassMasks();
    for (const [r, cs] of classCells()) {
      const g = cs.filter(i => B.isGray(i)).length, w = cs.length - g;
      const list = contains[cs[0]].filter(id => alive[id] && cand[id].cells.some(i => cs.includes(i)));
      if (!list.length) { fail('X1_无处可放'); break; }
      const areas = new Set(list.map(id => cand[id].area));
      const numv = cs.map(i => B.num.get(i)).filter(v => v !== undefined);
      const v = numv.length ? numv[0] : null;
      const areaFixed = v !== null ? 2 * v : (areas.size === 1 ? [...areas][0] : null);
      if (v !== null && (g > v || w > v)) { fail('X2_计数溢出'); break; }
      if (areaFixed !== null && (cs.length > areaFixed || g > areaFixed / 2 || w > areaFixed / 2)) { fail('X2_计数溢出'); break; }
      if (areaFixed !== null) {
        const gc = B.isGray(cs[0]) ? g : w;
        if (gc === areaFixed / 2 && cs.length < areaFixed) {   // 本半区已满 ⇒ 外面同色格进不来
          for (const i of cs) for (const j of B.nbrs.get(i)) if (B.isGray(j) === B.isGray(cs[0]) && !cs.includes(j)) {
            const t = drawBorder(i, j);
            if (t === 'CONTRA') fail('X1_无处可放');
            else if (t === true) { rules.N5_半区满封闭++; trace.push({ i, j, kind: 'b', rule: 'N5_半区满封闭' }); changed = true; }
          }
        }
        if (cs.length === areaFixed) {   // 组件装满块容量 ⇒ 封闭
          for (const i of cs) for (const j of B.nbrs.get(i)) if (!cs.includes(j)) {
            const t = drawBorder(i, j);
            if (t === 'CONTRA') fail('X1_无处可放');
            else if (t === true) { rules.N5_半区满封闭++; trace.push({ i, j, kind: 'b', rule: 'N5_半区满封闭' }); changed = true; }
          }
        }
      }
      let closed = true;
      for (const i of cs) for (const j of B.nbrs.get(i)) if (!cs.includes(j) && !isBordered(i, j)) { closed = false; break; }
      if (closed) {
        if (cs.every(i => assigned[i] >= 0 && cand[assigned[i]].cells.length === cs.length)) continue;
        rules.N9_封闭验形++;
        if (g !== w) { fail('X2_计数溢出'); break; }
        const mine = list.find(id => cand[id].cells.length === cs.length && cs.every(i => cand[id].cells.includes(i)));
        if (mine === undefined) { fail('X1_无处可放'); break; }
        if (!blockNumOK(B, cs)) { fail('X2_计数溢出'); break; }
        fixBlock(mine); changed = true;
      }
    }
    if (contradiction) break;
    if (!changed) break;   // 全部规则都推不动了：诚实收工（没解完就是没解完）
  }

  const cls = classCells();
  let knownEdges = 0, totalEdges = 0;
  const decided = new Map();     // "i-j" -> 'b' | 'o'，界面/提示都读这个
  for (const i of B.cells) for (const j of B.nbrs.get(i)) if (j > i) {
    totalEdges++;
    const same = find(i) === find(j);
    if (same || isBordered(i, j)) { knownEdges++; decided.set(SEG(i, j), same ? 'o' : 'b'); }
  }
  let unknown = 0;
  for (const i of B.cells) if (assigned[i] < 0) unknown++;
  const part = new Map();
  let gid = 0; const rid = new Map();
  for (const i of B.cells) { const r = find(i); if (!rid.has(r)) rid.set(r, gid++); part.set(i, rid.get(r)); }
  const allAssigned = unknown === 0;
  const violations = allAssigned ? B.check(part) : ['V1a 没铺满'];
  const solved = allAssigned && !contradiction && violations.length === 0;
  rules.N4_两半同形筛 = M;   // 候选块全部按构造满足"两半同形且连通"
  return {
    solved, contradiction, forced: knownEdges, total: totalEdges, unknownCells: unknown,
    rules, rulesFired: Object.entries(rules).filter(([k, v]) => v > 0 && !k.startsWith('X')).map(([k]) => k),
    partition: part, steps, candBlocks: M, poolTotal: pool.total, violations, decided, trace,
  };
}

// 判据合取（一盘的"绿"必须同时满足四件事，任一不成立就点名）：
//   ① 计数器 exhaustive 且 solutions==1
//   ② 铅笔推满（零猜测）
//   ③ 铅笔分区过整盘判据 check（另一套实现 independent 也过）
//   ④ 铅笔分区 == 计数器唯一解（按同块关系比，不按 gid）
export function judge(B, blocksAll, { cap = 400000, independent = null } = {}) {
  const ta = Date.now();
  const r = count(B, numFilter(B, blocksAll), { cap, maxSol: 2, order: 'mrv' });
  const msCount = Date.now() - ta;
  if (!(r.exhaustive && r.solutions === 1)) return { ok: false, why: r.exhaustive ? `解 ${r.solutions}${r.dead ? '（exhaustive 死盘）' : ''}` : `非穷尽(${r.stop})`, msCount, msP: 0 };
  const tb = Date.now();
  const p = pencil(B, { blocksAll });
  const msP = Date.now() - tb;
  if (!p.solved) return { ok: false, why: p.contradiction ? '铅笔 contradiction' : '铅笔推不满', msCount, msP, steps: p.steps, unknown: p.unknownCells };
  const v = B.check(p.partition);
  if (v.length) return { ok: false, why: 'check ' + v[0], msCount, msP };
  if (independent) {
    const iv = independent(B, p.partition);
    if (iv.length) return { ok: false, why: 'independent ' + iv[0], msCount, msP };
  }
  const e1 = eqRelOf(partitionToBlocks(p.partition));
  const e2 = eqRelOf(partitionToBlocks(r.sols[0]));
  const diff = [...e1].filter(k => !e2.has(k)).concat([...e2].filter(k => !e1.has(k)));
  if (diff.length) return { ok: false, why: '铅笔分区 ≠ 计数器解', msCount, msP };
  return { ok: true, msCount, msP, steps: p.steps, rules: p.rules, nums: B.num.size, unique: r.unique, nodes: r.nodes, read: r.read, solved: true, sol: r.sols[0] };
}

function eqRelOf(blocks) {
  const s = new Set();
  for (const bl of blocks) for (let a = 0; a < bl.length; a++) for (let b = a + 1; b < bl.length; b++) {
    const [x, y] = bl[a] < bl[b] ? [bl[a], bl[b]] : [bl[b], bl[a]];
    s.add(x + ':' + y);
  }
  return s;
};
