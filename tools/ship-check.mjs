// 资产上线完整性闸：把"美术资产出货了"从一句注释变成一个能红的判据。
//
// 为什么会需要这一份（2026-10-05 实测）：pages.yml 的 Assembling 腿只有 `cp index.html` 与
// `cp -r css js`，于是 icons/、assets/texture/、assets/sprite/、manifest.webmanifest、sw.js
// **全部不在产物里**。官方 pwa_icon_ship_check.py 对本仓给的是
// `buckets {'IN_GIT_NOT_SHIPPED': 9}`、`repos_with_unshipped_declared_icons 1`。
// 页面上看不出来：本地 file:// 与服务器的 server.cjs 都从仓根发文件，只有上线之后
// favicon/og:image/manifest/sw.js/纹理 一起 404，PWA 装不上、离线壳不存在、底纹凭空消失。
//
// 判法（三条，缺一不可）：
//  1) 引用收集：index.html 的 href/src/og:image、css/*.css 的 url(...)、manifest 的 icons[].src、
//     sw.js 的 SHELL[]、js/ 里出现的 assets/ icons/ 字面量 —— 同源、非 data:、非跨源。
//     每条都必须①在仓树里真实存在 ②在**上线清单**（tools/assemble-site.sh）覆盖的产物集合里。
//  2) 像素真实性：每个 .png 读 magic + IHDR，宽高都必须是正数、文件非 0 字节；
//     `sizes="WxH"` 声明必须与 IHDR 实测一致（SVG 冒充 PNG、名不副实的 512 都在这条红）。
//     ≥180px 的下限单独判（apple-touch 与 PWA 图标都要过）。
//  3) 阴性自证：GATE_SELFTEST=1 时临时把拷贝腿里的一项挪掉，本闸必须点名变红。
//     红不了说明这把尺读不到拷贝腿，那它的绿没有意义。
//
// 用法：node tools/ship-check.mjs        退出码 0=全绿
//       GATE_SELFTEST=1 node tools/ship-check.mjs   阴性对照，期望 rc≠0
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './loader.mjs';

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const reds = [];
const fail = (msg) => reds.push(msg);

// ---------------------------------------------------------------- 1. 拷贝腿 → 产物集合
// 清单只有一份：tools/assemble-site.sh。pages.yml 现在只调它（与农场其余仓同一形态），
// 所以"上线产物里有什么"的尺子必须读那一份——去 workflow 里读手抄的 cp 行等于量另一份清单，
// 而两份清单漂了正是这一闸要防的坏法。断言一条没动：仍然要求每条同源引用
// ①在仓树里真实存在 ②在这份清单覆盖的产物集合里。
function parseCopyLegs() {
  const list = path.join(ROOT, 'tools/assemble-site.sh');
  if (!fs.existsSync(list)) { fail('tools/assemble-site.sh 不存在：无法判断上线产物里有什么'); return { legs: [], shipped: new Set() }; }
  const txt = fs.readFileSync(list, 'utf8');
  // 脚本里的目标目录是 "$DEST"（参数），尺子按 Pages 的产物目录 _site 读它。
  const legs = [];
  for (const line of txt.split('\n')) {
    const m = /^\s*(?:-\s*\S+\s*)?cp\s+(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    const argv = raw.replace(/\$DEST\b/g, '_site');
    const parts = argv.split(/\s+/).filter((x) => x && !x.startsWith('-'));
    const dest = parts[parts.length - 1];
    const srcs = parts.slice(0, -1);
    if (!srcs.length || !dest.includes('_site')) continue;
    legs.push({ srcs, recursive: /(^|\s)-[rR](\s|$)/.test(raw), line: line.trim() });
  }
  const shipped = new Set();
  for (const leg of legs) {
    for (const s of leg.srcs) {
      const abs = path.join(ROOT, s);
      if (!fs.existsSync(abs)) { fail(`拷贝腿引用了仓里不存在的源：${s}`); continue; }
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(abs, { recursive: true })) {
          const fp = path.join(abs, String(f));
          if (fs.statSync(fp).isFile()) shipped.add(rel(fp));
        }
        if (!leg.recursive) fail(`源 ${s} 是目录但 cp 没带 -r：整目录不会上线`);
      } else shipped.add(rel(abs));
    }
  }
  return { legs, shipped };
}

const { legs, shipped } = parseCopyLegs();
if (!legs.length) fail('tools/assemble-site.sh 里一条 cp 到产物的腿都没有：产物集合无法确定');

