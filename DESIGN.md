# DESIGN · 双巧克力 DOUBLE CHOCO

这个文件只写两件事：**每一层为什么长这样**，以及**这句话由哪一行撑着**。
所有对外承诺的口径写在 README；这里写给改代码的人，包括"哪些行了不能删、删了就丢承诺"。

## 形状

```
index.html            一个文档两种视图（菜单 / 对局）；规则表由引擎提供，不在 HTML 里手抄
css/game.css          版式与 token；#board 的 touch-action 有它自己的理由
js/engine/rules.js    条款：V1a…V7 的原句与 clauses()（承重条款 V7 的裁定记录在文件头 1-22 行）
js/engine/blocks.js   候选池：exactBlocks 在这块底纹上**能**有哪些块（完整枚举，预算只放弃不截断）
js/engine/count.js    精确覆盖计数器：四态读数，绝不把"预算耗尽"说成"唯一"
js/engine/pencil.js   具名规则求解器（N1…N9 / X1、X2）+ judge()：唯一性与可推性的合取
js/engine/generate.js 出题：随机底纹 → 铺一块解 → 满数字起点 → 逐格挖 → 每挖一格重跑 judge
js/engine/tiers.js    档位表（gold 数组 = 实测值）+ build/rebuild + 菜单外尺寸的理由
js/engine/rng.js      可播种随机（shuffle / int / pick），全仓唯一随机源
js/ui/game.js         交互状态机：段表、落子/撤销、区域连通、判据读数、提示、通关
js/render/board.js    作画 + 命中：segLine 画的与 hitSegment 认的共用同一份几何
js/main.js            接线：DOM、指针与键盘、时钟、存档、busy 遮罩、window.dc 调试面
js/store.js           localStorage：成绩、续局档、seed 游标（存档**不带解**）
tools/                闸：engine-test / ui-smoke / balance（node）+ verify.sh / scenarios.js / playtest.cjs（浏览器）
```

树里那两句"有出处"的话在这里落回坐标：两个视图是 `index.html:33` 与 `index.html:83` 这两节，
规则表那个空的 `<ol>` 在 `index.html:77`，句子由 `js/main.js:534-542` 从引擎的 `RULE_TEXT` 填进去；
`#board` 那句 `touch-action: none` 的理由写在 `css/game.css:189-193`。

## 落子是"段"，不是"格"

这一局的唯一动作是在两个相邻格之间画一条界（或擦掉）。所以状态机的主语不是格子内容而是**段**：
`segmentTable` 列出全部内部虚线，段数 = `R·(C−1) + (R−1)·C`（`js/ui/game.js:28-43`），
4×4=24、6×6=60、8×8=112。`segIx` 是 `(i,j) → k` 的索引（`js/ui/game.js:52`），
渲染（`js/render/board.js:55`）、命中（`:79`）、落子（`js/ui/game.js:136`）都走这一张表，
不存在"界面另有一套段编号"。

区域是"跨不过已画之界"的连通分量（`js/ui/game.js:81-100`），不是"每画一条界就断成两半"。
这条口径在浏览器闸里被直接钉住：在 4×4 上封掉一条边，全盘仍然是一块
（`tools/scenarios.js:421` 「一条界不许把整盘断开（区域按连通算）」）。
删掉这一行就等于把"区域"两个字悄悄换回直觉读法——那正是最容易自我欺骗的一种改动。

## 判据、读数、画面是三层，接口上不许混

`recompute()` 一次算出所有派生量（`js/ui/game.js:102-121`），三份东西各有各的口径：

- **判据**：`rawErrs` 是 `clauses()` 的原样产出，`winFacts()` 读的正是未过滤的这一份（`js/ui/game.js:304-314`）。
- **宽容**：开局一条界都没画时，整盘就是一个大区域，那时报一串违反只会让玩家以为题面坏了。
  所以给状态行与读数的 `errs` 在 `touched` 之前是空的（`js/ui/game.js:105-112`）——**这份宽容只给读数，不给胜负**。
