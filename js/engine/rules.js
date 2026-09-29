// Double Choco（ダブルチョコ）的规则与判据。规则文本有两个来源，逐字抄在这里，
// 因为本仓的"承重条款"（V7 半区必须连通）正是从这两句的字面裁出来的：
//
//   Nikoli 英文 https://www.nikoli.co.jp/en/puzzles/double_choco/
//     "Divide the grid into blocks by drawing solid lines over the dotted lines.
//      A block must contain a pair of **areas** of white cells and gray cells having the same form
//      (size and shape). One area may be a rotated or mirror image of the other.
//      A number indicates the number of cells of that color in the block; the number corresponds
//      to half the number of cells of the block. A block can contain any number of cells with the number."
//   Cross+A（https://crossa.boy.jp/ ，#DoubleChoco 段）
//     "...exactly half of cells are painted gray... each region must contain **one area** of white cells
//      and **one area** of gray cells. A pair of areas must be of the same shape and size (the areas may
//      be rotated or mirrored). A number indicates how many cells of the same color the region contains.
//      A region may contain more than one cell with a number (in this case the cells contain the same number)."
//
// 两条 "area" 都按字面理解为**连通**的一片同色格（V7）。出版方自己的 4x4 例题不裁决这一点：
// 那题在"宽松（半区可不连通）"与"严格（半区必须连通）"两种读法下都是同一唯一解，
// 所以这条是**我们做的裁定**，不是出版方给的规则——README/DESIGN 里必须这么说，且
// tools/engine-test.mjs 要把"两种读法在这盘上给出同一结论"钉成断言，而不是留在注释里。
//
// 底纹（灰格）与数字都是题面给的，玩家只画区界（solid lines over the dotted lines）。

// ---- 形状/连通的独立小工具（本文件自带一份；tools/independent.mjs 另有一份，两套互不复用）----
const D4 = [
  (r, c) => [r, c], (r, c) => [c, r], (r, c) => [r, -c], (r, c) => [-c, r],
  (r, c) => [-r, c], (r, c) => [c, -r], (r, c) => [-r, -c], (r, c) => [-c, -r],
];

// 形状指纹：平移到左上角 + 排序。cells 是格子下标数组，C 是**这块盘**的列宽
// （列宽写死会让 4x4 的盘按 6 列折叠，官方例题直接被判成死盘——踩过）。
export function shapeKey(cells, C) {
  const rc = cells.map(i => [Math.floor(i / C), i % C]);
  let best = '\uffff';
  for (const f of D4) {
    const t = rc.map(([r, c]) => f(r, c));
    const r0 = Math.min(...t.map(p => p[0])), c0 = Math.min(...t.map(p => p[1]));
    const key = t.map(p => `${p[0] - r0},${p[1] - c0}`).sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1)).join(';');
    if (key < best) best = key;
  }
  return best;
}

export function congruent(a, b, C) {
  return a.length === b.length && shapeKey(a, C) === shapeKey(b, C);
}

// 边连通（4-邻接）
export function connected(cells, nbrs) {
  if (cells.length < 2) return cells.length === 1;
  const S = new Set(cells), seen = new Set([cells[0]]), stack = [cells[0]];
  while (stack.length) {
    const x = stack.pop();
    for (const y of nbrs.get(x)) if (S.has(y) && !seen.has(y)) { seen.add(y); stack.push(y); }
  }
  return seen.size === S.size;
}

// 条款号 → 原句。红要能点名是哪条、以及那句是谁写的。
export const CLAUSES = {
  V1a: 'Divide the grid into blocks（每格恰好属于一块）',
  V1b: 'Divide the grid into blocks（一格不能同时属于两块）',
  V2: 'blocks by drawing solid lines（区域必须连通）',
  V3: 'having the same form (size…)（两半等量）',
  V4: 'having the same form (…shape) / rotated or mirror image（两半同形，可旋转/镜像）',
  V5: 'A number indicates the number of cells of that color in the block',
  V6: 'the cells contain the same number（同块数字必须一致）',
  V7: 'one area of white cells and one area of gray cells（每个 area 连通）— 本仓按字面裁定',
};

// 一个块的全部判据：返回违反项数组（项名以条款号开头）。
// 出题器、计数器候选池、玩家界面用的是**同一份** clauses()，
// 这样"数出来的唯一"和"界面上判对/判错"不会是两套规则。
export function clauses(blk, B, bi) {
  const bad = [];
  const N = B.cells.length;
  const cells = [];
  for (const i of blk) {
    if (i < 0 || i >= N) { bad.push(`V1a 越界格 ${i}（块 ${bi}）`); continue; }
    cells.push(i);
  }
  if (!cells.length) { bad.push(`V1a 块 ${bi} 是空块`); return bad; }
  if (!connected(cells, B.nbrs)) bad.push(`V2 块 ${bi} 不连通：${cells.join(',')}`);
  const gs = cells.filter(i => B.isGray(i)), ws = cells.filter(i => !B.isGray(i));
  if (!gs.length || !ws.length) bad.push(`V3 块 ${bi} 缺一色（灰${gs.length}/白${ws.length}）`);
  else if (gs.length !== ws.length) bad.push(`V3 块 ${bi} 两半不等量（灰${gs.length}/白${ws.length}）`);
  else {
    if (!congruent(gs, ws, B.C)) bad.push(`V4 块 ${bi} 两半不同形 灰[${gs.join(',')}] 白[${ws.join(',')}]`);
    if (!connected(gs, B.nbrs)) bad.push(`V7 块 ${bi} 灰半区不连通：${gs.join(',')}`);
    if (!connected(ws, B.nbrs)) bad.push(`V7 块 ${bi} 白半区不连通：${ws.join(',')}`);
  }
  const ns = cells.filter(i => B.num.has(i));
  for (const i of ns) {
    const want = B.isGray(i) ? gs.length : ws.length;
    if (B.num.get(i) !== want) bad.push(`V5 格 ${i}(${B.isGray(i) ? '灰' : '白'}) 数字 ${B.num.get(i)} ≠ 本块同色格数 ${want}`);
  }
  const vs = new Set(ns.map(i => B.num.get(i)));
  if (vs.size > 1) bad.push(`V6 块 ${bi} 里有 ${[...vs].join(',')} 两种数字`);
  return bad;
}