// ---------------------------------------------------------------- 2. 引用收集
const refs = new Map(); // 路径 -> 出处列表
const add = (p, from) => {
  const clean = p.replace(/^\.\//, '').replace(/^\.\/?/, '');
  if (!clean || clean.startsWith('data:') || clean.startsWith('#') || /^[a-z]+:\/\//i.test(clean)) return;
  if (!refs.has(clean)) refs.set(clean, []);
  refs.get(clean).push(from);
};

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'index.html:link/script');
// 内联脚本里的字符串引用（register('./sw.js') 这一类）：href/src 抓不到，漏了它等于给
// "离线壳存在但永远 404"留了一条看不见的路。
for (const m of html.matchAll(/['"]((?:\.\/)?[\w./-]+\.(?:png|css|js|webmanifest|ico))['"]/gi)) add(m[1], 'index.html:字面量');
for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)) {
  const mine = /^https?:\/\/[^/]+\/(?:z-biz-game-doublechoco-cos\/)?(.+)$/.exec(m[1]);
  if (mine) add(mine[1], 'index.html:og:image');
}
for (const f of fs.readdirSync(path.join(ROOT, 'css'))) {
  const css = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8');
  for (const m of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/gi)) {
    const p = m[1].replace(/^\.\.\//, ''); // css/ 是唯一一层，../x → 仓根 x
    if (!p.startsWith('data:')) add(p, `css/${f}:url()`);
  }
}
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
for (const ic of man.icons || []) add(ic.src, 'manifest:icons[].src');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const shellBlock = /const SHELL\s*=\s*\[([\s\S]*?)\];/.exec(sw);
if (!shellBlock) fail('sw.js 里找不到 SHELL 数组：离线壳清单读不到');
else for (const m of shellBlock[1].matchAll(/['"]([^'"]+)['"]/g)) add(m[1], 'sw.js:SHELL[]');
// js/ 里的资产字面量：新增纹理/精灵时必须自动进闸，不靠人记得来改这份清单。
for (const f of walkJs(path.join(ROOT, 'js'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/['"]((?:assets|icons)\/[^'"]+\.(?:png|jpg|jpeg|webp|svg|ico))['"]/g)) add(m[1], `js/${rel(f)}:字面量`);
}
function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 3. PNG IHDR 实测
function pngIhdr(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.length < 24) return { err: `文件 ${buf.length} 字节（<24，连 IHDR 都放不下）` };
  const sig = buf.slice(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') {
    return { err: `不是 PNG magic（头 8 字节 ${sig}）—— 冒充 PNG 的东西在这条红` };
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return { err: 'IHDR 不在首位' };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], bytes: buf.length };
}