- **进度**：`remaining()` 是"还差几条界"，它是读数不是判据，故意**不在** `winFacts()` 的键里。
  闸断的是这个缺席：`胜负不读进度：winFacts 里没有 remaining 这一项`（`tools/scenarios.js:538`）。

`wantCuts`（要画几条）由唯一解自己数出来：段总数减去"两格同块"的相邻对（`js/ui/game.js:114-118`）。
这里刻意不读 `puzzle.stats.cuts`，因为续局那条路（`rebuild`）压根没有出题过程；
两处口径的一致由 `tools/ui-smoke.mjs:219` 拿出货盘逐盘断言（`wantCuts == stats.cuts`）。

"过判据"与"等于答案"是两件事，所以要有一个显式差集：`relDiff()` 把玩家划分与唯一解的同块关系逐边比
（`js/ui/game.js:124-127`），`mismatch` 进通关判据，`codes()`/`solutionCodes()` 的逐位比较进闸。

## 唯一性靠"完整池"，不靠"我的求解器只找到一条"

三段独立的地基，缺一不可：

1. **池是完整的。** `exactBlocks` 在这块底纹上枚举所有合法块；撞预算时它 `throw EnumBudget` 而**绝不返回半池**
   （`js/engine/blocks.js:86-92`）。所以"没抛的那一次"交出的就是全池——`tools/engine-test.mjs:96`（第 2b 段）
   把这一句钉成断言，`tools/engine-test.mjs:66`（第 2 段）再拿 `tools/independent.mjs:71` 的子集幂集暴力池做**双向相等**对照
   （少块 = 把唯一性算窄了，多块 = 算宽了）。
2. **计数是穷尽的。** `count()` 的读数分四态，不许混说：`exhaustive & 1` 才是唯一；
   `exhaustive & 0` 是死盘；`!exhaustive & stop=maxSol` 只证明"≥maxSol"；
   `!exhaustive & stop=cap` 是预算耗尽，**不能对外说"唯一"**（`js/engine/count.js:4-9`，本仓把它当判据红）。
   这是农场里的老坑："超预算"曾被当成"变强"。
3. **两条互不复用的实现。** `tools/independent.mjs` 自带一份 D4 变换（`tools/independent.mjs:15` 的显式矩阵
   vs `js/engine/rules.js:24-27` 的函数表）、一份 BFS 连通（`tools/independent.mjs:25-31`）、
   一份整盘条款（`tools/independent.mjs:34-67`），故意不 import 引擎任何东西。
   `tools/engine-test.mjs:295`（第 7 段）要求两套实现在一个突变族上**开火的条款集合一致**——
   自我一致的假设不算第二套路。

`judge()`（`js/engine/pencil.js:250-275`）是这些的合取：穷尽且唯一 → 铅笔推满 → `check` 零违反 → 独立实现附议。
`makePuzzle` 出货前每一盘都过它（`js/engine/generate.js:140-142`，终态重证），`rebuild` 续局时当场再过一遍
（`js/engine/tiers.js:141`）。**"唯一"与"可推"是同一次事件**，所以这两句承诺的成本一起付、也一起红。

## 提示不越权

界面上提示按的是同一份 `RULE_TEXT`（`js/engine/pencil.js:25-37`），菜单上那列规则就是从这张表渲染的
（`js/main.js:534-542`）：引擎改了名，页面当场少一条，不会留下一句引擎里已不存在的规则。

- 提示的落点来自边级 `p.decided`，并且必须能在 `p.trace` 里找回点名它的那条规则；**没有证人就不落子**
  （`js/ui/game.js:201-216`、`:239-289`）。
- 推不动／正矛盾时只出话不落子，也**不计一次求助**（`js/main.js:321-335`：`info.stalled || info.conflict` 直接 return）。
- 撤销一步不退还求助次数（`tools/ui-smoke.mjs:228`）：提示是买来的信息，撤回动作不该把它变便宜。

一盘用到几条具名规则是**盘的属性**，不是承诺。实测：原始铅笔 trace 在 sho 用 2–3 条、其余三档 3–5 条；
走界面提示这条路是 sho 1–2 条、chuu/gao 2–4 条。所以 `hint` 腿钉在自己选的那一输入上
（`tools/scenarios.js:456-462`，chuu seed 20，提示流给出 N2/N5/N7/N8 四条），
而不是把门槛降到"盘盘都过"——那句话红过，红的原因是拿 sho 的盘去要求三条以上。

