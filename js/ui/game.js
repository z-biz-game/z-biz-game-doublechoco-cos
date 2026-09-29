// 可玩状态机：玩家唯一能做的动作是"在某条虚线段上画/擦区界"。
//
// 两条与 js/engine/ 的硬绑定（这个文件不允许有第二套判断规则）：
//   * 胜负 = `B.check(part)`，即 rules.js 那张条款表（V1a/V1b/V2/V3/V4/V5/V6/V7），
//     与出题器、计数器用的是**同一份** clauses()。画面不会和判据 disagree。
//     题面唯一（generate.js 出货前逐盘重证），所以"过判据"与"等于答案"是同一件事；
//     mismatch 只作为读数保留，用来证明这两件事确实同时成立。
//   * 提示 = 在**玩家当前已画的界**约束下再跑一轮具名规则铅笔（pencil.js），
//     所以提示只能说"题面 + 你已经画下的东西"推得出的那一步，绝不会泄露一个推不出来的事实。
//     唯一用答案的地方是"你画的这条界让这盘无解"的诊断——它报的是错误，不是答案。
//
// 档位表来自 js/engine/tiers.js（唯一来源）：菜单、页面读数、闸都读那一份，这里不再另列。
import { partitionToBlocks, eqRel, mkBoard } from '../engine/rules.js';
import { exactBlocks } from '../engine/blocks.js';
import { pencil } from '../engine/pencil.js';
import { TIERS, OUT_OF_MENU, tierOf, tierFor, build, rebuild, tierMed } from '../engine/tiers.js';

export { TIERS, OUT_OF_MENU, tierOf, tierFor, build, rebuild, tierMed };

export const OPEN = 0;    // 没画界：两格目前同属一个候选区域
export const BORDER = 1;  // 画了界

export const segKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// 盘面内部的所有虚线段（相邻格之间的那条线）：横向 R*(C-1) + 纵向 (R-1)*C。
// 顺序固定（先横后纵、按行），codes()/loadCodes() 与渲染器都按这个顺序索引，
// 所以段表一变，存档字符串的语义就变了——这点写在 store 的 key 里（版本随格式走）。
export function segmentTable(B) {
  const segs = [];
  for (const i of B.cells) for (const j of B.nbrs.get(i)) if (j > i) segs.push([i, j]);
  return segs;
}

