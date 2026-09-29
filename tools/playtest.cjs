// Minimal CDP driver for headless playtesting (Node 22+ global WebSocket/fetch).
//
// env: CDP_PORT (devtools port, default 9363), BASE_URL (page origin, default
//      http://127.0.0.1:5263/), WITNESS (json handed to the resume scenario)
//      GATE_SELFTEST=1 (makes every report plant one deliberately wrong expectation —
//      scenarios.js 那份和 node 侧的 leg/nav/reload 那份走的是同一条规矩)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>' [nonav]   evaluate, await promises, print result
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __ng.<name>()
//   node tools/playtest.cjs witness             read timeOrigin/doc BEFORE any navigation
//   node tools/playtest.cjs nav <url> same|fresh   navigate + assert whether it is a new document
//   node tools/playtest.cjs reload              real reload + assert the document actually died
//   node tools/playtest.cjs leg mouse|touch|keys   真事件（Input.dispatch*）驱动的输入腿
//   node tools/playtest.cjs shot <file.png> / logs
//
// Which page to attach to is decided by BASE_URL's origin, never by a hard-coded port:
// an `eval` that silently lands on an about:blank target reads like a broken deploy.
//
// 这一份是从 z-biz-game-hebi-cos 的同一只驱动搬过来的：命令集、CDP 调用序列、几何取样点、
// 阴性自证的位置都保持原样。凡原来读的是蛇/黑格/格内数字的语义，这里保留同一行并打上 DC-HOOK，
// 换成 DOUBLE CHOCO 里同一位置的语义（底纹 / 数字 / 区界 / 归组）。
const fs = require('fs');
const path = require('path');