let pngChecked = 0, maxPx = 0;
const bigEnough = [];
for (const [p, froms] of [...refs].sort()) {
  const abs = path.join(ROOT, p);
  const tag = `${p} ← ${froms.join(', ')}`;
  if (!fs.existsSync(abs)) { fail(`引用了仓里不存在的文件：${tag}`); continue; }
  if (fs.statSync(abs).size === 0) { fail(`0 字节占位：${tag}`); continue; }
  if (!shipped.has(p)) fail(`在仓里但不上线（拷贝腿没覆盖）：${tag}`);
  if (/\.png$/i.test(p)) {
    const r = pngIhdr(abs);
    pngChecked += 1;
    if (r.err) { fail(`PNG 读数失败：${tag} — ${r.err}`); continue; }
    if (r.w <= 0 || r.h <= 0) { fail(`IHDR 宽高非法：${tag} — ${r.w}x${r.h}`); continue; }
    maxPx = Math.max(maxPx, r.w, r.h);
    if (r.w !== r.h && !/og-cover/.test(p)) fail(`图标必须正方：${tag} — ${r.w}x${r.h}`);
    // manifest 里 "sizes":"WxH" 与 IHDR 对表（名不副实的 512 在这条红）
    for (const f of froms) {
      if (!f.startsWith('manifest')) continue;
      const ic = (man.icons || []).find((x) => x.src.replace(/^\.\//, '') === p);
      const mm = ic && /(\d+)x(\d+)/.exec(ic.sizes || '');
      if (mm && (Number(mm[1]) !== r.w || Number(mm[2]) !== r.h)) fail(`manifest 声明 ${mm[1]}x${mm[2]} 而 IHDR 实测 ${r.w}x${r.h}：${p}`);
    }
    if (r.w >= 180) bigEnough.push(`${p}(${r.w}x${r.h})`);
  }
}

// favicon 与 ≥180 的下限单判：这是清单里"图标"那一格的两半，一条都不许靠另一条蒙过去。
const iconLinks = [...html.matchAll(/<link[^>]+rel=["']icon["'][^>]*>/gi)];
if (!iconLinks.length) fail('index.html 没有 <link rel="icon">');
if (!bigEnough.length) fail(`没有任何 ≥180px 的真 PNG 图标（实测最大的图：见上一段）`);
if (!/<link[^>]+rel=["']apple-touch-icon["']/.test(html)) fail('index.html 没有 apple-touch-icon');
if (!/<link[^>]+rel=["']manifest["']/.test(html)) fail('index.html 没有 <link rel="manifest">');
const touch = /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/.exec(html);
if (touch) {
  const r = pngIhdr(path.join(ROOT, touch[1].replace(/^\.\//, '')));
  if (r.err || r.w < 180) fail(`apple-touch-icon 不是 ≥180px 真 PNG：${touch[1]} → ${r.err || r.w + 'x' + r.h}`);
}

// sw.js 的 cache 名必须带版本，且不能对同源子资源做 cache-first（简报 §2）。
if (!/VERSION\s*=/.test(sw)) fail('sw.js 没有 VERSION：cache 名无法随发布变化');
if (/cache-first|caches\.match[^)]*\)[\s\S]{0,200}?fetch\(/.test(sw) && !/网络优先/.test(sw)) fail('sw.js 疑似 cache-first 子资源：js/css 会被永久钉死');

// ---------------------------------------------------------------- 输出
console.log(`拷贝腿 ${legs.length} 条：${legs.map((l) => l.srcs.join('+')).join(' | ') || '(无)'}`);
console.log(`产物文件 ${shipped.size} 个；被引用路径 ${refs.size} 条；真读 PNG ${pngChecked} 张，最大边 ${maxPx}px，≥180px 的 ${bigEnough.length} 张`);
if (bigEnough.length) console.log(`  ≥180px：${bigEnough.slice(0, 8).join(', ')}${bigEnough.length > 8 ? ` …共 ${bigEnough.length}` : ''}`);
console.log(`未上线引用 ${[...refs].filter(([p]) => shipped.has(p) === false).length} 条，仓内缺失 ${[...refs].filter(([p]) => !fs.existsSync(path.join(ROOT, p))).length} 条`);
if (reds.length) {
  console.log(`\n❌ ${reds.length} 条红：`);
  for (const r of reds) console.log('  · ' + r);
} else {
  console.log(`\n✅ ${refs.size} 条引用全部①在仓树里②在上线产物里，PNG 逐张 IHDR 可读`);
}

// 阴性自证：从拷贝腿里删掉 assets 这一源，本闸必须点名"不上线"。
if (process.env.GATE_SELFTEST === '1') {
  const touched = shipped.has('assets/texture/paper-fibre.png');
  if (!touched) { console.log('\n阴性对照基线不清（assets 本就不在产物里），对照无从做起'); process.exit(2); }
  const simulate = new Set([...shipped].filter((p) => !p.startsWith('assets/')));
  const missing = [...refs.keys()].filter((p) => p.startsWith('assets/') && !simulate.has(p));
  console.log(`\n=== 阴性对照：把 assets/ 从拷贝腿摘掉 ⇒ 应点名 ${missing.length} 条 ===`);
  for (const m of missing.slice(0, 4)) console.log('  预期红：' + m);
  if (!missing.length) { console.log('❌ 阴性对照不红 ⇒ 这把尺读不到拷贝腿，绿不可信'); process.exit(1); }
  console.log(`✅ 阴性对照生效：摘掉拷贝腿即判 ${missing.length} 条"在仓里但不上线"`);

  // 第二条对照：magic 分支会不会空跑。造一张名字叫 .png、内容是 SVG 的假图（写在 /tmp，不进仓），
  // 同一个 pngIhdr 必须拒掉它；同时仓里一张真图必须读出正宽高。两边都对才算这把尺有牙。
  const os = await import('node:os');
  const fake = path.join(os.tmpdir(), 'ship-check-fake.png');
  fs.writeFileSync(fake, '<svg xmlns="http://www.w3.org/2000/svg"/><' + '0'.repeat(64));
  const f = pngIhdr(fake);
  const g = pngIhdr(path.join(ROOT, 'icons/icon-192.png'));
  fs.unlinkSync(fake);
  console.log(`\n=== 阴性对照 2：假 PNG（SVG 内容，${path.basename(fake)}）与真 PNG 各喂一次 ===`);
  console.log(`  假图 → ${f.err || `误判为合法 ${f.w}x${f.h}`}`);
  console.log(`  icons/icon-192.png → ${g.err || `实测 ${g.w}x${g.h}`}`);
  if (!f.err) { console.log('❌ 假 PNG 没被 magic 拒掉 ⇒ IHDR 这条尺空跑'); process.exit(1); }
  if (g.err || g.w !== 192 || g.h !== 192) { console.log('❌ 真 PNG 读数不对 ⇒ 同一把尺读不出真图'); process.exit(1); }
  console.log('✅ 阴性对照 2 生效：假 PNG 被拒、真 PNG 读出 192x192');
}

process.exit(reds.length ? 1 : 0);
