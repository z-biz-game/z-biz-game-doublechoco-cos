#!/usr/bin/env node
// 文档行号对账（零依赖，纯 node）。
//
// README / DESIGN 里每个数字后面都挂着 `文件:行号`。那句"行号指本仓代码"必须有机器读回来：
// 只查"行号不超过文件长度"连隔壁一行都抓不住，所以加上锚点——贴着引用写在反引号里的那个名字，
// 必须真的出现在被指的那几行里。
//
// 规则与家族里其余几份（ferry / tatamibari / yajilin / echo-location / creek / lightsout / tapa）同一份：
//   · 六种贴法都认——`name`（`path:NN`）、`path:NN`（`name`）、`path:NN` 的 `name`、
//     `path:NN`（`fn(a, b)`）的调用形式、`path:NN`（`dir/file.js::symbol`）的符号形式、
//     `name` 在 `path:NN`；
//   · `::` 取段排在 `/` 判据之前，否则带目录限定的符号名会被当成路径而丢掉锚点；
//   · 带 `<占位>` 的模板 body 取字面量前缀（只有真写了占位符才这么拆，否则 `test:syntax` 会拆成 `test`）；
//   · 带空格的 body 是命令行（`npm test`），按首词钉就是一次假红；
//   · 纯标点间隔（`，`、`、`）不构成指认——前面那个名字只是列表的上一项；
//   · 锚点认**整词**不认子串：一个短名字坐在声明长标识符的那一行上也会"出现"，子串口径把一次真的漂读成绿；
//   · 续引（完整引用后面只写 `:NN`）向**同一句里最近的那条完整引用**借路径，句号、分号、空行、
//     新标题都截断这次借；借不到的计入「无法定址」，由等值闸逐处钉住，不静默跳过；
//   · 跨仓引用（`../别的仓/…:NN`）按形状分出去：单仓 checkout 里读不到它，按"文件在不在"决定红不红
//     就是一条随环境漂的闸。这条腿只数它（「跨仓引用 N 处」由等值闸钉住），不替别的仓担保行号。
//
// 用法：node tools/docs-test.mjs（npm test 的第三条链，CI 里同一条命令）
//   本条腿不覆盖什么写在 README 的「不承诺」里，别把它当成全量对账。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATH_SRC = '[\\w./-]+?\\.[A-Za-z][A-Za-z0-9]{0,11}'; // 后缀不许写死：写死成某一族的语言时，本腿在那种仓里是哑的，而「0 条引用」读起来和「全核过」一模一样
const CITE = new RegExp('^(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)$');
// 续引：完整引用后面只写行号（DESIGN.md 里就有三处），而只认带路径那一种的闸报"每一条都在界内"时，
// 看的其实是文档的一部分。只向同一句里最近的那条完整引用借路径；正文里提到一个文件名不构成出处——
// 宁可计入「无法定址」，也不要在错的文件上判绿（判绿比判红糟）。条数不写死在这里，由覆盖面行与等值闸现数现钉。
const BARE = /^:([0-9]+(?:[,-][0-9]+)*)$/;
const STOP = /[。！？；]/;
const inheritedPath = (text, spans, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const pc = spans[j].body.match(CITE);
    if (!pc) continue;
    const between = text.slice(spans[j].end, spans[i].s);
    if (between.includes('\n') && (STOP.test(between) || /\n[ \t]*\n/.test(between) || /\n#{1,6} /.test(between))) return null;
    return { path: pc[1] };
  }
  return null;
};
// 锚点可以是成员路径（`view.cellCenter`），但不许是文件路径：body 里带 `/` 的那一类是另一条引用，
// 把它当锚点按字符串去被指的那几行里找，只会凭空造出假红。
const ID = /^[A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]+)*$/;
const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const tpl = /^([^<>]+?)<[^<>\s]+>/.exec(seg);
  if (tpl && ID.test(tpl[1].split(':')[0].trim())) return tpl[1].split(':')[0].trim();
  const head = seg.split('(')[0].trim();
  if (ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return ID.test(lhs) ? lhs : '';
};