## 出题：预算全是确定量，墙钟只配观测

`makePuzzle`（`js/engine/generate.js:67`）的路径是：随机底纹 → 在完整池上铺一块解 → 满数字起点先过 `judge`
→ 按洗牌顺序逐格删数字，**每删一格重跑一次 `judge`**，红了就撤掉那一格（`js/engine/generate.js:110-122`）。
理由：删数字不破坏唯一性，但**不保证**不破坏可推性，所以不能靠单调性假设省掉重跑。

三条口径上的硬规定：

- 预算只有确定量：`capWork`（枚举工作量次数）、`shades`（底纹次数）、`tilingsPerShade`、`nodeCap`。
  判定链上没有任何一步读墙钟（`js/engine/generate.js:63-66`、`js/engine/blocks.js:98`）。
  墙钟进判定 ⇒ 快慢机器抽到不同的盘，"同一 seed 同一档同一盘"就作废；
  `tools/engine-test.mjs:264`（第 6 段）断言的是这件事，方法就是把耗时从判定链上摘下来单独打印。
- 默认值不读环境变量：浏览器里没有 `process`，CI 里设了它就更糟（同一号 seed 因环境换盘）。
  要换预算由调用方显式传 `{capWork}`（`js/engine/blocks.js:90-92`）。
- 成本读数用 `work` 不用 ms：被放弃的底纹也把它做掉的那 `e.n` 次记进总账（`js/engine/generate.js:84-88`），
  所以"这一盘花了多少算力"是与机器速度无关的数。

**披露②：出题器有枚举预算，撞预算时它换一张底纹，不放宽判据。**
因此出货条件是"这一盘在**无上限**规则下唯一且可推"，而不是"每一种底纹都算得起"。
这句话有两个方向上的读数撑着：`tools/balance.mjs:105`（B3b）反过来钉——**出货那一盘的枚举必须没撞预算**，
否则"无上限"不可证；`tools/balance.mjs:147`（B6）在同一个进程里饿不同预算跑同一批 seed，
打印"出货数 / 换底纹次数 / 总工作量"三条，说明 40 万相对 15 万买到的是更多底纹而不是更多出货。
B6 还有第四条（`tools/balance.mjs:173`）：`js/engine/tiers.js:27-28` 那句理由里印着的两个对照数
是从 tiers.js **原文**解析出来的，必须逐值等于本轮当场跑出的读数——注释改回任何历史值就红，
"注释讲历史、闸判现在"这种两套账在本仓不给活路。

## 档位：难度只有量出来的那一种说法

`TIERS`（`js/engine/tiers.js:42-68`）每档带一条 `gold` 数组，四列（steps / cuts / nums / work）都是
B1 那连续 8 号 seed 的实测值排序后钉住（`js/engine/tiers.js:47-65`）。
页面上的"实测推理 X 轮 / 数字 Y 个 / 区界 Z 条"只有一个来源：`tierMed` / `tierMax`（`js/engine/tiers.js:73-74`）。
红线在 `tools/balance.mjs:93`（B3）：**实测四条数组必须逐值等于 gold**——确定量不配带误差带，只配相等。
B2（`tools/balance.mjs:82`）断言阶梯方向：轮次严格升、数字占比严格降；顺序由实测定，不由边长定。
B4（`tools/balance.mjs:112`）判成本用 `work` 中位严格递增，墙钟只打印 + 一条 `GEN_BUDGET_MS` 上限（`js/engine/tiers.js:40`）。
B5（`tools/balance.mjs:130`）是天花板观测：10×10 每次真的抽 8 盘，打印出货率与耗时，断言的方向只有"仍然配不上菜单那句承诺"。

`OUT_OF_MENU`（`js/engine/tiers.js:80-95`）里每一档的理由都必须是这一页能自己验的那种：
奇数格数是规则结论（`tools/engine-test.mjs:289-291` 断言 5×5 被 `code==='奇面积'` 拒），
10×10 是成本结论（B5 每次复跑打印）。理由注释自己也要有台架，否则它就会烂掉。