// 整盘划分判据：part = Map(cell -> gid)，gid<0 表示未归块。
export function check(B, part) {
  const bad = [];
  const owner = new Map();
  const groups = new Map();
  for (const [i, g] of part) {
    if (g == null || g < 0) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  for (const i of B.cells) {
    const g = part.get(i);
    if (g == null || g < 0) { bad.push(`V1a 格 ${i} 不属于任何块`); continue; }
    if (owner.has(i)) bad.push(`V1b 格 ${i} 同时属于块 ${owner.get(i)} 与块 ${g}`);
    else owner.set(i, g);
  }
  for (const [g, blk] of groups) for (const v of clauses(blk, B, g)) if (!bad.includes(v)) bad.push(v);
  return [...new Set(bad)];
}

export function mkBoard(R, C, graySet, nums = {}) {
  const cells = Array.from({ length: R * C }, (_, i) => i);
  const id = (r, c) => r * C + c;
  const nbrs = new Map(cells.map(i => [i, cells.filter(j => {
    const a = Math.floor(i / C), b = i % C, x = Math.floor(j / C), y = j % C;
    return Math.abs(a - x) + Math.abs(b - y) === 1;
  })]));
  const gray = new Set([...graySet].map(g => (Array.isArray(g) ? id(g[0], g[1]) : g)));
  const num = new Map(Object.entries(nums).map(([k, v]) => [+k, v]));
  const B = {
    R, C, cells, id, nbrs, gray, num,
    isGray: i => gray.has(i),
    check: part => check(B, part),
    clauses: (blk, bi) => clauses(blk, B, bi),
  };
  return B;
}

// ---- 官方例题（文件头那个 Nikoli 页上的第一题：题面图与解答图各自逐像素量得）----
//   底纹 # = 灰：row0 #.## / row1 #..# / row2 ..#. / row3 .##.   —— 8 灰 8 白
//   数字：(0,0)=1 (0,2)=3 (1,3)=3 落在灰格，(2,3)=2 **落在白格**（白格中位亮度实测 255）
//   ⇒ 订正：早期笔记写过"数字全落在灰格上"，那是错的；V5 按该格自身颜色取数，
//     代码一直没错，错的是那句注释。
export const OFFICIAL = {
  R: 4, C: 4,
  gray: new Set([[0, 0], [0, 2], [0, 3], [1, 0], [1, 3], [2, 2], [3, 1], [3, 2]]),
  num: { 0: 1, 2: 3, 7: 3, 11: 2 },
};

// 官方解答的区界：从 Nikoli 页上那道例题的**解答图**逐边量出的 11 条粗实线还原的分区。
// 这份 golden 是**图片**给的，不是我们计数器给的——两者必须各自独立成立再对得上。
export const OFFICIAL_SOLUTION = 'AABB/CBBB/CBDD/EEDD';

export function blocksFromLabel(lab, C) {
  const map = new Map();
  lab.split('/').forEach((row, r) => [...row].forEach((ch, c) => map.set(ch, (map.get(ch) || []).concat(r * C + c))));
  return [...map.values()];
}

// 划分 → "AABB/CBBB/…" 的可读标签（只用于打印与 golden 比对）
export function label(B, part) {
  return Array.from({ length: B.R }, (_, r) =>
    Array.from({ length: B.C }, (_, c) => {
      const g = part.get(r * B.C + c);
      return g == null || g < 0 ? '?' : String.fromCharCode(65 + (g % 26));
    }).join('')).join('/');
}

// 同块关系（谁和谁在一块）：比较两个划分时用这个，不用 gid 标签——
// gid 是枚举顺序的产物，同一划分两次跑可能给不同编号。
export function eqRel(blocks) {
  const s = new Set();
  for (const bl of blocks) for (let a = 0; a < bl.length; a++) for (let b = a + 1; b < bl.length; b++) {
    const [x, y] = bl[a] < bl[b] ? [bl[a], bl[b]] : [bl[b], bl[a]];
    s.add(x + ':' + y);
  }
  return s;
}

export const partitionToBlocks = part => {
  const m = new Map();
  for (const [i, g] of part) { if (g == null || g < 0) continue; if (!m.has(g)) m.set(g, []); m.get(g).push(i); }
  return [...m.values()];
};
