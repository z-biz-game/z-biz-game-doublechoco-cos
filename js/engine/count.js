// 穷尽计数器：在候选池上做精确覆盖 DFS。
// "未盖格 f 必须被**以 f 为极小元**的块盖住" ⇒ 每个划分只被枚举一次（不需要额外去重）。
//
// 读数必须分清四态，不许混说：
//   exhaustive & solutions==1  ⇒ 唯一（可以承诺）
//   exhaustive & solutions==0  ⇒ **死盘**，不是"0 解下界"
//   !exhaustive & stop==maxSol ⇒ 只证明了"≥maxSol"，什么也不是的唯一性
//   !exhaustive & stop==cap    ⇒ 预算耗尽：**不能对外说"唯一"**（本仓把它当判据红）
// 这一条是 farm 的老坑（"超预算"被当成"变强"）：这里 stop=='cap' 一律不绿。

export function count(B, blocks, { cap = 200000, maxSol = 2, order = 'mrv' } = {}) {
  const N = B.cells.length;
  const flat = [];
  const contains = Array.from({ length: N }, () => []);
  for (const [, list] of blocks) for (const b of list) { const id = flat.length; flat.push(b); for (const i of b) contains[i].push(id); }
  // 池里若有一个格谁都盖不住，直接死盘——不必等 DFS 撞 cap（也是"死盘 ≠ 唯一"的一种）
  for (let i = 0; i < N; i++) if (!contains[i].length) {
    return { solutions: 0, nodes: 0, bounded: false, exhaustive: true, stop: null, sols: [], dead: true, unique: false, read: '0(exhaustive 死盘：格 ' + i + ' 无候选块)' };
  }
  const cover = new Uint8Array(N);
  const assign = new Int16Array(N).fill(-1);
  const gidStack = [];
  let gid = 0, nodes = 0, sols = [], bounded = false, stop = null;

  const viable = id => { const b = flat[id]; for (const c of b) if (cover[c]) return false; return true; };
  const choose = () => {
    if (order === 'row') { for (let i = 0; i < N; i++) if (!cover[i]) return i; return -1; }
    let best = -1, bn = Infinity;
    for (let i = 0; i < N; i++) {
      if (cover[i]) continue;
      let n = 0;
      for (const id of contains[i]) if (viable(id)) n++;
      if (n < bn) { bn = n; best = i; if (n <= 1) break; }
    }
    return best;
  };
  const rec = () => {
    if (bounded) return;
    if (nodes > cap) { bounded = true; stop = 'cap'; return; }
    const f = choose();
    if (f < 0) {
      nodes++;
      const part = new Map();
      for (const c of B.cells) part.set(c, assign[c]);
      sols.push(part);
      if (sols.length >= maxSol) { bounded = true; stop = 'maxSol'; }
      return;
    }
    for (const id of contains[f]) {
      const b = flat[id];
      if (!viable(id)) continue;
      nodes++;
      for (const i of b) { cover[i] = 1; assign[i] = gid; }
      gidStack.push(gid); gid++;
      rec();
      gid = gidStack.pop();
      for (const i of b) { cover[i] = 0; assign[i] = -1; }
      if (bounded) return;
    }
  };
  rec();
  const exhaustive = !bounded;
  return {
    solutions: sols.length, nodes, bounded, exhaustive, stop, sols,
    read: exhaustive ? (sols.length === 0 ? '0(exhaustive 死盘)' : `${sols.length}(exhaustive)`) : `≥?(${stop} 耗尽, 已见 ${sols.length})`,
    unique: exhaustive && sols.length === 1,
    dead: exhaustive && sols.length === 0,
  };
}

// 挑格启发式的对照：同一盘、同一池、两种 order 各跑一遍，节点数必须一致或都穷尽。
// （撞预算时先怀疑自己的搜索顺序，不先怀疑"成本无界"——上一轮 Sashigane 10x10 就是
//  行序 200M 节点 vs MRV 1,637。）
export function countBoth(B, blocks, cap) {
  const a = count(B, blocks, { cap, maxSol: 2, order: 'row' });
  const b = count(B, blocks, { cap, maxSol: 2, order: 'mrv' });
  return { row: a, mrv: b };
}
