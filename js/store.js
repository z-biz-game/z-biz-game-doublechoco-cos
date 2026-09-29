// Persistence. Everything lives under one key `doublechoco-cos:v1` so a reset is one line, and a run in
// progress is stored as (tier, origin seed, the clue set, what the player has written, what the
// run has cost) — never the solution. The clue set travels because regenerating a board re-pays an
// enumeration whose cost is a measured quantity (js/engine/tiers.js 的 gold.work：极档那一盘
// 的候选池枚举是四档里最贵的一笔), and a resume should not re-pay that; the seed travels because it
// is the only thing that makes "再来一局" reproducible.
//
// Every field is checked before it is trusted. A payload from another repo, a truncated string or
// a hand-edited JSON must fall back to "no save" rather than crash the first frame — the farm's
// rule is that storage is untrusted input.

const KEY = 'doublechoco-cos:v1';

// 玩家盘面串：一个字符 = 一条**内部虚线段**画没画（'1' 画了区界 / '0' 没画）。
// 一盘的段数是 R*(C-1) + (R-1)*C（4×4 = 24，6×6 = 60，8×8 = 112），
// 顺序由 js/ui/game.js 的 segmentTable() 定（先"右邻"后"下邻"、按行），
// 编码字母表由 codes()/loadCodes() 定。改那两处必须同时改这里——
// 这一段校验的作用是"长度或字母表不对 ⇒ 判成没有存档"，所以它必须与 codes() 严格同一口径；
// 段表顺序一变，旧串的含义就变了，所以存档的 key 带版本（v1 只对 v1 的段表顺序）。
const CODES = '01';
const codesLen = (R, C) => R * (C - 1) + (R - 1) * C;

const defaults = () => ({
  v: 1,
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0, generated: 0 },
  // 自增种子游标。默认 seed 绝不取日期/时间：那会让 UI 上印着的"seed 1234"变成一个
  // 明天就对不上号的数字。游标存在存档里，所以"这一档下一局"是可复跑的。
  seedCounter: 1,
});

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

// DC-HOOK: hebi 这里校验的是黑格三元组 [i, arrow, num]（箭头 + 读数）。DOUBLE CHOCO 的题面
// 是**底纹 + 数字**两张表：gray 是灰格下标数组，nums 是 [i, v] 对。两者都是 rules.js 的 mkBoard
// 直接吃的形状（gray: Set/array of index；nums: {index: v}）。
function validGray(raw, R, C) {
  if (!Array.isArray(raw) || !raw.length || raw.length > R * C) return null;
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!isInt(e) || e < 0 || e >= R * C || seen.has(e)) return null;
    seen.add(e);
    out.push(e);
  }
  out.sort((a, b) => a - b);
  // 规则本身的结论（rules.js V3 / blocks.js 的入场检查）：一块 = 白区 + 同形灰区 ⇒ 半盘灰。
  // 不在这里挡掉，rebuild() 会在 exactBlocks 里抛"底纹不是半盘灰"，坏档的表现就变成白屏。
  if (out.length !== (R * C) / 2) return null;
  return out;
}

