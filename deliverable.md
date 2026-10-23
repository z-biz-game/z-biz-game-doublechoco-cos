# 双巧克力方块 · DOUBLE CHOCO — 交付报告

读者：接手的维护者代理。本文件只登记**磁盘上真实存在、且在本次会话里被命令跑绿过**的东西。
每一条声称都指到一个具体文件与一条能跑的命令；输出行都是本机实跑后原样粘贴。

## 这一轮修的是什么

上游把这一仓**有机并线**过一次（并线提交 `ce2907c`，父 `bf59ddd` 本地侧 / `3043196` 远端侧，
共同祖先 `2eee03c`）。并线按"每个路径各自最后一次提交的时间戳"定权威，机械地选了，
于是合出一份**两边各取一半**的树：远端侧的 `index.html`（ESM 形态，只挂一个
`<script type="module" src="js/main.js">`）配本地侧的 `js/`（16 份 classic script）——
页面一打开就什么都不会发生；文档腿的 122 条行号锚点钉的是远端侧那套代码的布局，
而盘上的代码是本地侧的。

归因用工作树做基线，不是靠猜：

```
git worktree add -f /tmp/dc-a bf59ddd     # 本地侧那棵树
git worktree add -f /tmp/dc-b 3043196     # 远端侧那棵树
```

在 `/tmp/dc-a` 上跑同一个浏览器闸：**14 条断言红**（`盘边那一只键不留下残留按下态`、
`拒的时候说得出为什么`、`回选档仍然给这一局继续`、坏档那 6 条、触屏那 3 条…）。
⇒ **那批红是本地侧自己本来就红，不是并线引入的**；并线另外加进来的是"页面加载不了"
与"文档锚点指不回去"两条。所以这一轮的做法是：
**以本地侧（classic script + 美术资产 + 工具）为基线，把远端侧独有的能力并进来**，
并把远端侧后来修好的那几个行为搬过来。

## 改了什么

| 改的文件 | 改了什么 | 为什么 |
|---|---|---|
| `index.html` | 头回到本地侧那一版（真 PNG 图标链、manifest、PWA meta、canonical/og:url/1200×630 og 卡），去掉并线留下的第二枚全屏键 `btn-fullscreen` 与 `data:,` 占位图；`js/main.js` 之后挂 `<script src="js/sw-register.js">` | 并线取的是远端侧那份 ESM 页面：仓里没有 `import`/`export`（`grep -rn "^\s*(import\|export) " js/` 无命中），单挂一个 module 入口 ⇒ 页面加载不了。SW 注册从内联块挪进独立文件，是因为部署集闸的引用走查只扫 `.js` 站里的 `serviceWorker.register`（HTML 那边只看 `href/src`），内联块它抓不到 ⇒ `sw.js` 不在闸的视野里 |
| `js/main.js` | ① 不可用的边键改成 `removeAttribute('aria-pressed')`；② 已通关时 `setSeg`/`setDir` 不再被 `blocked()` 吞掉拒绝理由；③ `renderResumeCard` 的"这一局还在屏幕上"从 `!el.viewMenu.hidden` 改成 `!el.viewGame.hidden`；④ `flushResume()` 从 `show('menu')` 移到三个"回选档"按钮各自调用 | ①②③④ 各对应共享场景套件里一条红断言（下面 §3 有原文）。③ 原来是**判反了**：菜单可见时它认为"这一局还在屏幕上"，于是回选档之后继续卡片永远不露出来——玩家回选档等于把这一局丢了。④ 放在 `show('menu')` 里会被**任何一次**切到选档页顶掉存档位（包括程序化调用 `show('menu')` 的坏档那条腿），坏档刚种下就被合法档覆盖 |
| `css/game.css` | ≤900px 时把十字盘放倒成横排（`repeat(5, 1fr)`，↑ ← 光标 → ↓） | 面板落到盘面下面之后竖直方向成了稀缺资源。实测 390×844：改之前 `btn-new`/`btn-menu` 的中心在 y=899（视口高 844）⇒ `elementFromPoint` 读回 `null`，"点得到"不成立；十字盘占三行 147px，横排只占一行 45px，省下的正是那 99px |
| `sw.js` | `SHELL[]` 从只列 `js/main.js` 一份补成 16 份 classic script 全列 | 离线壳只缓存 `js/main.js` ⇒ 断网后打开是**白屏**（不是报错，是一片空白）。装载形态从 ESM 换成 classic 之后，壳里必须跟着换成全部 16 份 |
| `tools/assemble-site.sh` | 拷贝清单写成显式三行（`cp -r css js icons` + `assets/texture`/`assets/sprite`），`assets/gen`（美术生成器）不上线 | 原来用 `for d in icons assets` 整目录收，会把 `assets/gen` 一起传上线。清单本体现在是这几行，`tools/ship-check.mjs` 量"上线产物里有什么"读的也是它 |
| `.github/workflows/pages.yml` | 汇编腿改成 `run: bash tools/assemble-site.sh _site`（与农场其余仓同一形态），并加一步 `node tools/deploy-set.mjs _site`（量的就是即将上传的那份产物） | 部署集闸的 W2 要求 workflow 真的调那份清单；原来手抄的 `cp` 行与脚本里的那份迟早漂 |
| `tools/ship-check.mjs` | 拷贝腿的读数来源从 `pages.yml` 里手抄的 `cp` 行改到 `tools/assemble-site.sh`（`$DEST` → `_site`） | 清单只有一份了，尺子就得读那一份。**断言一条没动**：仍然要求每条同源引用①在仓树里真实存在（PNG 读 magic+IHDR）②在清单覆盖的产物集合里 |
| `tools/deploy-set.mjs` | 实数钉 `EXPECT_CHECKS` 42→**58**、`EXPECT_ROWS` 61→**77** | **钉的是实数，强度不变。** 多出来的 16 条引用是 SW 注册挪进 `.js` 之后闸才第一次量得到的 `sw.js` 与离线壳那 30 条；多出来的 16 条断言是 `sw.js` 的 `SHELL[]` 现在列了 16 份 script（R 段每条引用一条断言，P 段每张位图两条） |
| `tools/deploy-set-selftest.mjs` | X1 那把刀的针从 `for d in icons assets; do` 改成新的拷贝行 `cp -r css js icons "$DEST/"` | 刀口必须打在**现在这份清单**上（`edit()` 要求唯一命中，打空就是这一刀没落地）。刀的**期望**没变：仍然要求 R10 点名缺的那张位图 |
| `tools/docs-test.mjs` | 闸自己的样本锚点跟上当前布局：`tools/engine-test.mjs:20→22`（SAMPLES）、`:21→23`（fails）、`js/engine/generate.js:67→63`（makePuzzle）、`js/main.js:92→127`（announce）、§7 的 needle 67→63（毒化改成 64） | 这些是**闸自己的实数钉**：代码布局变了，样本锚点必须跟着走，形状与断言一条没动 |
| `README.md` / `DESIGN.md` | 72 处 `文件:行号` 逐条重锚到当前布局（README 12 处、DESIGN 60 处） | 文档写的是远端侧那套代码的行号，盘上是本地侧的代码。逐条按"贴着引用写的那个名字必须真的出现在被指的那几行里"重定位——**带指认的按标识符整词找**，范围型的按它指的那一段整体搬 |
| `tools/scenarios.js`、`js/engine/blocks.js` | 两处注释里的行号（`js/main.js:426→599`、`js/engine/rules.js:6-7,9-11→5-9,11-14`） | 注释里指着别处的坐标同样会漂；它们不在文档腿的输入集里，所以只能自己盯 |

