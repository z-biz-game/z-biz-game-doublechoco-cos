// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// private flag. A `.status` string says what the code intended; a client rect and a pixel say
// what the player got. The interesting failures in this game are exactly the ones where the state
// is right and the picture is wrong — a clue printed as a digit but painted as a plain gray cell,
// a "画了界" that paints identically to "还没画".
//
// 真事件（鼠标/触屏/键盘）不在这条腿里：那三条腿由 tools/playtest.cjs 的 `leg` 命令用 CDP
// Input.dispatch* 驱动。这里写格子走的是 dc.write，也就是点击之后落到的同一个状态机。
//
// window.dc.engine is the shipped module graph, so a scenario that passes here has passed on
// the same solver the player's hints come from — not a second copy kept for testing.
//
// 这一份是从 z-biz-game-hebi-cos 的同一套场景搬过来的：行的**顺序与形状**保持原样，
// 凡原来断的是蛇/黑格/箭头这类游戏语义，这里保留同一行并打上 DC-HOOK，
// 换成 DOUBLE CHOCO 里同一位置的语义（底纹 / 数字 / 区界 / 两半同形）。删行 = 丢承诺，不许。
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Mixing them up is
// how `ck('steps', 0)` reads as a failure to a human and a pass to a boolean — every "must equal"
// below therefore goes through eq. Every row name is printed on red, so a red line is never just
// `undefined`.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // 阴性自证：GATE_SELFTEST=1 时每一份报告都多一条注定错的期望。没有这一段，
    // "闸全绿"这句话没有任何东西支撑——写了但从没能红的闸，和坏掉的闸长得一样。
    if (w.__selftest) rows.push({ test: 'GATE_SELFTEST 种下的错期望（1 应当等于 2）', pass: 1 === 2, detail: 'planted red' });
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 崩掉不算"红"，崩掉必须点名叫出来：所以这里挂一个 error 收集器，坏档那条腿要读它。
  const bootErrors = [];
  w.addEventListener('error', (e) => bootErrors.push(String(e.message || e)));
  w.addEventListener('unhandledrejection', (e) => bootErrors.push('promise: ' + String(e.reason)));

  const A = () => w.dc;
  const E = () => w.dc.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const shown = (sel) => {
    // display 与几何两个都要读：`display:grid` 会盖掉 UA 的 [hidden]，所以"藏起来了"这句话
    // 只能由 getClientRects() 长度来作证，不能由 hidden 属性本身。
    const e = $.call(document, sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const rectOf = (sel) => {
    const e = $.call(document, sel);
    return e ? e.getBoundingClientRect() : null;
  };

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const near = (p, c, tol = 8) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // 一格的两个采样点：底色在 20% 处（数字不会盖到这里），内容在正中（数字/标记画在这里）。
  const basePixel = (i, f = 0.2) => {
    const r = A().view.cellRect(i);
    return pixel(r.x + r.size * f, r.y + r.size * f);
  };
  const midPixel = (i) => {
    const r = A().view.cellRect(i);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  const brightIn = (i) => {
    const v = A().view;
    const r = v.cellRect(i);
    const d = v.geo.dpr;
    const s = Math.round(r.size * 0.7 * d);
    const g = v.ctx.getImageData(Math.round((r.x + r.size * 0.15) * d), Math.round((r.y + r.size * 0.15) * d), s, s).data;
    let n = 0;
    for (let k = 0; k < g.length; k += 4) if (g[k] + g[k + 1] + g[k + 2] > 300) n++;
    return n;
  };
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);
  const count = (s, ch) => [...s].filter((c) => c === ch).length;
  // blocks array -> Map(cell -> gid)，也就是 rules.js 的 check()/label() 吃的那个形状。
  const partOf = (blocks) => {
    const m = new Map();
    blocks.forEach((bl, bi) => bl.forEach((i) => m.set(i, bi)));
    return m;
  };

  // 一次落子 = 在两格之间画/擦一条区界。drawAt 调的是 dc.setSeg —— 也就是 onPointerDown 点在
  // 那条虚线上调的同一个入口，所以闸画的每一条界与玩家自己点出来走的是同一条控制流。
  // 这个文件里不允许出现第二个写状态的通道（loadCodes 只在续局腿由页面自己用）。
  const drawAt = async (i, j, target) => {
    const g = A().game;
    const k = g.segIx.get(E().segKey(i, j));
    const r = A().setSeg(k, target);
    await wait(15);
    return { k, r };
  };

  // 段 k 在答案里到底该不该画界（solRel 是"同块关系"集，见 js/ui/game.js）。
  const solCut = (g, k) => {
    const [i, j] = g.segs[k];
    return !g.solRel.has(Math.min(i, j) + ':' + Math.max(i, j));
  };

  // 照唯一解画满：该不该画由 game.js 的 solutionCodes() 给，落子仍逐条走 setSeg。
  // 这一句很重要——这条腿证的正是"照着解画就通关"这条路径在真接口上成立，不是 loadCodes 的捷径。
  const paintSolution = async (g, { skip = null } = {}) => {
    const code = g.solutionCodes();
    for (let k = 0; k < g.segs.length; k++) if (code[k] === '1' && k !== skip) A().setSeg(k, E().BORDER);
    await wait(40);
    return code;
  };

  // 找一条两侧底色符合 want(grayI, grayJ) 的段；排除与光标相邻的那些（光标框与把手点就画在段上）。
  const segWith = (g, want) => {
    for (let k = 0; k < g.segs.length; k++) {
      const [i, j] = g.segs[k];
      if (i === g.cursor || j === g.cursor) continue;
      if (want(g.B.isGray(i), g.B.isGray(j))) return k;
    }
    return -1;
  };

  // 一条段在"某一侧那一格"上的可见性：max = 与那一格底色的最大色距，cov = 有墨的采样点比例。
  // vis 由调用方从**实测的灰白底色色差**推出来（见 layout 腿），不是抄进闸里的一个像素数：
  // 这样"看得见"这句话的量纲就是题面自己给的对比度。画布把一条段分两半、各按自己那一格的底色
  // 选墨（js/render/board.js 的 sideStroke），所以两侧必须各自量一遍——只量一侧的话，另一侧
  // 的墨沉进底色里（区界在白格那一侧曾用 --border ≈ 纸色）是读不出来的。
  const segProfile = (k, side, vis) => {
    const v = A().view;
    const s = v.segLine(k);
    const [i, j] = v.game.segs[k];
    const vertical = Math.abs(s.x1 - s.x2) < 0.5;
    const ix = side < 0 ? i : j;
    const base = basePixel(ix, 0.2);
    const n = 13;
    let max = 0;
    let ink = 0;
    for (let t = 0; t < n; t++) {
      const f = 0.12 + (0.76 * t) / (n - 1);
      const along = vertical ? s.y1 + (s.y2 - s.y1) * f : s.x1 + (s.x2 - s.x1) * f;
      const across = (vertical ? s.x1 : s.y1) + (side < 0 ? -1 : 0);
      const p = vertical ? pixel(across, along) : pixel(along, across);
      const d = Math.abs(p[0] - base[0]) + Math.abs(p[1] - base[1]) + Math.abs(p[2] - base[2]);
      if (d > max) max = d;
      if (d >= vis) ink++;
    }
    return { max, cov: Math.round((ink / n) * 100) / 100 };
  };

  // 白格上的数字是深色墨（Palette.inkOnPaper），所以"数亮像素"那一套在这里要反过来数。
  // 这一份只用在灰格上：白格自己的底色就够亮，brightIn 的绝对阈值在那一侧没有意义。
  const darkIn = (i) => {
    const v = A().view;
    const r = v.cellRect(i);
    const d = v.geo.dpr;
    const s = Math.round(r.size * 0.7 * d);
    const g = v.ctx.getImageData(Math.round((r.x + r.size * 0.15) * d), Math.round((r.y + r.size * 0.15) * d), s, s).data;
    const b = pixel(r.x + r.size * 0.2, r.y + r.size * 0.2);
    const bs = b[0] + b[1] + b[2];
    let n = 0;
    for (let k = 0; k < g.length; k += 4) if (bs - (g[k] + g[k + 1] + g[k + 2]) > 150) n++;
    return n;
  };

  const beginFresh = async (tier, seed) => {
    // begin() 是异步的：贵计算之前它要先画一帧"出题中"（withBusy 里 await nextPaint）。
    // 这里必须 await，否则拿到的是一个 Promise，而盘还没摆好——那种"绿"读的是上一局的残留状态。
    const g = await A().begin({ tier, seed });
    await wait(60);
    return g;
  };

  // ---------- engine ----------

  const engine = async () => {
    const en = E();
    ck(
      '页面挂出了可测的引擎',
      !!(en && en.mkBoard && en.makePuzzle && en.pencil && en.count && en.exactBlocks && en.TIERS),
      Object.keys(en || {}).slice(0, 8).join(',')
    );
    // DC-HOOK: hebi 这一行断的是蛇长这个"题面给的定值"（en.LEN === 5）。DOUBLE CHOCO 里
    // 同样由题面钉死的定值是"数字 = 本块的一半"，所以这一行改判官方例题的每一个数字。
    const OB = en.mkBoard(en.OFFICIAL.R, en.OFFICIAL.C, en.OFFICIAL.gray, en.OFFICIAL.num);
    const solBlocks = en.blocksFromLabel(en.OFFICIAL_SOLUTION, en.OFFICIAL.C);
    const halfOf = new Map();
    solBlocks.forEach((bl) => bl.forEach((i) => halfOf.set(i, bl.length / 2)));
    ck('数字 = 该格自身颜色在本块里的格数（V5 逐格核官方例题）', [...OB.num.entries()].every(([i, v]) => halfOf.get(i) === v), JSON.stringify([...OB.num.entries()]));
    // DC-HOOK: hebi 断的是箭头字母表（UDLR 四种）。本游戏题面不印方向，具名的那一组是规则表：
    // 每条都必须形如 N1_…/N9_…/X1_…/X2_…，与 pencil.js 里 trace 用的名字同一套。
    ck('具名规则表在页面上可得', en.RULE_TEXT && Object.keys(en.RULE_TEXT).length >= 9, en.RULE_TEXT && Object.keys(en.RULE_TEXT).length);
    ck('规则名都是 N*/X* 前缀', Object.keys(en.RULE_TEXT).every((k) => /^[NX]\d+_/.test(k)), Object.keys(en.RULE_TEXT).join(','));
    // DC-HOOK: hebi 的 DIR.U = [-1,0] 是"上移一行"。本仓没有方向线索，同一条"形状可旋转"的承诺
    // 由 V4 承载：横三格与竖三格的形状指纹必须相同，而直三格与 L 三格必须不同。
    eq('形状指纹对旋转不变（直三格 == 竖三格）', en.shapeKey([0, 1, 2], 3), en.shapeKey([0, 3, 6], 3));
    ck('直三格与 L 三格不同形', en.shapeKey([0, 1, 2], 3) !== en.shapeKey([0, 1, 3], 3), `${en.shapeKey([0, 1, 2], 3)} vs ${en.shapeKey([0, 1, 3], 3)}`);
    const spec0 = en.tierFor('sho');
    const B = en.mkBoard(spec0.R, spec0.C, en.randomShading(spec0.R, spec0.C, en.rng(7)), {});
    eq('档位声明的格数', B.cells.length, spec0.R * spec0.C);
    eq('id(r,c) 就是 r*C+c', B.id(2, 1), 2 * B.C + 1);
    // DC-HOOK: hebi 的 B.name(i)（r1c5 这样的格名）与 B.rc(i)/B.inb(r,c) 是引擎给的适配器；
    // 本仓 js/engine/rules.js 只给 id/nbrs/gray/num，格名与 rc/inb 由 js/ui/game.js 的 B 适配器提供
    // （main.js 的 moveCursor / select / dc.cellXY 都走那一份）。这里改断 label() 的往返。
    eq('blocksFromLabel 覆盖全盘格数', solBlocks.reduce((n, b) => n + b.length, 0), OB.cells.length);
    eq('角格只有两个邻居', B.nbrs.get(B.id(0, 0)).length, 2);
    eq('盘心格有四个邻居', B.nbrs.get(B.id(1, 1)).length, 4);
    ck('越界格被 V1a 点名', en.clauses([-1], B, 0).some((v) => /^V1a/.test(v)), JSON.stringify(en.clauses([-1], B, 0)));
    ck('空块被 V1a 点名', en.clauses([], B, 0).some((v) => /^V1a/.test(v)), JSON.stringify(en.clauses([], B, 0)));
    // DC-HOOK: hebi 的两条 ray（从黑格沿箭头走到下一个黑格/边界）与 eyeRay（蛇头背向身体的延长线）
    // 在本游戏没有对应几何；顶上来的是两条同样"承重"的判据：area 必须连通（V7），
    // 两半必须等量（V3）。这两条红了，出题器就不该出货。
    eq('连通判据认这条 L 形', en.connected([0, 1, B.C], B.nbrs), true);
    eq('连通判据拒两个分离的格', en.connected([0, 2 * B.C], B.nbrs), false);
    const oB = en.mkBoard(en.OFFICIAL.R, en.OFFICIAL.C, en.OFFICIAL.gray, en.OFFICIAL.num);
    const goodPart = partOf(solBlocks);
    eq('官方解答过整盘判据（0 条违反）', oB.check(goodPart).length, 0);
    eq('官方解答的 label 就是图片上那份', en.label(oB, goodPart), en.OFFICIAL_SOLUTION);
    // 把一块里的一格挪到另一块：两半不再等量（V3），并且多半也不再同形（V4）。
    const broken = new Map(goodPart);
    broken.set(1, 1);
    const bv = oB.check(broken);
    ck('拆走一格就报 V3/V4/V7 之一', bv.some((v) => /^V[347]/.test(v)), JSON.stringify(bv.slice(0, 2)));
    // 两半等量但形状不同（灰 {0,2} 是隔开的两格、白 {1,5} 是挨着的两格）⇒ V4 单独红；
    // 同一块里那条不连通的灰半区还要被 V7 点名。
    const shapeBad = en.clauses([0, 1, 2, 5], oB, 8);
    ck('两半不同形报 V4', shapeBad.some((v) => /^V4/.test(v)), JSON.stringify(shapeBad.slice(0, 2)));
    ck('半区不连通报 V7', shapeBad.some((v) => /^V7/.test(v)), JSON.stringify(shapeBad.slice(0, 2)));
    // 判据必须能点名"缺一色"的一块（全灰的两格）：V3 的那句"缺一色"
    ck('全一色的块报"缺一色"', en.clauses([0, 2], oB, 9).some((v) => /^V3/.test(v) && /缺一色/.test(v)), JSON.stringify(en.clauses([0, 2], oB, 9)));
    // 同块出现两个不同数字 ⇒ V6
    ck('同块两个数字报 V6', en.clauses([0, 1, 2, 3], oB, 7).some((v) => /^V6/.test(v)), JSON.stringify(en.clauses([0, 1, 2, 3], oB, 7)));
    // 确定性：同一个 seed 两次必须同一张盘（页面印 seed 就靠这句话）
    const mk = (seed) => en.build(spec0, seed);
    const a = mk(4242);
    const b = mk(4242);
    ck('出得了货', !!(a && b), JSON.stringify([!!a, !!b]));
    eq('同 seed 同底纹', [...a.gray].sort((x, y) => x - y).join(','), [...b.gray].sort((x, y) => x - y).join(','));
    eq('同 seed 同唯一解（按同块关系比）', [...en.eqRel(a.tiling)].sort().join(','), [...en.eqRel(b.tiling)].sort().join(','));
    ck('返回的 seed 是整数', Number.isInteger(a.seed), a.seed);
    // DC-HOOK: hebi 在这里断 difficulty(stats) === stats.pencilSteps（一个由 stats 派生的难度分）。
    // 本仓的 tiers.js 故意不把墙钟写进任何读数，难度分怎么算由 js/ui/game.js 定义；
    // 这里先钉住"轮次这个口径确实是铅笔给的"。
    ck('出货盘的推理轮次是正整数', Number.isInteger(a.stats.steps) && a.stats.steps > 0, a.stats.steps);
    const p = en.pencil(a.B, { blocksAll: a.pool, capWork: en.CAP_WORK });
    eq('出货盘必须零猜测推得满', p.solved, true);
    eq('铅笔分区过整盘判据', a.B.check(p.partition).length, 0);
    ck('铅笔的 trace 带规则名', /^[NX]\d+_/.test(p.trace[0].rule), p.trace[0].rule);
    ck('规则名指得回 RULE_TEXT', !!en.RULE_TEXT[p.trace[0].rule], p.trace[0].rule);
    ck('trace 的两端都是盘上的格', a.B.cells.includes(p.trace[0].i) && a.B.cells.includes(p.trace[0].j), JSON.stringify(p.trace[0]));
    // DC-HOOK: hebi 这一行断"出货盘确有留白的白格"（本游戏的对应物是"确有没数字的格"），
    // 但菜单第一档是 density=1.0 的全数字盘，所以这一句归 gen 腿按档核（见下面的 nums）。
    ck('底纹确实是半盘灰', a.B.gray.size * 2 === a.B.cells.length, `灰${a.B.gray.size}/${a.B.cells.length}`);
    ck('数字取值都在合法区间', [...a.B.num.values()].every((v) => Number.isInteger(v) && v >= 1 && 2 * v <= a.B.cells.length), JSON.stringify([...a.B.num.values()]));
    eq('数字个数与出货读数一致', a.B.num.size, a.stats.nums);
    eq('解本身 0 条违反', a.B.check(partOf(a.tiling)).length, 0);
    const cnt = en.count(a.B, en.numFilter(a.B, a.pool), { cap: 4000000, maxSol: 2, order: 'mrv' });
    eq('穷举只数出一个解', cnt.solutions, 1);
    eq('穷举是 exhaustive 的', cnt.exhaustive, true);
    return report({ clues: a.B.num.size, steps: a.stats.steps, cells: a.B.cells.length, gray: a.B.gray.size, cuts: a.stats.cuts });
  };

  // ---------- gen：菜单每一档的实测数字要在浏览器里也成立 ----------

  const gen = async () => {
    const en = E();
    // DC-HOOK: hebi 在这里钉死了"三档"。本仓档位表唯一的来源是 js/engine/tiers.js，
    // 所以钉的是**顺序与 key**（菜单就是按这个顺序渲染的），而不是一个抄来的条数。
    eq('档位 key 与顺序照 tiers.js', en.TIERS.map((t) => t.key).join(','), 'sho,chuu,gao,kyoku');
    const per = {};
    for (const [k, t] of en.TIERS.entries()) {
      const steps = [];
      const ms = [];
      for (let s = 0; s < 3; s++) {
        const pz = en.build(t, 900 + k * 40 + s);
        ck(`${t.name} 出得了货`, !!pz, `${t.name} seed ${900 + k * 40 + s}`);
        if (!pz) continue;
        steps.push(pz.stats.steps);
        ms.push(pz.stats.ms);
        const p = en.pencil(pz.B, { blocksAll: pz.pool, capWork: en.CAP_WORK });
        eq(`${t.name} 零猜测推得满`, p.solved, true);
        const c = en.count(pz.B, en.numFilter(pz.B, pz.pool), { cap: 4000000, maxSol: 2, order: 'mrv' });
        eq(`${t.name} 唯一解`, c.solutions, 1);
        eq(`${t.name} 解过判据`, pz.B.check(p.partition).length, 0);
        const B = pz.B;
        eq(`${t.name} 尺寸就是档位`, `${B.R}×${B.C}`, `${t.R}×${t.C}`);
        // 密度这一轴要在页面上是真的：数字少的档必须真能出现"没有数字的格"。
        ck(`${t.name} 数字个数不超过全盘`, B.num.size <= B.cells.length, `${B.num.size}/${B.cells.length}`);
      }
      per[t.key] = { med: median(steps), medMs: median(ms), min: Math.min(...steps), max: Math.max(...steps) };
      // 页面上念的中位数只有一个来源（tierMed），这里核对它确实读的是同一份 gold 数组。
      ck(`${t.name} 的 tierMed 读数可得`, en.tierMed(t, 'steps') > 0, en.tierMed(t, 'steps'));
    }
    // 相邻两档会重叠（balance 只承诺首末两档不重叠），所以这里量的就是那句承诺：
    const first = per[en.TIERS[0].key];
    const last = per[en.TIERS[en.TIERS.length - 1].key];
    ck('首末两档的推理轮次区间不重叠', last.min > first.max, `首 max ${first.max} < 末 min ${last.min}`);
    ck('难度按轮次单调（首<末中位）', first.med < last.med, `${first.med} < ${last.med}`);
    // DC-HOOK: hebi 的 OUT_OF_MENU 是**一个对象**（只有 10×10 那一条）。tiers.js 给的是一条数组
    // （奇面积一条、10×10 成本一条），页面上 main.js 逐条渲染，所以这里两条都要点名。
    ck('不在菜单里的每一档都有理由', en.OUT_OF_MENU.length >= 2 && en.OUT_OF_MENU.every((o) => o.why && o.R && o.C), JSON.stringify(en.OUT_OF_MENU.map((o) => `${o.R}×${o.C}`)));
    ck('10×10 的出局理由写在页面上', en.OUT_OF_MENU.some((o) => /10×10/.test(o.why)), en.OUT_OF_MENU.map((o) => o.why).join(' | '));
    ck('奇数格数的出局理由写在页面上', en.OUT_OF_MENU.some((o) => /奇数格数/.test(o.why)), en.OUT_OF_MENU.map((o) => o.why).join(' | '));
    ck('档位标的是实测数而不是形容词', en.TIERS.every((t) => t.gold && t.gold.steps.length && en.tierMed(t, 'steps') > 0), JSON.stringify(en.TIERS.map((t) => t.gold && t.gold.steps)));
    return report(per);
  };

  // ---------- play：读数、光标、画/擦一条界、盘外与盘边的拒答 ----------

  const play = async () => {
    const en = E();
    const t0 = en.tierFor('sho');
    eq('开局前棋局页是藏起来的', shown('#view-game'), false);
    const g = await beginFresh('sho', 21);
    ck('点档位进入棋局', shown('#view-game'));
    eq('选档页必须真的 collapsed（0 个矩形）', $('#view-menu').getClientRects().length, 0);
    eq('档位名', g.puzzle.tier, 'sho');
    ck('棋头写了尺寸', text('#stat-name').includes(`${t0.R}×${t0.C}`), text('#stat-name'));
    ck('棋头写了题面数字数', /个数字/.test(text('#stat-name')), text('#stat-name'));
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('seed 印在页面上', text('#stat-seed'), `seed ${g.puzzle.seed}`);
    // DC-HOOK: hebi 这一行比的是 puzzle.score（引擎给一张盘打的难度分）。本仓不打分，
    // 页面上念的是**这一盘**出货时 judge() 量到的铅笔轮数——"难度实测"这句话必须等于引擎给的数。
    eq('难度实测显示这一盘实测的轮数', text('#stat-score'), `${g.puzzle.stats.steps} 轮`);
    ck('出题耗时是量出来的', /ms$/.test(text('#stat-genms')), text('#stat-genms'));
    ck('胜利遮罩藏起', !shown('#win-veil'));
    eq('状态行开局为空', text('#state-line'), '');
    // 开局一条界都没画：整盘就是一块，待画的界数就是唯一解里那串 1 的个数。
    eq('已画区界从 0 起', text('#stat-cuts'), `0/${g.wantCuts}`);
    eq('待画区界就是解里的界数', text('#stat-remaining'), String(g.wantCuts));
    eq('开局整盘就是一块', text('#stat-regions'), `1/${g.puzzle.tiling.length}`);
    eq('题面数字读数与引擎同数', text('#stat-nums'), `${g.B.num.size}/${g.B.cells.length}`);
    eq('开局 0 条违反', text('#stat-conflicts'), '0');
    eq('段表条数 = R(C-1)+(R-1)C', g.segs.length, g.R * (g.C - 1) + (g.R - 1) * g.C);
    eq('开局一条界都没画', g.cuts, 0);

    // 光标 + 落子：画一条"该画"的界
    const kCut = g.segs.findIndex((_, k) => solCut(g, k));
    ck('这一档确实有该画的界', kCut >= 0, kCut);
    const [ci, cj] = g.segs[kCut];
    ck('选中一格当光标', A().select(ci), true);
    eq('光标就在这一格', g.cursor, ci);
    eq('方向键盘中间写出了光标格名', text('#pad-cursor'), g.name(ci));
    // DC-HOOK: hebi 在这里断数字键 1–5 的 aria-label（格内读数）。DOUBLE CHOCO 的四只键落的是
    // "光标这一格与那一面邻居之间的段"，所以键上必须当场写得出它画的是哪一条界——
    // 一只只画了箭头的键说不清自己在画哪条界，玩家就只能靠猜。
    const dir = cj === ci + 1 ? 'right' : 'down';
    const padSel = `#btn-edge-${dir}`;
    eq(`${dir} 键落的就是这条段`, $(padSel).dataset.seg, String(kCut));
    eq(`${dir} 键的 aria-label 点名了这条段`, $(padSel).getAttribute('aria-label'),
      `画 ${g.segName(kCut)} 之间的区界（${g.name(ci)} ↔ ${g.name(cj)}）`);
    eq(`${dir} 键此刻没有按下`, $(padSel).getAttribute('aria-pressed'), 'false');
    await drawAt(ci, cj, en.BORDER);
    eq('画下去就是 BORDER', g.st[kCut], en.BORDER);
    eq('落子算一步', g.moves, 1);
    eq('已画读数跟着变', text('#stat-cuts'), `1/${g.wantCuts}`);
    eq('待画少一条', text('#stat-remaining'), String(g.wantCuts - 1));
    eq('键亮起来了（aria-pressed）', $(padSel).getAttribute('aria-pressed'), 'true');
    eq('重复落同一条界不算一步', A().setSeg(kCut, en.BORDER), null);
    eq('步数没被重复落子推进', g.moves, 1);
    await drawAt(ci, cj, en.OPEN);
    eq('再按一次擦掉', g.st[kCut], en.OPEN);
    eq('擦掉也算一步', g.moves, 2);
    eq('擦光之后已画归零', text('#stat-cuts'), `0/${g.wantCuts}`);
    eq('擦光之后待画回到解里的数', text('#stat-remaining'), String(g.wantCuts));

    // 盘外没有段可画：挡回来的那一步必须当场说清为什么
    eq('段号越界被挡回来', A().setSeg(g.segs.length), null);
    ck('状态行说出了为什么', /没有可画的段/.test(text('#state-line')), text('#state-line'));
    eq('越界落子不算一步', g.moves, 2);
    // 盘边：那一面没有邻居，方向键与键盘都不许画出一条根本不存在的界
    A().select(g.B.id(0, 0));
    eq('光标到角格', g.cursor, g.B.id(0, 0));
    eq('角格的 ↑ 键 disabled', $('#btn-edge-up').disabled, true);
    eq('角格的 ↑ 键没有落点（data-seg 空）', $('#btn-edge-up').dataset.seg, '');
    ck('↑ 键说这一面到了盘边', /到盘边/.test($('#btn-edge-up').getAttribute('aria-label')), $('#btn-edge-up').getAttribute('aria-label'));
    eq('按 ↑ 画不出界', A().setDir('up'), null);
    ck('状态行说那一面没有相邻的格', /没有相邻的格/.test(text('#state-line')), text('#state-line'));
    eq('盘外的格选不中', A().select(g.B.cells.length + 3), false);
    ck('盘外选中也说得出为什么', /不在盘上/.test(text('#state-line')), text('#state-line'));

    // 按下态属于"那一段"，不属于那只键：光标挪到盘边之后那一段已经不存在了，
    // 残留的 aria-pressed="true" 就是对着"那一面没有相邻的格"亮着一盏已画界灯。
    A().select(g.B.id(0, 1));
    await drawAt(0, 1, en.BORDER);
    eq('画下之后 ← 键带着按下态', $('#btn-edge-left').getAttribute('aria-pressed'), 'true');
    A().select(g.B.id(0, 0));
    eq('光标回到角格之后 ← 键 disabled', $('#btn-edge-left').disabled, true);
    eq('盘边那一只键不留下残留按下态', $('#btn-edge-left').getAttribute('aria-pressed'), null);
    await drawAt(0, 1, en.OPEN);

    // 一条多余的界：画在"解里同块"的那对上——判据必须当场抓到，画面不能装没事
    const kBad = g.segs.findIndex((_, k) => k !== kCut && !solCut(g, k));
    ck('这一档确实有一条不该画的界', kBad >= 0, kBad);
    const [bi, bj] = g.segs[kBad];
    await drawAt(bi, bj, en.BORDER);
    ck('违反的第一句是条款号', /^V[1-7]/.test(g.errs[0] || ''), g.errs[0]);
    ck('状态行念出了违反', /违反/.test(text('#state-line')), text('#state-line'));
    eq('违反读数不为零', text('#stat-conflicts'), String(g.errs.length));
    ck('多余的那条界被 diagnose 点名', g.diagnose().includes(kBad), JSON.stringify(g.diagnose()));
    ck('违反的格被标进 bad 集合（画面知道是哪一块）', g.bad.size > 0, g.bad.size);
    // 区域是"跨不过界"的连通分量，不是"每画一条界就断成两半"：4×4 上封掉一条边，
    // 全盘仍旧连着（网格去掉一条边还是连通的）。这一行钉的就是这个口径。
    ck('一条界不许把整盘断开（区域按连通算）', g.blocks.length, 1);
    eq('撤掉多余的那条界', A().undo() !== null, true);
    eq('撤掉之后违反清空', text('#stat-conflicts'), '0');
    eq('状态行也清空', text('#state-line'), '');
    // 剩下的两步里有一步是"擦掉"，撤到它时界会重新出现：撤到底才是真的空盘。
    while (g.steps.length) A().undo();
    eq('撤到底：一条界都不剩', g.cuts, 0);
    eq('撤到底：整盘又是一块', text('#stat-regions'), `1/${g.puzzle.tiling.length}`);
    eq('撤到底：步数归零', text('#stat-moves'), '0');
    eq('一步不剩时撤销不给东西', A().undo(), null);
    ck('撤销到底还说得出为什么', /还没画过/.test(text('#state-line')), text('#state-line'));

    // 回选档
    $('#btn-menu').click();
    await wait(40);
    ck('回选档显示菜单', shown('#view-menu'));
    eq('棋局页藏起来（0 个矩形）', $('#view-game').getClientRects().length, 0);
    ck('档位按钮与 tiers.js 同数', document.querySelectorAll('#tier-list .tier').length, en.TIERS.length);
    ck('出局披露写在选档页上', /10×10/.test(text('#tier-out')), text('#tier-out'));
    ck('奇数格数的出局披露也在', /奇数格数/.test(text('#tier-out')), text('#tier-out'));
    ck('每一档都念了实测数而不是形容词', /实测推理/.test(text('#tier-list')), text('#tier-list').slice(0, 90));
    // DC-HOOK: hebi 在这一行核对页面上手抄的规则表。本仓菜单规则的句子由 RULE_TEXT 给
    // （main.js 的 MENU_RULES 只列 id），所以这里断的是"页面上不会出现一句引擎里已经不存在的规则"。
    const lis = [...document.querySelectorAll('#rule-list li[data-rule]')];
    ck('菜单规则列表非空', lis.length >= 4, lis.length);
    ck('每一条菜单规则都指得回 RULE_TEXT', lis.every((li) => !!en.RULE_TEXT[li.dataset.rule]), lis.map((li) => li.dataset.rule).join(','));
    ck('页面没有念出"引擎里没这条"的兜底句', !/RULE_TEXT 里没有/.test(text('#rule-list')), text('#rule-list'));
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档把游标归一', en.Store.peekSeed(), 1);
    return report({ segs: g.segs.length, wantCuts: g.wantCuts, blocks: g.puzzle.tiling.length, rules: lis.length });
  };

  // ---------- hint：提示必须点名一条具名规则，而且说的就是解里的那一条 ----------

  const hint = async () => {
    const en = E();
    // 一盘用到几条具名规则是**盘的属性**，不是承诺：实测 sho 1~2 条、chuu/gao 2~4 条。
    // 所以这一腿钉在 chuu seed 20（实测提示流给出 N2/N5/N7/N8 四条），让"不止一条规则"
    // 这句话在它自己选的输入上真的是三条以上，而不是把门槛降到盘盘都过。
    const g = await beginFresh('chuu', 20);
    const info = A().useHint();
    ck('提示给了东西', !!info, 'null');
    ck('提示带规则名', /^[NX]\d+_/.test(info.rule || ''), info.rule);
    ck('规则名指得回 RULE_TEXT', !!en.RULE_TEXT[info.rule], info.rule);
    eq('规则框写出规则', text('#hint-rule'), `规则：${info.rule}`);
    ck('提示文本有内容', (info.text || '').length > 8, info.text);
    // DC-HOOK: hebi 断的是"提示落的那一格读出的就是它给的数字"。DOUBLE CHOCO 的提示落的是
    // **一条段**，所以两边都要读：那条段上确实画了它说的态。
    eq('提示画的就是它说的那条界', g.st[info.seg], info.value);
    eq('提示计一次', text('#stat-hints'), '1');
    eq('提示按钮角标同步', text('#hint-count'), '1');
    eq('提示画下的界也进步数读数', text('#stat-moves'), '1');
    // 这一行才是"提示不是报答案"的反面证人：它说"必须画界"的那一段，唯一解里那两格确实不同块；
    // 它说"不能画界"的那一段，解里确实同块。说反了的提示本质上就是在编答案。
    eq('提示说的与唯一解不相悖', solCut(g, info.seg), info.value === en.BORDER);
    ck('提示的两个端点都在盘上', g.B.cells.includes(info.cell) && g.B.cells.includes(info.j), JSON.stringify([info.cell, info.j]));
    ck('提示句子里有段名', /第\d+行/.test(info.text), info.text);
    ck('提示句子里有格名', /r\d+c\d+/.test(info.text), info.text);
    ck('提示的 why 指向同一条段名', info.why.includes(g.segName(info.seg)), info.why);

    // 画一条多余的界之后再问提示：它不许顺手把盘改成答案，只许报错。
    const afterHint = g.codes();
    const kBad = g.segs.findIndex((_, k) => k !== info.seg && !solCut(g, k));
    ck('这一档确实有一条不该画的界', kBad >= 0, kBad);
    const [bi, bj] = g.segs[kBad];
    await drawAt(bi, bj, en.BORDER);
    const withBad = g.codes();
    ck('多余界落下去之后盘面确实多了一条', count(withBad, '1'), count(afterHint, '1') + 1);
    const c2 = A().useHint();
    ck('画错了界时提示点名多余的那条', !!(c2 && c2.conflict), JSON.stringify(c2));
    ck('点名里带着段名', String(c2.conflict).includes(g.segName(kBad)), c2.conflict);
    ck('矛盾的提示不许顺手改盘面', g.codes(), withBad);
    eq('矛盾的提示不算一次求助', text('#stat-hints'), '1');
    eq('矛盾写进规则框', text('#hint-rule'), '这里和题面矛盾');
    ck('矛盾点名的段就是那一条', JSON.stringify(c2.segs), JSON.stringify([kBad]));
    eq('撤销把多余的界退掉', A().undo() !== null, true);
    eq('退掉之后盘面回到提示给的那一步', g.codes(), afterHint);

    // 连续问提示 = 全程零猜测地把这局推完
    const res = g.solveWithLogic();
    eq('照规则能推到底', res.status, 'won');
    ck('用到的规则不止一条', res.rules.length >= 3, JSON.stringify(res.rules));
    ck('每条规则名都在 RULE_TEXT 里', res.rules.every((n) => !!en.RULE_TEXT[n]), JSON.stringify(res.rules));
    eq('推完之后再要提示不给东西', A().useHint(), null);
    const f = g.winFacts();
    eq('判据 0 条', f.errs, 0);
    eq('区界画满', `${f.cuts}/${f.wantCuts}`, `${f.wantCuts}/${f.wantCuts}`);
    eq('与唯一解逐对同块关系相同', f.mismatch, 0);
    eq('分成块数与解同数', f.regions, g.puzzle.tiling.length);
    const used = g.hints;
    ck('提示次数被计下了', used > 3, used);
    // 正面证人：提示这条路画出来的界与唯一解逐条相同（一条都没画歪，也没多画）。
    eq('提示画的全在解里（逐条相同）', g.codes(), g.solutionCodes());
    // 提示不能凭空造界：把最终盘面交给铅笔自己复核一遍
    const { p } = g.pencilNow();
    eq('玩家盘面交给铅笔不矛盾', !!p.contradiction, false);
    return report({ hints: used, rules: res.rules, steps: res.steps, cuts: f.wantCuts, blocks: f.regions });
  };

  // ---------- win：画满 / 差一条都不等于赢，三条判据要同时成立 ----------

  const win = async () => {
    const en = E();
    const g = await beginFresh('sho', 44);
    // 负例一：把每一条段都画满（每一格自成一块）。"满了"和"对了"是两件事。
    for (let k = 0; k < g.segs.length; k++) A().setSeg(k, en.BORDER);
    await wait(30);
    const all = g.winFacts();
    eq('画满每一条段也不算赢', g.status, 'playing');
    ck('判据不同意这个假盘', all.errs > 0, JSON.stringify(g.errs.slice(0, 2)));
    ck('与唯一解的差集更是不小', all.mismatch > 0, all.mismatch);
    ck('胜利遮罩没露出来', !shown('#win-veil'));
    // 待画读数在这里是 0（wantCuts 早就被超过了）——这一行钉的就是"进度读数不是胜负判据"。
    eq('待画归零但赢不了', text('#stat-remaining'), '0');
    eq('已画读数越过了要画的条数', text('#stat-cuts'), `${g.segs.length}/${g.wantCuts}`);
    eq('分成块数也越过了答案的块数', text('#stat-regions'), `${g.B.cells.length}/${g.puzzle.tiling.length}`);
    ck('胜负不读进度：winFacts 里没有 remaining 这一项', !('remaining' in all), JSON.stringify(Object.keys(all)));

    // 负例二：照解画但少一条界。差的这一条不许靠"判据恰好还过"蒙过去。
    const g2 = await beginFresh('sho', 45);
    const skip = g2.segs.findIndex((_, k) => solCut(g2, k));
    ck('这一档有可跳过的界', skip >= 0, skip);
    await paintSolution(g2, { skip });
    const near = g2.winFacts();
    eq('少画一条界就不算赢', g2.status, 'playing');
    ck('少的那一条进了待画读数', text('#stat-remaining'), '1');
    ck('差一条界时胜利遮罩不露', !shown('#win-veil'));
    // 这一行是本仓的胜负口径：判据与"等于唯一解"是两条独立的条件，
    // 少一条界必然让同块关系差集非空，而判据是否同时红由这盘的性质决定（读数里带着它）。
    ck('拒赢的理由至少有一条读数在红', near.errs > 0 || near.mismatch > 0, JSON.stringify({ errs: near.errs, mismatch: near.mismatch }));
    ck('差的这一条让同块关系变了（这才是拦住它的那一条）', near.mismatch > 0, true);
    eq('补上那一条就赢', A().setSeg(skip, en.BORDER) !== null, true);
    eq('补齐之后状态是 won', g2.status, 'won');

    // 真赢：一条一条照唯一解画（不借提示），这才是玩家会走的那条路
    const g3 = await beginFresh('sho', 46);
    const code = await paintSolution(g3);
    eq('照唯一解画满就赢', g3.status, 'won');
    const f = g3.winFacts();
    eq('判据 0 条违反', f.errs, 0);
    eq('区界画满', `${f.cuts}/${f.wantCuts}`, `${f.wantCuts}/${f.wantCuts}`);
    eq('与解不同处 0', f.mismatch, 0);
    eq('分成块数与解同数', f.regions, g3.puzzle.tiling.length);
    eq('画下的正是解里那一条串', g3.codes(), code);
    ck('胜利遮罩可见（有矩形）', shown('#win-veil'));
    ck('胜利文案印了 seed', text('#win-meta').includes(`seed ${g3.puzzle.seed}`), text('#win-meta'));
    ck('胜利文案把耗时/步数/提示都念出来', /\d+:\d\d · \d+ 步 · 提示 \d+ 次/.test(text('#win-meta')), text('#win-meta'));
    ck('胜利文案把三条判据都念出来', /判据 0 条违反/.test(text('#win-record')) && /区界 (\d+)\/\1 条/.test(text('#win-record')) && /分成 \d+ 块/.test(text('#win-record')) && /（0 处不同）/.test(text('#win-record')), text('#win-record'));
    ck('手工通关写下纪录', !!en.Store.best('sho'), JSON.stringify(en.Store.best('sho')));
    eq('胜利后续局被清掉（不再拿这局烦玩家）', en.Store.resume(en.tierOf), null);
    const total = en.Store.data.totals;
    ck('总局数累加了', total.solved >= 1, total.solved);
    // 赢了就不能再改子
    const before = g3.codes();
    eq('赢了之后再画一条界被拒', A().setSeg(0), null);
    ck('拒的时候说得出为什么', /已经推完/.test(text('#state-line')), text('#state-line'));
    eq('盘面没有变', g3.codes(), before);
    const h4 = A().useHint();
    eq('赢了之后不再给提示', h4, null);
    // 回选档：这一局已经不存在"续"的了
    $('#btn-menu-2').click();
    await wait(40);
    eq('胜利回选档之后没有续局卡片', en.Store.resume(en.tierOf), null);
    ck('选档页重新露出来', shown('#view-menu'));
    return report({ moves: g3.moves, errs: f.errs, cuts: f.cuts, blocks: f.regions, skipSeg: g2.segName(skip) });
  };

  // ---------- save：存档存的是题面 + 玩家画下的界，绝不带解 ----------

  const save = async () => {
    const en = E();
    const g = await beginFresh('sho', 51);
    // 落子从解里挑：只画"该画"的那几条界，剩下的一大把留着不画。
    // 存档腿测的是"玩家状态存得回来"，不是推理对错——随手画会造出一个自相矛盾的半成品盘，
    // 于是续局之后的提示腿一起变红，红的还是不相干的那一条。
    const cutKs = g.segs.map((_, k) => k).filter((k) => solCut(g, k));
    ck('这一档的解里有界可画', cutKs.length >= 3, cutKs.length);
    const pick = cutKs.slice(0, 3);
    for (const k of pick) A().setSeg(k, en.BORDER);
    await wait(20);
    eq('存档之前画下了三条界', g.cuts, 3);
    const h0 = A().useHint();
    ck('落子之后提示还能推（不是自相矛盾的半成品）', !h0.conflict && !!h0.rule, JSON.stringify(h0));
    ck('提示说的仍然与解同向', solCut(g, h0.seg) === (h0.value === en.BORDER), JSON.stringify(h0));
    // 提示那一步自己也会画一条界（它画的正是解里的一条），所以落盘的条数是"我画的三条 + 它画的那一条"。
    // 这一腿不猜这个数：它由 codes() 当场数出来，存档必须与它相同。
    const drawn = count(g.codes(), '1');
    eq('画下的条数 = 三条落子 + 提示那一步', drawn, 3 + (h0.value === en.BORDER ? 1 : 0));
    A().persistNow();
    await wait(40);
    const raw = localStorage.getItem('doublechoco-cos:v1');
    ck('存档写在 doublechoco-cos:v1 下', !!raw, 'null');
    const d = JSON.parse(raw);
    // 这一句是本仓最要紧的一条：存档里若带了 tiling，续局就等于"答案由存档定义"，
    // tiers.js 的 rebuild 那一步重证会被整段跳过——界面照样能玩，但唯一性再没人证过。
    ck('存档里没有解', !('tiling' in d.resume) && !('sol' in d.resume) && !('solution' in d.resume), Object.keys(d.resume).join(','));
    eq('存档记了档位', d.resume.tier, g.puzzle.tier);
    eq('存档记了 seed', d.resume.seed, g.puzzle.seed);
    eq('存档记了尺寸', `${d.resume.R}×${d.resume.C}`, `${g.R}×${g.C}`);
    eq('底纹条数是半盘', d.resume.gray.length * 2, g.R * g.C);
    ck('底纹与题面逐格相同', d.resume.gray.slice().sort((a, b) => a - b).join(',') === [...g.B.gray].sort((a, b) => a - b).join(','), JSON.stringify(d.resume.gray));
    ck('每条数字都是 [格, 值] 对', d.resume.nums.every((e) => Array.isArray(e) && e.length === 2), JSON.stringify(d.resume.nums[0]));
    eq('数字条数与题面相同', d.resume.nums.length, g.B.num.size);
    ck('数字与题面逐格相同', JSON.stringify(d.resume.nums), JSON.stringify([...g.B.num.entries()].sort((a, b) => a[0] - b[0])));
    // DC-HOOK: hebi 的盘面串每格一个字符（'.'=未定）。DOUBLE CHOCO 的落子是**格与格的关系**，
    // 所以本仓 store.js 的口径是每条内部段一个字符（共 R*(C-1)+(R-1)*C 条）；
    // 字母表与长度都必须与 game.js 的 codes() 同口径——改那里必须同时改 store.js 的校验。
    eq('盘面串一条段一个字符', d.resume.cells.length, g.R * (g.C - 1) + (g.R - 1) * g.C);
    ck('盘面串只有 0/1 两个字符', /^[01]+$/.test(d.resume.cells), d.resume.cells);
    eq('玩家画的界与存档逐条相同', d.resume.cells, g.codes());
    eq('存档画下的条数就是盘上那几条', count(d.resume.cells, '1'), drawn);
    eq('没画的段在存档里仍然是没画', count(d.resume.cells, '0'), g.segs.length - drawn);
    ck('存档里的界少于解要求的条数（存的确实不是解）', g.wantCuts > drawn, `${g.wantCuts} vs ${drawn}`);
    eq('游标已经把 seed 让开了', d.seedCounter > g.puzzle.seed, true);
    eq('提示次数进了存档', d.resume.hints, g.hints);
    eq('步数进了存档', d.resume.moves, g.moves);
    ck('存档里的计时在走（续局腿拿它当基线）', d.resume.elapsedMs > 0, d.resume.elapsedMs);
    eq('光标也存了（键盘玩家不该一上来画错段）', d.resume.cursor, g.cursor);
    ck('存的光标在盘上', d.resume.cursor < g.B.cells.length, d.resume.cursor);
    const codes = g.codes();
    return report({ timeOrigin: performance.timeOrigin, doc: A().doc, seed: g.puzzle.seed, codes, tier: g.puzzle.tier, gray: d.resume.gray.length, nums: d.resume.nums.length, hints: g.hints, moves: g.moves, elapsedMs: d.resume.elapsedMs, wantCuts: g.wantCuts, blocks: g.puzzle.tiling.length });
  };

  const resume = async () => {
    const wit = w.__witness;
    ck('续局腿拿到了派发前的证人', !!wit, JSON.stringify(wit));
    if (!wit) return report({ note: 'no witness' });
    ck('这是一个新文档（timeOrigin 换了）', performance.timeOrigin !== wit.timeOrigin, `${wit.timeOrigin} -> ${performance.timeOrigin}`);
    ck('这是一个新文档（doc 身份换了）', A().doc !== wit.doc, `${wit.doc} -> ${A().doc}`);
    eq('旧文档的哨兵在这个文档里不存在', w.__gateSentinel, undefined);
    const en = E();
    eq('选档页开局可见', shown('#view-menu'), true);
    ck('继续卡片露出来了', shown('#resume-card'));
    ck('继续卡片写了 seed', text('#resume-meta').startsWith(`seed ${wit.seed}`), text('#resume-meta'));
    ck('继续卡片也写了已经花了多久', /· \d+ 步 · 提示 \d+ 次/.test(text('#resume-meta')), text('#resume-meta'));
    const rec = en.Store.resume(en.tierOf);
    ck('存档读得回来', !!rec, 'null');
    if (!rec) return report({});
    eq('读回来的 seed 与证人同一个', rec.seed, wit.seed);
    eq('读回来的盘面与证人同一个', rec.cells, wit.codes);
    $('#btn-resume').click();
    await wait(120);
    const g = A().game;
    ck('续上了局（棋局页露出来）', shown('#view-game'));
    eq('续上了同一个 seed', g.puzzle.seed, wit.seed);
    eq('续上了同一档', g.puzzle.tier, wit.tier);
    eq('续上了同一个盘面', g.codes(), wit.codes);
    eq('底纹照存档重建', g.B.gray.size, wit.gray);
    eq('数字照存档重建', g.B.num.size, wit.nums);
    eq('提示次数没被续局清零', g.hints, wit.hints);
    eq('步数没被续局清零', g.moves, wit.moves);
    // 计时不是"看起来在走"：拿派发前证人抄下的存档 elapsedMs 当基线，续局之后必须接着它走。
    const msAfter = A().state().elapsedMs;
    ck('计时从存档接着走（没有从 00:00 重来）', msAfter >= wit.storedMs && wit.storedMs > 0, `${text('#stat-time')} ${msAfter}ms vs 存档 ${wit.storedMs}ms`);
    // DC-HOOK: hebi 在这里比续局之后的难度分。本仓续局那条路**没有出题过程**（rebuild 只重证判据），
    // 所以"难度实测"这一格必须报"—"而不是编一个数：js/ui/game.js 的 boardSteps 读 puzzle.stats.steps，
    // 而 rebuild 给的 stats 只有 {ms}——undefined 也不是 null，只判 null 就会印出"undefined 轮"。
    ck('续局的难度实测报"—"，不编一个数', text('#stat-score').startsWith('—'), text('#stat-score'));
    // 「这一局耗时」在续局这条路上读的是 rebuild 当场重证判据花掉的毫秒（js/main.js:426 抄的 stats.ms），
    // 所以它是这一份文档量出来的数，不是出货那一盘抄来的——把它抹成"—（续局）"反而是说谎。
    // "没有重跑出题器"这句话由于上面那行（难度实测）与下面这行（遮罩文案）一起作证。
    ck('续局的耗时读数是一个量出来的毫秒数', /^\d+ ms$/.test(text('#stat-genms')), text('#stat-genms'));
    const bl = A().busyLog();
    ck('续局走的是"重证"这条路，不是重新出题（遮罩文案为证）', bl.length >= 1 && /续局重证中/.test(bl[bl.length - 1].label), JSON.stringify(bl.map((x) => x.label)));
    // 解不是从存档里读出来的：这两行钉住"当场重证"确实发生，而且证出来的是同一张解。
    ck('重证之后仍然有唯一解可读', g.puzzle.tiling.length >= 2, g.puzzle.tiling.length);
    eq('重证出来的解要画的界数与出货那一盘相同', g.wantCuts, wit.wantCuts);
    eq('重证出来的解块数与出货那一盘相同', g.puzzle.tiling.length, wit.blocks);
    ck('续局的界面把光标放回存档那一格', text('#pad-cursor'), g.name(rec.cursor));
    // 续局之后还能推：提示走的是同一条铅笔路径
    const info = A().useHint();
    ck('续局之后提示还能推', !!info && !!info.rule, JSON.stringify(info));
    ck('续局之后提示说的仍是解里的那一条', solCut(g, info.seg) === (info.value === en.BORDER), JSON.stringify(info));
    // DC-HOOK: hebi 这里断"续局之后不再给继续卡片"。本仓那张卡片住在选档页里，而棋局页露出来时
    // 选档页整段是 [hidden] 的——那时"量不到矩形"是真盘面上的每一张卡片都量不到，等于没断。
    // 所以这里换成一个有分母的正断言：回选档（它会 flush 一份新存档）之后，卡片必须还在，
    // 写的还是同一个 seed——续局没有把这局的存档吃掉。
    $('#btn-menu').click();
    await wait(40);
    ck('回选档仍然给这一局继续（续局没把存档吃掉）', shown('#resume-card'));
    ck('卡片写的还是同一个 seed', text('#resume-meta').startsWith(`seed ${wit.seed}`), text('#resume-meta'));
    eq('存档的题面与判据相容（不崩）', bootErrors.length, 0);
    return report({ seed: g.puzzle.seed, codes: g.codes().length, timeOrigin: performance.timeOrigin, doc: A().doc, wantCuts: g.wantCuts, blocks: g.puzzle.tiling.length });
  };

  // ---------- corrupt：坏档必须是"没有存档"或"当场拒掉"，不是白屏、也不是半截盘 ----------

  const corrupt = async () => {
    const en = E();
    // 先确认种下的还是那份坏档：pagehide 的自动存档会把刚种下去的 payload 覆写回一份合法档，
    // 于是"坏档被判成没有存档"红得莫名其妙。这一条把机制自己说出来。
    const raw = localStorage.getItem('doublechoco-cos:v1') || 'null';
    ck('种下的坏档还在（没被页面自己的合法存档覆写）', /"tier":"slant"/.test(raw), raw.slice(0, 90));
    ck('探针键也还在（证明这条腿读的是同一份档）', localStorage.getItem('doublechoco-cos:v1:probe') === '1', localStorage.getItem('doublechoco-cos:v1:probe'));
    ck('坏档之后应用仍然起来了', !!(A() && A().engine.mkBoard), 'window.dc 不在');
    eq('坏档没有抛出未捕获错误', bootErrors.length, 0);
    eq('坏档被判成没有存档', JSON.stringify(en.Store.resume(en.tierOf)), 'null');
    ck('继续卡片没露出来（不显示半截盘）', !shown('#resume-card'));
    // DC-HOOK: hebi 钉的是"档位表还是三条"。本仓档位表只在 tiers.js 里，所以钉的是"每一档都完整"
    // （key/尺寸/gold 三样都在），条数交给 gen 腿去钉顺序。
    eq('档位表没被坏档污染', en.TIERS.filter((t) => t.key && t.R && t.C && t.gold).length, en.TIERS.length);
    eq('设置退回默认', en.Store.setting('sound'), true);
    const g = await beginFresh('sho', 77);
    ck('坏档之后还能正常开局', !!g, 'null');
    eq('seed 游标可用', g.puzzle.seed > 0, true);

    // 第二种坏档：结构**全合格**、题面却当场证不出唯一解。store 的校验放得下它，
    // 所以"坏档 = 没有存档"这句话在这里不成立——必须由 tiers.js 的 rebuild 重证来挡。
    // 数字 9 在 4×4 上不可能成立：全盘只有 8 个灰格，任何一块都凑不出 9 个同色格，
    // 于是 judge() 数出 0 个解（exhaustive 死盘）。这一条测的是
    // "合法但不可证的存档不会变成一张由存档定义答案的盘"。
    const gray = g.B.cells.filter((i) => g.B.isGray(i));
    en.Store.data.resume = {
      tier: 'sho', seed: 900, R: g.R, C: g.C, gray,
      nums: [[0, 9]],
      cells: '0'.repeat(g.R * (g.C - 1) + (g.R - 1) * g.C),
      cursor: 0, moves: 0, hints: 0, elapsedMs: 1000,
    };
    // 让页面自己重渲染一次选档页：卡片该不该给出来由 renderResumeCard 判，闸不替它决定。
    A().show('menu');
    await wait(30);
    const bad = en.Store.resume(en.tierOf);
    ck('结构合格的坏档被 Store 读成有存档（校验确实放得下它）', !!bad, JSON.stringify(bad));
    ck('正因为读成有存档，卡片才露出来', shown('#resume-card'));
    $('#btn-resume').click();
    await wait(120);
    ck('重证不过就拒绝开局并点名理由', /续局丢弃/.test(text('#menu-note')), text('#menu-note'));
    ck('理由里带着是判据的哪一条拒的', /重证不过判据/.test(text('#menu-note')), text('#menu-note'));
    ck('点名的那句里确实有读数（不是空括号）', /（[^）]+）/.test(text('#menu-note')), text('#menu-note'));
    eq('拒绝之后没有摆出一张由存档定义的盘', shown('#view-game'), false);
    eq('拒绝之后存档被丢掉（不会每次都来烦玩家）', JSON.stringify(en.Store.resume(en.tierOf)), 'null');
    ck('丢掉之后卡片跟着收起来', !shown('#resume-card'));
    eq('拒档全程没抛未捕获错误', bootErrors.length, 0);
    // 丢档之后游戏还玩得下去
    const g2 = await beginFresh('sho', 6);
    ck('拒过坏档之后还能正常开局', !!g2 && g2.status === 'playing', JSON.stringify(g2 && g2.status));
    eq('拒档没有把游标弄坏', en.Store.peekSeed() > 1, true);
    return report({ planted: w.__plantedGarbage || 'unknown', why: text('#menu-note').slice(0, 60) });
  };

  // ---------- layout：几何、hit box、两种底色、点线/实线的可见性与那段阻塞的遮罩 ----------

  const layout = async () => {
    const en = E();
    const lum = (p) => p[0] + p[1] + p[2];
    const cdist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    // 遮罩的自量读数按"这一腿自己出了几次题"来断（beginLogged 替这一腿数），不是抄一个常数：
    // 少一份就是有一次出题玩家对着白屏等，而常数会把这件事洗成绿。
    let begins = 0;
    const beginLogged = async (tier, seed) => { begins++; return beginFresh(tier, seed); };
    const blBefore = A().busyLog().length;

    // 先拿一张真盘：底纹、数字、区界都画在它的画布上量（不是造一个假 Game 喂给渲染器）。
    const g = await beginLogged('sho', 5);
    const grayIx = g.B.cells.find((i) => g.B.isGray(i) && g.B.num.has(i));
    const whiteIx = g.B.cells.find((i) => !g.B.isGray(i) && g.B.num.has(i));
    ck('题面里既有带数字的灰格也有带数字的白格（V5 两半都要有证人）', grayIx !== undefined && whiteIx !== undefined, JSON.stringify([grayIx, whiteIx]));

    // 可见性的刻度由题面自己给：灰格底色与白格底色在像素上差多少，就是"一眼分得开"的量纲。
    const baseG = basePixel(grayIx, 0.2);
    const baseW = basePixel(whiteIx, 0.2);
    const gap = cdist(baseG, baseW);
    ck('灰格与白格的底色在像素上分得开', gap >= 120, gap);
    // DC-HOOK: hebi 的题面只有"黑格/纸"两色，所以它把白格直接比成 --bg-bottom。DOUBLE CHOCO 的
    // 两种题面色是 --gray 与 --paper，而画布还会给每格掺一层"玩家自己分块"的回显色，
    // 所以这里断的是**保住的份额**：实测色差不少于 token 色差的六成。
    const tokG = hex(cssVar('--gray'));
    const tokW = hex(cssVar('--paper'));
    ck('两种底色来自 theme 的那两枚 token（灰暗纸亮，次序与 token 一致）', lum(baseG) < lum(baseW) && lum(tokG) < lum(tokW), `${lum(baseG)}/${lum(baseW)} token ${lum(tokG)}/${lum(tokW)}`);
    const tokGap = cdist(tokG, tokW);
    ck('区域回显没有把题面色洗掉（实测色差不少于 token 的六成）', gap >= tokGap * 0.6, `实测 ${gap} / token ${tokGap}`);
    const vis = Math.round(gap * 0.25);

    // 数字的墨向：印在哪种颜色上就数哪种颜色的格数（V5 的原句），所以两种底色上的墨必须相反。
    ck('灰格上的数字是亮墨（数得出亮像素）', brightIn(grayIx) > 2, brightIn(grayIx));
    eq('灰格上的数字不是深墨（印反了 V5 就说反了）', darkIn(grayIx), 0);
    ck('白格上的数字比它自己的底色暗（深墨）', darkIn(whiteIx) > 2, darkIn(whiteIx));

    // 点线 / 实线在每一侧底色上的可见性。一条段被画布按两侧底色分两笔描（js/render/board.js 的
    // sideStroke），所以两侧各量一遍：只量一侧的话，"区界在白格那一侧沉进纸色"是读不出来的。
    const combos = {};
    for (let k = 0; k < g.segs.length; k++) {
      const [i, j] = g.segs[k];
      if (i === g.cursor || j === g.cursor) continue;   // 光标框与把手点就画在光标格的段上
      const key = (g.B.isGray(i) ? 'g' : 'p') + (g.B.isGray(j) ? 'g' : 'p');
      if (!combos[key]) combos[key] = k;
    }
    const keys = Object.keys(combos).sort();
    ck('灰白相邻的几种组合盘上都有（每种都单独核一遍可见性）', keys.length >= 3, JSON.stringify(keys));
    let covRows = 0;
    for (const key of keys) {
      const k = combos[key];
      await wait(1650);   // 上一条测量的落子回显（pulse）必须先退掉，否则它的粗描会冒充"有墨"
      const dNeg = segProfile(k, -1, vis);
      const dPos = segProfile(k, 1, vis);
      A().setSeg(k, en.BORDER);
      await wait(40);
      const sNeg = segProfile(k, -1, vis);
      const sPos = segProfile(k, 1, vis);
      A().setSeg(k, en.OPEN);
      covRows++;
      const side = (s) => (s === 'Neg' ? `第${g.name(g.segs[k][0])}那一侧` : `第${g.name(g.segs[k][1])}那一侧`);
      ck(`未画的虚线在 ${key} 两侧都看得见`, dNeg.cov >= 0.2 && dPos.cov >= 0.2 && dNeg.max >= vis && dPos.max >= vis, JSON.stringify({ dNeg, dPos, vis }));
      ck(`画下的区界在 ${key} 两侧都看得见且够实`, sNeg.cov >= 0.9 && sPos.cov >= 0.9 && sNeg.max >= vis && sPos.max >= vis, JSON.stringify({ sNeg, sPos, vis }));
      ck(`虚线仍是虚线、区界仍是实线（画没画读得出来）`, dNeg.cov <= 0.8 && dPos.cov <= 0.8 && sNeg.cov > dNeg.cov && sPos.cov > dPos.cov, JSON.stringify({ dNeg, dPos, sNeg, sPos }));
      void side;
    }
    ck('可见性逐侧核过了（每一种底色组合都算一行）', covRows >= 3, covRows);

    // 指针的落点：段的中点与格心必须是两个不同的动作，而且都得先有命中盒。
    const rect = rectOf('#board');
    let segHits = 0;
    let boxes = 0;
    for (let k = 0; k < g.segs.length; k++) {
      const s = A().view.segLine(k);
      const x = rect.left + (s.x1 + s.x2) / 2;
      const y = rect.top + (s.y1 + s.y2) / 2;
      if (A().view.hitSegment(x, y) === k) segHits++;
      const el2 = document.elementFromPoint(x, y);
      if (el2 && el2.id === 'board') boxes++;
    }
    eq('每一条段的中点都命中的就是它自己', segHits, g.segs.length);
    eq('每一条段的中点都到得了画布（hit box 先于点击成立）', boxes, g.segs.length);
    const kTap = combos.gp !== undefined ? combos.gp : combos.pg;
    const sTap = A().view.segLine(kTap);
    const tapXY = { x: rect.left + (sTap.x1 + sTap.x2) / 2, y: rect.top + (sTap.y1 + sTap.y2) / 2 };
    const beforeTap = g.codes();
    const t1 = A().tapAt(tapXY.x, tapXY.y);
    const changed = [];
    for (let x = 0; x < t1.length; x++) if (t1[x] !== beforeTap[x]) changed.push(x);
    eq('点那条虚线就是在这里画一条界（只动那一条）', changed.join(','), String(kTap));
    const t2 = A().tapAt(tapXY.x, tapXY.y);
    eq('再点一次就是擦掉（盘面逐条回到原样）', t2, beforeTap);
    const ci2 = g.B.cells.find((i) => i !== g.cursor);
    const r2 = A().view.cellRect(ci2);
    const cellXY = { x: rect.left + r2.x + r2.size / 2, y: rect.top + r2.y + r2.size / 2 };
    const before2 = g.codes();
    A().tapAt(cellXY.x, cellXY.y);
    eq('点格心一条界都不许多画', g.codes(), before2);
    eq('点格心只把光标移到那一格', g.cursor, ci2);
    eq('格心也命中画布', (() => { const e = document.elementFromPoint(cellXY.x, cellXY.y); return e && e.id; })(), 'board');
    eq('画布之外的点不落子（段）', A().view.hitSegment(rect.left - 8, rect.top - 8), -1);
    eq('画布之外的点不落子（格）', A().view.hitCell(rect.left - 8, rect.top - 8), -1);

    // 最大档：菜单里最贵的那一档必须在 900×900 的视口里，且每一格、每一条段都点得中。
    const big = en.TIERS[en.TIERS.length - 1];
    const gb = await beginLogged(big.key, 61);
    eq(`最大档 ${big.R}×${big.C}`, `${gb.R}×${gb.C}`, `${big.R}×${big.C}`);
    const rectB = rectOf('#board');
    ck('最大盘也在视口里', rectB.left >= 0 && rectB.top >= 0 && rectB.right <= innerWidth + 1 && rectB.bottom <= innerHeight + 1, JSON.stringify({ r: rectB, iw: innerWidth, ih: innerHeight }));
    ck('格子不小于可点最小值', A().view.geo.cell >= en.theme.Cell.min, A().view.geo.cell);
    ck('格子不大于上限', A().view.geo.cell <= en.theme.Cell.max, A().view.geo.cell);
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    let hits = 0;
    for (let i = 0; i < gb.B.cells.length; i++) {
      const r = A().view.cellRect(i);
      const x = rectB.left + r.x + r.size / 2;
      const y = rectB.top + r.y + r.size / 2;
      const e = document.elementFromPoint(x, y);
      if (e && e.id === 'board' && A().view.hitCell(x, y) === i) hits++;
    }
    eq('大棋盘每一格都点得中（命中元素=canvas 且 hitCell 同格）', hits, gb.B.cells.length);
    let bHits = 0;
    for (let k = 0; k < gb.segs.length; k++) {
      const s = A().view.segLine(k);
      if (A().view.hitSegment(rectB.left + (s.x1 + s.x2) / 2, rectB.top + (s.y1 + s.y2) / 2) === k) bHits++;
    }
    eq('大棋盘每一条段也都点得中', bHits, gb.segs.length);

    // 出题那几百毫秒里玩家看得见"在算什么"：这一份几何是 paintBusy 在遮罩挂上的那一刻
    // 自己量的（主线程在那一段里同步重算，画外的闸一挂上就被同一段阻塞吞掉，量不到）。
    const bl = A().busyLog();
    const last = bl[bl.length - 1];
    ck('遮罩的几何盖住了画布（不是挂在旁边的一块）', last && last.veil[2] > 0 && last.veil[3] > 0
      && last.veil[0] <= last.canvas[0] + 1 && last.veil[1] <= last.canvas[1] + 1
      && last.veil[0] + last.veil[2] >= last.canvas[0] + last.canvas[2] - 1
      && last.veil[1] + last.veil[3] >= last.canvas[1] + last.canvas[3] - 1, JSON.stringify(last));
    ck('遮罩上写的是这一笔在算什么', last && /出题中/.test(last.label), last && last.label);
    ck('遮罩上那一行字也量到了宽度', last && last.veil[2] > 40 && last.canvas[2] > 40, JSON.stringify(last && last.veil));
    ck('盘摆好之后遮罩收了', !shown('#busy-veil') && !A().busy(), JSON.stringify({ shown: shown('#busy-veil'), busy: A().busy() }));

    // 控件：这一局的落子只有一种动作，所以盘上只该有四只方向键，且每一只都点得到。
    eq('图例六项', document.querySelectorAll('.legend span').length, 6);
    eq('统计项九条', document.querySelectorAll('.stats .stat').length, 9);
    eq('落子盘四只键（画/擦四个方向的界）', document.querySelectorAll('.pad .edge').length, 4);
    ck('四只键都有落点名或盘边说明', [...document.querySelectorAll('.pad .edge')].every((b) => b.dataset.seg !== undefined && (b.dataset.seg !== '' || b.disabled)), JSON.stringify([...document.querySelectorAll('.pad .edge')].map((b) => [b.id, b.dataset.seg, b.disabled])));
    ck('键都够点（高度 ≥ 34）', [...document.querySelectorAll('.pad .edge')].every((x) => x.getBoundingClientRect().height >= 34), JSON.stringify([...document.querySelectorAll('.pad .edge')].map((x) => Math.round(x.getBoundingClientRect().height))));
    ck('动作键与顶部键也都够点', [...document.querySelectorAll('.acts button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 34), JSON.stringify([...document.querySelectorAll('.acts button')].map((x) => Math.round(x.getBoundingClientRect().height))));
    ck('顶部按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })(), JSON.stringify([...document.querySelectorAll('.top-actions button')].map((x) => [Math.round(x.left), Math.round(x.right)])));

    // 通关态：实线改用成功色，两侧仍然都看得见（同一把 vis 刻度，换色不许把线洗掉）。
    const gw = await beginLogged('sho', 5);
    await paintSolution(gw);
    await wait(1650);
    eq('照唯一解画满就胜利', gw.status, 'won');
    ck('胜利遮罩可见（有矩形）', shown('#win-veil'));
    const kWin = Object.keys(combos).map((key) => combos[key]).find((k) => solCut(gw, k));
    const wNeg = segProfile(kWin, -1, vis);
    const wPos = segProfile(kWin, 1, vis);
    ck('通关换色之后区界两侧仍看得见', wNeg.cov >= 0.9 && wPos.cov >= 0.9 && wNeg.max >= vis && wPos.max >= vis, JSON.stringify({ wNeg, wPos, vis }));
    ck('胜利卡居中在棋盘内', (() => {
      const card = rectOf('.win-card');
      const wrap = rectOf('#board-wrap');
      return card && wrap && card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: rectOf('.win-card'), w: rectOf('#board-wrap') }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40, $('#btn-again').getBoundingClientRect().width);
    // 这一腿自己出了三次题（两张 sho + 一张最大档），每一次都必须留下一份自量读数：
    // 断的是**增量等于次数**，所以漏一次就红，而"至少几份"那种常数会被复用页面洗绿。
    eq('这一腿每一次出题都挂过遮罩（自量读数一份不少）', A().busyLog().length - blBefore, begins);
    return report({ gap, vis, tokGap, combos: keys, cell: A().view.geo.cell, dpr: A().view.geo.dpr, segs: g.segs.length, begins });
  };

  // ---------- 阴性自证：这个闸必须能被证明会红 ----------

  const selftest = async () => {
    const g = await beginFresh('sho', 91);
    eq('种一条注定错的期望（2 不等于 1）', g.R, 1);
    ck('这条腿本来就该红（GATE_SELFTEST）', false, 'planted red expectation');
    return report({ planted: 2 });
  };

  w.__ng = { engine, gen, play, hint, win, save, resume, corrupt, layout, selftest };
})(window);
