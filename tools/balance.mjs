// 阶梯闸：菜单上那四档的**难度顺序**、**每一号的盘面**和**页面上印着的数字**都在这里被重新量一遍。
//
// 为什么要有这个文件而不是只看 engine-test：engine-test 证的是"出货的每一盘都成立"，
// 它不比较档位之间的关系。而页面上每一档都写着"实测推理 X 轮 / 数字 Y 个 / 区界 Z 条"——
// 那是一句会被下一次改动悄悄推翻的承诺，所以它得有闸。
//
// 口径分成两类，混了就等于给自己埋雷：
//   · **确定量**（轮次、数字个数、区界、工作量 work）：同一 seed 序列在任何机器上都一模一样
//     （engine-test 第 6 段把 Date.now 改成每跳 5 秒都仍然出货且同盘，就是这条的证据）。
//     ⇒ 钉成 golden 数组，逐值相等（B3）。带内不算通过，等才算。
//   · **墙钟**（ms）：那是机器速度，不是这盘的性质。它进不了等式，也进不了档位顺序的判定——
//     中/高两档的 ms 中位实测只差 1–2 ms（B4 每轮把相邻差打印出来），邻居进程就能拧倒它。
//     墙钟只留一条判定：**上限**（GEN_BUDGET_MS，界面与浏览器闸共用的那一个数）。
//
// 红线清单，每条都点名是哪条红了：
//   B1 出货：每一档连续 N 号 seed 全出货，且每一盘都复跑合取判据
//   B2 阶梯：铅笔轮次中位**严格递增**，数字占比**严格递减**——顺序由实测定，不由边长定
//   B3 恒等式：这一轮实测的 steps/cuts/nums/work 四条数组必须与 tiers.js 钉着的 golden 完全一致
//   B3b 池没被截断：出货那盘的枚举工作量必须没撞过预算 ⇒ 它是**完整池**，"无上限规则下唯一"才站得住
//   B4 成本：work 中位严格递增（确定口径）；墙钟只打印顺序，只判一条上限 GEN_BUDGET_MS
//   B5 天花板观测：10×10 真的去抽，出货率只是观测；另配一条方向单调的防降级线
//   B6 CAP_WORK 的理由：同一批 seed 换三个预算，方向必须和 tiers.js 里那句话一致
//
// 用法：node tools/balance.mjs [每档样本数=8] [--pin]
//   --pin 只打印 golden（并重写 tiers.js 里那四个数组），不做判定——数字要人来钉，不许程序自己改自己的考题。
import { makePuzzle } from '../js/engine/generate.js';
import { judge } from '../js/engine/pencil.js';
import { TIERS, OUT_OF_MENU, tierMed, tierMax, GEN_BUDGET_MS } from '../js/engine/tiers.js';
import { check as indCheck } from './independent.mjs';

const PIN = process.argv.includes('--pin');
// 样本数不自由：golden 数组是按几号 seed 钉的，这一轮就得抽几个。CI 里 `node tools/balance.mjs`
// 不带参数就是钉着的那个 n——否则 B3 的"逐值相等"会退化成数组长度都不一样的比较。
const GOLD_N = Math.min(...TIERS.map(t => (t.gold ? t.gold.steps.length : 0)));
const SAMPLES = Number(process.argv.find(a => /^\d+$/.test(a)) || GOLD_N || 8);
if (TIERS.some(t => !t.gold) && !PIN) { console.log('RED 有档位没钉 gold 数组：先跑 --pin 读数，再由人钉进 tiers.js'); }
let checks = 0, fails = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`); }
};
const sorted = a => a.slice().sort((x, y) => x - y);
const med = a => (a.length ? sorted(a)[Math.floor((a.length - 1) / 2)] : NaN);
const p95 = a => (a.length ? sorted(a)[Math.max(0, Math.ceil(a.length * 0.95) - 1)] : NaN);

const seedOf = (tier, s) => s * 104729 + tier.R * 31 + Math.round(tier.density * 100) * 7;
const draw = (tier, s, capWork = tier.capWork) =>
  makePuzzle(tier.R, tier.C, seedOf(tier, s), {
    density: tier.density, capWork, shades: tier.shades, tilingsPerShade: tier.tilingsPerShade,
    cap: tier.counterCap, independent: (B, part) => indCheck(B, part),
  });

console.log(`== B1 出货：TIERS 全表连续 ${SAMPLES} 号 seed（tier 顺序就是菜单顺序）`);
const RUN = [];
for (const tier of TIERS) {
  const rows = [], bad = [];
  const t0 = Date.now();
  for (let s = 1; s <= SAMPLES; s++) {
    const m = draw(tier, s);
    if (!m.ok) { bad.push(`#${s}:${m.code}`); continue; }
    const j = judge(m.B, m.blocks, { cap: tier.counterCap, independent: (B, part) => indCheck(B, part) });
    if (!j.ok) bad.push(`#${s}:复跑判据 ${j.why}`);
    rows.push(m);
  }
  ok(`${tier.key} ${tier.R}x${tier.C} d=${tier.density} 出货且复跑判据绿 ${rows.length}/${SAMPLES}`, rows.length === SAMPLES && !bad.length, bad.join(' '));
  RUN.push({ tier, rows, cap: tier.capWork });
  console.log(`       ${tier.key}: 轮次 med=${med(rows.map(r => r.steps))} · 数字 med=${med(rows.map(r => r.nums))}/${tier.R * tier.C} · 区界 med=${med(rows.map(r => r.cuts))} · 工作量 med=${med(rows.map(r => r.work))} · 出题 ms med=${med(rows.map(r => r.ms))} p95=${p95(rows.map(r => r.ms))} max=${Math.max(...rows.map(r => r.ms), 0)} · 换底纹 med=${med(rows.map(r => r.budgetT))} max=${Math.max(...rows.map(r => r.budgetT), 0)} · 台架 ${Date.now() - t0}ms`);
}