// 9363 而不是 9362：9362 是本农场 z-biz-game-hebi-cos 那条闸的 devtools 端口。
// 两个仓同时在跑时，attach 到别人的 Chrome 上读到的是别人的盘。
const PORT = Number(process.env.CDP_PORT || 9363);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5263/';
const ORIGIN = new URL(BASE).origin;
const SELFTEST = process.env.GATE_SELFTEST === '1';
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];
const rows = [];
const ck = (test, cond, detail) => rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
const result = (extra) => {
  // 阴性自证要覆盖 node 侧的腿：真事件（leg mouse/touch/keys）与 nav/reload 的报告不经过
  // scenarios.js 的 report()，不在这里也种一条的话，这五条腿就永远是"没能红过的绿"。
  if (SELFTEST) rows.push({ test: 'GATE_SELFTEST 种下的错期望（1 应当等于 2）', pass: 1 === 2, detail: 'planted red' });
  return { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
};
const out = (extra) => {
  const r = result(extra);
  if (logs.length) console.error(logs.slice(-40).join('\n'));
  // Console noise first, machine-readable line last: the parser in verify.sh takes the final
  // RESULT line, so a stray '{' in a log cannot hijack the report.
  console.log('RESULT ' + JSON.stringify(r));
};
const evidence = (o) => console.log('EVIDENCE ' + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' '));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify((${expression}))`));

  const ready = async () => {
    for (let i = 0; i < 160; i++) {
      const s = await evaluate('document.readyState').catch(() => 'loading');
      if (s === 'complete') return;
      await sleep(100);
    }
  };
  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await ready();
    await sleep(200);
  };
  // 只差一个 hash 的 URL 是 same-document navigation：Page.navigate 过去并不会换文档。
  // 所以"这一腿必须落在新文档里"的走 Page.reload，URL 真的不同才用 navigate。
  const gotoFresh = async (url = BASE) => {
    const cur = String(await evaluate('location.href').catch(() => ''));
    const cut = (u) => u.split('#')[0];
    if (cur && cut(cur) === cut(url)) {
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await ready();
      await sleep(200);
    } else {
      await navigate(url);
    }
  };
  // 文档身份：每个文档一个随机 doc 号。片段导航不换文档所以它不变，真重载一定变。
  const docInfo = () =>
    evaluate(`(()=>{const h=window.dc;return {url:location.href,to:performance.timeOrigin,doc:h?h.doc:'(no window.dc)',boot:!!h};})()`).catch((e) => ({ url: 'unknown', to: 0, doc: 'ERR:' + e.message, boot: false }));

  // ---------- in-page geometry: 先量 hit box，再谈"点得到" ----------

  // DOUBLE CHOCO 的题面是**两张表**：g.B.gray（底纹半盘）与 g.B.num（格上的读数）。
  // 落子不是"格里的数字"而是**两格之间的那条段**，所以取样点比 hebi 多一类：段的中点。
  // 每一类都只认真几何（画布的客户端坐标 + document.elementFromPoint + view 自己的判定），
  // 不读页面里的标志位——"能点着"这句话的证据只能在命中盒上。
  const PREP = `(()=>{
    const h=window.dc, v=h.view, g=h.game, SK=h.engine.segKey;
    if(!g) throw new Error('no game on screen');
    const rect=v.canvas.getBoundingClientRect();
    const at=(x,y)=>{const e=document.elementFromPoint(x,y);return e?(e.id||e.tagName):'null';};
    const o={rect:{l:rect.left,t:rect.top,w:rect.width,h:rect.height},iw:innerWidth,dpr:devicePixelRatio,
      seed:g.puzzle.seed,tier:g.puzzle.tier,btns:[],sweepTotal:g.B.cells.length,sweepHits:0,
      segTotal:g.segs.length,segHits:0};
    let miss=0;
    const cellAt=(i)=>{const r=v.cellRect(i);const x=rect.left+r.x+r.size/2,y=rect.top+r.y+r.size/2;return {i,x,y,hit:at(x,y)};};
    for(let i=0;i<g.B.cells.length;i++){const c=cellAt(i);if(c.hit==='board')o.sweepHits++;else miss++;}
    o.sweepMiss=miss;
    // 段中点两件事都要成立：命中的是画布，而且 view 把这一点判回**同一条**段。
    // 只断第一件的话，"看着有两条虚线、点下去画到隔壁那条"这种错位照样能绿过去。
    let smiss=0;
    const segAt=(k)=>{const s=v.segLine(k);const x=rect.left+(s.x1+s.x2)/2,y=rect.top+(s.y1+s.y2)/2;
      return {k,i:g.segs[k][0],j:g.segs[k][1],x,y,hit:at(x,y),back:v.hitSegment(x,y)};};
    for(let k=0;k<g.segs.length;k++){const s=segAt(k);if(s.hit==='board'&&s.back===k)o.segHits++;else smiss++;}
    o.segMiss=smiss;
    const num=[...g.B.num.keys()];
    const gi=num.find((i)=>g.B.isGray(i)), wi=num.find((i)=>!g.B.isGray(i));
    o.gray=gi===undefined?null:cellAt(gi);
    o.white=wi===undefined?null:cellAt(wi);
    // 三种真落点：一个盘心的格（移光标）、一条不碰光标的段（画/擦）、顶行相邻的两段（拖过去）。
    o.tap=cellAt(g.B.id(1,1));
    o.corner=cellAt(g.B.id(0,0));
    const sk=g.segs.findIndex(([i,j])=>i!==g.cursor&&j!==g.cursor&&i!==o.tap.i&&j!==o.tap.i);
    o.segK=sk;
    o.seg=segAt(sk<0?0:sk);
    const kA=g.segIx.get(SK(g.B.id(0,1),g.B.id(0,2))), kB=g.segIx.get(SK(g.B.id(0,2),g.B.id(0,3)));
    o.drag=[segAt(kA),segAt(kB)];
    // 键盘腿画的那一条由**题面**挑：解里要求画界的相邻对。随便挑一条的话，它多半是条多余的界，
    // 于是后面"按 H 给了一次提示"会被判据顶成报矛盾（一次求助都不该计），那句话就成了看盘面脸色。
    const kc=g.B.id(2,2);
    let kd=null;
    for(const pair of [['ArrowRight','right'],['ArrowDown','down'],['ArrowLeft','left'],['ArrowUp','up']]){
      const to=g.step(kc,pair[1]);if(to===null)continue;
      if(!g.solRel.has(Math.min(kc,to)+':'+Math.max(kc,to))){kd={key:pair[0],dir:pair[1],k:g.segIx.get(SK(kc,to)),i:kc,j:to};break;}
    }
    o.keyDraw=kd;
    // 光标从 o.tap 那一格出发：右一格、再下一格，必须正好落到 kc（键盘腿下面两行断的就是这条走法）。
    o.keyFrom=g.step(g.step(o.tap.i,'right'),'down');
    o.keyTo=kc;
    // disabled 的那只键（光标在角格时 ↑ 到盘边）不进"中心落在自己上"那一组：
    // 它按契约就是点不动的，那一组的断言只对**可用**的控件说真话。
    for(const id of ['btn-edge-right','btn-edge-down','btn-hint','btn-undo','btn-new','btn-menu']){
      const e=document.getElementById(id);const b=e.getBoundingClientRect();
      const x=b.left+b.width/2,y=b.top+b.height/2;
      o.btns.push({id,x,y,hit:at(x,y),w:Math.round(b.width),h:Math.round(b.height)});}
    const up=document.getElementById('btn-edge-up').getBoundingClientRect();
    o.edgeUp={x:up.left+up.width/2,y:up.top+up.height/2};
    return o;})()`;

  // 两条腿各自只发自己那一种真事件：mouse 腿发鼠标，touch 腿发触屏。脚本里成对写 tap，
  // 于是同一条断言在两种事件下各跑一次，而不会出现"鼠标腿其实也按了一遍触屏"的假证据。
  const mouse = async (x, y) => {
    if (arg === 'touch') return;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(90);
  };
  const key = async (k, shift) => {
    const map = { Backspace: 'Backspace', ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', h: 'KeyH', z: 'KeyZ' };
    const vk = { Backspace: 8, ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, h: 72, z: 90 };
    const text = k.length === 1 ? k : undefined;
    // 修饰键按 CDP 的位掩码给（Shift=8）：游戏里 Shift+方向键才是"落子"，不加这一位的话
    // 键盘腿测的永远只是"移动光标"，那一条控制流根本没被走过。
    const modifiers = shift ? 8 : 0;
    // 绝不给 nativeVirtualKeyCode：在 macOS 上 Chrome 把它当平台原生键码，于是这只键被 raw
    // keyboard 路径反复补发，一次派发在页面里到达 N 次 keydown。让 Chrome 自己从 wvk 推原生键码，
    // 一次派发就正好是一次按键。这句理由由谁读着：`按键 X 到达游戏一次`（逐只键的 seen/handled/
    // repeat/thiskey 增量）与 `派发了 N 个按键：到达游戏的 keydown 总数`——带上 nvk 变红的是这两行。
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: map[k], text, windowsVirtualKeyCode: vk[k], modifiers }, sessionId);
    if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, key: k, code: map[k], windowsVirtualKeyCode: vk[k], modifiers }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: map[k], windowsVirtualKeyCode: vk[k], modifiers }, sessionId);
    await sleep(60);
  };
  const touch = async (x, y) => {
    if (arg !== 'touch') return;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(90);
  };
  // 一笔画：按下 → 拖过 → 放开。鼠标腿发 mousePressed/mouseMoved*，触屏腿发 touchStart/touchMove*，
  // 两条路都让页面自己合成 pointermove（js/main.js 的 onPointerMove 才是被测的那一段）。
  const drag = async (a, b) => {
    if (arg === 'touch') {
      const pt = (x, y) => ({ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(a.x, a.y)] }, sessionId);
      await sleep(40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt((a.x + b.x) / 2, (a.y + b.y) / 2)] }, sessionId);
      await sleep(40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(b.x, b.y)] }, sessionId);
      await sleep(40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
      await sleep(90);
      return;
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, button: 'left' }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left' }, sessionId);
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(90);
  };

  // DC-HOOK: g.codes() 是 game.js 的盘面串（hebi 每格一个字符）；本仓 store.js 的默认口径是
  // 每条内部虚线一个字符。这一句读的还是"盘面串的长度/内容在动"，口径由 game.js 定。
  const GAME = `(()=>{const g=window.dc.game;return {cursor:g.cursor,seed:g.puzzle.seed,moves:g.moves,hints:g.hints,status:g.status,cuts:g.cuts,steps:g.steps.length,codes:g.codes(),errs:g.errs.length,doc:window.dc.doc,to:performance.timeOrigin};})()`;
  const DOMTXT = `(()=>{const t=s=>(document.querySelector(s)||{}).textContent||'';
    return {name:t('#stat-name'),seed:t('#stat-seed'),moves:t('#stat-moves'),hints:t('#stat-hints'),
    cuts:t('#stat-cuts'),remaining:t('#stat-remaining'),conflicts:t('#stat-conflicts'),regions:t('#stat-regions'),nums:t('#stat-nums'),
    cursor:t('#pad-cursor'),state:t('#state-line'),hintRule:t('#hint-rule'),hintLine:t('#hint-line'),
    veilShown:(()=>{const e=document.getElementById('win-veil');return e?getComputedStyle(e).display!=='none'&&e.getClientRects().length>0:false;})(),
    active:document.activeElement?(document.activeElement.id||document.activeElement.tagName):'null',
    pressed:[...document.querySelectorAll('.pad .edge')].map(b=>b.id+'='+b.getAttribute('aria-pressed')).join(','),
    disabled:[...document.querySelectorAll('.pad .edge')].map(b=>b.id+'='+(b.disabled?'1':'0')).join(','),
    label:document.getElementById('btn-edge-up').getAttribute('aria-label'),
    gen:t('#stat-genms'),score:t('#stat-score')};})()`;

  // ---------- commands ----------

  if (cmd === 'open') {
    await navigate(arg || BASE);
    const d = await docInfo();
    evidence({ url: d.url, timeOrigin: d.to, doc: d.doc, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const v = await evaluate(arg);
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
  } else if (cmd === 'witness') {
    const d = await docInfo();
    // 派发导航之先，证人已经在 node 手里了：续局那条腿要证明的是"新文档"，不是"我按了一次刷新"。
    // 证人同时把"导航前盘面长什么样"抄一份下来——续局腿要比的是这一份，不是它自己重算的期望。
    const sent = await evaluate(`(()=>{const g=window.dc.game;window.__gateSentinel='sn'+Math.floor(Math.random()*1e6);return window.__gateSentinel+'|'+(g?g.codes():'')+'|'+(g?g.puzzle.seed:'');})()`);
    // DC-HOOK: hebi 抄的是 g.black.size（黑格条数）；本仓抄题面两张表的条数：底纹 + 数字。
    // wantCuts/blocks 也一起抄：续局腿要比的是"重证出来的那一盘要求几条界、几块"，
    // 这两个数只有导航前的文档知道，续局文档自己算不出来（它不跑出题器）。
    const snap = JSON.parse(await evaluate(`(()=>{const g=window.dc.game,S=window.dc.engine.Store,r=S.resume(window.dc.engine.tierOf);
      return JSON.stringify({tier:g?g.puzzle.tier:'',seed:g?g.puzzle.seed:0,codes:g?g.codes():'',gray:g?g.B.gray.size:0,nums:g?g.B.num.size:0,
        wantCuts:g?g.wantCuts:0,blocks:g?g.puzzle.tiling.length:0,
        hints:g?g.hints:0,moves:g?g.moves:0,ms:g?window.dc.state().elapsedMs:0,storedMs:r?r.elapsedMs:0,storedSeed:r?r.seed:0});})()`));
    evidence({ url: d.url, timeOrigin: d.to, doc: d.doc, sentinel: sent, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio'), ...snap });
    console.log(JSON.stringify({ timeOrigin: d.to, doc: d.doc, url: d.url, sentinel: sent, ...snap }));
  } else if (cmd === 'nav' || cmd === 'reload') {
    const before = await docInfo();
    const expect = cmd === 'reload' ? 'fresh' : rest;
    const url = cmd === 'reload' ? before.url.split('#')[0] : arg;
    if (cmd === 'reload') await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
    else await cdp.send('Page.navigate', { url: url || BASE }, sessionId);
    await sleep(expect === 'fresh' ? 500 : 350);
    await ready();
    if (expect === 'fresh') {
      for (let i = 0; i < 60; i++) {
        const d = await docInfo();
        if (d.boot && d.doc !== before.doc) break;
        await sleep(150);
      }
    }
    const after = await docInfo();
    evidence({ leg: cmd, expect, urlBefore: before.url, urlAfter: after.url, timeOriginBefore: before.to, timeOriginAfter: after.to, docBefore: before.doc, docAfter: after.doc, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    eq(`${cmd} 之后页面还在同一个 URL 形态`, new URL(after.url).pathname, new URL(url || before.url).pathname);
    ck(`${cmd} 之后应用又起来了（window.dc 在）`, after.boot, after.doc);
    if (expect === 'same') {
      eq('片段导航不算重载：timeOrigin 必须没变', after.to, before.to);
      eq('片段导航不算重载：文档身份必须没变', after.doc, before.doc);
    } else {
      ck('真重载：timeOrigin 必须换了（新文档）', after.to !== before.to, `${before.to} -> ${after.to}`);
      ck('真重载：文档身份必须换了', after.doc !== before.doc, `${before.doc} -> ${after.doc}`);
    }
    out({ before, after, expect });
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await gotoFresh(BASE);
    await evaluate(`window.__witness=${process.env.WITNESS || 'null'};window.__selftest=${SELFTEST};'ok'`);
    // Headless reports the page as hidden, and the render loop is allowed to skip frames when
    // hidden — so a scenario that waits on animation would time out against a browser that is
    // only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const d = await docInfo();
    evidence({ scenario: arg, url: d.url, timeOrigin: d.to, doc: d.doc, innerWidth: await evaluate('innerWidth'), dpr: await evaluate('devicePixelRatio') });
    const res = await evaluate(`(async()=>{
      if (!window.__ng) throw new Error('scenarios.js never installed');
      // 报告必须是字符串：把对象交给 returnByValue 只会打印出 "[object Object]"，
      // 于是这一腿看起来跑了、verify.sh 却一行断言都解析不到。
      return JSON.stringify(await window.__ng[${JSON.stringify(arg)}]());
    })()`);
    // 每一次注入都在文档上留一份，用完就撤：否则同一个文档里会有第 N 份 scenarios.js 在跑。
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => {});
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + res);
  } else if (cmd === 'leg') {
    await leg();
  } else if (cmd === 'shot') {
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs' || cmd === 'reload-logs') {
    if (cmd === 'reload-logs') await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);

  // ---------- 真事件腿：鼠标 / 触屏 / 键盘（都走 CDP Input.*，不是页内 new Event） ----------

  async function leg() {
    await gotoFresh(BASE);
    // begin() 是异步的（withBusy 先把"出题中"画上屏才跑那段贵计算），所以这里等的是
    // "盘真的在屏幕上了"，不是固定 sleep 一个猜来的数：拿着半个盘往下量，读回来的是上一份文档。
    await evaluate(`(()=>{ if(!window.dc.game) window.dc.begin({tier:'sho'}); return 1; })()`);
    for (let i = 0; i < 80; i++) {
      if (await evaluate(`(()=>{const g=window.dc.game;return !!(g&&g.puzzle&&!window.dc.busy());})()`)) break;
      await sleep(100);
    }
    if (arg === 'touch') {
      // 覆写必须写在腿自己的调用里，并且腿要能读回证人：另起进程设 Emulation 等于把桌面断言
      // 重跑一遍。所以这里读回 innerWidth/dpr 并把它命名成"覆写在位"，不命名成"这是手机"。
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, sessionId);
      await sleep(400);
    }
    const p = await json(PREP);
    const C = await json(`window.dc.game.C`);
    const d0 = await docInfo();
    evidence({ leg: arg, url: d0.url, timeOrigin: d0.to, doc: d0.doc, innerWidth: p.iw, dpr: p.dpr, seed: p.seed, segs: p.segTotal });
    // 两条盘面串逐位比：整串求差只会给一个 hamming 距离，说不清"是不是只多点了一条"。
    const diffIx = (a, b) => { const o = []; for (let k = 0; k < b.length; k++) if (a[k] !== b[k]) o.push(k); return o; };

    eq('hit box：棋盘每一格中心都落在画布上', p.sweepMiss, 0);
    eq('hit box：每一条段的中点都判回那一条', p.segMiss, 0);
    eq('hit box：落子盘与动作键的中心都落在自己上', p.btns.filter((b) => b.hit !== b.id).map((b) => b.hit + '@' + b.id).join(','), '');
    ck('按钮都够点（>=34px 高）', p.btns.every((b) => b.h >= 34), JSON.stringify(p.btns.map((b) => [b.id, b.h])));
    if (arg === 'touch') {
      eq('移动覆写在位：innerWidth 读回 390', p.iw, 390);
      eq('移动覆写在位：devicePixelRatio 读回 3', p.dpr, 3);
      ck('窄屏下棋盘仍在视口里', p.rect.l >= 0 && p.rect.w <= p.iw + 1, JSON.stringify({ rect: p.rect, iw: p.iw }));
    }
    if (arg === 'touch' || arg === 'mouse') {
      ck('这一档的题面两种底色都带着数字（V5 的两半都要有证人）', !!p.gray && !!p.white, JSON.stringify([p.gray, p.white]));
      eq(`hit box：带数字的底纹格 ${p.gray.i} 的命中元素就是画布`, p.gray.hit, 'board');
      eq(`hit box：带数字的白格 ${p.white.i} 的命中元素就是画布`, p.white.hit, 'board');

      // ① 点格子中间 = 移光标（这个游戏里"选中"只有这一种来路）
      await mouse(p.tap.x, p.tap.y);
      await touch(p.tap.x, p.tap.y);
      const sel = await json(GAME);
      const domSel = await json(DOMTXT);
      const nameSel = await json(`window.dc.game.name(window.dc.game.cursor)`);
      eq(`${arg} 点格子中间把光标移到那一格`, sel.cursor, p.tap.i);
      eq('界面上的光标读数与引擎同一格', domSel.cursor, nameSel);

      // ② 落子盘的方向键 = 画那一条界，再按一次 = 擦掉。
      // DC-HOOK: hebi 在这里按的是数字键 1–5（格内读数）。DOUBLE CHOCO 的落子键是四只方向键，
      // 每只都带着它那条段的段名（aria-label）与按下态（aria-pressed），所以两边都要读。
      ck('盘上有一条不碰光标的段可以给指针点', p.segK >= 0, p.segK);
      const padR = p.btns.find((b) => b.id === 'btn-edge-right');
      const kRight = await json(`Number(document.getElementById('btn-edge-right').dataset.seg)`);
      ck('↑→↓← 里 → 那只键此刻有落点', kRight >= 0 && kRight < p.segTotal, kRight);
      await mouse(padR.x, padR.y);
      await touch(padR.x, padR.y);
      const drew = await json(GAME);
      const pressOn = await json(`document.getElementById('btn-edge-right').getAttribute('aria-pressed')`);
      eq('点方向键画上了它那一条界', drew.codes[kRight], '1');
      eq('键亮起来（aria-pressed）', pressOn, 'true');
      eq('画一条算一步', drew.moves, 1);
      eq('已画读数跟着走', drew.cuts, 1);
      await mouse(padR.x, padR.y);
      await touch(padR.x, padR.y);
      const erased = await json(GAME);
      const pressOff = await json(`document.getElementById('btn-edge-right').getAttribute('aria-pressed')`);
      eq('再点一次就是擦掉', erased.codes[kRight], '0');
      eq('灯跟着灭', pressOff, 'false');
      eq('擦掉也算一步（不许装作没发生）', erased.moves, 2);
      eq('擦干净之后已画归零', erased.cuts, 0);

      // ③ 直接点画布上那条虚线：只该翻那一条，隔壁的不许跟着动
      const before = await json(GAME);
      await mouse(p.seg.x, p.seg.y);
      await touch(p.seg.x, p.seg.y);
      const onSeg = await json(GAME);
      eq('点段的中点就画那一条（没有第二条跟着变）', JSON.stringify(diffIx(before.codes, onSeg.codes)), JSON.stringify([p.seg.k]));
      await mouse(p.seg.x, p.seg.y);
      await touch(p.seg.x, p.seg.y);
      const offSeg = await json(GAME);
      eq('再点同一条就擦回来（盘面逐位回到原样）', offSeg.codes, before.codes);

      // ④ 一笔画：按住拖过相邻的两条段，两条都落向同一个目标态。
      // 这条只在真事件下测得出：页内 dc.setSeg 是一段一段调的，压根不经过 onPointerMove。
      const beforeDrag = await json(GAME);
      await drag(p.drag[0], p.drag[1]);
      const afterDrag = await json(GAME);
      eq('拖过的那两条都画上（一次拖 = 两处落子）', JSON.stringify(diffIx(beforeDrag.codes, afterDrag.codes)), JSON.stringify([p.drag[0].k, p.drag[1].k]));
      ck('拖出来的两条确实都是界', afterDrag.codes[p.drag[0].k] === '1' && afterDrag.codes[p.drag[1].k] === '1', afterDrag.codes);

      // ⑤ 撤销键逐条退到底：界与违反都不许留残留
      let guard = 0;
      while (guard++ < 60) {
        const now = await json(GAME);
        if (!now.steps) break;
        const bu = p.btns.find((b) => b.id === 'btn-undo');
        await mouse(bu.x, bu.y);
        await touch(bu.x, bu.y);
      }
      const cleared = await json(GAME);
      const domCleared = await json(DOMTXT);
      eq('撤销到底：一条界都不剩', cleared.cuts, 0);
      eq('撤销到底：一步不剩', cleared.steps, 0);
      eq('撤销到底：违反也归零', domCleared.conflicts, '0');
      eq('撤销到底：步数读数归零', domCleared.moves, '0');

      // ⑥ 盘边无处可画：那一面的键按契约就是点不动的（它被标成 disabled，并且不带着按下态）。
      // DC-HOOK: hebi 的拒答是"题面钉死的黑格改不了"。DOUBLE CHOCO 每一格都能落子，
      // 不存在的那种是**落点**——光标走到盘边，外侧没有相邻的格，也就没有那一条段。
      const corner = await json(`window.dc.game.B.id(0,0)`);
      await mouse(p.corner.x, p.corner.y);
      await touch(p.corner.x, p.corner.y);
      const atCorner = await json(GAME);
      const beforeEdge = await json(GAME);
      await mouse(p.edgeUp.x, p.edgeUp.y);
      await touch(p.edgeUp.x, p.edgeUp.y);
      const afterEdge = await json(GAME);
      eq('点角格把光标带到那一格', atCorner.cursor, corner);
      eq('盘边那只 ↑ 键被标成不可用', await json(`document.getElementById('btn-edge-up').disabled`), true);
      ck('它说这一面到了盘边', /到盘边/.test(await json(`document.getElementById('btn-edge-up').getAttribute('aria-label')`)), await json(`document.getElementById('btn-edge-up').getAttribute('aria-label')`));
      eq('点它不落下任何一条界（盘面逐位没动）', afterEdge.codes, beforeEdge.codes);
      eq('点它也不计一步', afterEdge.moves, beforeEdge.moves);
      eq('不可用的那只键没有残留按下态', await json(`document.getElementById('btn-edge-up').getAttribute('aria-pressed')`), null);

      // ⑦ 提示键：一次点击 = 一条界，而且它画的那一条是解里要求的那一条
      const solCodes = await json(`window.dc.game.solutionCodes()`);
      const beforeHint = await json(GAME);
      const bh = p.btns.find((b) => b.id === 'btn-hint');
      await mouse(bh.x, bh.y);
      await touch(bh.x, bh.y);
      const afterHint = await json(GAME);
      const domHint = await json(DOMTXT);
      eq('提示计一次求助', afterHint.hints - beforeHint.hints, 1);
      ck('提示说出了具名规则', /^规则：[NX]\d/.test(domHint.hintRule), domHint.hintRule);
      const changed = diffIx(beforeHint.codes, afterHint.codes);
      eq('提示只画了那一条', changed.length, 1);
      eq('提示画的那一条确实写在解里', afterHint.codes[changed[0]], solCodes[changed[0]]);

      // 换一局：seed 必须来自存档里的自增游标，而不是日期/时间
      const sBefore = await json(`(()=>({seed:window.dc.game.puzzle.seed,cur:window.dc.engine.Store.peekSeed()}))()`);
      const bn = p.btns.find((b) => b.id === 'btn-new');
      await mouse(bn.x, bn.y);
      await touch(bn.x, bn.y);
      const sAfter = await json(`(()=>({seed:window.dc.game.puzzle.seed,cur:window.dc.engine.Store.peekSeed(),tier:window.dc.game.puzzle.tier}))()`);
      const domN = await json(DOMTXT);
      ck('换一局换了盘（seed 变了）', sAfter.seed !== sBefore.seed, `${sBefore.seed} -> ${sAfter.seed}`);
      ck('seed 是小整数自增号，不是日期/时间戳', sAfter.seed >= 1 && sAfter.seed < 1e6 && Number.isInteger(sAfter.seed), sAfter.seed);
      ck('游标推到了 seed 之后（下一局不会撞同一张）', sAfter.cur > sAfter.seed, `${sAfter.seed} / ${sAfter.cur}`);
      ck('页面把 seed 印出来了', domN.seed.includes(String(sAfter.seed)), domN.seed);
    }
    if (arg === 'keys') {
      ck('键盘腿在题面里找到了一条要画的界', !!p.keyDraw, JSON.stringify(p.keyDraw));
      await mouse(p.tap.x, p.tap.y);
      const act = await json(`(()=>({active:document.activeElement?document.activeElement.id:'null'}))()`);
      eq('焦点钉在棋盘上（先真点了一次）', act.active, 'board');
      const start = await json(GAME);
      eq('那一下真点击把光标带到了 o.tap 那一格', start.cursor, p.tap.i);
      // 六只键：两只走格、一只带 Shift 落子、一只提示、两只撤销（撤销有 z 与退格两个名字，都要认）。
      const seq = [{ k: 'ArrowRight' }, { k: 'ArrowDown' }, { k: p.keyDraw.key, shift: true }, { k: 'h' }, { k: 'z' }, { k: 'Backspace' }];
      // 逐个按键各取一次快照：整段求差只会打印出一个大数，说不清是哪一只键被重复送达。
      const per = [];
      for (const s of seq) {
        const a = await json(`window.dc.keyHits()`);
        const da = await json(GAME);
        await key(s.k, s.shift);
        const b = await json(`window.dc.keyHits()`);
        const db = await json(GAME);
        per.push({ label: (s.shift ? 'Shift+' : '') + s.k, seen: b.seen - a.seen, handled: b.handled - a.handled, rep: b.repeated - a.repeated, n: (b.by[s.k] || 0) - (a.by[s.k] || 0), da, db });
      }
      const dom = await json(DOMTXT);
      // 仓里 known flake：同一个键盘计数在同样的跑法里读到 0/2/7。所以这里报的是"到达数"，
      // 派发数与实际到达数不等就红，红的那条写着到达数、处理数和自动重复数。
      // 这一句是键盘腿的全部难点：派发一只键，页面里必须**只**多一次 keydown、只多一次处理、
      // 且没有自动重复。Shift+方向键与裸方向键的 ev.key 同名，所以 by[] 取的是增量而不是累计。
      for (const q of per) eq(`按键 ${q.label} 到达游戏一次`, `${q.seen} seen/${q.handled} handled/${q.rep} repeat/${q.n} thiskey`, '1 seen/1 handled/0 repeat/1 thiskey');
      const sum = per.reduce((a, q) => a + q.seen, 0);
      eq(`派发了 ${seq.length} 个按键：到达游戏的 keydown 总数`, sum, seq.length);
      // 到达数只证明"键送到了"。下面这一组证明每一只键做了它那句话：逐只读盘面，不求总差。
      eq('方向键把光标右移一格', per[0].db.cursor, per[0].da.cursor + 1);
      eq('方向键把光标下移一行', per[1].db.cursor, per[1].da.cursor + C);
      eq('走两格之后落在键盘腿挑的那一格（与题面挑的那条界同源）', per[2].da.cursor, p.keyTo);
      eq('Shift+方向键画上一条界（已画 +1）', per[2].db.cuts - per[2].da.cuts, 1);
      eq('Shift+方向键只动了那一条', JSON.stringify(diffIx(per[2].da.codes, per[2].db.codes)), JSON.stringify([p.keyDraw.k]));
      eq('H 键给了一次提示', per[3].db.hints - per[3].da.hints, 1);
      eq('Z 退掉最后一步', per[4].db.steps, per[4].da.steps - 1);
      eq('退格也退掉一步（两只撤销键都要认）', per[5].db.steps, per[5].da.steps - 1);
      eq('撤到底：界一条不剩', per[5].db.cuts, 0);
      eq('撤到底：违反归零', per[5].db.errs, 0);
      ck('提示说出了规则名', /^规则：[NX]\d/.test(dom.hintRule), dom.hintRule);
      ck('提示不是空话', dom.hintLine.length > 8, dom.hintLine);
      // 键盘玩家不看鼠标：走格、落子、提示、撤销四件事都在 DOM 读数上有对应的一动。
      ck('光标读数跟着键走（不是只有引擎内部在动）', /r\d+c\d+/.test(dom.cursor), dom.cursor);
      ck('不可用的落点不许挂着按下态', (() => {
        const dis = dom.disabled.split(','), pr = dom.pressed.split(',');
        return dis.every((x, ix) => !x.endsWith('=1') || pr[ix].endsWith('=null'));
      })(), JSON.stringify([dom.disabled, dom.pressed]));
    }
    if (arg === 'touch') {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId).catch(() => {});
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
    }
    out({ leg: arg, segs: p.segTotal, buttons: p.btns.length, sweepTotal: p.sweepTotal, sweepHits: p.sweepHits, segHits: p.segHits });
  }
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (rows.length) console.error('RESULT ' + JSON.stringify(result({ crashed: true })));
  else console.error('RESULT ' + JSON.stringify({ rows: [{ test: `${cmd} ${arg || ''} 整条腿跑挂了`, pass: false, detail: String(err.message || err) }], fail: 1, crashed: true }));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
