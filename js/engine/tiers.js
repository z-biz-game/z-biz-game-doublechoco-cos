// 档位表：菜单上每一档的**唯一**来源（界面、闸、balance 台架都读这一份，不在别处另列清单）。
//
// 两件事在这一份里是承诺，不是注释：
//   1) 每一档的 capWork 都是**确定的工作量预算**（DFS 访问 + 同形配对次数）。预算只会在算不起时**放弃这块底纹**，
//      不会截断已算完的池：exactBlocks 没抛 EnumBudget ⇒ 它枚举了这块底纹下的**全部**合法块
//      （blocks.js 里的 throw 只发生在超出的那一刻，从不返回部分池）。
//      所以出货那一盘的"无上限规则下唯一"是可证的，与预算大小无关；预算大小只决定等得起多少底纹。
//   2) gold 里的每一列都是 `node tools/balance.mjs 8 --pin` 实测回来的**整条数组**（同一代码路径、同一档参数、
//      连续 8 号 seed），不是手写的期望值。这些量都是确定量（轮次、数字个数、区界、工作量），
//      任何机器上逐值一样 ⇒ 闸断言的是**相等**，不是"落在带内"（B3）。
//      页面上念的中位数由这里派生（tierMed），不再有第二个手抄的数。
//      唯一的墙钟口径（出题 ms）故意**不**写进来：那是机器速度，不是这盘的性质，它只在 B4 卡方向。
//
// density 是这一档的**线索密度**：0 = 挖到"仍能过合取判据"的最稀；1 = 全数字盘。
// 这条轴是本游戏的难度主轴（同一尺寸下 4×4：d=1.00 铅笔 2 轮、d=0 要 4 轮），
// 所以阶梯不是只按边长爬——它按实测轮次爬。

import { makePuzzle } from './generate.js';
import { exactBlocks } from './blocks.js';
import { mkBoard, partitionToBlocks } from './rules.js';
import { judge } from './pencil.js';

// 出厂的工作量预算：capWork = 一块底纹允许的 DFS 访问 + 同形配对次数上限。
// 定在 40 万是量出来的，而那次测量现在就在闸里：`node tools/balance.mjs` 的 **B6** 每轮都拿同一批 seed
// 只换三个预算（15 万 / 40 万 / 400 万），打印并断言四件事：
//   · 出货率三档一样 ⇒ 预算往上买到的不是"更多的盘"，只是"更多的计算"，所以它没有理由再变大；
//   · 15 万那侧换底纹次数**不少于** 40 万 ⇒ 再小就开始把 6×6 的正常底纹判成算不起（实测 2 vs 1）；
//   · 400 万总工作量比 40 万贵好几倍（实测 4415455 vs 810975）⇒ 那条线不是免费的。
// 这四行不是注释文学：方向由 B6 断言，上面那两个"实测"数由 B6 从本文件原文解析出来与本轮读数对表。
// 墙钟也不进这条理由——预算是**计数**预算，它的理由只该由确定量支撑。
// 这条预算不伤"无上限规则下唯一"：超出即 throw，绝不返回半池 ⇒ 出货那盘的池仍是完整池
// （balance B3b 逐盘核对出货那块的枚举工作量确实留在预算内，也就是"没抛过 ⇒ 池是完整的"这一步有读数）。
// 它伤的是另一句更弱的承诺——"所有底纹都算得起"，那句本仓就不承诺（见 OUT_OF_MENU 与 DESIGN）。
export const CAP_WORK = 400_000;

// 界面与闸共用的那一个"等多久"：按"换一局"到看见盘的等待上限。
// 它是墙钟，所以只做**上界**判定（balance B4），绝不做档位顺序判定——
// 中/高两档的出题 ms 中位实测只差 1–2 ms（B4 每轮打印相邻差），邻居进程就能把它拧倒。
// 浏览器闸的等待也读这个数：一处改，两边一起改，红的时候才点得出同一句承诺。
export const GEN_BUDGET_MS = 12_000;