// 一块盘的拼装：存档续局与台架（官方例题、UI 烟雾）都走这里，不各自手搓字段。
// tiling 是这块盘的解，只在三处被读，且三处都不是判据：
//   1) mismatch 这个读数（证明"过判据"与"等于答案"同时成立），
//   2) wantCuts 这个进度读数（还差几条界），
//   3) "你画的界让这盘无解"时点名多余的那一条（报错误，不报下一步该怎么画）。
// 胜负（B.check）与提示（pencilNow）都不看它，所以界面没有抄答案的后门。
export function puzzleFromParts(spec, gray, nums, tiling, seed = null) {
  const B = mkBoard(spec.R, spec.C, gray, nums);
  return { tier: spec.key, spec, B, gray, tiling, seed, stats: null, pool: exactBlocks(B, { capWork: spec.capWork }) };
}

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.B = puzzle.B;
    this.R = this.B.R;
    this.C = this.B.C;
    this.segs = segmentTable(this.B);
    this.segIx = new Map(this.segs.map(([i, j], k) => [segKey(i, j), k]));
    this.st = new Uint8Array(this.segs.length);   // 全 OPEN = 开局一条界都没画
    this.status = 'playing';
    this.moves = 0;
    this.hints = 0;
    this.steps = [];
    this.cursor = this.B.id(0, 0);
    this.lastHint = null;
    this.poolFull = puzzle.pool || exactBlocks(this.B, { capWork: puzzle.spec.capWork });
    this.solRel = eqRel(this.tilingBlocks());
    this.recompute();
  }

  tilingBlocks() {
    return this.puzzle.tiling;
  }

  // 段名：给玩家看的说法。横段说"r 行 c 列 ↔ c+1 列"，纵段说"r 行 ↔ r+1 行"。
  segName(k) {
    const [i, j] = this.segs[k];
    const rc = (x) => [Math.floor(x / this.C) + 1, (x % this.C) + 1];
    const a = rc(i), b = rc(j);
    return a[0] === b[0] ? `第${a[0]}行 第${a[1]}列↔第${b[1]}列` : `第${a[0]}行↔第${b[0]}行 第${a[1]}列`;
  }

  name(i) {
    return `r${Math.floor(i / this.C) + 1}c${(i % this.C) + 1}`;
  }

  // 由已画的界推出整盘划分：没画界的相邻就是同一区域（区域 = 跨界的连通分量）。
  // gid 取该分量里最小的格号，稳定且不依赖遍历顺序。
  partition() {
    const part = new Map();
    const blocked = (i, j) => this.st[this.segIx.get(segKey(i, j))] === BORDER;
    for (const start of this.B.cells) {
      if (part.has(start)) continue;
      const stack = [start];
      const comp = [];
      part.set(start, -1);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const nx of this.B.nbrs.get(cur)) if (!part.has(nx) && !blocked(cur, nx)) { part.set(nx, -1); stack.push(nx); }
      }
      const gid = Math.min(...comp);
      for (const x of comp) part.set(x, gid);
    }
    return part;
  }

  recompute() {
    this.part = this.partition();
    this.blocks = partitionToBlocks(this.part);
    // 判据说什么，画面就画什么：违反的格直接来自 clauses()，渲染器不参与判断。
    this.rawErrs = this.B.check(this.part);
    // 开局一条界都没画时，全盘就是一个大区域：那时报一串违反只会让玩家以为题面坏了。
    // 这份宽容只给状态行与读数，不给胜负（winFacts 读未过滤的 rawErrs）。
    this.touched = this.st.some((v) => v === BORDER);
    this.errs = this.touched ? this.rawErrs : [];
    const bad = new Set();
    for (const bl of this.blocks) if (this.B.clauses(bl, bl[0]).length) for (const i of bl) bad.add(i);
    this.bad = this.touched ? bad : new Set();
    this.cuts = [...this.st].filter((v) => v === BORDER).length;
    // 要画几条界由唯一解自己数出来：段总数减去"两格同块"的相邻对。
    // 这里不读 puzzle.stats.cuts，是因为续局那条路（rebuild）没有出题过程；
    // 两处口径必须一致——tools/ui-smoke.mjs 拿出货盘逐盘断言 derived === stats.cuts。
    this.wantCuts = this.segs.filter(([i, j]) => !this.solRel.has(Math.min(i, j) + ':' + Math.max(i, j))).length;
    this.mismatch = this.relDiff().length;
    return this;
  }

  // 玩家划分与唯一解的同块关系差集（读数用：证明"过判据"和"等于答案"同时成立）。
  relDiff() {
    const mine = eqRel(this.blocks);
    return [...mine].filter((k) => !this.solRel.has(k)).concat([...this.solRel].filter((k) => !mine.has(k)));
  }

  select(i) {
    if (i < 0 || i >= this.B.cells.length) return false;
    this.cursor = i;
    return true;
  }

  // 画/擦一条段。target 省略就是取反；拖拽时传入起点定下的目标态，整段拖出同一个结果。
  toggleSeg(k, target = null) {
    if (this.status === 'won') return { refused: '这一局已经推完了。' };
    if (k < 0 || k >= this.segs.length) return { refused: '那里没有可画的段。' };
    const from = this.st[k];
    const to = target === null ? (from === BORDER ? OPEN : BORDER) : target;
    if (from === to) return { noop: true };
    this.st[k] = to;
    this.steps.push({ kind: 'seg', writes: [{ seg: k, from, to }] });
    this.moves++;
    this.recompute();
    this.checkWin();
    return { step: this.steps[this.steps.length - 1], seg: k, to };
  }

  // 键盘：方向键移动光标；Shift+方向键 = 画/擦光标与那一格邻居之间的段。
  step(from, dir) {
    const [r, c] = [Math.floor(from / this.C), from % this.C];
    const nr = r + (dir === 'up' ? -1 : dir === 'down' ? 1 : 0);
    const nc = c + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0);
    if (nr < 0 || nc < 0 || nr >= this.R || nc >= this.C) return null;
    return this.B.id(nr, nc);
  }

  toggleDir(from, dir) {
    const to = this.step(from, dir);
    if (to === null) return { refused: '已经到边了：那一面没有相邻的格。' };
    return this.toggleSeg(this.segIx.get(segKey(from, to)));
  }

  codes() {
    let s = '';
    for (const v of this.st) s += v === BORDER ? '1' : '0';
    return s;
  }

  loadCodes(codes) {
    for (let k = 0; k < this.segs.length && k < codes.length; k++) this.st[k] = codes[k] === '1' ? BORDER : OPEN;
    this.recompute();
    this.checkWin();
    return this;
  }

  // 答案对应的那一串段（台架用：证明"照着唯一解画就通关"这条路径是真的）。
  // 判据与提示都不读它，所以它不可能是"界面上抄答案"的后门。
  solutionCodes() {
    let s = '';
    for (const [i, j] of this.segs) s += this.solRel.has(Math.min(i, j) + ':' + Math.max(i, j)) ? '0' : '1';
    return s;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    for (const w of step.writes) this.st[w.seg] = w.from;
    // 提示撤回来也仍然是"用过提示"：记录按求助次数排名，退回去就等于让玩家把提示撤销成零求助。
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    // 状态跟着判据走：撤掉一步后盘不再满足条款，就不能还挂在"已通关"上。
    this.checkWin();
    return step;
  }

  // 在"玩家已画的界"约束下重跑铅笔：候选块不许跨过任何一条已画的界。
  // 过滤后的池仍是完整池的子集，而 exactBlocks 给的是这块底纹下的全部合法块（引擎注释里有这条），
  // 所以"跨界的块全去掉"不会漏掉与玩家已画内容一致的真解。
  pencilNow() {
    const crossed = [];
    for (const [i, j] of this.segs) if (this.st[this.segIx.get(segKey(i, j))] === BORDER) crossed.push([i, j]);
    let pool = this.poolFull;
    if (crossed.length) {
      pool = new Map();
      pool.total = 0;
      for (const [f, list] of this.poolFull) {
        const keep = list.filter((cells) => {
          const set = new Set(cells);
          return !crossed.some(([i, j]) => set.has(i) && set.has(j));
        });
        if (keep.length) { pool.set(f, keep); pool.total += keep.length; }
      }
    }
    return { pool, p: pencil(this.B, { blocksAll: pool }) };
  }

  // 已画的界把题面搞坏了：用唯一解点名到底是哪条界多余（报错误，不报答案）。
  diagnose() {
    const wrong = [];
    for (let k = 0; k < this.segs.length; k++) {
      if (this.st[k] !== BORDER) continue;
      const [i, j] = this.segs[k];
      if (this.solRel.has(i < j ? `${i}:${j}` : `${j}:${i}`)) wrong.push(k);
    }
    return wrong;
  }

  // 提示：只说"题面 + 你已经画下的界"逼出来的一步。
  //
  // 落点取自 pencil 的 decided，而不是 trace：decided 是**逐条相邻边**的结论，
  // trace 只记下"哪一次规则开火触发了哪一对格"。类级的界关系会覆盖同一类里每一条相邻边
  // （N8 钉下一块时只在块与块外的一对格上开火，但那块与外围的每一格之间都得画界），
  // 所以按 trace 找下一步会在离答案还差几条界的地方假性卡住——实测 6×6 差 3 条。
  // 规则名由 trace 里跨越同样两个类的那次开火作证人给出；找不到证人就**不落子**：
  // 一句说不出规则名的提示，本质上就是在报答案。这条"每条界都有具名证人"由
  // tools/ui-smoke.mjs 逐档断言，不留在这份注释里当说法。
  hint() {
    if (this.status === 'won') return null;
    const { p } = this.pencilNow();
    const wrong = this.diagnose();
    if (p.contradiction || wrong.length) {
      const which = wrong.length ? wrong.map((k) => this.segName(k)).join('、') : '';
      return {
        conflict: `你画的界和题面冲突了${which ? `：多余的应该是 ${which}` : ''}。撤销一步再想。`,
        segs: wrong,
      };
    }
    const part = p.partition;
    const same = (a, b) => part.get(a) === part.get(b);
    const apply = (k, to, rule) => {
      this.toggleSeg(k, to);
      this.steps[this.steps.length - 1].kind = 'hint';
      this.hints++;
      const [i, j] = this.segs[k];
      const info = {
        rule,
        cell: i,
        j,
        seg: k,
        value: to,
        charged: true,
        why: `${rule} ⇒ ${this.segName(k)}`,
        text: `${rule} ⇒ ${this.segName(k)} ${to === BORDER ? '必须画界' : '不能画界'}（${this.name(i)} 与 ${this.name(j)} ${to === BORDER ? '不在同一块' : '必在同一块'}）。`,
      };
      this.lastHint = info;
      this.recompute();
      this.checkWin();
      return info;
    };
    // ① 该画而还没画的界：按段号顺序扫，同一状态必给同一条提示
    for (let k = 0; k < this.segs.length; k++) {
      if (this.st[k] === BORDER || p.decided.get(segKey(this.segs[k][0], this.segs[k][1])) !== 'b') continue;
      const [i, j] = this.segs[k];
      const w = p.trace.find((t) => t.kind === 'b' && ((same(t.i, i) && same(t.j, j)) || (same(t.i, j) && same(t.j, i))));
      if (!w) continue;
      return apply(k, BORDER, w.rule);
    }
    // ② 规则说这两格同块，而玩家在那里画了界 ⇒ 擦掉它也是可推的一步
    for (const t of p.trace) {
      if (t.kind !== 'o') continue;
      const k = this.segIx.get(segKey(t.i, t.j));
      if (k === undefined || this.st[k] !== BORDER) continue;
      return apply(k, OPEN, t.rule);
    }
    if (!this.touched) return { stalled: true, text: '已经推到底了。' };
    return { stalled: true, text: `具名规则推不出新的界了：还有 ${this.remaining()} 条界要画，剩下的要么靠你再看一眼题面，要么已经推完了。` };
  }

  remaining() {
    // 铅笔说得出"还有几格没定"，界数由已画的与答案的差给：这是读数不是判据。
    return Math.max(0, this.wantCuts - this.cuts);
  }

  checkWin() {
    const won = this.winFacts();
    this.status = won.ok ? 'won' : 'playing';
    return won;
  }

  // 三条各可单独读数：判据 0 条 / 划分非平凡 / 与唯一解逐对同块关系相同。
  // 只写"看起来满了"的判定，等于让一个画满但画错的盘冒充通关。
  winFacts() {
    const errs = (this.rawErrs || this.errs).length;
    return {
      ok: errs === 0 && this.mismatch === 0 && this.cuts > 0,
      errs,
      mismatch: this.mismatch,
      cuts: this.cuts,
      wantCuts: this.wantCuts,
      regions: this.blocks.length,
    };
  }

  // 只给验收台架与"我不想推了"用：一轮一轮问提示，直到通关或推不动。
  // 它画的每一条界都是铅笔点名的，所以这条路本身就是"零猜测可推"的证据。
  solveWithLogic({ cap = 800 } = {}) {
    let k = 0;
    const rules = new Set();
    while (this.status !== 'won' && k++ < cap) {
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (h.rule) rules.add(h.rule);
    }
    return { status: this.status, steps: k, rules: [...rules], hints: this.hints, won: this.status === 'won' };
  }

  state() {
    const spec = this.puzzle.spec || tierFor(this.puzzle.tier);
    return {
      tier: this.puzzle.tier,
      name: spec.name,
      seed: this.puzzle.seed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      cuts: this.cuts,
      wantCuts: this.wantCuts,
      remaining: this.remaining(),
      regions: this.blocks.length,
      // 分母来自唯一解的块数：它和 wantCuts 一样是**进度读数**，不参与胜负（胜负只读 B.check）。
      regionsTotal: this.puzzle.tiling.length,
      conflicts: this.errs.length,
      mismatch: this.mismatch,
      grayTotal: this.B.gray.size,
      cells: this.B.cells.length,
      nums: this.B.num.size,
      poolTotal: this.poolFull.total,
      steps: this.steps.length,
      cursor: this.cursor,
      // 这一盘的实测铅笔轮数：出货时由 judge() 量的；续局那条路没有出题过程，所以是 null，
      // 界面必须据此显示"—"而不是编一个数（DESIGN 里"难度实测"这句话的分母）。
      // undefined 也算没有：rebuild() 给的 stats 只有 {ms}，写 `stats.steps` 读到的是 undefined，
      // 而 undefined !== null —— 只判 null 的话页面上会印出"undefined 轮"这句谎话。
      boardSteps: this.puzzle.stats && this.puzzle.stats.steps !== undefined ? this.puzzle.stats.steps : null,
      medSteps: tierMed(spec, 'steps'),
      medNums: tierMed(spec, 'nums'),
      medCuts: tierMed(spec, 'cuts'),
      genMs: this.puzzle.stats ? this.puzzle.stats.ms : 0,
    };
  }
}