function validNums(raw, R, C) {
  if (!Array.isArray(raw) || raw.length > R * C) return null;
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 2) return null;
    const [i, v] = e;
    if (!isInt(i) || i < 0 || i >= R * C || seen.has(i)) return null;
    if (!isInt(v) || v < 1 || v > R * C) return null;
    seen.add(i);
    out.push([i, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function validCells(raw, R, C) {
  const len = codesLen(R, C);
  if (typeof raw !== 'string' || raw.length !== len) return null;
  for (const ch of raw) if (!CODES.includes(ch)) return null;
  return raw;
}

function readResume(raw, tierOf) {
  if (!raw || typeof raw !== 'object') return null;
  const tier = typeof raw.tier === 'string' ? raw.tier : '';
  const spec = tierOf(tier);
  // 尺寸必须与档位声明一致：这一条把"别的仓/别的盘"的存档直接挡掉，
  // 而不是等到 mkBoard 拿一个没见过的 R×C 去画空棋盘。
  if (!spec) return null;
  const R = raw.R, C = raw.C;
  if (!isInt(R) || !isInt(C) || R !== spec.R || C !== spec.C) return null;
  if (R * C > 400) return null;
  if (!isInt(raw.seed) || raw.seed < 1 || raw.seed > 1e9) return null;
  const gray = validGray(raw.gray, R, C);
  const nums = validNums(raw.nums, R, C);
  const cells = validCells(raw.cells, R, C);
  if (!gray || !nums || !cells) return null;
  const n = (v) => (isInt(v) && v >= 0 ? v : 0);
  return {
    tier,
    seed: raw.seed,
    R,
    C,
    gray,
    nums,
    cells,
    // 光标不在盘上就当第 0 格：它是一个位置读数，不值得为它丢一整局。
    cursor: isInt(raw.cursor) && raw.cursor >= 0 && raw.cursor < R * C ? raw.cursor : 0,
    moves: n(raw.moves),
    hints: n(raw.hints),
    elapsedMs: n(raw.elapsedMs),
  };
}

function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    const settings =
      parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...settings },
      totals: { ...base.totals, ...(parsed.totals || {}) },
      seedCounter: isInt(parsed.seedCounter) && parsed.seedCounter >= 1 ? parsed.seedCounter : 1,
      best: parsed.best && typeof parsed.best === 'object' ? parsed.best : {},
      // 结构不过就丢，不抛：坏档的表现必须是"没有存档"，不是白屏。
      resume: parsed.resume && typeof parsed.resume === 'object' ? parsed.resume : null,
    };
  } catch {
    return base;
  }
}

export const Store = {
  data: load(),
  key: KEY,

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  // ---- seed counter (the default seed is this cursor, never the clock) ----

  peekSeed() {
    return this.data.seedCounter;
  },
  // 出货后把游标推到"实际用掉的那个 seed 的下一号"：makePuzzle 在退货时会内部 seed++，
  // 推到位才不会连着两次按"换一局"拿到同一张盘。
  advanceSeed(to) {
    const next = isInt(to) && to + 1 > this.data.seedCounter ? to + 1 : this.data.seedCounter + 1;
    this.data.seedCounter = Math.min(next, 1e9);
    this.save();
    return this.data.seedCounter;
  },

  best(tier) {
    const b = this.data.best[tier];
    return b && isInt(b.ms) && isInt(b.hints) && isInt(b.moves) ? b : null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board
  // out myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.best(tier);
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  // DC-HOOK: puzzle 这一侧读的是题面两张表——B.gray（Set<格下标>）与 B.num（Map<格下标, 数字>），
  // 形状来自 js/engine/rules.js 的 mkBoard。hebi 在这里序列化的是 black Map(i -> {arrow, num})。
  // codes: 玩家自己的盘面串，字母表与长度见上面那两条常量。
  saveResume(puzzle, codes, elapsedMs, run) {
    const bl = [];
    for (const i of puzzle.B.gray) bl.push(i);
    bl.sort((a, b) => a - b);
    const nums = [];
    for (const [i, v] of puzzle.B.num) nums.push([i, v]);
    nums.sort((a, b) => a[0] - b[0]);
    this.data.resume = {
      tier: puzzle.tier,
      seed: puzzle.seed,
      R: puzzle.B.R,
      C: puzzle.B.C,
      gray: bl,
      nums,
      cells: codes,
      // 光标也存：四个方向键落的是"光标那一格"的四条边，续局后光标停在昨天的格上，
      // 键盘玩家才不会一上来就画错段。它只是一个位置读数，越界就当 0（见 readResume）。
      cursor: isInt(run.cursor) ? run.cursor : 0,
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that
      // decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      elapsedMs,
      at: Date.now(),
    };
    this.save();
  },

  // null on "no save" and on "unusable save"; the caller never has to try/catch.
  resume(tierOf) {
    return readResume(this.data.resume, tierOf);
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    // 游标也归零：纪录清空后"下一局"应当从可复跑的第 1 号重新开始，而不是接着今天抽到的号。
    this.data = defaults();
    this.save();
  },
};