export const TIERS = [
  {
    key: 'sho', name: '初', R: 4, C: 4, density: 1.0,
    capWork: CAP_WORK, shades: 12, tilingsPerShade: 30, counterCap: 4000000,
    // gold 四列都是 balance B1 那连续 8 号 seed 的实测值（排序后钉住，B3 逐值比）。
    gold: { steps: [2, 2, 2, 2, 3, 3, 3, 4], cuts: [9, 9, 9, 10, 10, 12, 12, 15], nums: [16, 16, 16, 16, 16, 16, 16, 16], work: [94, 145, 174, 204, 207, 214, 289, 469] },
    note: '全盘印数字：每一格都告诉你它所在块的半区大小，先把"同形两半"拼出来',
  },
  {
    key: 'chuu', name: '中', R: 6, C: 6, density: 0.35,
    capWork: CAP_WORK, shades: 12, tilingsPerShade: 30, counterCap: 4000000,
    gold: { steps: [4, 4, 4, 4, 5, 5, 5, 6], cuts: [24, 26, 28, 28, 31, 32, 33, 35], nums: [13, 13, 13, 13, 13, 13, 13, 13], work: [552, 569, 946, 1254, 1407, 11249, 27667, 50225] },
    note: '六六盘、三分之一格有数：没有数字的格子要靠界和形状挤出去',
  },
  {
    key: 'gao', name: '高', R: 6, C: 6, density: 0,
    capWork: CAP_WORK, shades: 12, tilingsPerShade: 30, counterCap: 4000000,
    gold: { steps: [5, 5, 5, 6, 6, 7, 7, 10], cuts: [26, 27, 28, 29, 29, 31, 31, 33], nums: [3, 3, 3, 4, 4, 5, 5, 6], work: [1230, 1723, 1795, 10260, 64290, 371440, 427480, 508663] },
    note: '挖到判据不肯再挖为止：数字删到推不动才停手，剩下的格子全靠界推',
  },
  {
    key: 'kyoku', name: '极', R: 8, C: 8, density: 0,
    capWork: CAP_WORK, shades: 12, tilingsPerShade: 30, counterCap: 4000000,
    gold: { steps: [7, 8, 8, 9, 13, 13, 14, 14], cuts: [57, 57, 58, 59, 63, 63, 64, 69], nums: [3, 4, 4, 5, 7, 7, 8, 10], work: [218554, 263029, 917772, 1068386, 1520849, 2193401, 3053136, 4536722] },
    note: '八八盘挖到底：数字少到只剩几个、区界要画一大把，出题的工作量也是四档里最贵的',
  },
];

// 页面上"实测推理 X 轮 / 数字 Y 个"这类读数只有一个来源：上面那条 gold 数组。
// 中位取排序后的第 (n-1)/2 个（偶数长度取下中位），与 balance 用的口径是同一个函数。
const srt = (a) => a.slice().sort((x, y) => x - y);
export const tierMed = (t, k) => srt(t.gold[k])[Math.floor((t.gold[k].length - 1) / 2)];
export const tierMax = (t, k) => Math.max(...t.gold[k]);

// 不在菜单里的尺寸，每一档的理由都得是**这一页能自己验**的那种：
//   - 奇面积是规则推出的无解（两半等量 ⇒ 每块偶数格 ⇒ 全盘偶数格），engine-test 第 6 段直接断言它被拒；
//   - 10×10 是成本：tools/balance.mjs 的观测段每次真的去抽 8 盘并打印出货率与耗时，页面上这句
//     理由背后有当场可复跑的读数，不是一次性探针里的数字。
export const OUT_OF_MENU = [
  {
    R: 5, C: 5, odd: true,
    why: '奇数格数的盘（5×5、7×7…）不在菜单里：一块 = 白 area + 同形灰 area ⇒ 每块偶数格 ⇒ 全盘必为偶数格。这是规则本身的结论，不是算力问题。',
  },
  {
    R: 10, C: 10, odd: false,
    why: '10×10 不在菜单里：40 万次工作量预算下多数底纹算不起（得换底纹），12 块全换完仍钉不死的也不少 ⇒ 连续抽 8 号 seed 凑不满 8 盘，"每一号都有一盘可推、而且等得起"这句承诺给不出。出货率与单盘耗时不写死在这一行里：tools/balance.mjs 的 B5 每次真的去抽 8 盘并当场打印，那句"凑不满"就是它断言的方向。',
  },
];