if (PIN) {
  console.log('\n== --pin：golden 数组（按 seed 号排序后打印，逐档抄进 tiers.js 的 gold 字段）');
  for (const { tier, rows } of RUN) {
    const g = {};
    for (const k of ['steps', 'cuts', 'nums', 'work']) g[k] = sorted(rows.map(r => r[k]));
    console.log(`${tier.key}  gold: { steps: [${g.steps}], cuts: [${g.cuts}], nums: [${g.nums}], work: [${g.work}] },`);
  }
  console.log('（打印完就退出：这一轮不判定，golden 要人看过再钉）');
  process.exit(0);
}

console.log('\n== B2 阶梯方向：轮次严格升、数字占比严格降（顺序由实测定，不由边长定）');
{
  const st = RUN.map(r => med(r.rows.map(x => x.steps)));
  const dens = RUN.map(r => med(r.rows.map(x => x.nums)) / (r.tier.R * r.tier.C));
  const up = st.every((v, i) => i === 0 || v > st[i - 1]);
  const dn = dens.every((v, i) => i === 0 || v < dens[i - 1] - 1e-9);
  ok(`铅笔轮次中位严格递增 ${st.join(' < ')}`, up, up ? '' : '有两档实测一样或倒挂 ⇒ 菜单上那两句"更难"没有根据');
  ok(`数字占比严格递减 ${(dens.map(d => (d * 100).toFixed(0) + '%')).join(' > ')}`, dn);
  console.log(`       观测：区界中位 ${RUN.map(r => med(r.rows.map(x => x.cuts))).join(' / ')}（跟着尺寸走，不是难度轴本身）`);
}

console.log('\n== B3 恒等式：实测四条数组必须逐值等于 tiers.js 钉着的 golden（确定量不配带，只配等）');
for (const { tier, rows } of RUN) {
  if (!tier.gold) { ok(`${tier.key} 有 gold 数组`, false, 'tiers.js 里还没钉 golden ⇒ 页面那句实测数没有闸'); continue; }
  for (const k of ['steps', 'cuts', 'nums', 'work']) {
    const got = sorted(rows.map(r => r[k])), want = sorted(tier.gold[k] || []);
    const same = got.length === want.length && got.every((v, i) => v === want[i]);
    ok(`${tier.key} ${k} 逐值相等`, same, same ? `[${got}]` : `实测 [${got}] ≠ 钉着 [${want}] ⇒ 出题路径变了，页面上那句实测数过期`);
  }
  // 页面上念的是中位（tierMed 从 gold 派生），这里把它连同它的来路一起打印，免得读数无法对账
  console.log(`       ${tier.key} 页面读数：轮次 ${tierMed(tier, 'steps')} · 数字 ${tierMed(tier, 'nums')}/${tier.R * tier.C} · 区界 ${tierMed(tier, 'cuts')} · 工作量中位 ${tierMed(tier, 'work')} max ${tierMax(tier, 'work')}`);
}

console.log('\n== B3b 出货那盘的池必须是**完整池**（枚举没撞预算 ⇒ "无上限规则下唯一"才可证）');
for (const { tier, rows, cap } of RUN) {
  const over = rows.filter(r => r.blocks.work > cap + 32767);
  ok(`${tier.key} ${rows.length} 盘的枚举工作量都留在预算内（没有一盘是截断池）`, over.length === 0,
    over.length ? `${over.length} 盘 work>预算：完整池这句话对它们不成立` : `预算 ${cap}，实测 max=${Math.max(...rows.map(r => r.blocks.work), 0)}`);
}