## 存档不带解，续局当场重证

`Store.saveResume` 写的是题面（spec + 底纹 + 数字）+ 玩家的段串 + 用时（`js/store.js:198`），
**没有解**。续局走 `rebuild(spec, gray, nums, seed)`（`js/engine/tiers.js:131`），
它把 `judge()` 那条合取当场重跑一遍再返回 puzzle；证不过就丢弃这份存档并点名拒在哪一条
（`js/main.js:412-430`，`rb.ok` 为假时 `Store.clearResume()` 在 `js/main.js:424`）。坏档、被人改过的档绝不能变成一个"答案由存档定义"的盘。

由此有两个看起来奇怪但都写死了的口径：

- 续局的 `puzzle.stats = { ms }` 装的是**重证耗时**，不是当初的出题耗时（`js/main.js:429`），
  而 `stats.steps` 是 undefined ⇒ 界面"这一局实测推理"印「—」。不印一个没有量过的数。
- 续局走的是重证而不是重新出题（那笔实测成本极档中位几百毫秒不该重付），
  这条走法由遮罩文案作证：`续局重证中：seed N`（resume 腿在 `tools/scenarios.js:645`，
  那句断言在 `tools/scenarios.js:685`）。

seed 游标 `peekSeed`（`js/store.js:158`）是自增小整数，**默认种子不是按日期算的**：
「换一局」必须真的换一盘，而且页面上印的 seed 说真话
（`js/main.js:432-444`；浏览器闸里 `seed 是小整数自增号，不是日期/时间戳`、
`游标推到了 seed 之后` 两行钉着）。出不了货就往前推一号，没有"换个随机种子再试"的余地——
那等于让界面上的 seed 变成假话。

## 渲染：画的 == 点的 == 看得见的

一条段跨在两种底色上，所以实线与点线**都分两次画、各 clip 进相邻的那一格**，而且两半各挑一种墨
（灰底配 `Palette.border`、纸底配 `Palette.borderOnPaper`，`js/render/board.js:153-166`）。
这不是铺张："一白走两边"在这种题面上就是不成立——落笔的四种墨与底的色距由 `tools/ui-smoke.mjs:323-331`
逐条钉着，尺是题面自己的灰↔纸色差（实测 506，门槛取其 1/4 = 127），同一段还留着一条负样本：
两半同用近白的 `border` 时，落在纸底的那一半色距只有 19。玩家画了、判据认了、屏幕上什么都没有——
于是这里有三层各自独立的证据：

- `tools/ui-smoke.mjs:186-190`：假 canvas 只记账，钉"每一条界画了两半、每一条段两半都是点线、每一半都被 clip"
  （条数一定是 2×，因为这个形状）。
- `tools/ui-smoke.mjs:323-331`：同一份闸里钉"两半的墨都分得开"，并把那种坏写法当成**负样本**钉着
  （它必须沉底，否则"分两半"这句理由就没人读）。
- `js/render/board.js:55` 的 `segLine` 与 `:79` 的 `hitSegment` 共用一份几何，
  `tools/ui-smoke.mjs:133` 要求**每一条**段的中点都被认回同一条段（不是抽样）。
- `tools/scenarios.js:764` 起的 layout 腿在真像素上量：逐段两侧与**那一格底色**的色距，
  门槛 `vis` 由盘面自己测出的灰白色差推出来（`tools/scenarios.js:793`，`vis = round(gap * 0.25)`），
  不抄进闸里当一个常数——代码改了色板而闸还绿，那种绿最没用。

悬停回显只给指针设备（`js/main.js:614-627`）：触屏没有"悬停"这个状态，给它设 hover 会让一条
根本没人指的段亮起来。光标格四条边上的把手点在没有相邻格的那一面不画（`js/render/board.js:196-215`）。