const lineCache = new Map();
const linesOf = (p) => {
  if (!lineCache.has(p)) {
    let arr = null;
    try {
      arr = fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n');
      if (arr[arr.length - 1] === '') arr.pop();
    } catch {
      arr = null;
    }
    lineCache.set(p, arr);
  }
  return lineCache.get(p);
};

function parseRefs(text, orphans = null) {
  const spans = [];
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text))) spans.push({ body: m[1], s: m.index, end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i].body.match(CITE);
    const bare = c ? null : BARE.exec(spans[i].body);
    if (!c && !bare) continue;
    const owner = c ? { path: c[1] } : inheritedPath(text, spans, i);
    if (!owner) { if (orphans) orphans.push(bare[0]); continue; }
    let anchor = '';
    let consumed = false;
    const next = spans[i + 1];
    const gA = next ? text.slice(spans[i].end, next.s) : null;
    if (gA !== null && gA.length <= 4 && !gA.includes('\n')) {
      const gN = gA.replace(/\s+/g, '');
      if (/^[（(]/.test(gN) || gN === '的') { consumed = true; anchor = tokOf(next.body); }
    }
    // 前向没认出注解形状时才接着试后向。用 `else if` 挂在前向条件上，
    // 「`NAME` 在 `js/….js:1`、」这种后面紧跟短间隔的写法就把后向那把弄哑了。
    if (!consumed && i > 0) {
      const prev = spans[i - 1];
      const gap = text.slice(prev.end, spans[i].s);
      const gT = gap.replace(/\s+/g, '');
      const shaped = /^[（(]/.test(gT) || /[\w一-鿿]/.test(gT);
      if (shaped && !/\s/.test(prev.body) && gap.length <= 4 && !gap.includes('\n')) anchor = tokOf(prev.body);
    }
    // 续引只借路径——它自己印的那些数字才是文档的主张。
    const range = c ? c[2] : bare[1];
    for (const seg of range.split(',')) {
      const parts = seg.split('-').map(Number);
      out.push({ path: owner.path, from: parts[0], to: parts[parts.length - 1] || parts[0], anchor, cont: !c });
    }
  }
  return out;
}

// 整词而不是子串：子串口径比它替掉的手写锚点表**更弱**——`node` 坐在 `let nodes = 0;` 那一行上也算"出现"，
// 一个短名字会碰巧落在任何含它的标识符里，于是把一次真的漂读成绿。名字两侧不得再是标识符字符。
// 带缓存是因为一条腿要核上百次同一个名字。
const wordCache = new Map();
const hasWord = (text, name) => {
  if (!wordCache.has(name)) {
    wordCache.set(name, new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_$])'));
  }
  return wordCache.get(name).test(text);
};

function audit(text) {
  const orphans = [];
  const refs = parseRefs(text, orphans);
  const outOfRange = [];
  const anchorBad = [];
  let foreign = 0;
  for (const r of refs) {
    // 跨仓引用在单仓 checkout 里根本读不到：按"文件在不在"决定红不红，这条腿就变成一台机器上绿、
    // CI 里红。所以按**形状**分类，不按存在性——它是别的仓的坐标，本仓的闸只数它、不验它，
    // 那个数由文档写出来并由等值闸钉住（不静默放行）。
    if (r.path.startsWith('..')) { foreign++; continue; }
    const label = `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}`;
    const lines = linesOf(r.path);
    if (!lines) { outOfRange.push(`${label} 文件不存在`); continue; }
    if (r.from < 1 || r.to > lines.length) {
      outOfRange.push(`${label} 越界（该文件共 ${lines.length} 行）`);
      continue;
    }
    // 行号在界内不等于指到了实处：整段落在空行上时，读者顺着引用走过去什么也找不到。
    // 后面那条 `continue` 让一把只交一行红，九把的计数才有意义。
    if (lines.slice(r.from - 1, r.to).join('').trim() === '') {
      outOfRange.push(`${label} 那几行整段是空行`);
      continue;
    }
    if (r.anchor && !hasWord(lines.slice(r.from - 1, r.to).join('\n'), r.anchor)) {
      anchorBad.push(`${label} 那几行里没有 ${r.anchor}`);
    }
  }
  // `` `文件`（N 行）`` 这种实测值按等式收：写歪一格、文件不在，都算指不回实处。
  const cntRe = new RegExp('`(' + PATH_SRC + ')`（([0-9]+) 行）', 'g');
  let k;
  while ((k = cntRe.exec(text))) {
    const lines = linesOf(k[1]);
    if (!lines) outOfRange.push(`${k[1]}（${k[2]} 行）文件不存在`);
    else if (lines.length !== Number(k[2])) outOfRange.push(`${k[1]} 实测 ${lines.length} 行，文档写的是 ${k[2]}`);
  }
  return { refs, outOfRange, anchorBad, cont: refs.filter((r) => r.cont).length, unaddressed: orphans.length, foreign };
}