没有新建 README/总结类文档（这份 `deliverable.md` 除外）；没有删任何玩法；
没有新增运行时依赖、素材或网络请求。

## 闸的读数（本机实跑）

| 命令 | 结果 |
|---|---|
| `npm run check` | `OK`（12 份 `js/` + 21 份 `tools/` + `server.cjs` 逐个 `node --check`） |
| `node tools/engine-test.mjs` | `44/44 条闸绿` · `TIERS_MEASURED` 四档齐全 |
| `node tools/ui-smoke.mjs` | `ui-smoke 194/194 绿`（含 8 种墨 × 底纹的色距实测与阴性对照） |
| `node tools/behavior-test.mjs` | `behavior 70/70 绿`（静音/暂停/重开/存档两段式解码） |
| `node tools/balance.mjs` | `33/33 条红线绿` |
| `node tools/independent.mjs` | rc=0（第二套判据实现与引擎的条款集合逐例一致） |
| `node tools/ship-check.mjs` | `31 条引用全部①在仓树里②在上线产物里，PNG 逐张 IHDR 可读` · 未上线引用 0 条 |
| `node tools/deploy-set.mjs` | `部署集：58 条引用（含 3 张位图尺寸核对），失败 0 项` · `rows: 77 fail: 0` |
| `node tools/deploy-set-selftest.mjs` | `DS_SELFTEST rc=0`（十一刀每一刀都被点名；X10 阴性对照按预期不发力） |
| `node tools/docs-test.mjs` | `24/24 条闸绿` · `2 份文档 · 解析 134 条 · 续引 5 条 · 无法定址 0 处 · 带指认 122 条 · 跨仓引用 0 处` |
| `bash tools/verify.sh` | 两条 URL 形态（根 `/` 与 Pages 前缀 `/z-biz-game-doublechoco-cos/`）各跑 7 条腿，逐腿 `0 failed`；末尾 `=== ALL GREEN ===` rc=0 |

浏览器闸的腿（每种 URL 形态各一遍）：`core` 38+83 条、`play` 78+35 条、`win` 35+54 条、
`mouse` 41 条、`touch` 44 条、`keys` 28 条、`save` 27+4+32+4+21 条。

官方整局不可玩量具：

```
node z-biz-game-lead/003_辅助能力/polish/script/cos_load_sweep.js z-biz-game-doublechoco-cos
z-biz-game-doublechoco-cos               | LOADED
```

## 留给组织决定的事

1. **两仓的代码是同一条设计线的两个平行版本**（同一套词汇：`segmentTable`/`segIx`/`toggleSeg`/
   `recompute`/`relDiff`/`wantCuts`/`pencilNow`/`winFacts`/`MENU_RULES`/`useHint`…）。
   这一轮以**本地侧**（classic script + 16 份 script + 美术资产 + 行为/帧率/资产三把额外闸）为基线，
   把远端侧修好的行为搬进来。远端侧那套 ESM 实现没有被删除（在本仓的历史里），
   但组织若决定"这一仓以后走 ESM"，那要重做的是 `tools/loader.mjs`（它按 classic script 在 vm 里装载）
   与 `tools/app-host.mjs`/`frame-compare.mjs`/`ship-check.mjs` 这几把按经典脚本写的闸。
2. **本仓是农场里唯一同时有 `deploy-set` 与 `ship-check` 两道资产闸的仓**。这一轮把清单收成一份
   （`tools/assemble-site.sh`），两道闸都读它。若组织更希望两道闸各读各的（`ship-check` 读 workflow
   手抄的 `cp` 行），那就要把 `pages.yml` 的手抄行留着，两份清单的漂就回到没人管的状态。
3. **`assets/gen/`（美术生成器与 palette）不上线**：这一轮在 `assemble-site.sh` 里显式排除了它。
   若组织希望生成器也随站点发布（便于外部复现那张 1024 母图），改一行即可。