`#board` 的 `touch-action: none`（`css/game.css:189-193`）是被真事件测出来的：
`manipulation` 只关双击缩放、仍把手势交给页面滚动，触屏一笔画在第一条之后就来 `pointercancel` +
`lostpointercapture`，第二条根本画不上——而界面明明白白写着"拖过去能连着画一条"。
同时 `js/main.js:648` 接住 `pointercancel`：手势被系统收走时不会补 `pointerup`，
不接这一句，`drag` 会留在原位，之后落在盘上的任何一次移动都还在替一个已经不存在的按住状态画线。
这两件事都不靠 CSS 值作证，靠 `tools/playtest.cjs:492` 那一条断言作证（拖一次 = 两处落子，逐位比对段串）。

## 三条真事件腿，和它们各自不信任的东西

指针与键盘都不走页内 `new Event`：`tools/playtest.cjs` 用 CDP `Input.dispatch*` 派发，
页面自己合成 pointer 事件，被测的是 `js/main.js` 那一段真实处理器。

- **先断命中盒，再谈"点得到"**：`document.elementFromPoint` 的中心必须落在这个 id 上，
  否则"点不动"到底是几何坏了还是 CSS 藏了，红成一片也说不清是谁的锅（`tools/playtest.cjs:186` 的 PREP）。
  `display: grid` 会盖掉 UA 的 `[hidden]`，所以"这块藏起来了"必须由几何作证。
- **触屏腿自己读回覆写证人**（`innerWidth=390 / dpr=3`），覆写写在腿自己的调用里；
  另起进程设 `Emulation` 等于把桌面断言重跑一遍。因此它的结论只命名为"覆写在位"，不命名为"这是手机"。
- **键盘腿最难**：一次派发可能到达 N 次。`nativeVirtualKeyCode` 在 macOS 上被 Chrome 当平台原生键码，
  于是这只键被 raw keyboard 路径反复补发（`tools/playtest.cjs:255-258` 记着这个坑，所以派发不带它）。
  读着这句理由的是那两行闸：`按键 X 到达游戏一次` 与
  `派发了 N 个按键：到达游戏的 keydown 总数`——不是注释里的一句话。
  断言取的是页内计数器 `keyHits()` 的**增量**（`js/main.js:691-700`）：
  `1 seen / 1 handled / 0 repeat / 1 thiskey`，逐只键各取一次快照——
  整段求差只会打印一个大数，说不清是哪一只键被重复送达。
  `Shift` + 方向键与裸方向键的 `ev.key` 同名，所以 `by[]` 也只能取增量。
  到达数只证明"键送到了"，下面那组逐只键读盘面，钉的是"每一只键做了它那句话"
  （光标 +1、+C、落在题面挑的那一格、已画 +1 且只动那一条、求助 +1、步数 −1 两次、撤到底 0 条界）。
- 盘边的拒答走的是**落点**不存在（那一面没有相邻格），因此那一只键 `disabled`、不带 `aria-pressed`、
  标签写着"到盘边"（`js/main.js:207-234`）。不可用的控件不许挂着按下态——这一条是被真点击测出来的，
  不是被 CSS 选择器测出来的。

## 闸的地图与它的口径

- `node tools/engine-test.mjs` —— 条款贯通 / 池完整性 / 计数器四态 / 出题×判据 / 确定性 / 两套实现
  （`tools/engine-test.mjs:32-295`）。
- `node tools/ui-smoke.mjs` —— 解答判通关 / 画的==点的 / 零猜测推到通关 / 键鼠与存档口径 / 续局生产路径 /
  两半的墨分得开（`tools/ui-smoke.mjs:111-331`）。
- `node tools/balance.mjs` —— B1–B6（`tools/balance.mjs:54-177`）。
- `node tools/docs-test.mjs` —— 文档行号对账：这两份文档里每一条 `文件:行号` 指回的是不是真代码
  （`tools/docs-test.mjs:126-163` 的 `audit`）。
- `bash tools/verify.sh` —— 真浏览器：core play win mouse touch keys save（`tools/verify.sh:78`）× 两种 URL 形态。
- `GATE_SELFTEST=1 bash tools/verify.sh` —— 阴性自证：每份报告必须点名吃下种下的错（`tools/verify.sh:231-256`）。