console.log('\n== B4 成本阶梯：判定交给确定口径，墙钟只打印 + 一条上限');
{
  // 顺序（"越难的档越贵"）由 work 承担：它是确定的计数，本档实测阶梯 204 < 1254 < 10260 < 1068386。
  // ms 不再参与顺序判定，理由不是修辞而是这一轮打印出来的读数：中/高两档的 ms 中位只差个位数
  // （相邻差打印在下面 msΔ 里，2026-09-29 三次复跑都是 1–2 ms），任何一个邻居进程都能把它拧倒——
  // 一次 engine-test 紧接 balance 就跑通过一次红。一条能被兄弟进程拧红的线不是红线，是噪声。
  const wk = RUN.map(r => med(r.rows.map(x => x.work)));
  ok(`工作量中位严格递增 ${wk.join(' < ')}`, wk.every((v, i) => i === 0 || v > wk[i - 1]));
  const ms = RUN.map(r => med(r.rows.map(x => x.ms)));
  const p95v = RUN.map(r => p95(r.rows.map(x => x.ms)));
  console.log(`       ms 中位 ${ms.join(' · ')}（相邻差 ${ms.slice(1).map((v, i) => v - ms[i]).join(' · ')}）· p95 ${p95v.join(' · ')} — 只打印，不进判定`);
  // 唯一被留下的墙钟判定是**上限**，而且它有主人：界面上"换一局"按下去到看见盘，
  // 玩家等的是这台机器的几秒，不是档位顺序。快机器永远不会把它拧红，只有真的算不起才会。
  const worst = Math.max(...RUN.flatMap(r => r.rows.map(x => x.ms)), 0);
  ok(`每一盘出题都在 ${GEN_BUDGET_MS}ms 内出得来（本轮最慢 ${worst}ms）`, worst <= GEN_BUDGET_MS,
    `超过上限 ⇒ "按下去不会卡住"这句界面承诺给不出，且说明这一档的成本已经越过机器速度能兜住的范围`);
}

console.log('\n== B5 天花板观测（只观测，不判定）+ 防降级线');
{
  const out10 = OUT_OF_MENU.find(x => x.R === 10);
  const rows = [];
  const t0 = Date.now();
  for (let s = 1; s <= 8; s++) {
    const m = makePuzzle(10, 10, s * 104729 + 310 + 7, { density: 0, capWork: TIERS[TIERS.length - 1].capWork, shades: 12, tilingsPerShade: 30 });
    if (m.ok) rows.push(m);
  }
  console.log(`       10×10 最稀：出货 ${rows.length}/8 · ms med=${med(rows.map(r => r.ms))} max=${Math.max(...rows.map(r => r.ms), 0)} · 换底纹 max=${Math.max(...rows.map(r => r.budgetT), 0)} · 台架 ${Date.now() - t0}ms`);
  console.log(`       菜单外那一行现在说的是：${out10 ? out10.why : '（没有 10×10 这一行）'}`);
  // 方向单调的防降级线：如果哪天 10×10 连续 8 号全出货，OUT_OF_MENU 那句"凑不满"就成了假话，
  // 那时必须**要么把它请进菜单、要么重写理由**。红只认"变强"，不认"变宽"。
  ok('10×10 仍然配不上菜单那句承诺（出货 < 8/8）', rows.length < 8,
    rows.length === 8 ? '全出货了 ⇒ OUT_OF_MENU 里那句理由过期，去重写它或加一档，别让它留在页面上说谎' : '');
}

console.log('\n== B6 CAP_WORK 那句理由的复跑：同一批 seed 只换预算（确定口径，不看墙钟）');
{
  // tiers.js 里写着"再小就把正常底纹判成算不起、更大只是多做工"。这句话得有闸，否则它就是注释文学。
  const tier = TIERS.find(t => t.key === 'gao') || TIERS[TIERS.length - 1];
  const arms = [150_000, tier.capWork, 4_000_000];
  const n = 4;
  const res = arms.map(cap => {
    let ship = 0, work = 0, aban = 0;
    for (let s = 1; s <= n; s++) {
      const m = draw(tier, s, cap);
      ship += m.ok ? 1 : 0; work += m.work; aban += m.budgetT;
    }
    return { cap, ship, work, aban };
  });
  for (const r of res) console.log(`       cap=${String(r.cap).padStart(7)} 出货 ${r.ship}/${n} · 超预算换底纹 ${r.aban} 次 · 总工作量 ${r.work}`);
  const [small, mid, big] = res;
  ok(`40 万不比 15 万少出货（${mid.ship} ≥ ${small.ship}）`, mid.ship >= small.ship);
  ok(`15 万至少不比 40 万少换底纹（${small.aban} ≥ ${mid.aban}）`, small.aban >= mid.aban,
    small.aban >= mid.aban ? '小的那一头确实在判不起 ⇒ tiers.js 那句"再小就把正常底纹算不起"有读数' : '两侧一样：那句理由得重写');
  ok(`400 万多做的工一定比 40 万贵（${big.work} > ${mid.work}）`, big.work > mid.work,
    '预算买到的是更多底纹，不是更多出货 ⇒ 这条不收紧，出货率早就满了');
}

console.log(`\n${checks - fails}/${checks} 条红线绿`);
if (fails) { console.log(`RED ${fails} 条`); process.exit(1); }