const head = t => console.log(`\n== ${t}`);

// ok 与 tools/engine-test.mjs 同一支签名：名字、条件、见证。红的那一行必须自己点名。
export function run(ok) {
  head('1. 输入集：文档清单从目录里现数，不手抄');
  // 手抄的清单会让这条腿自己缩样，而它照样打印"全部在范围内"。
  const docFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
  ok('D 输入集：本仓根下有两份以上的文档可审（这条腿读的是整个目录，不是一份手抄名单）',
    docFiles.length >= 2, docFiles.join(','));

  let docText = '';
  const bad = [];
  const anchorBad = [];
  let refs = 0, cont = 0, unaddressed = 0, foreign = 0;
  for (const f of docFiles) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const a = audit(t);
    docText += t + '\n';
    refs += a.refs.length;
    cont += a.cont;
    unaddressed += a.unaddressed;
    foreign += a.foreign;
    for (const b of a.outOfRange) bad.push(`${f} · ${b}`);
    for (const b of a.anchorBad) anchorBad.push(`${f} · ${b}`);
  }
  const anchored = anchorCount(docText);

  head('2. 覆盖面与两条主判据');
  ok('D 覆盖面：这条腿读到的引用数多到它自己算覆盖面（少于 100 条就是输入集缩了）',
    refs >= 100, `本次解析 ${refs} 条`);
  ok('D 边界：文档里每一条 文件:行号 都在盘上、在界内（写了行号就得还在文件里）',
    bad.length === 0, `解析 ${refs} 条` + (bad.length ? ` · 不在的 ${bad.length} 处：${bad.join(' | ')}` : ''));
  ok('D 锚点：贴着引用的那个名字真的出现在被指的那几行里（漂到隔壁一行要红）',
    anchorBad.length === 0, (anchorBad.length ? `锚点漂 ${anchorBad.length} 处：${anchorBad.join(' | ')}` : `${anchored} 条带锚点的全部落回原处`));
  ok('D 锚点非空转：文档里确实有足够多的引用带指认（少于 8 条就是锚点腿空转）',
    anchored >= 8, `本次认到锚点的 ${anchored} 条`);

  head('3. 等式闸：文档转写的每个实测数都必须等于这条腿自己数到的');
  const claims = [...docText.matchAll(/解析 (\d+) 条/g)].map((x) => Number(x[1]));
  ok('D 等式「解析 N 条」', claims.length >= 1 && claims.every((c) => c === refs),
    `闸数到 ${refs} · 文档写了 ${claims.length} 处：${[...new Set(claims)].join('/') || '（一处都没写）'}`);
  const gapClaims = [...docText.matchAll(/无法定址 (\d+) 处/g)].map((x) => Number(x[1]));
  ok('D 等式「无法定址 N 处」（借不到出处的续引：不判错，也不静默跳过）',
    gapClaims.length >= 1 && gapClaims.every((c) => c === unaddressed),
    `闸数到 ${unaddressed} · 文档写了 ${gapClaims.length} 处：${[...new Set(gapClaims)].join('/') || '（一处都没写）'}`);
  const anchorClaims = [...docText.matchAll(/(\d+) 条(?:贴着引用写了指认|带指认)/g)].map((x) => Number(x[1]));
  ok('D 等式「N 条带指认」（只写下限抓不住"文档抄的是上一轮那个数"）',
    anchorClaims.length >= 1 && anchorClaims.every((c) => c === anchored),
    `闸数到 ${anchored} · 文档写了 ${anchorClaims.length} 处：${[...new Set(anchorClaims)].join('/') || '（一处都没写）'}`);
  const contClaims = [...docText.matchAll(/续引 (\d+) 条/g)].map((x) => Number(x[1]));
  ok('D 等式「续引 N 条」（同句内借到出处的条数）',
    contClaims.length >= 1 && contClaims.every((c) => c === cont),
    `闸数到 ${cont} · 文档写了 ${contClaims.length} 处：${[...new Set(contClaims)].join('/') || '（一处都没写）'}`);
  const foreignClaims = [...docText.matchAll(/跨仓引用 (\d+) 处/g)].map((x) => Number(x[1]));
  ok('D 等式「跨仓引用 N 处」（本仓一份跨仓引用都没有，这个数就该是 0，写歪一样红）',
    foreignClaims.length >= 1 && foreignClaims.every((c) => c === foreign),
    `闸数到 ${foreign} · 文档写了 ${foreignClaims.length} 处：${[...new Set(foreignClaims)].join('/') || '（一处都没写）'}`);

  // 续引这条规则在**别的仓**里有跨仓引用可数，本仓没有；所以它由下面两把控制腿证明，
  // 而不是由 foreign>=1 的覆盖面假装证明。
  const cX = audit('这条分工照 `../z-biz-game-other-cos/tools/balance.mjs:99999` 那份');
  ok('D 跨仓按形状分出去：行号再离谱也不参与本仓的越界检查（否则单仓 checkout 里必红）',
    cX.foreign === 1 && cX.outOfRange.length === 0 && cX.refs.length === 1,
    `foreign=${cX.foreign} refs=${cX.refs.length} 红=${cX.outOfRange.join(' | ') || '无'}`);
  const cY = audit('本仓的假路径 `tools/nope-here.js:9`');
  ok('D 同一条腿对本仓路径照旧判红：上一条的绿不是"什么都不查"',
    cY.foreign === 0 && cY.outOfRange.length === 1 && cY.outOfRange[0].includes('文件不存在'),
    `foreign=${cY.foreign} 红=${cY.outOfRange.join(' | ') || '（没红）'}`);

  head('4. 续引的七把控制腿（全在内存里，盘上的文档一个字不动）');
  // 借到 / 句尾墙 / 软换行仍算同一句 / 空行与新标题截断 / 借来的路径喂进边界检查 /
  // 正文里提到的文件名不是出处 / 同一句改写成完整引用就读得回来。
  const cG = audit('`SAMPLES`（`tools/engine-test.mjs:20`）、`fails`（`:21`）');
  ok('D 续引在同句内借到出处，并带上自己那一格的指认',
    cG.refs.length === 2 && cG.cont === 1 && cG.unaddressed === 0 &&
    cG.outOfRange.length + cG.anchorBad.length === 0 && cG.refs.every((r) => r.path === 'tools/engine-test.mjs'),
    [...cG.outOfRange, ...cG.anchorBad].join(' | ') + `（refs=${cG.refs.length} 借到=${cG.cont} 借不到=${cG.unaddressed}）`);
  const cW = audit('`SAMPLES`（`tools/engine-test.mjs:20`）。\n`fails`（`:21`）');
  ok('D 句号把借的窗口关上：下一句的续引不许挂到上一句的出处上',
    cW.refs.length === 1 && cW.unaddressed === 1, `refs=${cW.refs.length} 借不到=${cW.unaddressed}`);
  const cP = audit('`SAMPLES`（`tools/engine-test.mjs:20`）、\n`fails`（`:21`）');
  ok('D 软换行不算换句：同一句折行后续引照样借得到',
    cP.refs.length === 2 && cP.unaddressed === 0, `refs=${cP.refs.length} 借不到=${cP.unaddressed}`);
  const cH = audit('`SAMPLES`（`tools/engine-test.mjs:20`）\n\n## 续\n`fails`（`:21`）');
  ok('D 空行与新标题同样截断这次借', cH.refs.length === 1 && cH.unaddressed === 1,
    `refs=${cH.refs.length} 借不到=${cH.unaddressed}`);
  const cB = audit('`SAMPLES`（`tools/engine-test.mjs:20`）、`fails`（`:99999`）');
  ok('D 借来的路径喂进边界检查：续引写一个越界的行号必须红，并点名被借的那个文件',
    cB.outOfRange.length === 1 && cB.outOfRange[0].includes('tools/engine-test.mjs') && cB.outOfRange[0].includes('越界'),
    cB.outOfRange.join(' | ') || '（没红）');
  const cF = audit('这套名单住在 `engine-test.mjs` 里，`fails`（`:21`）');
  ok('D 正文里提到的文件名不是出处：这种写法必须算借不到，而不是在错的文件上判绿',
    cF.refs.length === 0 && cF.unaddressed === 1, `refs=${cF.refs.length} 借不到=${cF.unaddressed}`);
  const cC = audit('这套名单住在 `engine-test.mjs` 里，`fails`（`tools/engine-test.mjs:21`）');
  ok('D 同一句改写成完整引用就读得回来：上一条红的是写法，不是解析器漏了这一句',
    cC.refs.length === 1 && cC.unaddressed === 0 && cC.outOfRange.length + cC.anchorBad.length === 0,
    [...cC.outOfRange, ...cC.anchorBad].join(' | ') + `（refs=${cC.refs.length} 借不到=${cC.unaddressed}）`);

  head('5. 反空转：九把假引用必须一把不落');
  // 空行靶子的行号当场从 js/engine/generate.js 数出来，不抄常量：写死一个数字，那位子哪天被填上
  // 内容，这一把就悄悄不测了——所以 blankAt > 0 与计数一起判。
  // 第九把是**截前缀**：generate.js 第 34 行声明的是 `nodes`，把锚点写成 `node` 时子串口径算命中
  // （那行里除了 `nodes` 没有别的 `node`），整词口径判它红。这条腿哪天退回 `.includes`，
  // 少的就是这一把——它是整词那道口径的哨，红行当场点名。
  const blankLines = linesOf('js/engine/generate.js') || [];
  let blankAt = 0;
  for (let i = 1; i < blankLines.length; i++) if (String(blankLines[i]).trim() === '') { blankAt = i + 1; break; }
  const F = audit('出处 `js/engine/nope.js:1`、`js/engine/generate.js:99999`、`NO_SUCH_NAME` 在 `js/engine/generate.js:1`、' +
    '`package.json`（999 行）、`js/engine/generate.js:1`（`makePuzzle`）、`js/engine/generate.js:1` 的 `makePuzzle`、' +
    '`js/engine/generate.js:1`（`Math.max(3, 4)`）' +
    (blankAt ? '、`js/engine/generate.js:' + blankAt + '`' : '') +
    '、`js/engine/generate.js:34`（`node`）');
  ok('D 假引用九把全被抓到（不存在 / 越界 / 行数错 / 后向锚点漂 / 前向括号锚点漂 / 「的」锚点漂 / 函数调用形式锚点漂 / 无锚点落在空行第 ' + blankAt + ' 行 / 前缀不算整词）',
    blankAt > 0 && F.outOfRange.length + F.anchorBad.length === 9, [...F.outOfRange, ...F.anchorBad].join(' | '));

  head('6. 阳性对照：六种真注解写法 + 真行数必须判绿');
  // 上一条的"红"可能只是解析器自己坏了——这一把用本仓真的行与真的名字，走同一个 audit。
  const pkgLines = linesOf('package.json');
  const fwd = audit('`SAMPLES`（`tools/engine-test.mjs:20`）、`tools/engine-test.mjs:20`（`SAMPLES`）、' +
    '`tools/engine-test.mjs:20` 的 `SAMPLES`、`js/engine/generate.js:67`（`makePuzzle(R, C, seed, opt)`）、' +
    '`js/main.js:92`（`js/main.js::announce`）、`tools/engine-test.mjs:20`（`npm test`） 与 ' +
    '`package.json`（' + (pkgLines ? pkgLines.length : 0) + ' 行）');
  ok('D 后向、前向括号、「的」、`path::symbol`、函数调用五种真注解加带空格的命令行 body 都在同一个解析器下判绿',
    fwd.outOfRange.length === 0 && fwd.anchorBad.length === 0 && fwd.refs.length === 6,
    [...fwd.outOfRange, ...fwd.anchorBad].join(' | ') + `（refs=${fwd.refs.length}）`);

  // 模板前缀：`name:<占位>` 指的是那串字面量前缀。本仓文档没这么写过，所以这一把只由台架证明——
  // 规则一丢，`NOPE:<占位>` 那种假引用连锚点都不会生成，九把里就少一把。
  const tplGreen = audit('`js/engine/generate.js:67`（`makePuzzle:<占位>`）');
  const tplRed = audit('`js/engine/generate.js:67`（`NOPE:<占位>`）').anchorBad;
  ok('D 模板 body 取字面量前缀（前缀对得上判绿、对不上必须红）',
    tplGreen.anchorBad.length === 0 && tplGreen.refs.length === 1 && tplRed.length === 1,
    `绿=${tplGreen.anchorBad.length ? tplGreen.anchorBad.join(' | ') : 'ok'} · 红在 ${tplRed.join(' | ') || '（一处都没红）'}`);

  // 反方向的控制：逗号不是指认。前面那个名字只是列表的上一项，按它钉会把正确的文档读红。
  const comma = audit('`NO_SUCH_NAME`，`tools/engine-test.mjs:20`');
  ok('D 纯标点间隔（`，`）不构成指认：这种写法必须判绿',
    comma.anchorBad.length === 0 && comma.refs.length === 1,
    `${comma.anchorBad.join(' | ') || '绿'}（refs=${comma.refs.length}）`);

  head('7. 这条腿对本仓文档真有牙齿');
  // 把一条界内的真引用挪歪一格，越界检查看不见它（68 在界内），只有锚点抓得住。
  // 改的是内存里的副本，盘上的文档一个字不动。
  const needle = '`makePuzzle`（`js/engine/generate.js:67`';
  const hits = docText.split(needle).length - 1;
  const poisoned = audit(docText.replace(needle, '`makePuzzle`（`js/engine/generate.js:68`'));
  ok('D 把文档里一条真引用的行号挪歪一格，这条腿必须为它变红',
    hits === 1 && poisoned.anchorBad.length === 1,
    `needle 命中 ${hits} 处 · 红在 ${[...poisoned.outOfRange, ...poisoned.anchorBad].join(' | ') || '（一处都没红）'}`);

  return { refs, anchored, cont, unaddressed, foreign, docs: docFiles.length };
}

// 指认条数与 audit 用同一套解析，只数"有锚点的"那几条。
function anchorCount(text) {
  return parseRefs(text).filter((r) => r.anchor).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let checks = 0, fails = 0;
  const ok = (name, cond, detail = '') => {
    checks++;
    if (cond) console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`);
    else { fails++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`); }
  };
  const r = run(ok);
  console.log(`\n文档行号对账：${r.docs} 份文档 · 解析 ${r.refs} 条 · 续引 ${r.cont} 条 · 无法定址 ${r.unaddressed} 处 · ` +
    `带指认 ${r.anchored} 条 · 跨仓引用 ${r.foreign} 处`);
  console.log(`\n${checks - fails}/${checks} 条闸绿`);
  if (fails) { console.log(`RED ${fails} 条`); process.exit(1); }
}