前四条都是纯 node 的闸，其中 engine-test / ui-smoke / docs-test 三条挂在 `npm test`（`package.json` 的 `test`）
上、balance 在 CI 里单列一步；后两条要起 headless Chrome，是 CI 的另一个 job。

### 文档行号对账这条腿口径（它与它没覆盖的）

README / DESIGN 里每个数字后面都挂着 `文件:行号`。这句"行号指本仓代码"以前没有机器读回来过——
上一节那句"断言里不许有抄来的常数"管的是代码，文档自己那份常数没人管。这条腿补的就是这一段，
它是家族标准（ferry / tatamibari / yajilin / lightsout / tapa 同一份规则）在本仓的那一份：

- **锚点**：只查"行号不超过文件长度"连隔壁一行都抓不住。贴着引用写在反引号里的那个名字，必须真的出现在
  被指的那几行里。本仓这一把第一次跑就抓出一条真漂：`Store.clearResume()` 在 `js/main.js:424`，
  而文档原先把它挂在隔壁那一行（`:423`）。
- **续引**（完整引用后面只写 `:NN`）：向**同一句里最近的那条完整引用**借路径；句号、分号、空行、新标题都
  截断这次借。**正文里提到一个文件名不构成出处**——那种写法计入「无法定址」，宁可数出来，也不在错的文件上判绿。
- **跨仓引用**（`../别的仓/…:NN`）按**形状**分出去，只数不验：单仓 checkout 里根本读不到兄弟仓，
  按"文件在不在"决定红不红就是一条随环境漂的闸。本仓一份都没有，所以那个数是 0——它照样被等值闸钉着，
  哪天有人补一条跨仓引用而忘了改文档，红的是这条腿。
- **等式闸**：文档转写的实测数（下面那五个）必须逐个等于这条腿自己数到的，**删掉数字同样算红**；
  输入集从目录里现数（`docFiles`），不手抄名单。
- 九把假引用（不存在 / 越界 / 行数写错 / 四种写法各自的锚点漂 / 无锚点那条整段落在空行上——空行靶子的
  行号当场从 `js/engine/generate.js` 数出来、不写死常量，那位子哪天被填上内容这一把会连着 `blankAt > 0`
  一起失效并被抓住——第九把管**前缀不算整词**：锚点写 `node`，被指的第 34 行声明的是 `nodes`）必须一把不落，
  六种真贴法必须判绿，
  外加一把"把本仓一条界内的真引用挪歪一格"的阳性刀——这一把红的是 `js/engine/generate.js:68`
  那几行里没有 `makePuzzle`，也就是锚点腿真有牙齿。
- 空行那一把另有一次性的牙齿证明（日志 `_tmp-doublechoco-blank-teeth.log`，判词 `TEETH_OK`）：在 `_scratch/`
  下的**副本**里把 DESIGN 中一条界内、当前不落在空行的真引用改指到 `js/engine/generate.js` 的第 17 行——
  副本动刀之前自己就是绿的，动刀后 rc 1、只交出 1 行红、红行点名「整段是空行」并把「解析 134 条」原样印在
  那一行里（所以那条红不来自计数对账）；改回去 rc 回 0。盘上的仓一个字没改，副本跑完即删。
- **锚点认整词，不认子串。** 换口径之前这一格查的是"被指的那几行里有这串字符"：`node` 坐在声明 `nodes` 的
  那一行上也算命中，任何一个碰巧含它的标识符也算命中——于是这道比它替掉的那份手抄锚点表**更弱**，一次真的
  漂会被读成绿。现在要求名字两侧不得再是标识符字符（字母、数字、`_`、`$`），第九把假引用写的正是这种前缀
  写法：这条腿哪天退回子串，那把刀当场少一把、台账那条断言当场红。本仓没有另一张手抄的字面锚点表，所以
  只有这一处口径、不存在"两处口径不同"的分工。本轮换口径时两份文档里已有的带锚点引用没有一条因此变红
  （红的是这条腿自己插了行、闸的地图里挂着的那段 `audit` 区间漂到隔壁，已 grep 真实行号改回），
  所以这一道是加严，不是修一处已经存在的漂。
  牙是两双腿，都跑在 `_scratch/` 下的同名副本里：读数 `_tmp-doublechoco-word-teeth.log`，判词 `TEETH_OK`——
  A 腿把锚点检查改回子串，24 条断言里只有那一条假引用台账红，而它交出的红行恰好少了 `node` 那一把；
  B 腿把两份文档里每一条 `Store.clearResume()` 真引用的名字截成它的前缀，锚点那一格为它红并点名
  「那几行里没有」（两处文档各截一处以上，是为了不把同一个坐标留成两种锚点）；这一腿交两行红，第二行是
  第 7 节那把"挪歪一格"的针——它 audit 的是整份文档文本，所以同一处漂被它数到第二次，不是另一种失败；
  两双腿复原后都回全绿。