export const tierOf = (key) => TIERS.find((t) => t.key === key) || null;
export const tierFor = (key) => tierOf(key) || TIERS[0];

// 一张盘的完整出货：makePuzzle 的返回值 + 档位声明 + 可给界面用的读数。
// null = 这一号 seed 出不了货；由调用方决定是报错还是往前推一号，绝不退回"用时间当 seed"。
export function build(spec, seed) {
  const m = makePuzzle(spec.R, spec.C, seed, {
    density: spec.density,
    capWork: spec.capWork,
    shades: spec.shades,
    tilingsPerShade: spec.tilingsPerShade,
    cap: spec.counterCap,
  });
  if (!m.ok) return null;
  return {
    tier: spec.key,
    spec,
    B: m.B,
    gray: m.gray,
    tiling: m.tiling,
    pool: m.blocks,
    seed: m.seed,
    stats: {
      ms: m.ms, enumMs: m.enumMs, digMs: m.digMs, steps: m.steps, cuts: m.cuts,
      nums: m.nums, pieces: m.pieces, poolTotal: m.blocks.total, work: m.work,
      shadeTries: m.shadeTries, tilingTries: m.tilingTries, budgetT: m.budgetT,
    },
  };
}

// 续局：照存档里的底纹+数字重建题面，不重新出题（省掉那一笔实测的生成耗时）。
//
// 存档**故意不带解**（js/store.js 只存底纹、数字和玩家自己画下的界），所以这里把解重新证一遍：
// judge() 的合取判据——计数器 exhaustive-1 + 铅笔推满 + check 0 违反 + 两者同解——当场重跑，
// 证出来的 partitionToBlocks(j.sol) 就是这一盘的块表。
// 两条后果都得写明，而且都由闸读数（tools/ui-smoke.mjs 的续局段逐档断言 ok、块表相同、重证耗时在上限内）：
//   1) 改过的/别处的档不会变成一个"答案由存档定义"的盘：过不了判据就 ok:false，界面据此丢弃并说明理由。
//      这里返回 {ok,…} 而不是像 build() 那样返回 null，就是因为丢弃必须能点名是哪一条拒了。
//   2) 重证比出题便宜得多：实测四档的续局重证都在个位到几十毫秒，而出题（含逐格挖数字的整轮判据）
//      是几十到几百毫秒——成本口径见 proof（枚举 msCount + 铅笔 msP），它由台架打印，不写死在这里。
export function rebuild(spec, bl, nums, seed = null) {
  const gray = new Set(bl);
  const B = mkBoard(spec.R, spec.C, gray, Object.fromEntries(nums));
  let pool;
  try {
    pool = exactBlocks(B, { capWork: spec.capWork });
  } catch (e) {
    if (e.name !== 'EnumBudget') throw e;
    return { ok: false, why: `枚举超工作量预算（${e.message}）` };
  }
  const j = judge(B, pool, { cap: spec.counterCap });
  if (!j.ok) return { ok: false, why: j.why };
  return {
    ok: true,
    proof: { steps: j.steps, nodes: j.nodes, msCount: j.msCount, msP: j.msP, poolTotal: pool.total },
    puzzle: { tier: spec.key, spec, B, gray, tiling: partitionToBlocks(j.sol), pool, seed, stats: null },
  };
}