本轮读数（由 `node tools/docs-test.mjs` 自己打印）：解析 134 条、续引 5 条、无法定址 0 处、
14 条贴着引用写了指认、跨仓引用 0 处。

口径（都是被红过之后写下来的）：

- 读 DOM 文本、几何、画布像素、真实事件，**不读私有标志位**（`tools/scenarios.js:1-22` 的文件头）。
- 每一次"必须相等"都走 `eq`，`ck` 只表达真伪：`ck('steps', 0)` 在人眼里像失败、在布尔里是成功，
  负向断言用 `ck` 会把红写成绿（`tools/scenarios.js:19-22`）。
- 断言里不许有抄来的常数：条数对着本腿自己的计数器取增量（layout 腿的 `begins` 与 `busyLog`）、
  色差对着盘面自己量的 `gap`、耗时对着自己的 `performance.now()` 带宽。
- 对数表：报告**应有**份数由腿的形状算（`tools/verify.sh:231-240`），少一份就红，
  写的是"有腿没跑，或对数表漂了"；红了还要每一份都点名，差的那些腿从没红过＝没被证明会红。
- 端口与 profile：5263 / 9363 是本仓的（9362 是 z-biz-game-hebi-cos 的，`tools/verify.sh:21-26`），
  preflight 还会验"这个端口上坐着的确实是 DOUBLE CHOCO"（`tools/verify.sh:55-60`）——
  attach 到别人的 Chrome 上读到的是别人的盘，那种绿比红更糟。
  每腿一个 `--user-data-dir`（`tools/verify.sh:81`），写完档的腿自己清档（`tools/verify.sh:95-98`）。
- 退出码住在产物里：任何包装日志都要留一行 `GATE_RC=$?`，读回来再说绿——wrapper 的 0 是 `tail` 的。

## CI 与 Pages

`.github/workflows/ci.yml`：`check` job（语法 + engine-test + ui-smoke + balance + docs-test + 入口文件），
`browser` job（Node 22：台架用裸 CDP 驱动，靠的是 Node 22 才有的全局 WebSocket/fetch）跑
`bash tools/verify.sh` 与 `GATE_SELFTEST=1` 两步。阴性自证在 CI 里也必须跑，否则"这条闸会红"
这句话只在作者机器上成立过。
`.github/workflows/pages.yml` 无构建：站点根就是仓库根，Pages 挂在 `/z-biz-game-doublechoco-cos/` 前缀下，
`index.html` 里全是相对引用，所以前缀形态不需要第二份构建。

## 两处披露（承诺的边界，不是待办）

1. **V7 是我们的字面裁定。** 两家出版方都写 "area"（`js/engine/rules.js:1-21` 逐字抄了原句），
   都没有裁决"半区必须连通"这一层；官方 4×4 例题在宽松与严格两种读法下给出同一唯一解
   （`js/engine/rules.js:144-152` 的 golden 两种读法都过）。
   所以我们采用严格读法，并且**明说这是裁定**：`tools/engine-test.mjs:139`（第 3 段）要求存在
   "只违反 V7"的见证盘——如果这条承重条款其实不承重，那一段就会红。
2. **枚举预算会换底纹。** 见"出题"一节末尾。承诺是"这盘在无上限规则下唯一"，
   不是"所有底纹都算得起"；B3b 与 B6 一正一反地把这句话钉成读数。
